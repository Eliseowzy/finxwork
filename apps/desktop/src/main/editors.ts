import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// The editors a file opens in from a reply (content-actions-design §4.3): the known ones
// installed on this Mac, found by bundle id in one Spotlight query, each told to go to a
// line the way its family takes it. Windows and Linux have none yet (DQ-40).

/** How an editor is told to open a file at a line. */
export type Family = "vscode" | "jetbrains" | "xcode" | "cli" | "plain";

/** The editors looked for, by bundle id. */
export const known: Record<string, Family> = {
  "com.microsoft.VSCode": "vscode",
  "com.microsoft.VSCodeInsiders": "vscode",
  "com.vscodium": "vscode",
  "com.todesktop.230313mzl4w4u92": "vscode",
  "com.exafunction.windsurf": "vscode",
  "com.trae.app": "vscode",
  "cn.trae.app": "vscode",
  "com.qoder.app": "vscode",
  "dev.kiro.desktop": "vscode",
  "com.jetbrains.intellij": "jetbrains",
  "com.jetbrains.intellij.ce": "jetbrains",
  "com.jetbrains.WebStorm": "jetbrains",
  "com.jetbrains.pycharm": "jetbrains",
  "com.jetbrains.pycharm.ce": "jetbrains",
  "com.jetbrains.goland": "jetbrains",
  "com.jetbrains.rustrover": "jetbrains",
  "com.jetbrains.CLion": "jetbrains",
  "com.jetbrains.PhpStorm": "jetbrains",
  "com.jetbrains.rider": "jetbrains",
  "com.google.android.studio": "jetbrains",
  "com.apple.dt.Xcode": "xcode",
  "dev.zed.Zed": "cli",
  "dev.zed.Zed-Preview": "cli",
  "com.sublimetext.4": "cli",
  "com.sublimetext.3": "cli",
  "com.barebones.bbedit": "plain",
  "com.panic.Nova": "plain",
  "com.macromates.TextMate": "plain",
  "com.coteditor.CotEditor": "plain",
  "abnerworks.Typora": "plain",
  "com.apple.TextEdit": "plain",
};

/** An editor found here: where it is, and what its family needs (a URL scheme, a command-line program). */
export type Editor = { id: string; name: string; path: string; family: Family; scheme?: string; program?: string };

/**
 * The apps `mdfind -attr kMDItemCFBundleIdentifier` printed, one per bundle id: the copy in
 * /Applications first, then ~/Applications, then elsewhere; none inside another app or the Trash.
 */
export function parseFound(out: string, home: string): { id: string; path: string }[] {
  const rank = (p: string) => (p.startsWith("/Applications/") ? 0 : p.startsWith(path.join(home, "Applications") + "/") ? 1 : 2);
  const best = new Map<string, string>();
  for (const line of out.split("\n")) {
    const m = /^(\/.*?\.app)\s+kMDItemCFBundleIdentifier = (\S+)\s*$/.exec(line);
    if (!m || m[1].slice(0, -4).includes(".app/") || m[1].includes("/.Trash/")) continue;
    const [, at, id] = m;
    const had = best.get(id);
    if (!had || rank(at) < rank(had)) best.set(id, at);
  }
  return [...best].map(([id, at]) => ({ id, path: at }));
}

/** Whether an editor opens a folder as a project (the others take files only). */
export const opensFolders = (e: Pick<Editor, "family">) => e.family === "vscode" || e.family === "jetbrains" || e.family === "cli";

/** A path as a URL's path, each part encoded (`#`, spaces and Chinese survive). */
const urlPath = (file: string) => file.split("/").map(encodeURIComponent).join("/");

/**
 * How `file` opens in `e`, at `line` where the editor takes one: a URL to hand to the system,
 * or a program and its arguments (never a shell string).
 */
export function launchOf(e: Editor, file: string, line?: number): { url: string } | { program: string; args: string[] } {
  const at = line && line > 0 ? line : undefined;
  switch (e.family) {
    case "vscode":
      if (e.scheme) return { url: `${e.scheme}://file${urlPath(file)}${at ? `:${at}:1` : ""}` };
      break;
    case "jetbrains":
      if (e.program) return { program: "/usr/bin/open", args: ["-na", e.program, "--args", ...(at ? ["--line", String(at)] : []), file] };
      break;
    case "xcode":
      if (at) return { program: "/usr/bin/xed", args: ["--line", String(at), file] };
      break;
    case "cli":
      if (e.program) return { program: e.program, args: [at ? `${file}:${at}` : file] };
      break;
  }
  return { program: "/usr/bin/open", args: ["-a", e.path, file] };
}

const run = (program: string, args: string[]) =>
  new Promise<string>((resolve) => execFile(program, args, { timeout: 5000 }, (err, stdout) => resolve(err ? "" : stdout.trim())));

/** What a family needs from the installed app: VS Code's URL scheme (its product.json), a JetBrains IDE's or Zed's and Sublime's program. */
function needs(family: Family, app: string): Pick<Editor, "scheme" | "program"> {
  try {
    switch (family) {
      case "vscode": {
        const product = JSON.parse(fs.readFileSync(path.join(app, "Contents/Resources/app/product.json"), "utf8")) as { urlProtocol?: unknown };
        return typeof product.urlProtocol === "string" && /^[a-z][a-z0-9+.-]*$/.test(product.urlProtocol) ? { scheme: product.urlProtocol } : {};
      }
      case "jetbrains": {
        const dir = path.join(app, "Contents/MacOS");
        const program = fs.readdirSync(dir).find((f) => !f.startsWith("."));
        return program ? { program: path.join(dir, program) } : {};
      }
      case "cli": {
        const program = [path.join(app, "Contents/MacOS/cli"), path.join(app, "Contents/SharedSupport/bin/subl")].find((p) => fs.existsSync(p));
        return program ? { program } : {};
      }
    }
  } catch {
    // Read as a plain editor.
  }
  return {};
}

async function find(home: string): Promise<Editor[]> {
  if (process.platform !== "darwin") return [];
  const query = Object.keys(known).map((id) => `kMDItemCFBundleIdentifier == "${id}"`).join(" || ");
  const found = parseFound(await run("/usr/bin/mdfind", ["-attr", "kMDItemCFBundleIdentifier", query]), home);
  const editors = await Promise.all(
    found.map(async ({ id, path: app }): Promise<Editor> => {
      const shown = await run("/usr/bin/mdls", ["-name", "kMDItemDisplayName", "-raw", app]);
      const name = (shown && shown !== "(null)" ? shown : path.basename(app)).replace(/\.app$/, "");
      const want = known[id];
      const got = needs(want, app);
      // A family whose part is missing (no scheme, no program) still opens files, without the line.
      const family = (want === "vscode" && !got.scheme) || ((want === "jetbrains" || want === "cli") && !got.program) ? "plain" : want;
      return { id, name, path: app, family, ...got };
    }),
  );
  return editors.sort((a, b) => a.name.localeCompare(b.name));
}

let looked: { at: number; editors: Promise<Editor[]> } | undefined;

/**
 * The editors installed here. Looked for once, then given at once; asked again after a minute,
 * the look is done again in the background, for the next time.
 */
export function editors(home: string): Promise<Editor[]> {
  const now = Date.now();
  if (!looked) looked = { at: now, editors: find(home) };
  else if (now - looked.at > 60_000) {
    const next = find(home);
    const previous = looked.editors;
    looked = { at: now, editors: previous };
    void next.then((list) => looked && (looked.editors = Promise.resolve(list)));
  }
  return looked.editors;
}
