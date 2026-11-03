import { useSyncExternalStore } from "react";
import { FileDoc, baseName, type RpcClient } from "@finx/client";
import type { FilesListResult, FilesReadResult } from "@finx/protocol";
import { i18n } from "../../../shared/i18n";
import { errorText, type Store } from "../store";

// The file panel's files (file-panel-design §10), by session: the open tabs with their
// documents, and the folders of the tree. Kept outside the components, so a panel that is
// closed, or a session left for another, finds them as they were. finx is told what to watch
// as tabs and folders come and go, and what it says changed is read again.

/** Lines to bring into view and mark; `seq` grows each time, so the same lines again still move there. */
export type Target = { line: number; endLine?: number; seq: number };

export type Tab = {
  /** Absolute, as finx resolves it. */
  path: string;
  name: string;
  /** Under the session's folder; null outside it. */
  rel: string | null;
  /** How it read; null while it reads. */
  read: FilesReadResult | null;
  /** Why it could not be read. */
  error: string | null;
  /** A text file's document: what is on disk and what is being edited. */
  doc: FileDoc | null;
  /** Markdown and SVG: showing what the file looks like, not its source. */
  preview: boolean;
  target: Target | null;
  /** The editor's own state (CodeMirror's), kept across tab switches; only the editor reads it. */
  editor: unknown;
  scroll: number;
};

/** A folder of the tree: its entries once read. */
export type Dir = { list: FilesListResult | null; error: string | null };

export type SessionFiles = {
  session: string;
  /** The session's folder: the tree's root, and what paths are relative to. */
  cwd: string;
  tabs: Tab[];
  active: string | null;
  /** The tree is shown; null until the panel first shows, which decides by its width. */
  tree: boolean | null;
  expanded: Set<string>;
  dirs: Map<string, Dir>;
  /** Grows with every change, for the components that show it. */
  rev: number;
  /** What finx was last told to watch. */
  watched: string;
};

const t = i18n.getFixedT(null, "session");
const sessions = new Map<string, SessionFiles>();
const listeners = new Map<string, Set<() => void>>();
let rpc: RpcClient | null = null;
let seq = 0;

/** The connection to finx the panel talks over; after a new one, what is watched is told again. */
export function setFilesConnection(next: RpcClient | null) {
  if (next === rpc) return;
  rpc = next;
  for (const s of sessions.values()) {
    s.watched = "";
    watchSoon(s);
  }
}

function changed(s: SessionFiles) {
  s.rev++;
  listeners.get(s.session)?.forEach((f) => f());
  watchSoon(s);
}

export function filesOf(session: string, cwd: string): SessionFiles {
  let s = sessions.get(session);
  if (!s) {
    s = { session, cwd, tabs: [], active: null, tree: null, expanded: new Set([cwd]), dirs: new Map(), rev: 0, watched: "" };
    sessions.set(session, s);
  }
  return s;
}

/** A session's files, the component drawn again as they change. */
export function useFiles(session: string, cwd: string): SessionFiles {
  const s = filesOf(session, cwd);
  useSyncExternalStore(
    (f) => {
      let set = listeners.get(session);
      if (!set) listeners.set(session, (set = new Set()));
      set.add(f);
      return () => void set.delete(f);
    },
    () => s.rev,
  );
  return s;
}

const sep = (path: string) => (path.includes("\\") && !path.includes("/") ? "\\" : "/");
export const joinPath = (dir: string, name: string) => (dir.endsWith(sep(dir)) ? dir + name : dir + sep(dir) + name);
const parentOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))) || path;
const under = (dir: string, path: string) => path.startsWith(dir + sep(dir));
export const relativeTo = (dir: string, path: string) => (under(dir, path) ? path.slice(dir.length + 1) : null);

// ── tabs ──

/** Opens a file in the panel (or brings its tab forward), at the lines given; the tree shows where it is. */
export function openFile(s: SessionFiles, path: string, at?: { line?: number; endLine?: number }) {
  let tab = s.tabs.find((x) => x.path === path);
  if (!tab) {
    tab = { path, name: baseName(path), rel: relativeTo(s.cwd, path), read: null, error: null, doc: null, preview: /\.(md|markdown|svg)$/i.test(path), target: null, editor: null, scroll: 0 };
    s.tabs.push(tab);
    void load(s, tab);
  }
  s.active = path;
  if (at?.line) tab.target = { line: at.line, endLine: at.endLine, seq: ++seq };
  reveal(s, parentOf(path));
  changed(s);
}

/** Reads a tab's file (again): a document's disk version moves on, or the edits wait for a choice. */
async function load(s: SessionFiles, tab: Tab) {
  if (!rpc) return;
  try {
    const read = await rpc.request("files/read", { session_id: s.session, path: tab.path });
    tab.read = read;
    tab.error = null;
    if (read.kind === "text" && read.text !== undefined && read.text !== null && read.hash) {
      const version = { text: read.text, hash: read.hash };
      if (tab.doc) tab.doc.diskChanged(version);
      else tab.doc = new FileDoc(version, { write: (text, base) => write(s, tab, text, base), changed: () => changed(s) });
    }
  } catch (e) {
    tab.error = errorText(e);
    tab.doc?.diskChanged(null);
  }
  changed(s);
}

async function write(s: SessionFiles, tab: Tab, text: string, base: string | null) {
  if (!rpc) throw new Error(t("files.offline"));
  const r = await rpc.request("files/write", { session_id: s.session, path: tab.path, text, ...(base ? { base_hash: base } : {}) });
  return { status: r.status, hash: r.hash ?? null, message: r.message ?? null };
}

