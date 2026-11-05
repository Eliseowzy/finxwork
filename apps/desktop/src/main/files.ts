import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { shell } from "electron";
import type { OpenFileResult, PathInfo } from "../shared/bridge";
import { isPageFile } from "../shared/pageFile";
import { editors, launchOf, opensFolders } from "./editors";
import { bundle, launches, relativeIn, resolveFrom } from "./paths";
import { platform } from "./platform";

// What a reply's files and links lead to outside the app (content-actions-design §4, §10):
// a path looked up for the page, a file opened as the person's default way says, the file
// manager, a terminal, the default browser. The page only points; this side checks again
// before it acts, and never opens what would run.

/**
 * End-to-end tests (FINXWORK_E2E_OPENED=<file>): what would open outside the app is written
 * to that file, a JSON line each, instead of opening.
 */
const recordTo = process.env.FINXWORK_E2E_OPENED;
function record(entry: Record<string, unknown>): boolean {
  if (!recordTo) return false;
  fs.appendFileSync(recordTo, JSON.stringify(entry) + "\n");
  return true;
}

/** Shows a file or folder in the file manager. */
export function reveal(p: string) {
  if (!record({ kind: "reveal", path: p })) shell.showItemInFolder(p);
}

/** Opens a folder in the file manager, or a file in its default app. */
async function openPath(p: string): Promise<boolean> {
  if (record({ kind: "open", path: p })) return true;
  return (await shell.openPath(p)) === "";
}

/** A folder in the file manager. */
export function openFolder(dir: string) {
  void openPath(dir);
}

/** A web page in the system's default browser. */
export function openExternal(url: string) {
  if (!record({ kind: "external", url })) void shell.openExternal(url).catch(() => {});
}

/** A new window of the system's terminal, its shell in this folder. */
export function openTerminal(dir: string) {
  if (!record({ kind: "terminal", path: dir })) platform.openTerminal(dir);
}

/** Paths as a reply wrote them, looked up under `base`: what each is, never what is in it (§3.6). */
export function pathInfo(base: string, paths: string[]): Promise<PathInfo[]> {
  return Promise.all(
    paths.map(async (p) => {
      const abs = resolveFrom(base, p);
      const st = await fs.promises.stat(abs).catch(() => null);
      return { path: abs, rel: relativeIn(base, abs), kind: st ? (st.isDirectory() ? "folder" : "file") : null };
    }),
  );
}

/** An HTML file's address for the session's browser; null when it is not one or is not there. */
export async function pageOfFile(file: string): Promise<string | null> {
  if (!isPageFile(file)) return null;
  const st = await fs.promises.stat(file).catch(() => null);
  return st?.isFile() ? pathToFileURL(file).href : null;
}

function launch(program: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => execFile(program, args, { timeout: 15_000 }, (err) => resolve(!err)));
}

/**
 * Opens what a reply points at outside the app (§4.2; in the app it is the file panel's). A
 * folder in the file manager (a bundle only shown there); a file in the editor chosen for it
 * (`app`, an editor's bundle id), else in its default app, unless that would run it: then it is
 * only shown in the file manager.
 */
export async function openFile(file: string, options: { line?: number; app?: string } = {}): Promise<OpenFileResult> {
  const st = await fs.promises.stat(file).catch(() => null);
  if (!st) return { ok: false, reason: "missing" };
  const found = await editors(os.homedir());
  const chosen = options.app && options.app !== "system" ? found.find((e) => e.id === options.app) : undefined;
  const editor = async (e: (typeof found)[number]) => {
    const how = launchOf(e, file, options.line);
    if (record({ kind: "editor", editor: e.id, path: file, line: options.line ?? null, ...how })) return { ok: true as const, how: "editor" as const };
    const ok = "url" in how ? await shell.openExternal(how.url).then(() => true, () => false) : await launch(how.program, how.args);
    // Xcode's own command may be missing (the command line tools chosen instead): the app still opens the file.
    if (!ok && "program" in how && how.program === "/usr/bin/xed") return (await launch("/usr/bin/open", ["-a", e.path, file])) ? { ok: true as const, how: "editor" as const } : { ok: false as const, reason: "failed" as const };
    return ok ? { ok: true as const, how: "editor" as const } : { ok: false as const, reason: "failed" as const };
  };
  if (st.isDirectory()) {
    if (chosen && opensFolders(chosen)) return editor(chosen);
    if (bundle(file)) return reveal(file), { ok: true, how: "revealed" };
    return (await openPath(file)) ? { ok: true, how: "folder" } : { ok: false, reason: "failed" };
  }
  if (chosen) return editor(chosen);
  if (launches(file, st.mode)) return reveal(file), { ok: true, how: "revealed" };
  return (await openPath(file)) ? { ok: true, how: "app" } : { ok: false, reason: "failed" };
}
