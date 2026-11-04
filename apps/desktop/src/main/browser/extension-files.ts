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
  if (typeof target !== "string" || !fs.existsSync(target)) return "dead";
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
