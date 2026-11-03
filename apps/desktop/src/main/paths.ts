import os from "node:os";
import path from "node:path";

// The paths a reply writes, made absolute under its session's folder, and the files a
// default app would run rather than show (content-actions-design §3.6, §4.4).

/** A path as a reply wrote it, made absolute: `~` is the home folder, a relative one is under `base`. */
export function resolveFrom(base: string, p: string): string {
  const expanded = p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
  return path.resolve(base, expanded);
}

/** Where `abs` is under `base`, or null when it is not under it. */
export function relativeIn(base: string, abs: string): string | null {
  const rel = path.relative(base, abs);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : null;
}

/** What a default app runs rather than shows (§4.4), by extension; with the execute bit, anything. */
const runs: Record<string, string[]> = {
  any: ["command", "tool", "terminal", "workflow", "action", "jar", "py", "pyw", "sh", "bash", "zsh", "rb", "pl", "webloc", "inetloc", "fileloc", "url"],
  darwin: ["app", "pkg", "mpkg", "mobileconfig", "prefpane", "saver", "kext", "scpt", "scptd", "applescript"],
  win32: ["exe", "bat", "cmd", "com", "ps1", "msi", "lnk", "scr", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta", "reg", "cpl", "msc"],
  linux: ["desktop", "appimage", "run"],
};

/** Whether a default app would run the file: by its extension on this system, or its execute bit. */
export function launches(file: string, mode: number, system: NodeJS.Platform = process.platform): boolean {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (ext && [...runs.any, ...(runs[system] ?? [])].includes(ext)) return true;
  return system !== "win32" && (mode & 0o111) !== 0;
}

/** A bundle the file manager shows as a file (an app, a package): opening it starts it. */
export const bundle = (p: string) => /\.(app|pkg|mpkg|bundle|plugin|prefpane|saver|kext)\/?$/i.test(p);
