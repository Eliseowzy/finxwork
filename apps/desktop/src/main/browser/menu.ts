import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, clipboard, dialog, session, shell, type WebContents } from "electron";
import type { BrowserMenuAction, BrowserMenuState, BrowserViewport } from "../../shared/bridge";
import { i18n } from "../../shared/i18n";
import { preferences, setPreferences } from "../preferences";
import { partition, tabContents } from "./pages";

// What the browser panel's ⋯ menu does: the shown tab's page elsewhere, its address, a picture
// of it, the size it lays out at, and what the embedded browser keeps of the sites. The page
// draws the menu (session/BrowserMenu.tsx); the tab steps aside meanwhile.

const t = (key: string, options?: Record<string, unknown>): string => (i18n.t as (k: string, o?: Record<string, unknown>) => string)(`main:browserMenu.${key}`, options);

/** The sizes a tab may lay out at; "responsive" follows the panel. */
const viewports: Record<BrowserViewport, { width: number; height: number } | null> = { responsive: null, mobile: { width: 375, height: 812 }, tablet: { width: 768, height: 1024 } };
type Viewport = BrowserViewport;
const viewportOf = new Map<string, Viewport>();

/** The browser that opens https links on this machine, by name, when the system says. */
export function defaultBrowser(): string | null {
  try {
    const name = app.getApplicationNameForProtocol("https://").replace(/\.app$/, "").trim();
    return name || null;
  } catch {
    return null;
  }
}

function setViewport(targetId: string, wc: WebContents, v: Viewport) {
  const size = viewports[v];
  viewportOf.set(targetId, v);
  wc.once("destroyed", () => viewportOf.delete(targetId));
  const sent = size
    ? wc.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 0, mobile: true })
    : wc.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
  void sent.catch(() => {});
}

async function saveScreenshot(win: BrowserWindow | null, wc: WebContents) {
  const image = await wc.capturePage();
  const host = (() => {
    try {
      return new URL(wc.getURL()).host;
    } catch {
      return "";
    }
  })();
  const name = `${host || "page"}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`;
  const options = { defaultPath: path.join(app.getPath("downloads"), name), filters: [{ name: "PNG", extensions: ["png"] }] };
  const r = await (win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options));
  if (!r.canceled && r.filePath) await fs.promises.writeFile(r.filePath, image.toPNG());
}

/** Everything the sites left: cookies, storage, cache. */
async function forgetSites() {
  const s = session.fromPartition(partition);
  await Promise.all([s.clearStorageData(), s.clearCache(), s.clearAuthCache()]);
}

/** At start, when cookies are kept only until quit: what the last run left goes. */
export function forgetSitesOnStart() {
  if (preferences().browserCookies === "untilQuit") void forgetSites().catch(() => {});
}

async function confirmForget(win: BrowserWindow | null) {
  const options = {
    type: "warning" as const,
    message: t("clearConfirm"),
    detail: t("clearDetail"),
    buttons: [t("clear"), t("cancel")],
    defaultId: 1,
    cancelId: 1,
  };
  const r = await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
  if (r.response === 0) await forgetSites();
}

/** What the panel's menu shows for a tab: where its page may open, and the choices in effect. */
export function tabMenuState(targetId: string | null): BrowserMenuState {
  const wc = targetId ? tabContents(targetId) : undefined;
  return {
    browser: defaultBrowser(),
    web: /^https?:/.test(wc?.getURL() ?? ""),
    viewport: (targetId && viewportOf.get(targetId)) || "responsive",
    cookies: preferences().browserCookies === "untilQuit" ? "untilQuit" : "always",
  };
}

/** What the person picked in the panel's menu. */
export function tabMenuAction(sender: WebContents, targetId: string | null, a: BrowserMenuAction) {
  const win = BrowserWindow.fromWebContents(sender);
  const wc = targetId ? tabContents(targetId) : undefined;
  const url = wc?.getURL() ?? "";
  const web = /^https?:/.test(url);
  switch (a.action) {
    case "open":
      if (web) void shell.openExternal(url);
      break;
    case "copy":
      if (web) clipboard.writeText(url);
      break;
    case "screenshot":
      if (web && wc) void saveScreenshot(win, wc).catch(() => {});
      break;
    case "viewport":
      if (targetId && wc && a.viewport in viewports) setViewport(targetId, wc, a.viewport);
      break;
    case "cookies":
      setPreferences({ browserCookies: a.cookies === "untilQuit" ? "untilQuit" : undefined });
      break;
    case "clear":
      void confirmForget(win).catch(() => {});
      break;
  }
}
