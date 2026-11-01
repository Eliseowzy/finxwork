import { randomUUID } from "node:crypto";
import path from "node:path";
import { BrowserWindow, session, WebContentsView, type WebContents } from "electron";
import type { BrowserPanel, BrowserTab, BrowserTabCommand } from "../../shared/bridge";
import type { Download, Page, PageEvents, PageHost } from "./shim";
import { typedURL } from "./url";

// The embedded browser's pages (browser-design §8.3.4): each tab is a WebContentsView with
// its debugger attached, on a partition of its own, apart from the app's pages and from the
// managed browser's profile. A window's page reports where its browser panel is and which
// session it shows; the tab that session shows goes there. Tabs nobody shows wait in a
// hidden window, so they keep painting for snapshots and screenshots.

export const partition = "persist:finx-browser";

/** The size of a tab no panel shows. */
const parkedSize = { width: 1280, height: 800 };

type Tab = { targetId: string; finxSession?: string; view: WebContentsView; events: PageEvents; seq: number };

const tabs = new Map<string, Tab>();
/** The tab each finx session shows: the one it opened or selected last. */
const shown = new Map<string, string>();
/** Each window's browser panel, as its page reports it. */
const panels = new Map<BrowserWindow, BrowserPanel>();
let parking: BrowserWindow | null = null;
let seq = 0;
let downloadDir: string | null = null;
let reportDownload: ((d: Download) => void) | null = null;
let sessionReady = false;

function browserSession() {
  const s = session.fromPartition(partition);
  if (sessionReady) return s;
  sessionReady = true;
  // Pages here ask for nothing: no camera, location or notifications.
  s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  s.on("will-download", (_e, item, wc) => {
    const tab = [...tabs.values()].find((t) => t.view.webContents === wc);
    if (!downloadDir || !reportDownload || !tab) return item.cancel();
    const guid = randomUUID();
    const report = reportDownload;
    item.setSavePath(path.join(downloadDir, guid));
    report({ state: "begin", guid, targetId: tab.targetId, url: item.getURL(), suggestedFilename: item.getFilename() });
    item.once("done", (_e, state) => report({ state: state === "completed" ? "completed" : "canceled", guid }));
  });
  return s;
}

function parkingWindow(): BrowserWindow {
  if (parking && !parking.isDestroyed()) return parking;
  parking = new BrowserWindow({ ...parkedSize, show: false, webPreferences: { backgroundThrottling: false } });
  parking.on("closed", () => (parking = null));
  return parking;
}

export const electronPages: PageHost = {
  create({ targetId, url, finxSession }, events): Page {
    const view = new WebContentsView({
      webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false },
    });
    browserSession();
    // A page without a background of its own is white, as in any browser, whatever the app's
    // theme: such pages draw dark text. Pages that support a dark scheme follow the app's
    // appearance (prefers-color-scheme), and so does a blank tab.
    view.setBackgroundColor("#ffffff");
    const wc = view.webContents;
    const tab: Tab = { targetId, finxSession, view, events, seq: ++seq };
    tabs.set(targetId, tab);
    wc.debugger.attach("1.3");
    // A tab acts as if focused even when its window is not (or is hidden): otherwise the
    // first mouse press only focuses it, and a click never reaches the page.
    void wc.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    wc.debugger.on("message", (_e, method: string, params: Record<string, unknown>, sessionId?: string) =>
      events.message(method, params, sessionId || undefined),
    );
    wc.debugger.on("detach", (_e, reason: string) => events.gone(`the browser stopped controlling the tab (${reason})`));
    const changed = () => (events.changed(), broadcast());
    wc.on("page-title-updated", changed);
    wc.on("did-navigate", changed);
    wc.on("did-navigate-in-page", changed);
    wc.on("did-start-loading", broadcast);
    wc.on("did-stop-loading", broadcast);
    wc.on("render-process-gone", () => events.gone("the tab crashed"));
    // New windows become tabs the kernel takes over, never windows of their own.
    wc.setWindowOpenHandler(({ url: next }) => {
      events.open(next);
      return { action: "deny" };
    });
    if (finxSession) shown.set(finxSession, targetId);
    void wc.loadURL(url).catch(() => {});
    layout();
    return {
      send: (method, params, sessionId) => wc.debugger.sendCommand(method, params, sessionId),
      url: () => (wc.isDestroyed() ? "" : wc.getURL()),
      title: () => (wc.isDestroyed() ? "" : wc.getTitle()),
      close: () => close(targetId),
    };
  },
  activate(targetId) {
    const tab = tabs.get(targetId);
    if (tab?.finxSession) shown.set(tab.finxSession, targetId);
    layout();
  },
  downloads(dir, report) {
    downloadDir = dir;
    reportDownload = report;
  },
};