export function activate(s: SessionFiles, path: string) {
  if (s.active === path) return;
  s.active = path;
  changed(s);
}

/** Closes a tab, saving it first; one with a choice still to make stays, and says so. */
export async function closeTab(st: Store, s: SessionFiles, path: string) {
  const tab = s.tabs.find((x) => x.path === path);
  if (!tab) return;
  await tab.doc?.flush();
  if (tab.doc?.dirty) {
    s.active = path;
    changed(s);
    st.show(t("files.unsavedClose", { name: tab.name }), undefined, true);
    return;
  }
  const i = s.tabs.indexOf(tab);
  s.tabs.splice(i, 1);
  if (s.active === path) s.active = (s.tabs[i] ?? s.tabs[i - 1])?.path ?? null;
  changed(s);
}

/** Saves what every open file of every session has not saved yet (the window hides, the panel goes). */
export function flushAll(s?: SessionFiles): Promise<void> {
  const all = s ? [s] : [...sessions.values()];
  return Promise.all(all.flatMap((x) => x.tabs.map((tab) => tab.doc?.flush()))).then(() => {});
}

/** "Load the disk's version": the edits are dropped for what is there now. */
export async function takeDisk(s: SessionFiles, tab: Tab) {
  if (!rpc || !tab.doc) return;
  try {
    const read = await rpc.request("files/read", { session_id: s.session, path: tab.path });
    tab.read = read;
    if (read.kind === "text" && read.text !== undefined && read.text !== null && read.hash) tab.doc.takeDisk({ text: read.text, hash: read.hash });
  } catch (e) {
    tab.error = errorText(e);
  }
  changed(s);
}

export function setPreview(s: SessionFiles, tab: Tab, preview: boolean) {
  tab.preview = preview;
  changed(s);
}

// ── the tree ──

export function setTree(s: SessionFiles, shown: boolean) {
  s.tree = shown;
  if (shown) void listDir(s, s.cwd);
  changed(s);
}

/** Reads a folder's entries; read before, they show until the new ones come. */
export async function listDir(s: SessionFiles, dir: string, again = false) {
  const had = s.dirs.get(dir);
  if (had && !again) return;
  if (!had) s.dirs.set(dir, { list: null, error: null });
  if (!rpc) return;
  try {
    const list = await rpc.request("files/list", { session_id: s.session, path: dir });
    s.dirs.set(dir, { list, error: null });
  } catch (e) {
    s.dirs.set(dir, { list: null, error: errorText(e) });
  }
  changed(s);
}

export function toggleDir(s: SessionFiles, dir: string) {
  if (s.expanded.has(dir)) s.expanded.delete(dir);
  else {
    s.expanded.add(dir);
    void listDir(s, dir);
  }
  changed(s);
}

/** Opens the folders down to `dir` (in the session's folder), so the tree shows it. */
function reveal(s: SessionFiles, dir: string) {
  if (dir !== s.cwd && !under(s.cwd, dir)) return;
  for (let d = dir; d === s.cwd || under(s.cwd, d); d = parentOf(d)) {
    s.expanded.add(d);
    void listDir(s, d);
    if (d === s.cwd) break;
  }
}

// ── what changes on disk ──

const watchTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Tells finx, after the moment's changes, what this session's panel shows: its tabs and open folders. */
function watchSoon(s: SessionFiles) {
  clearTimeout(watchTimers.get(s.session));
  watchTimers.set(
    s.session,
    setTimeout(() => {
      const paths = [...s.tabs.map((x) => x.path), ...[...s.expanded].filter((d) => s.dirs.get(d)?.list)].sort();
      const key = JSON.stringify(paths);
      if (!rpc || key === s.watched) return;
      s.watched = key;
      rpc.request("files/watch", { session_id: s.session, paths }).catch(() => (s.watched = ""));
    }, 150),
  );
}

/** finx says these changed: open files are read again, open folders listed again. */
export function filesChanged(session: string, paths: string[]) {
  const s = sessions.get(session);
  if (!s) return;
  for (const path of paths) {
    const tab = s.tabs.find((x) => x.path === path);
    if (tab) void load(s, tab);
    if (s.dirs.has(path)) void listDir(s, path, true);
  }
}

/** The window came back: the file in front is read again, for a change that was missed. */
export function recheckActive() {
  for (const s of sessions.values()) {
    const tab = s.tabs.find((x) => x.path === s.active);
    if (tab && !tab.doc?.dirty) void load(s, tab);
  }
}

// ── from the conversation ──

/** A file a reply or a step points at, opened in the session's panel at its lines (DD-91). */
export function showFile(st: Store, session: string, cwd: string, path: string, at?: { line?: number; endLine?: number }) {
  openFile(filesOf(session, cwd), path, at);
  st.set({ files: true, browser: false, background: false });
}

/** A folder in the session's folder: the panel, its tree open down to it. */
export function showFolder(st: Store, session: string, cwd: string, dir: string) {
  const s = filesOf(session, cwd);
  s.tree = true;
  reveal(s, dir);
  s.expanded.add(dir);
  void listDir(s, dir);
  changed(s);
  st.set({ files: true, browser: false, background: false });
}

/** Whether a folder is the session's or in it (shown in the panel's tree, not the file manager). */
export const inSession = (cwd: string, path: string) => path === cwd || under(cwd, path);
