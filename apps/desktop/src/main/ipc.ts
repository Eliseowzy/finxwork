import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserPanel, BrowserTabCommand, Command, MenuItem, MenuState, PickedFile, Preferences } from "../shared/bridge";
import { i18n } from "../shared/i18n";
import { currentTabs, setPanel, showTab, tabCommand } from "./browser/pages";
import { gitBranch } from "./git";
import { connectKernel, kernelStatus, restartKernel, retryKernel } from "./kernel";
import { platform } from "./platform";
import { preferences, setPreferences } from "./preferences";
import { check, download, install, setAutoDownload, snooze, updateInfo } from "./updater";
import { mainWindow, ours, settingsVisible, showMain, showSettings } from "./windows";

// The page's requests to the main process (shared/bridge.ts). Each handler
// checks the request comes from one of our own pages.
function trusted(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return !!e.senderFrame && ours(e.senderFrame.url);
}

const noMenuState: MenuState = { main: false, session: null, sidebar: true, undo: false };
let menuState = noMenuState;
export const currentMenuState = () => menuState;
export const menuStateListeners = new Set<() => void>();
const reporting = new WeakSet<WebContents>();
let pending: Command | undefined;

/** Hands a command to the main window's page, opening the window first if needed; a page still loading gets it once it reports its state. */
export function command(c: Command) {
  const win = showMain();
  if (menuState.main) win.webContents.send("command", c);
  else pending = c;
}

/** A tab command as the page sends it. */
function tabCommandOk(c: unknown): c is BrowserTabCommand {
  if (typeof c !== "object" || c === null) return false;
  const { command, url } = c as Record<string, unknown>;
  if (command === "go") return typeof url === "string" && url.length <= 8192;
  return ["back", "forward", "reload", "stop", "close", "new"].includes(command as string);
}

/** A panel as the page reports it: a session id or null, a rectangle of finite numbers or null. */
function browserPanel(p: unknown): p is BrowserPanel {
  if (typeof p !== "object" || p === null) return false;
  const { session, rect } = p as Record<string, unknown>;
  if (session !== null && typeof session !== "string") return false;
  if (rect === null) return true;
  if (typeof rect !== "object" || rect === undefined) return false;
  const r = rect as Record<string, unknown>;
  return ["x", "y", "width", "height"].every((k) => typeof r[k] === "number" && Number.isFinite(r[k]));
}

/** The images an attachment sends as image content; any other file goes by its path. */
const imageTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

/** What an image may be as sent: its size, and its long side (larger ones are scaled down, as providers would anyway). */
const maxImageBytes = 5 * 1024 * 1024;
const maxImageSide = 2048;

/** The local application FinxWork can connect (finx-connections' QwenWork adapter looks for it here too). */
const sourceApps: Record<string, string> = { qwenwork: "/Applications/QwenWorkCN.app", qoder: "/Applications/Qoder.app" };
function sourceApplication(adapter: unknown): string {
  if (typeof adapter !== "string" || !Object.hasOwn(sourceApps, adapter)) throw new Error("Unknown source application");
  return sourceApps[adapter];
}

/**
 * An image as the model gets it: as it is when small enough, else scaled
 * to fit maxImageSide and sent as JPEG. Null when it can't be read as one
 * (it then goes by its path, like any file).
 */
async function readImage(p: string, mime: string, bytes: number): Promise<{ mime_type: string; data: string } | null> {
  const img = nativeImage.createFromPath(p);
  if (img.isEmpty()) return bytes <= maxImageBytes ? { mime_type: mime, data: (await fs.promises.readFile(p)).toString("base64") } : null;
  const { width, height } = img.getSize();
  if (bytes <= maxImageBytes && Math.max(width, height) <= maxImageSide) return { mime_type: mime, data: (await fs.promises.readFile(p)).toString("base64") };
  const fit = Math.max(width, height) > maxImageSide ? img.resize(width >= height ? { width: maxImageSide, quality: "best" } : { height: maxImageSide, quality: "best" }) : img;
  return { mime_type: "image/jpeg", data: fit.toJPEG(88).toString("base64") };
}

/** A path the page may reveal: the person's own files, never the app's. */
function revealable(p: unknown): p is string {
  return typeof p === "string" && path.isAbsolute(p.replace(/^~(?=$|\/)/, os.homedir()));
}

/** A folder the page may open, in the file manager or a terminal: an existing one, by its absolute path. */
function folder(p: unknown): p is string {
  return typeof p === "string" && path.isAbsolute(p) && fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
}