function close(targetId: string) {
  const tab = tabs.get(targetId);
  if (!tab) return;
  tabs.delete(targetId);
  if (tab.finxSession && shown.get(tab.finxSession) === targetId) {
    // The session's newest other tab takes its place.
    const next = [...tabs.values()].filter((t) => t.finxSession === tab.finxSession).sort((a, b) => b.seq - a.seq)[0];
    if (next) shown.set(tab.finxSession, next.targetId);
    else shown.delete(tab.finxSession);
  }
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.contentView.removeChildView(tab.view);
  const wc = tab.view.webContents;
  if (!wc.isDestroyed()) {
    if (wc.debugger.isAttached()) wc.debugger.detach();
    wc.close();
  }
  layout();
}

/** Puts each tab where it belongs: in a panel that shows its session, or in the hidden window. */
function layout() {
  const placed = new Map<string, { win: BrowserWindow; bounds: Electron.Rectangle }>();
  for (const [win, panel] of panels) {
    if (win.isDestroyed() || !panel.session || !panel.rect) continue;
    const targetId = shown.get(panel.session);
    if (targetId && tabs.has(targetId) && !placed.has(targetId)) placed.set(targetId, { win, bounds: rounded(panel.rect) });
  }
  for (const tab of tabs.values()) {
    const place = placed.get(tab.targetId);
    const win = place?.win ?? parkingWindow();
    for (const other of BrowserWindow.getAllWindows()) if (other !== win && !other.isDestroyed()) other.contentView.removeChildView(tab.view);
    if (!win.contentView.children.includes(tab.view)) win.contentView.addChildView(tab.view);
    tab.view.setBounds(place?.bounds ?? { x: 0, y: 0, ...parkedSize });
  }
  broadcast();
}

const rounded = (r: Electron.Rectangle) => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) });

/** A window's page says where its panel is, or that it has none (session null). */
export function setPanel(wc: WebContents, panel: BrowserPanel) {
  const win = BrowserWindow.fromWebContents(wc);
  if (!win) return;
  if (!panels.has(win)) win.once("closed", () => (panels.delete(win), layout()));
  panels.set(win, panel);
  layout();
}

/**
 * The person drives a tab in the panel: they take over, and the agent's next call finds the
 * page changed (browser-design §7.4). What they open still passes the kernel's checks: a
 * refused site is stopped as one a page would open.
 */
export function tabCommand(targetId: string, c: BrowserTabCommand) {
  const tab = tabs.get(targetId);
  if (!tab || tab.view.webContents.isDestroyed()) return;
  const wc = tab.view.webContents;
  switch (c.command) {
    case "back":
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      break;
    case "forward":
      if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
      break;
    case "reload":
      wc.reload();
      break;
    case "stop":
      wc.stop();
      break;
    case "go": {
      const url = typedURL(c.url);
      if (url) void wc.loadURL(url).catch(() => {});
      break;
    }
    case "close":
      tab.events.gone("the user closed the tab");
      break;
    case "new":
      tab.events.open("about:blank", true);
      break;
  }
}

/** The person picked a tab in a panel. */
export function showTab(targetId: string) {
  electronPages.activate(targetId);
}

export function currentTabs(): BrowserTab[] {
  return [...tabs.values()]
    .filter((t) => !t.view.webContents.isDestroyed())
    .sort((a, b) => a.seq - b.seq)
    .map((t) => ({
      targetId: t.targetId,
      session: t.finxSession ?? null,
      url: t.view.webContents.getURL(),
      title: t.view.webContents.getTitle(),
      shown: !!t.finxSession && shown.get(t.finxSession) === t.targetId,
      loading: t.view.webContents.isLoading(),
      canGoBack: t.view.webContents.navigationHistory.canGoBack(),
      canGoForward: t.view.webContents.navigationHistory.canGoForward(),
    }));
}

/** Tells every window's page the tabs there are now. */
function broadcast() {
  const list = currentTabs();
  for (const win of BrowserWindow.getAllWindows()) if (win !== parking && !win.isDestroyed()) win.webContents.send("browser-tabs", list);
}
