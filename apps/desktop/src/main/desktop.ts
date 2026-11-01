import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Desktop control's program, agent-desktop, as finx's desktop tools find it
// (crates/finx-desktop): `desktop.executable`, else the copy beside finx in the
// packaged app's Contents/MacOS, else finx's own copy in ~/.finx/desktop/bin, else PATH. The permissions are the app's own and are
// read in ipc.ts; this part needs no Electron.

const PROGRAM = process.platform === "win32" ? "agent-desktop.exe" : "agent-desktop";

/** Where a Mac app launched from the Dock has no PATH entry for npm's or Homebrew's binaries. */
const USUAL_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

/** The program finx would run, or null when there is none. */
export function locateDesktopProgram(
  configured: string | undefined,
  home = os.homedir(),
  pathVar = process.env.PATH ?? "",
  beside: string | null = null,
): string | null {
  const isFile = (p: string) => fs.statSync(p, { throwIfNoEntry: false })?.isFile() === true;
  if (configured) return path.isAbsolute(configured) && isFile(configured) ? configured : null;
  const dirs = [...(beside ? [beside] : []), path.join(home, ".finx", "desktop", "bin"), ...pathVar.split(path.delimiter).filter(Boolean), ...USUAL_DIRS];
  return dirs.map((d) => path.join(d, PROGRAM)).find(isFile) ?? null;
}

/** The version in `agent-desktop version`'s envelope. */
export function parseDesktopVersion(stdout: string): string | null {
  const line = stdout.trim().split("\n").pop() ?? "";
  try {
    const envelope = JSON.parse(line) as { ok?: boolean; data?: { version?: unknown } };
    return envelope.ok === true && typeof envelope.data?.version === "string" ? envelope.data.version : null;
  } catch {
    return null;
  }
}

/** The program's version, or null when it does not answer as agent-desktop. */
export function desktopProgramVersion(program: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(program, ["version"], { timeout: 5000 }, (err, stdout) => resolve(err ? null : parseDesktopVersion(stdout)));
  });
}

/** A bundle id as macOS writes them; anything else (an app known only by name) is not looked up. */
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.\-_]*$/;

/** The installed app with `bundleId`, by Spotlight: its path and its name in the system's language. */
export function findApp(bundleId: string): Promise<{ path: string; name: string } | null> {
  if (process.platform !== "darwin" || !BUNDLE_ID.test(bundleId)) return Promise.resolve(null);
  const run = (cmd: string, args: string[]) =>
    new Promise<string>((resolve) => execFile(cmd, args, { timeout: 5000 }, (err, stdout) => resolve(err ? "" : stdout.trim())));
  return run("mdfind", [`kMDItemCFBundleIdentifier == "${bundleId}"`]).then(async (out) => {
    const found = out.split("\n").find((p) => p.endsWith(".app"));
    if (!found) return null;
    const name = await run("mdls", ["-name", "kMDItemDisplayName", "-raw", found]);
    return { path: found, name: (name && name !== "(null)" ? name : path.basename(found)).replace(/\.app$/, "") };
  });
}
