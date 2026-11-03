import { randomUUID } from "node:crypto";
import path from "node:path";
import { app, BrowserWindow, ipcMain, session, WebContentsView, type WebContents } from "electron";
import { homeBrowserSession } from "../../shared/bridge";
import type { BrowserPanel, BrowserTab, BrowserTabCommand } from "../../shared/bridge";
import type { Download, Page, PageEvents, PageHost } from "./shim";
import { browserUserAgent, typedURL } from "./url";
import { chromeOverride, clientHintHeaders, hintsGo } from "./identity";
import { preferences } from "../preferences";
import { allEngines } from "../../shared/search";
import { language } from "../../shared/i18n";
import { webComment, type BrowserComment } from "../../shared/annotations";

// The embedded browser's pages (browser-design §8.3.4): each tab is a WebContentsView with
// its debugger attached, on a partition of its own, apart from the app's pages and from the
// managed browser's profile. A window's page reports where its browser panel is and which
// session it shows; the tab that session shows goes there. Tabs nobody shows wait in a
// hidden window, so they keep painting for snapshots and screenshots. Once the app quits
// nothing waits there any more: tabs close with the windows that show them.

export const partition = "persist:finx-browser";

/** The size of a tab no panel shows. */
const parkedSize = { width: 1280, height: 800 };

type Tab = { targetId: string; finxSession?: string; view: WebContentsView; events: PageEvents; seq: number; annotating?: boolean; managed?: boolean };

const tabs = new Map<string, Tab>();
/** The tab each finx session shows: the one it opened or selected last. */
const shown = new Map<string, string>();
/** Each window's browser panel, as its page reports it. */
const panels = new Map<BrowserWindow, BrowserPanel>();
let parking: BrowserWindow | null = null;
/** The app is quitting: no hidden window is made again, or the app could never finish. */
let quitting = false;
let seq = 0;
let downloadDir: string | null = null;
let reportDownload: ((d: Download) => void) | null = null;
let sessionReady = false;
function annotationState(tab: Tab) {
  return { url: tab.view.webContents.getURL(), enabled: !!tab.annotating, language: language() };
}
function syncAnnotations(tab: Tab) {
  if (!tab.view.webContents.isDestroyed()) tab.view.webContents.send("browser-annotation-state", annotationState(tab));
}
// Only the embedded tab's isolated preload can use this channel. No app bridge is
// exposed to the website, and subframes and requests from a page since left are rejected.
// "chat" hands a part of the page to the composer of the conversation the tab belongs to.
ipcMain.handle("browser-annotation", (event, request: unknown) => {
  const tab = [...tabs.values()].find((t) => t.view.webContents === event.sender);
  if (!tab || event.senderFrame !== event.sender.mainFrame || !request || typeof request !== "object") throw new Error("Invalid annotation source");
  const r = request as Record<string, unknown>;
  const url = event.sender.getURL();
  if (r.url !== url || !/^https?:/.test(url)) throw new Error("Page changed");
  if (r.action === "exit") { tab.annotating = false; broadcast(); }
  else if (r.action === "chat") {
    if (!tab.annotating) throw new Error("Annotation mode is closed");
    if (!tab.finxSession) throw new Error("This tab belongs to no conversation");
    const message: BrowserComment = { session: tab.finxSession, comment: webComment(url, event.sender.getTitle(), r) };
    // The window whose panel shows the tab: its composer is the one in front of the person.
    const win = BrowserWindow.getAllWindows().find((w) => w !== parking && !w.isDestroyed() && w.contentView.children.includes(tab.view));
    if (!win) throw new Error("No window to add the comment to");
    win.webContents.send("browser-comment", message);
  } else if (r.action !== "read") throw new Error("Invalid annotation request");
  return annotationState(tab);
});

function browserSession() {
  const s = session.fromPartition(partition);
  if (sessionReady) return s;
  sessionReady = true;
  // Pages here ask for nothing: no camera, location or notifications.
  s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  // And say so when asked: otherwise a page reads Notification.permission as "granted" while
  // every request is refused, which no real browser does.
  s.setPermissionCheckHandler(() => false);
  // The client hints Chrome sends, which Electron leaves out (identity.ts).
  const hints = clientHintHeaders(process.versions.chrome, process.platform);
  s.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    if (hintsGo(details.url) && !Object.keys(headers).some((h) => h.toLowerCase() === "sec-ch-ua")) Object.assign(headers, hints);
    callback({ requestHeaders: headers });
  });
  // Sites see Chrome, not Electron or the app: some serve a reduced page to browsers they do
  // not know (Google's sign-in, for one, without its images).
  s.setUserAgent(browserUserAgent(s.getUserAgent()));
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