export function registerIPC() {
  ipcMain.handle("open-source-app", async (e, adapter: unknown = "qwenwork") => {
    if (!trusted(e)) return;
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => execFile("/usr/bin/open", ["-a", sourceApplication(adapter)], err => err ? reject(new Error("Cannot open source application")) : resolve()));
  });
  // Its icon from the installed app (Quick Look draws it, whatever the bundle keeps it in): no copy of it ships with FinxWork.
  ipcMain.handle("source-app-icon", async (e, adapter: unknown = "qwenwork") => {
    if (!trusted(e)) return null;
    const sourceApp = sourceApplication(adapter);
    if (!fs.existsSync(sourceApp)) return null;
    try {
      const icon = await nativeImage.createThumbnailFromPath(sourceApp, { width: 128, height: 128 });
      return icon.isEmpty() ? null : icon.toDataURL();
    } catch {
      return null;
    }
  });
  ipcMain.on("connect-kernel", (e) => trusted(e) && connectKernel(e.sender));
  ipcMain.on("browser-panel", (e, panel: unknown) => trusted(e) && browserPanel(panel) && setPanel(e.sender, panel));
  ipcMain.handle("browser-tabs", (e) => (trusted(e) ? currentTabs() : []));
  ipcMain.on("browser-show", (e, targetId: unknown) => trusted(e) && typeof targetId === "string" && showTab(targetId));
  ipcMain.on("browser-command", (e, targetId: unknown, c: unknown) => trusted(e) && typeof targetId === "string" && tabCommandOk(c) && tabCommand(targetId, c));
  ipcMain.handle("kernel-status", (e) => (trusted(e) ? kernelStatus() : null));
  ipcMain.on("retry-kernel", (e) => trusted(e) && retryKernel());
  ipcMain.on("restart-kernel", (e, now: unknown) => trusted(e) && restartKernel(now === true));
  ipcMain.on("open-settings", (e, page?: string) => trusted(e) && showSettings(typeof page === "string" ? page : undefined));
  ipcMain.handle("settings-open", (e) => trusted(e) && settingsVisible());
  ipcMain.on("relaunch", (e) => {
    if (!trusted(e)) return;
    app.relaunch();
    app.quit();
  });
  ipcMain.on("open-external", (e, url: string) => {
    if (!trusted(e) || typeof url !== "string") return;
    // https, or plain http on this machine (a sign-in served by a local server).
    const loopback = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(url);
    if (!(url.startsWith("https://") || loopback)) return;
    // Tests play the browser themselves.
    if (process.env.FINXWORK_NO_BROWSER) return;
    shell.openExternal(url);
  });
  ipcMain.on("reveal-path", (e, p: unknown) => {
    if (trusted(e) && revealable(p)) shell.showItemInFolder(p.replace(/^~(?=$|\/)/, os.homedir()));
  });
  ipcMain.on("open-folder", (e, p: unknown) => {
    if (trusted(e) && folder(p)) void shell.openPath(p);
  });
  ipcMain.on("open-terminal", (e, p: unknown) => trusted(e) && folder(p) && platform.openTerminal(p));
  ipcMain.handle("git-branch", (e, p: unknown) => (trusted(e) && typeof p === "string" && path.isAbsolute(p) ? gitBranch(p) : null));
  ipcMain.on("show-about", (e) => trusted(e) && app.showAboutPanel());
  ipcMain.on("menu-state", (e, s: MenuState) => {
    if (!trusted(e) || BrowserWindow.fromWebContents(e.sender) !== mainWindow()) return;
    // A closed window's page shows nothing any more.
    if (!reporting.has(e.sender)) {
      reporting.add(e.sender);
      e.sender.once("destroyed", () => {
        menuState = noMenuState;
        menuStateListeners.forEach((f) => f());
      });
    }
    menuState = s;
    if (s.main && pending) {
      e.sender.send("command", pending);
      pending = undefined;
    }
    menuStateListeners.forEach((f) => f());
  });
  ipcMain.handle("pick-directory", async (e) => {
    if (!trusted(e)) return null;
    const win = BrowserWindow.fromWebContents(e.sender);
    const options = { properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[] };
    const r = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options));
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  // A skill to upload (自定义 › 上传技能): its folder, or an archive or a SKILL.md; finx reads it.
  ipcMain.handle("pick-skill-source", async (e) => {
    if (!trusted(e)) return null;
    const win = BrowserWindow.fromWebContents(e.sender);
    const options = {
      properties: ["openFile", "openDirectory"] as ("openFile" | "openDirectory")[],
      filters: [{ name: i18n.t("main:dialog.skillSource"), extensions: ["zip", "skill", "md"] }],
    };
    const r = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options));
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  // Files to attach, chosen in the system's dialog: only what the person picked there is read.
  ipcMain.handle("pick-files", async (e): Promise<PickedFile[]> => {
    if (!trusted(e)) return [];
    const win = BrowserWindow.fromWebContents(e.sender);
    const options = { properties: ["openFile", "multiSelections"] as ("openFile" | "multiSelections")[] };
    const r = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options));
    if (r.canceled) return [];
    return Promise.all(
      r.filePaths.map(async (p): Promise<PickedFile> => {
        const name = path.basename(p);
        const mime = imageTypes[path.extname(p).toLowerCase()];
        const image = mime ? await readImage(p, mime, (await fs.promises.stat(p)).size).catch(() => null) : null;
        return image ? { kind: "image", path: p, name, ...image } : { kind: "file", path: p, name };
      }),
    );
  });
  ipcMain.handle("popup-menu", (e, items: MenuItem[]) => {
    if (!trusted(e) || !Array.isArray(items)) return null;
    return new Promise<string | null>((resolve) => {
      let chosen: string | null = null;
      const menu = Menu.buildFromTemplate(
        items.map((it) =>
          "separator" in it
            ? { type: "separator" as const }
            : {
                label: String(it.label),
                enabled: it.enabled !== false,
                type: it.checked === undefined ? ("normal" as const) : ("checkbox" as const),
                checked: it.checked,
                click: () => (chosen = it.id),
              },
        ),
      );
      menu.popup({ window: BrowserWindow.fromWebContents(e.sender) ?? undefined, callback: () => setTimeout(() => resolve(chosen)) });
    });
  });
  ipcMain.handle("preferences", (e) => (trusted(e) ? preferences() : null));
  ipcMain.handle("set-preferences", (e, p: Partial<Preferences>) => (trusted(e) && typeof p === "object" && p !== null ? setPreferences(p) : null));
  ipcMain.handle("update-info", (e) => (trusted(e) ? updateInfo() : null));
  ipcMain.on("check-updates", (e) => trusted(e) && void check());
  ipcMain.on("download-update", (e) => trusted(e) && download());
  ipcMain.on("install-update", (e) => trusted(e) && install());
  ipcMain.on("snooze-update", (e) => trusted(e) && snooze());
  ipcMain.handle("set-auto-download", (e, on: unknown) => (trusted(e) ? setAutoDownload(on === true) : null));
}
