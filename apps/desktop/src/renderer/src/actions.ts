import { displayTitle, stateOf, type ListSession } from "@finx/client";
import { i18n } from "../../shared/i18n";
import type { Store } from "./store";

// What can be done to a session from the list, the menus and its page.

const t = i18n.getFixedT(null, "common");

/** A session can be archived when nothing runs in it. */
export function isArchivable(s: ListSession): boolean {
  const st = stateOf(s);
  return !s.archived && (st === "idle" || st === "failed");
}

export function archive(st: Store, s: ListSession) {
  st.run(() => st.call("session/archive", { session_id: s.session_id })).then((ok) => {
    if (!ok) return;
    if (st.selection.kind === "session" && st.selection.id === s.session_id && !st.archived) st.set({ selection: { kind: "new" } });
    st.show(t("sessionMenu.archived", { title: displayTitle(s) }), () => unarchive(st, s));
  });
}

/** A new title, when it says something and differs from the one shown. */
export function rename(st: Store, s: ListSession, title: string) {
  const v = title.trim();
  if (v && v !== displayTitle(s)) st.run(() => st.call("session/rename", { session_id: s.session_id, title: v }));
}

export function unarchive(st: Store, s: ListSession) {
  st.run(() => st.call("session/unarchive", { session_id: s.session_id }));
}

/** Delete, once confirmed: what goes for good, and that a task in progress is interrupted. */
export function confirmDelete(st: Store, s: ListSession) {
  const title = displayTitle(s);
  st.set({
    sheet: {
      kind: "confirm",
      title: t("sessionMenu.deleteTitle", { title }),
      message: [t("sessionMenu.deleteMessage"), stateOf(s) === "running" || stateOf(s) === "awaiting_approval" ? t("sessionMenu.deleteRunning") : ""].filter(Boolean).join(""),
      button: t("sessionMenu.deleteButton"),
      run: () => {
        // Off its page first: a page attaches again when finx closes the session under it.
        if (st.selection.kind === "session" && st.selection.id === s.session_id) st.set({ selection: { kind: "new" } });
        return st.call("session/delete", { session_id: s.session_id });
      },
      done: t("sessionMenu.deleted", { title }),
    },
  });
}

export function copyId(st: Store, s: ListSession) {
  navigator.clipboard.writeText(s.session_id).then(() => st.show(t("sessionMenu.copiedId")));
}

/** The session's log file in Finder (from the session's info, which the page has once it is open). */
export function reveal(path: string | undefined) {
  if (path) window.finx?.revealPath(path);
}

/** The native context menu of a session row. */
export async function sessionMenu(st: Store, s: ListSession, file?: string) {
  const mac = window.finx?.platform === "mac";
  const id = await window.finx?.popupMenu([
    { id: "open", label: t("sessionMenu.open") },
    { separator: true },
    { id: "rename", label: t("sessionMenu.rename") },
    s.archived ? { id: "unarchive", label: t("sessionMenu.unarchive") } : { id: "archive", label: t("sessionMenu.archive"), enabled: isArchivable(s) },
    { separator: true },
    { id: "copy", label: t("sessionMenu.copyId") },
    { id: "reveal", label: mac ? t("sessionMenu.revealFinder") : t("sessionMenu.reveal"), enabled: !!file },
    { separator: true },
    { id: "delete", label: t("sessionMenu.delete") },
  ]);
  switch (id) {
    case "open":
      return st.select(s.session_id);
    case "rename":
      return st.set({ renaming: s.session_id });
    case "archive":
      return archive(st, s);
    case "unarchive":
      return unarchive(st, s);
    case "copy":
      return copyId(st, s);
    case "reveal":
      return reveal(file);
    case "delete":
      return confirmDelete(st, s);
  }
}
