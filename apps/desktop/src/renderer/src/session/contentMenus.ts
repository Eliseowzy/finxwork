import { baseName, toolOutput, type ToolView } from "@finx/client";
import type { EditorInfo, MenuItem, PathInfo } from "../../../shared/bridge";
import { i18n } from "../../../shared/i18n";
import { isPageFile } from "../../../shared/pageFile";
import type { Store } from "../store";
import { showFile } from "../files/state";
import { recheckFiles, type Scope } from "./scope";

// What a reply's files, links, code blocks and steps do, from a click or their native menus
// (content-actions-design §4–§8). The main process checks again before it acts.

const t = i18n.getFixedT(null, "session");
const mac = () => window.finx?.platform === "mac";

export const copyText = (text: string) => navigator.clipboard.writeText(text);

function copy(st: Store, text: string, said: string) {
  void copyText(text).then(() => st.show(said));
}

let editorsAsked: { at: number; list: Promise<EditorInfo[]> } | undefined;
/** The editors installed here, asked at most once a minute (the main process looks again in the background when asked later). */
export function editorList(): Promise<EditorInfo[]> {
  if (!editorsAsked || Date.now() - editorsAsked.at > 60_000) editorsAsked = { at: Date.now(), list: window.finx?.editors().catch(() => []) ?? Promise.resolve([]) };
  return editorsAsked.list;
}

/** The text selected in the conversation (not in a field), to copy first in any menu there. */
function selection(): string {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return "";
  const at = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
  return at?.closest(".dwrap") && !at.closest("[contenteditable], input, textarea") ? sel.toString() : "";
}

/** A menu with Copy first when text is selected; resolves to what was picked ("copySel" is handled here). */
async function popup(st: Store, items: MenuItem[]): Promise<string | null> {
  const sel = selection();
  const id = await window.finx?.popupMenu(sel ? [{ id: "copySel", label: t("content.copy") }, ...(items.length ? [{ separator: true } as const] : []), ...items] : items);
  if (id === "copySel") copy(st, sel, t("content.copied"));
  return id ?? null;
}

/** Right-click on text selected in the conversation, outside anything with a menu of its own (§7.2). */
export function selectionMenu(st: Store) {
  if (selection()) void popup(st, []);
}

/** Opens a file or folder a reply pointed at, in `app` or the person's way (§4.2), and says what came of it. */
export async function openRef(st: Store, info: PathInfo, line?: number, app?: string) {
  const name = baseName(info.path);
  if (info.kind === null) return st.show(t("content.missing", { name }), undefined, true);
  const r = await window.finx?.openFile(info.path, { line, app });
  if (!r) return;
  if (!r.ok) {
    if (r.reason === "missing") recheckFiles();
    st.show(t(r.reason === "missing" ? "content.missing" : "content.failed", { name }), undefined, true);
  } else if (r.how === "revealed") st.show(t(mac() ? "content.revealed" : "content.revealedOther", { name }));
}

/** Whether a file opens as a page here: an HTML file, with a browser to show it in (none in the web preview). */
export const opensAsPage = (path: string) => !!window.finx && isPageFile(path);

/** An HTML file as the page it is, in the session's browser (DD-156), brought to the front. */
export function showPage(st: Store, session: string, path: string) {
  void st.run(async () => {
    if (await window.finx?.openPageFile(session, path)) return st.set({ browser: true, background: false, files: false, filesMax: false });
    recheckFiles();
    st.show(t("content.missing", { name: baseName(path) }), undefined, true);
  });
}

/** One more way to see a file in the app, in its menu right after Open. */
export type FileView = { label: string; run: () => void };

/** An HTML file's other view, given the one a click takes: its source beside the page, the page beside its source. */
export function otherView(st: Store, session: string, cwd: string, path: string, clickShows: "page" | "source"): FileView | undefined {
  if (!opensAsPage(path)) return undefined;
  return clickShows === "page"
    ? { label: t("content.viewSource"), run: () => showFile(st, session, cwd, path) }
    : { label: t("content.previewInBrowser"), run: () => showPage(st, session, path) };
}

/**
 * A file's or folder's menu (§4.5). `open` opens it in the app: the first item when given (not in
 * the panel itself), with `view` after it. "Open With" is this once: the default app or an
 * editor, at the line where the editor takes one.
 */
