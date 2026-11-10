import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// What the app keeps on disk for the user's own browser, without Electron, so tests can stand in
// for the machine: what a browser's host manifest points at, and the extension's folder, which
// the app replaces in one step when an update brings other files (browser-design §8.4.7).

/**
 * What a browser would start for the extension: this home's host; one that is gone (a temporary
 * home of a test, an app removed), which is repaired; or another home's, which is left alone:
 * another FinxWork registered it, and that one is working.
 */
export type ManifestState = "missing" | "ours" | "dead" | "other";

/** One word of `sh` in single quotes, as `finx browser extension install` writes them: `'\''` is a quote. */
const QUOTED = String.raw`'((?:[^']|'\\'')*)'`;
const unquote = (word: string) => word.replaceAll(String.raw`'\''`, "'");

/** The program and home a launcher script of `finx browser extension install` runs; null for another script. */
export function launcherTarget(script: string): { program: string; home: string | null } | null {
  const program = new RegExp(`exec ${QUOTED} browser native-host`).exec(script)?.[1];
  if (program === undefined) return null;
  const home = new RegExp(`FINX_HOME=${QUOTED}`).exec(script)?.[1];
  return { program: unquote(program), home: home === undefined ? null : unquote(home) };
}

/**
 * A launcher whose program or home is gone starts nothing: the script of a test's temporary
 * home outlives the build it ran. Chrome would start it, and it exits at once.
 */
function launcherGone(launcher: string): boolean {
  let script: string;
  try {
    script = fs.readFileSync(launcher, "utf8");
  } catch {
    return true;
  }
  const target = launcherTarget(script);
  if (!target) return false; // Not one of ours to judge: a program of its own.
  return !fs.existsSync(target.program) || (target.home !== null && !fs.existsSync(target.home));
}

export function manifestState(manifest: string, launcher: string): ManifestState {
  let text: string;
  try {
    text = fs.readFileSync(manifest, "utf8");
  } catch {
    return "missing";
  }
  let target: unknown;
  try {
    target = (JSON.parse(text) as { path?: unknown }).path;
  } catch {
    return "dead";
  }
  if (typeof target !== "string" || !fs.existsSync(target) || launcherGone(target)) return "dead";
  return target === launcher ? "ours" : "other";
}

type Keep = (file: string) => boolean;

function files(dir: string, keep: Keep): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => {
      const full = path.join(dir, e.name);
      if (!keep(full)) return [];
      return e.isDirectory() ? files(full, keep) : [full];
    })
    .sort();
}

/** What the extension's files add up to: tells one build from another. */
export function folderBuild(dir: string, keep: Keep): string {
  const hash = createHash("sha256");
  for (const file of files(dir, keep)) hash.update(path.relative(dir, file)).update("\0").update(fs.readFileSync(file)).update("\0");
  return hash.digest("hex").slice(0, 16);
}

/** The build a folder holds. */
export function heldBuild(dir: string): string | null {
  try {
    return (JSON.parse(fs.readFileSync(path.join(dir, "build.json"), "utf8")) as { build?: string }).build ?? null;
  } catch {
    return null;
  }
}

/**
 * Puts the extension in its folder, unless it is there already. In one step: Chrome reads this
 * folder, and must never find it half written. The extension sees `build.json` change and reloads
 * once the agent has no tab in use.
 */
export function placeExtension(from: string, to: string, keep: Keep) {
  const build = folderBuild(from, keep);
  if (heldBuild(to) === build) return;
  const fresh = `${to}.new`;
  const old = `${to}.old`;
  fs.rmSync(fresh, { recursive: true, force: true });
  fs.rmSync(old, { recursive: true, force: true });
  fs.cpSync(from, fresh, { recursive: true, filter: keep });
  fs.writeFileSync(path.join(fresh, "build.json"), `${JSON.stringify({ build })}\n`);
  if (fs.existsSync(to)) fs.renameSync(to, old);
  fs.renameSync(fresh, to);
  fs.rmSync(old, { recursive: true, force: true });
}
