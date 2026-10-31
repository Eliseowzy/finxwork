import { app, BrowserWindow, screen, shell, type Rectangle } from "electron";
import os from "node:os";
import path from "node:path";
import { i18n, language } from "../shared/i18n";
import { kernelKind } from "./kernel";
import { platform } from "./platform";

export const origin = "app://finxwork";
export const devURL = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;

let main: BrowserWindow | undefined;
let settings: BrowserWindow | undefined;

/** Is url one of our own pages (the only pages that may call the main process)? */
export function ours(url: string): boolean {
  return url.startsWith(origin + "/") || (devURL !== undefined && url.startsWith(devURL));
}

function page(hash = ""): string {
  return (devURL ?? `${origin}/index.html`) + hash;
}

function secure(win: BrowserWindow) {
  const wc = win.webContents;
  // Nothing but our own pages, ever; links open in the browser, https only.
  wc.on("will-navigate", (e, url) => {
    if (!ours(url)) e.preventDefault();
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
}

function webPreferences() {
  const arg = (name: string, value: string) => `--finx-${name}=${value}`;
  return {
    preload: path.join(import.meta.dirname, "../preload/index.cjs"),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    spellcheck: false,
    additionalArguments: [
      arg("user", os.userInfo().username),
      arg("home", os.homedir()),
      arg("version", app.getVersion()),
      arg("lang", language()),
      arg("platform", platform.id),
      arg("kernel", kernelKind),
      arg("catalog", app.isPackaged ? path.join(process.resourcesPath, "catalog/skills") : path.join(app.getAppPath(), "resources/catalog/skills")),
    ],
  };
}

export function mainWindow(): BrowserWindow | undefined {
  return main;
}

export function showMain(): BrowserWindow {
  if (main) {
    main.show();
    main.focus();
    return main;
  }
  main = new BrowserWindow({
    width: 1240,
    height: 800,
    // The conversation alone, its margins narrowed; the info card and the sidebar give way before (renderer layout.ts).
    minWidth: 480,
    minHeight: 620,
    show: false,
    title: "FinxWork",
    ...platform.chrome("main"),
    webPreferences: webPreferences(),
  });
  secure(main);
  main.once("ready-to-show", () => main?.show());
  // Settings work as a dialog over the main window: going back to the main window closes them.
  main.on("focus", () => settingsVisible() && settings!.close());
  main.on("closed", () => (main = undefined));
  main.loadURL(page());
  return main;
}

export function settingsVisible(): boolean {
  return !!settings && !settings.isDestroyed() && settings.isVisible();
}

/**
 * Where a window of this size opens: centred on the main window, kept inside
 * the screen the main window is on. Without a visible main window, the
 * system centres it on the screen.
 */
function overMain(width: number, height: number): Partial<Rectangle> {
  if (!main || main.isDestroyed() || !main.isVisible() || main.isMinimized()) return {};
  const b = main.getBounds();
  const area = screen.getDisplayMatching(b).workArea;
  const clamp = (v: number, min: number, max: number) => Math.round(Math.min(Math.max(v, min), Math.max(min, max)));
  return {
    x: clamp(b.x + (b.width - width) / 2, area.x, area.x + area.width - width),
    y: clamp(b.y + (b.height - height) / 2, area.y, area.y + area.height - height),
  };
}

/** Tells the main window whether settings are open: it dims while they are. */
function settingsChanged(open: boolean) {
  if (main && !main.isDestroyed()) main.webContents.send("settings-open", open);
}

/** The settings window, laid out as System Settings, on a page; it opens over the main window, which dims behind it, and closes when the main window is used again. */
export function showSettings(page_?: string) {
  if (settings) {
    if (page_) settings.webContents.send("settings-page", page_);
    settings.show();
    settings.focus();
    return;
  }
  settings = new BrowserWindow({
    width: 820,
    height: 620,
    ...overMain(820, 620),
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: i18n.t("main:settingsWindow"),
    minimizable: false,
    fullscreenable: false,
    ...platform.chrome("settings"),
    webPreferences: webPreferences(),
  });
  secure(settings);
  settings.once("ready-to-show", () => settings?.show());
  settings.on("show", () => settingsChanged(true));
  settings.on("closed", () => {
    settings = undefined;
    settingsChanged(false);
  });
  settings.loadURL(page(`#settings${page_ ? "/" + page_ : ""}`));
}