export async function fileMenu(st: Store, info: PathInfo, line: number | undefined, open?: () => void, view?: FileView) {
  const copies: MenuItem[] = [{ id: "copyPath", label: t("content.copyPath") }, ...(info.rel ? [{ id: "copyRel", label: t("content.copyRelative") }] : [])];
  let items: MenuItem[];
  if (info.kind === null) items = copies;
  else {
    const editors = await editorList();
    if (info.kind === "folder") {
      const able = editors.filter((e) => e.folders);
      items = [
        ...(open ? [{ id: "open", label: t("files.showInTree") }] : []),
        { id: "openFolder", label: t(mac() ? "content.openFinder" : "content.openFolder") },
        { id: "terminal", label: t("content.openTerminal") },
        ...(able.length ? [{ id: "with", label: t("content.openWith"), submenu: able.map((e) => ({ id: `app:${e.id}`, label: e.name, ...(e.icon && { icon: e.icon }) })) }] : []),
        { separator: true },
        ...copies,
      ];
    } else {
      items = [
        ...(open ? [{ id: "open", label: t("content.open") }] : []),
        ...(view ? [{ id: "view", label: view.label }] : []),
        {
          id: "with",
          label: t("content.openWith"),
          submenu: [
            { id: "app:system", label: t("content.systemApp") },
            ...(editors.length ? [{ separator: true } as const] : []),
            ...editors.map((e) => ({ id: `app:${e.id}`, label: e.name, ...(e.icon && { icon: e.icon }) })),
          ],
        },
        { id: "reveal", label: t(mac() ? "content.revealFinder" : "content.reveal") },
        { separator: true },
        ...copies,
      ];
    }
  }
  const id = await popup(st, items);
  switch (id) {
    case "open":
      return open?.();
    case "view":
      return view?.run();
    case "openFolder":
      return window.finx?.openFolder(info.path);
    case "terminal":
      return window.finx?.openTerminal(info.path);
    case "reveal":
      return window.finx?.revealPath(info.path);
    case "copyPath":
      return copy(st, info.path, t("content.copiedPath"));
    case "copyRel":
      return copy(st, info.rel ?? info.path, t("content.copiedPath"));
  }
  if (id?.startsWith("app:")) return openRef(st, info, line, id.slice(4));
}

/** A web page: in the session's browser panel, else (⌘, or outside a session) the default browser (§5.2). */
export function openLink(st: Store, url: string, scope: Scope, external: boolean) {
  const finx = window.finx;
  if (!finx) return void window.open(url, "_blank", "noreferrer");
  if (external || !scope) return finx.openExternal(url);
  void st.run(async () => {
    await finx.openURL(scope.session, url);
    st.set({ browser: true, background: false, files: false, filesMax: false });
  });
}

/** A link's menu (§5.3). */
export async function linkMenu(st: Store, url: string, scope: Scope) {
  const browser = (await window.finx?.browserMenuState(null).catch(() => null))?.browser;
  const id = await popup(st, [
    ...(scope ? [{ id: "panel", label: t("content.openInPanel") }] : []),
    { id: "external", label: browser ? t("content.openIn", { browser }) : t("content.openInDefault") },
    { separator: true },
    { id: "copy", label: t("content.copyLink") },
  ]);
  if (id === "panel") openLink(st, url, scope, false);
  else if (id === "external") openLink(st, url, scope, true);
  else if (id === "copy") copy(st, url, t("content.copiedLink"));
}

/** A terminal in the session's folder, the command copied to paste there: it runs only when the person runs it (§6.2). */
export function terminalWith(st: Store, scope: NonNullable<Scope>, command: string) {
  void copyText(command).then(() => {
    window.finx?.openTerminal(scope.cwd);
    st.show(t("content.commandCopied"));
  });
}

/** A code block's menu (§6). */
export async function codeMenu(st: Store, text: string, shell: boolean, scope: Scope) {
  const id = await popup(st, [
    { id: "copy", label: t(shell ? "content.copyCommand" : "content.copyCode") },
    ...(shell && scope ? [{ id: "terminal", label: t("content.openTerminal") }] : []),
  ]);
  if (id === "copy") copy(st, text, t("content.copied"));
  else if (id === "terminal" && scope) terminalWith(st, scope, text);
}

/**
 * A step's menu (§7.1): a file's for reading and editing, its command's for a command; none for
 * the others (then false, and the conversation's own menu shows).
 */
export function stepMenu(st: Store, tool: ToolView, scope: Scope): boolean {
  if (!scope) return false;
  const path = tool.args.path;
  if ((tool.category === "read" || tool.category === "edit") && typeof path === "string" && path) {
    const offset = Number(tool.args.offset);
    const line = tool.category === "read" && offset >= 1 ? offset : undefined;
    void window.finx
      ?.pathInfo(scope.cwd, [path])
      .then(([info]) => info && fileMenu(st, info, line, () => showFile(st, scope.session, scope.cwd, info.path, { line }), otherView(st, scope.session, scope.cwd, info.path, "source")));
    return true;
  }
  if (tool.category !== "execute") return false;
  const command = typeof tool.args.command === "string" ? tool.args.command : tool.title;
  const output = toolOutput(tool);
  void popup(st, [
    { id: "copy", label: t("content.copyCommand") },
    ...(output ? [{ id: "output", label: t("content.copyOutput") }] : []),
    { separator: true },
    { id: "terminal", label: t("content.openTerminal") },
  ]).then((id) => {
    if (id === "copy") copy(st, command, t("content.copied"));
    else if (id === "output") copy(st, output, t("content.copied"));
    else if (id === "terminal") terminalWith(st, scope, command);
  });
  return true;
}
