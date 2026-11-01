import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, nativeImage, shell } from "electron";
import type { SystemBrowser, SystemBrowserId } from "../../shared/bridge";
import { finxHome, kernelStatus } from "../kernel";

// The user's own browser (browser-design §8.4), set up from the settings: which browsers
// this Mac has, registering finx as the extension's host, the extension's folder, and the
// browser's extensions page. Whether the extension is connected is finx's to say
// (browser/status); this module only does what needs the machine.

type Known = { id: SystemBrowserId; name: string; app: string; process: string; data: string; extensions: string };

/** Chromium-family browsers that run the FinxWork extension, with where each keeps its data. */
const known: Known[] = [
  { id: "chrome", name: "Google Chrome", app: "Google Chrome.app", process: "Google Chrome", data: "Google/Chrome", extensions: "chrome://extensions" },
  { id: "edge", name: "Microsoft Edge", app: "Microsoft Edge.app", process: "Microsoft Edge", data: "Microsoft Edge", extensions: "edge://extensions" },
  { id: "brave", name: "Brave", app: "Brave Browser.app", process: "Brave Browser", data: "BraveSoftware/Brave-Browser", extensions: "brave://extensions" },
  { id: "chromium", name: "Chromium", app: "Chromium.app", process: "Chromium", data: "Chromium", extensions: "chrome://extensions" },
];

const HOST_MANIFEST = "NativeMessagingHosts/com.finxwork.browser.json";

const run = (file: string, args: string[], env?: NodeJS.ProcessEnv) =>
  new Promise<{ ok: boolean; out: string }>((resolve) =>
    execFile(file, args, { env, timeout: 15000 }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}`.trim() })),
  );

function appPath(k: Known): string | null {
  for (const dir of ["/Applications", path.join(os.homedir(), "Applications")]) {
    const p = path.join(dir, k.app);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const dataDir = (k: Known) => path.join(os.homedir(), "Library/Application Support", k.data);

async function running(k: Known): Promise<boolean> {
  return (await run("/usr/bin/pgrep", ["-x", k.process])).ok;
}

/** The browsers on this Mac that can run the extension; none off macOS for now. */
export async function systemBrowsers(): Promise<SystemBrowser[]> {
  if (process.platform !== "darwin") return [];
  const found = known.flatMap((k) => (appPath(k) ? [k] : []));
  return Promise.all(
    found.map(async (k) => ({
      id: k.id,
      name: k.name,
      registered: fs.existsSync(path.join(dataDir(k), HOST_MANIFEST)),
      running: await running(k),
    })),
  );
}

/** The finx that runs the service: the host must be that very program, or the service refuses it. */
function serviceBinary(): string | null {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(finxHome, "run", "finx.lock"), "utf8").split("\n")[0]);
    if (typeof record.exe === "string" && fs.existsSync(record.exe)) return record.exe;
  } catch {
    // No service record yet: the one the app starts.
  }
  return kernelStatus().binary;
}

/** The extension as the app ships it. */
function bundledExtension(): string {
  return app.isPackaged ? path.join(process.resourcesPath, "chrome-extension") : path.resolve(app.getAppPath(), "../chrome-extension");
}

/** Where the user loads the extension from: a copy outside the app, so moving or updating the app does not pull it away. */
export function extensionFolder(): string {
  return path.join(finxHome, "browser", "FinxWork Extension");
}

function copyExtension() {
  const from = bundledExtension();
  const to = extensionFolder();
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, {
    recursive: true,
    filter: (f) => !f.endsWith(".test.js") && path.basename(f) !== "package.json" && path.basename(f) !== "node_modules",
  });
}

/**
 * Registers finx as the extension's host for every browser here, and puts the extension
 * where the user can load it from. Safe to run again: it rewrites the same files.
 */
export async function setUpSystemBrowser(): Promise<{ ok: true } | { ok: false; message: string }> {
  const binary = serviceBinary();
  if (!binary) return { ok: false, message: "FinxWork's service is not available" };
  try {
    copyExtension();
  } catch (e) {
    return { ok: false, message: `cannot copy the extension: ${e instanceof Error ? e.message : String(e)}` };
  }
  const result = await run(binary, ["browser", "extension", "install"], { ...process.env, FINX_HOME: finxHome });
  return result.ok ? { ok: true } : { ok: false, message: result.out || "registering failed" };
}

/** At start: when the user set this up before, the files follow the app (it may have moved or updated). */
export async function refreshSystemBrowser() {
  const browsers = await systemBrowsers();
  if (browsers.some((b) => b.registered)) await setUpSystemBrowser();
}

function find(id: unknown): Known | undefined {
  return known.find((k) => k.id === id);
}

/** Opens the browser (it may be closed), on its extensions page when asked. */
export async function openSystemBrowser(id: unknown, page?: "extensions"): Promise<boolean> {
  const k = find(id);
  const where = k && appPath(k);
  if (!k || !where) return false;
  const args = page === "extensions" ? ["-a", where, k.extensions] : ["-a", where];
  return (await run("/usr/bin/open", args)).ok;
}

/** The browser's own icon, as Finder draws it. */
export async function systemBrowserIcon(id: unknown): Promise<string | null> {
  const k = find(id);
  const where = k && appPath(k);
  if (!where) return null;
  try {
    const icon = await nativeImage.createThumbnailFromPath(where, { width: 64, height: 64 });
    return icon.isEmpty() ? null : icon.toDataURL();
  } catch {
    return null;
  }
}

/** Shows the extension's folder in Finder, ready to drag onto the extensions page. */
export function revealExtension() {
  if (!fs.existsSync(extensionFolder())) copyExtension();
  shell.showItemInFolder(extensionFolder());
}