/**
 * The app goes: the tabs no panel shows close, and so does each shown one when its window
 * does. A quit marks it (`before-quit`); an update's install calls it first, as it closes
 * every window before it quits.
 */
export function endBrowser() {
  quitting = true;
  layout();
}
app.on("before-quit", endBrowser);

/** The hidden window tabs wait in: a window of the app's, never the person's. */
export const isParking = (win: BrowserWindow) => win === parking;

function parkingWindow(): BrowserWindow {
  if (parking && !parking.isDestroyed()) return parking;
  parking = new BrowserWindow({ ...parkedSize, show: false, webPreferences: { backgroundThrottling: false } });
  parking.on("closed", () => (parking = null));
  return parking;
}

export const electronPages: PageHost = {
  create({ targetId, url, finxSession }, events): Page {
    // The session first: a tab takes its user agent when it is made.
    const ses = browserSession();
    const view = new WebContentsView({
      webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false,
        preload: path.join(import.meta.dirname, "../preload/browser.cjs") },
    });
    // A page without a background of its own is white, as in any browser, whatever the app's
    // theme: such pages draw dark text. Pages that support a dark scheme follow the app's
    // appearance (prefers-color-scheme), and so does a blank tab.
    view.setBackgroundColor("#ffffff");
    const wc = view.webContents;
    wc.setUserAgent(ses.getUserAgent());
    const tab: Tab = { targetId, finxSession, view, events, seq: ++seq };
    tabs.set(targetId, tab);
    wc.debugger.attach("1.3");
    // Sites see the Chrome this is, the same way in headers and in page scripts (identity.ts).
    void wc.debugger
      .sendCommand("Emulation.setUserAgentOverride", chromeOverride(ses.getUserAgent(), process.versions.chrome, language(), {
        os: process.platform,
        arch: process.arch,
        systemVersion: process.getSystemVersion(),
      }))
      .catch(() => {});
    // A tab acts as if focused even when its window is not (or is hidden): otherwise the
    // first mouse press only focuses it, and a click never reaches the page.
    void wc.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    wc.debugger.on("message", (_e, method: string, params: Record<string, unknown>, sessionId?: string) =>
      tab.events.message(method, params, sessionId || undefined),
    );
    wc.debugger.on("detach", (_e, reason: string) => tab.events.gone(`the browser stopped controlling the tab (${reason})`));
    // A blank tab leaves the panel to the new-tab page, and comes back once it has a page.
    const changed = () => (tab.events.changed(), layout());
    wc.on("page-title-updated", changed);
    wc.on("did-navigate", changed);
    wc.on("did-navigate-in-page", changed);
    wc.on("did-start-loading", broadcast);
    wc.on("did-stop-loading", broadcast);
    wc.on("dom-ready", () => syncAnnotations(tab));
    wc.on("did-navigate-in-page", (_e, _url, mainFrame) => { if (mainFrame) syncAnnotations(tab); });
    wc.on("did-start-navigation", (_e, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) { tab.annotating = false; broadcast(); }
    });
    wc.on("render-process-gone", () => tab.events.gone("the tab crashed"));
    // New windows become tabs the kernel takes over, never windows of their own.
    wc.setWindowOpenHandler(({ url: next }) => {
      tab.events.open(next);
      return { action: "deny" };
    });
    if (finxSession) shown.set(finxSession, targetId);
    void wc.loadURL(url).catch(() => {});
    layout();
    return pageFor(tab);
  },
  pending(finxSession) {
    return [...tabs.values()].filter((t) => t.finxSession === finxSession && !t.managed)
      .sort((a, b) => Number(shown.get(finxSession) === a.targetId) - Number(shown.get(finxSession) === b.targetId))
      .map((t) => t.targetId);
  },
  adopt(targetId, events) {
    const tab = tabs.get(targetId);
    if (!tab || tab.managed) throw new Error("Browser tab is no longer available");
    tab.managed = true;
    tab.events = events;
    return pageFor(tab);
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

function pageFor(tab: Tab): Page {
  const wc = tab.view.webContents;
  return {
    send: (method, params, sessionId) => wc.debugger.sendCommand(method, params, sessionId),
    url: () => wc.isDestroyed() ? "" : wc.getURL(),
    title: () => wc.isDestroyed() ? "" : wc.getTitle(),
    close: () => close(tab.targetId),
  };
}

/** Move only the home browser's tabs into the newly created conversation. */
export function claimHomeBrowser(finxSession: string) {
  const selected = shown.get(homeBrowserSession);
  for (const tab of tabs.values()) {
    if (tab.finxSession !== homeBrowserSession) continue;
    tab.finxSession = finxSession;
  }
  shown.delete(homeBrowserSession);
  if (selected) shown.set(finxSession, selected);
  layout();
  return currentTabs().filter((t) => t.session === finxSession);
}

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
  discard(tab);
  layout();
}

