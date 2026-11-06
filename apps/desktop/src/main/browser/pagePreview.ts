import { BrowserWindow, session, WebContentsView, type WebContents } from "electron";
import { isPageFile } from "../../shared/pageFile";
import type { PagePreviewEvent, PagePreviewRect } from "../../shared/bridge";
import { pageOfFile } from "../files";

// An HTML file in the preview over the window (bot-mode-design §6.6.1, DD-159): the page in a view
// of its own, placed over the dialog's room. It runs as a page in the built-in browser does, in a
// process of its own and apart from the app, but it is nobody's tab: no agent drives it, it keeps
// nothing, and it goes when the preview does.

/** Not `persist:`, so it lives in memory: a page shown here leaves nothing behind. */
const partition = "finx-page-preview";
let sessionReady = false;

type Preview = { view: WebContentsView; win: BrowserWindow };
const previews = new Map<WebContents, Preview>();
/** The latest ask of each window's page: an open still finding its file gives way to a newer ask, or to a close. */
const asks = new WeakMap<WebContents, number>();
const watched = new WeakSet<WebContents>();

function previewSession() {
  const s = session.fromPartition(partition);
  if (sessionReady) return s;
  sessionReady = true;
  s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  s.setPermissionCheckHandler(() => false);
  s.on("will-download", (_e, item) => item.cancel());
  return s;
}

const rounded = (r: PagePreviewRect) => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) });

const webAddress = (url: string) => /^https?:\/\//i.test(url);

/** Where the page may go in place: another page file. A web address leaves the preview for the session's browser. */
function staysHere(url: string) {
  try {
    const u = new URL(url);
    return u.protocol === "file:" && isPageFile(decodeURIComponent(u.pathname));
  } catch {
    return false;
  }
}

function drop(owner: WebContents) {
  const shown = previews.get(owner);
  if (!shown) return;
  previews.delete(owner);
  if (!shown.win.isDestroyed()) shown.win.contentView.removeChildView(shown.view);
  const wc = shown.view.webContents;
  if (wc.isDestroyed()) return;
  // Keys go back to the app's page, or Esc and the shortcuts would go nowhere.
  if (wc.isFocused() && !owner.isDestroyed()) owner.focus();
  wc.close();
}

/** The window's page says its preview is gone by going itself: closed, or loaded again. */
function watch(owner: WebContents) {
  if (watched.has(owner)) return;
  watched.add(owner);
  owner.once("destroyed", () => drop(owner));
  owner.on("did-navigate", () => closePagePreview(owner));
}

/** Shows an HTML file in the rectangle given, in place of any before it. False when the file is not there. */
export async function openPagePreview(owner: WebContents, file: string, rect: PagePreviewRect): Promise<boolean> {
  const ask = (asks.get(owner) ?? 0) + 1;
  asks.set(owner, ask);
  drop(owner);
  const url = await pageOfFile(file);
  if (!url) return false;
  const win = BrowserWindow.fromWebContents(owner);
  if (!win || asks.get(owner) !== ask) return true;
  watch(owner);
  previewSession();
  const view = new WebContentsView({
    webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, disableDialogs: true },
  });
  // As in any browser: a page without a background of its own is white, and draws dark text.
  view.setBackgroundColor("#ffffff");
  view.setBorderRadius(8);
  const wc = view.webContents;
  const tell = (event: PagePreviewEvent) => void (!owner.isDestroyed() && owner.send("page-preview", event));
  wc.setWindowOpenHandler(({ url: to }) => {
    if (webAddress(to)) tell({ kind: "link", url: to });
    return { action: "deny" };
  });
  wc.on("will-navigate", (e, to) => {
    if (staysHere(to)) return;
    e.preventDefault();
    if (webAddress(to)) tell({ kind: "link", url: to });
  });
  // Once the page has the keys, Esc would never reach the dialog.
  wc.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown" || input.key !== "Escape") return;
    e.preventDefault();
    tell({ kind: "close" });
  });
  previews.set(owner, { view, win });
  win.contentView.addChildView(view);
  view.setBounds(rounded(rect));
  void wc.loadURL(url).catch(() => {});
  return true;
}

export function placePagePreview(owner: WebContents, rect: PagePreviewRect) {
  previews.get(owner)?.view.setBounds(rounded(rect));
}

export function closePagePreview(owner: WebContents) {
  asks.set(owner, (asks.get(owner) ?? 0) + 1);
  drop(owner);
}
