import { useEffect, useRef } from "react";
import { isRunning, needsAttention, stateOf, type ListSession } from "@finx/client";
import type { Command, MenuState } from "../../shared/bridge";
import { archive, copyId, isArchivable, reveal, unarchive } from "./actions";
import { attachEvent } from "./composer/attachments";
import { layoutOf, setCard, setSidebar } from "./layout";
import { keptView } from "./session/useSession";
import { listSections } from "./sidebar/Sidebar";
import { useStore, type Store } from "./store";

// The app menu's commands (main/menu.ts), and what the menus need to know
// about the window. A page outside the app (a browser preview) has no menu:
// the same shortcuts work from the keyboard.

/** Commands a session's page carries out itself (it knows the pending approval). */
export const pageCommand = "finx-page-command";

export function useCommands() {
  const st = useStore();
  const latest = useRef(st);
  latest.current = st;
  useEffect(() => window.finx?.onCommand((c) => run(latest.current, c)), []);
  useEffect(() => {
    if (window.finx) return;
    const keys = (e: KeyboardEvent) => {
      const c = shortcut(e);
      if (!c) return;
      e.preventDefault();
      run(latest.current, c);
    };
    document.addEventListener("keydown", keys);
    return () => document.removeEventListener("keydown", keys);
  }, []);

  const s = selected(st);
  const state: MenuState = {
    main: true,
    session: s
      ? {
          interruptible: isRunning(s) || stateOf(s) === "awaiting_approval",
          approvable: stateOf(s) === "awaiting_approval",
          archivable: isArchivable(s),
          archived: s.archived === true,
          inspector: layoutOf(st).card !== "hidden" && !st.background,
        }
      : null,
    sidebar: layoutOf(st).sidebar !== "hidden",
    undo: st.toast?.undo !== undefined,
  };
  const key = JSON.stringify(state);
  useEffect(() => window.finx?.setMenuState(JSON.parse(key)), [key]);
  useEffect(() => () => window.finx?.setMenuState({ main: false, session: null, sidebar: true, undo: false }), []);
}

function selected(st: Store): ListSession | undefined {
  const sel = st.selection;
  return sel.kind === "session" ? st.sessions.find((s) => s.session_id === sel.id) : undefined;
}

export function run(st: Store, c: Command) {
  const s = selected(st);
  switch (c) {
    case "newSession":
      return st.set({ selection: { kind: "new" }, searching: false });
    case "openProject":
      return openProject(st);
    case "search":
      return st.set({ searching: true });
    case "nextAttention":
      return next(st, needsAttention);
    case "nextActive":
      return next(st, isRunning);
    case "toggleInspector":
      return s && setCard(st, layoutOf(st).card === "hidden" || st.background);
    case "toggleSidebar":
      return setSidebar(st, layoutOf(st).sidebar === "hidden");
    case "approve":
      return s && window.dispatchEvent(new CustomEvent(pageCommand, { detail: "approve" }));
    case "interrupt":
      return s && (isRunning(s) || stateOf(s) === "awaiting_approval") && st.op(s.session_id, { type: "interrupt" });
    case "rename":
      return s && (setSidebar(st, true), st.set({ renaming: s.session_id }));
    case "archive":
      return s && isArchivable(s) && archive(st, s);
    case "unarchive":
      return s?.archived && unarchive(st, s);
    case "copySessionId":
      return s && copyId(st, s);
    case "revealSessionFile":
      return s && reveal(keptView(s.session_id)?.info.session_file);
    case "undo":
      return undo(st);
    case "attachFiles":
    case "attachFolder":
      // To the composer on screen (a session's or a new session's), which keeps what is attached.
      return window.dispatchEvent(new CustomEvent(attachEvent, { detail: c === "attachFolder" ? "folder" : "files" }));
  }
}

/** A new session in a folder picked from the system's dialog. */
async function openProject(st: Store) {
  const dir = await window.finx?.pickDirectory();
  if (dir) st.set({ selection: { kind: "new" }, draft: { ...st.draft, cwd: dir, noProject: false } });
}

/** The session after the selected one (from the top) that matches, in the sidebar's order. */
function next(st: Store, matches: (s: ListSession) => boolean) {
  const list = listSections(st, new Date()).flatMap((x) => x.sessions).filter(matches);
  if (!list.length) return;
  const i = list.findIndex((s) => s.session_id === selected(st)?.session_id);
  st.select(list[(i + 1) % list.length].session_id);
}

/** ⌘Z: the text field's own undo while typing, otherwise what the toast offers to undo. */
function undo(st: Store) {
  const el = document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable)) {
    document.execCommand("undo");
    return;
  }
  const t = st.toast;
  if (!t?.undo) return;
  st.set({ toast: null });
  t.undo();
}

/** The menu's shortcuts, for a page without the menu. */
function shortcut(e: KeyboardEvent): Command | undefined {
  if (!e.metaKey && !e.ctrlKey) return undefined;
  const k = e.key.toLowerCase();
  if (e.altKey) return k === "0" || e.code === "Digit0" ? "toggleInspector" : undefined;
  if (e.ctrlKey && e.metaKey && k === "s") return "toggleSidebar";
  if (e.shiftKey) return k === "o" ? "openProject" : undefined;
  return ({ k: "search", f: "search", n: "newSession", u: "attachFiles", ".": "interrupt", "2": "nextAttention", "3": "nextActive", e: "archive", enter: "approve" } as Record<string, Command>)[k];
}