/** Takes a tab out of every window and closes its page. */
function discard(tab: Tab) {
  tabs.delete(tab.targetId);
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.contentView.removeChildView(tab.view);
  const wc = tab.view.webContents;
  if (!wc.isDestroyed()) {
    if (wc.debugger.isAttached()) wc.debugger.detach();
    wc.close();
  }
}

/** Puts each tab where it belongs: in a panel that shows its session, or in the hidden window (closed, once the app quits). */
function layout() {
  const placed = new Map<string, { win: BrowserWindow; bounds: Electron.Rectangle }>();
  for (const [win, panel] of panels) {
    if (win.isDestroyed() || !panel.session || !panel.rect) continue;
    const targetId = shown.get(panel.session);
    const tab = targetId ? tabs.get(targetId) : undefined;
    // A blank tab stays out of sight: the panel draws the new-tab page in its room.
    if (targetId && tab && !blankPage(tab.view.webContents.getURL()) && !placed.has(targetId)) placed.set(targetId, { win, bounds: rounded(panel.rect) });
  }
  for (const tab of tabs.values()) {
    const place = placed.get(tab.targetId);
    if (!place && quitting) {
      discard(tab);
      continue;
    }
    const win = place?.win ?? parkingWindow();
    for (const other of BrowserWindow.getAllWindows()) if (other !== win && !other.isDestroyed()) other.contentView.removeChildView(tab.view);
    if (!win.contentView.children.includes(tab.view)) win.contentView.addChildView(tab.view);
    tab.view.setBounds(place?.bounds ?? { x: 0, y: 0, ...parkedSize });
  }
  broadcast();
}

const blankPage = (url: string) => url === "" || url === "about:blank";

const rounded = (r: Electron.Rectangle) => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) });

/** The latest report of each window, so a slow picture does not undo a newer one. */
const reports = new WeakMap<BrowserWindow, number>();

/**
 * A window's page says where its panel is, or that it has none (session null). On `hold` the
 * shown tab steps aside, and first the page gets a picture of it to show in its place.
 */
export async function setPanel(wc: WebContents, panel: BrowserPanel) {
  const win = BrowserWindow.fromWebContents(wc);
  if (!win) return;
  if (!panels.has(win)) win.once("closed", () => (panels.delete(win), layout()));
  const report = (reports.get(win) ?? 0) + 1;
  reports.set(win, report);
  const before = panels.get(win);
  const targetId = panel.session ? shown.get(panel.session) : undefined;
  const tab = targetId ? tabs.get(targetId) : undefined;
  if (panel.hold && panel.session && before?.rect && tab && !tab.view.webContents.isDestroyed()) {
    try {
      const image = await tab.view.webContents.capturePage();
      if (!wc.isDestroyed()) wc.send("browser-still", { session: panel.session, image: image.toDataURL(), width: before.rect.width });
    } catch {
      // No picture: the room shows empty for the moment.
    }
    if (reports.get(win) !== report) return;
  }
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
    case "annotate":
      if (!/^https?:/.test(wc.getURL()) || wc.isLoading()) return;
      tab.annotating = !tab.annotating;
      syncAnnotations(tab);
      broadcast();
      break;
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
      const p = preferences();
      const url = typedURL(c.url, { engines: allEngines(p.searchEngines), engine: p.searchEngine, keyword: c.engine });
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

/** Open the browser the person asked for: the home page's, or a conversation's, with a blank tab when it has none. */
export function openBrowser(finxSession = homeBrowserSession) {
  const existing = currentTabs().find((t) => t.session === finxSession && t.shown);
  if (existing) showTab(existing.targetId);
  else createHomeTab("about:blank", finxSession);
}

function createHomeTab(url: string, owner = homeBrowserSession) {
  const targetId = randomUUID();
  electronPages.create({ targetId, url, finxSession: owner }, {
    message() {},
    changed() {},
    open: (next) => { createHomeTab(next, tabs.get(targetId)?.finxSession ?? owner); },
    gone: () => close(targetId),
  });
}

/** A tab's page, for the panel's menu; none once it is gone. */
export function tabContents(targetId: string): WebContents | undefined {
  const wc = tabs.get(targetId)?.view.webContents;
  return wc && !wc.isDestroyed() ? wc : undefined;
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
      annotating: !!t.annotating,
    }));
}

/** Tells every window's page the tabs there are now. */
function broadcast() {
  const list = currentTabs();
  for (const win of BrowserWindow.getAllWindows()) if (win !== parking && !win.isDestroyed()) win.webContents.send("browser-tabs", list);
}
