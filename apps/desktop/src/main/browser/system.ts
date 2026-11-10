import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, nativeImage, shell } from "electron";
import type { SystemBrowser, SystemBrowserDiagnosis, SystemBrowserId } from "../../shared/bridge";
import { finxHome, kernelStatus } from "../kernel";
import { heldBuild, launcherTarget, manifestState, placeExtension } from "./extension-files";

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

/**
 * Opens an app. End-to-end tests (FINXWORK_E2E_OPENED=<file>): what would open is written there
 * instead, one JSON per line: the browser under test is not the one this Mac would start.
 */
const open = async (args: string[]) => {
  const recordTo = process.env.FINXWORK_E2E_OPENED;
  if (recordTo) {
    fs.appendFileSync(recordTo, `${JSON.stringify({ browser: args })}\n`);
    return { ok: true, out: "" };
  }
  return run("/usr/bin/open", args);
};

function appPath(k: Known): string | null {
  for (const dir of ["/Applications", path.join(os.homedir(), "Applications")]) {
    const p = path.join(dir, k.app);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const dataDir = (k: Known) => path.join(os.homedir(), "Library/Application Support", k.data);

/** This home's host, which the manifests of a browser it set up point at. */
const launcherPath = () => path.join(finxHome, "browser", "native-host");
const manifestOf = (k: Known) => manifestState(path.join(dataDir(k), HOST_MANIFEST), launcherPath());

async function running(k: Known): Promise<boolean> {
  return (await run("/usr/bin/pgrep", ["-x", k.process])).ok;
}

/** The browsers on this Mac that can run the extension; none off macOS for now. */
export async function systemBrowsers(): Promise<SystemBrowser[]> {
  if (process.platform !== "darwin") return [];
  const found = known.flatMap((k) => (appPath(k) ? [k] : []));
  return Promise.all(
    found.map(async (k) => {
      const manifest = manifestOf(k);
      return { id: k.id, name: k.name, registered: manifest === "ours" || manifest === "dead", manifest, running: await running(k) };
    }),
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
  placeExtension(from, extensionFolder(), (f) =>
    !f.endsWith(".test.js") &&
    !f.endsWith(".d.ts") &&
    !["package.json", "node_modules", "build.json"].includes(path.basename(f)) &&
    // The store packaging, in a development checkout.
    !["scripts", "store", "dist"].includes(path.relative(from, f).split(path.sep)[0]),
  );
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

/**
 * At start, and when a host is refused: where this home set the browser up, the files follow the
 * app, which may have moved or updated. A manifest that points at nothing is repaired; one of
 * another home's stays: another FinxWork, or a test with its own home, may be using it.
 * `deadOnly`: each time the app comes to the front, only what starts nothing is repaired, as the
 * extension asks the user to open FinxWork when its host will not start.
 */
let refreshing: Promise<void> = Promise.resolve();
let pending = 0;
export function refreshSystemBrowser(deadOnly = false): Promise<void> {
  // One at a time; a look on focus while one runs or waits adds nothing.
  if (deadOnly && pending > 0) return refreshing;
  pending++;
  refreshing = refreshing.then(() => refreshNow(deadOnly)).catch(() => {}).finally(() => pending--);
  return refreshing;
}

async function refreshNow(deadOnly: boolean) {
  if (process.platform !== "darwin") return;
  const mine = known.filter((k) => (deadOnly ? ["dead"] : ["ours", "dead"]).includes(manifestOf(k)));
  const binary = serviceBinary();
  if (mine.length === 0 || !binary) return;
  try {
    copyExtension();
  } catch {
    // The folder is in use or read-only: the host still follows.
  }
  for (const k of mine) await run(binary, ["browser", "extension", "install", "--user-data-dir", dataDir(k)], { ...process.env, FINX_HOME: finxHome });
}

/** A task waits for the user's own browser: starts the one set up here, behind what the user is doing. */
export async function openSystemBrowserQuietly() {
  const k = known.find((b) => appPath(b) && ["ours", "dead"].includes(manifestOf(b)));
  const where = k && appPath(k);
  if (where) await open(["-g", "-a", where]);
}

/** Each link from the browser to finx's service, as this machine has it. */
export async function diagnoseSystemBrowser(): Promise<SystemBrowserDiagnosis> {
  const launcher = launcherPath();
  let program: string | null = null;
  try {
    program = launcherTarget(fs.readFileSync(launcher, "utf8"))?.program ?? null;
  } catch {
    // No script yet.
  }
  const folder = extensionFolder();
  return {
    app: app.getVersion(),
    service: serviceBinary(),
    launcher,
    program,
    programExists: !!program && fs.existsSync(program),
    extensionFolder: folder,
    extensionBuild: heldBuild(folder),
    browsers: await Promise.all(
      known.filter((k) => appPath(k)).map(async (k) => ({ name: k.name, running: await running(k), manifest: manifestOf(k) })),
    ),
  };
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
  return (await open(args)).ok;
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
