import { app, BrowserWindow, shell } from "electron";
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
    minWidth: 980,
    minHeight: 620,
    show: false,
    title: "FinxWork",
    ...platform.chrome("main"),
    webPreferences: webPreferences(),
  });
  secure(main);
  main.once("ready-to-show", () => main?.show());
  main.on("closed", () => (main = undefined));
  main.loadURL(page());
  return main;
}

export function settingsVisible(): boolean {
  return !!settings && !settings.isDestroyed() && settings.isVisible();
}

/** The settings window, laid out as System Settings, on a page. */
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
  settings.on("closed", () => (settings = undefined));
  settings.loadURL(page(`#settings${page_ ? "/" + page_ : ""}`));
}
