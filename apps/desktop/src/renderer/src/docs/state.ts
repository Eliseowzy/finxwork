import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import { RpcError, type DocQuote, type RpcClient } from "@finx/client";
import type { Anchor, DocInfo } from "@finx/protocol";
import { docAttachment } from "../composer/attachments";
import { toComposer } from "../composer/inbox";

// The document column of each session (document-editor-design §7.1): which documents it
// opened, which one shows and on which page. That is the session's view; the document itself
// is the file's, the same in every session, and kept by finx.

/** `password`: an encrypted document's, from finx, for pdf.js; in memory only (§9.4.3). */
export type DocTab = { info: DocInfo; token: string; page: number; password?: string };

/** A document that needs its password before it opens: what was asked for, and whether a password was refused. */
export type Locked = { what: { path: string } | { doc_id: string }; name: string; anchor?: Anchor; wrong: boolean };

/** Where to go in a document, and what to light up there; `seq` tells two jumps to the same place apart. */
export type Jump = { doc_id: string; anchor: Anchor; seq: number };

export type SessionDocs = { tabs: DocTab[]; current: string | null; shown: boolean; jump: Jump | null; locked: Locked | null };

const empty: SessionDocs = { tabs: [], current: null, shown: false, jump: null, locked: null };
const all = new Map<string, SessionDocs>();
const listeners = new Set<() => void>();
let seq = 0;

function set(session: string, next: SessionDocs) {
  all.set(session, next);
  listeners.forEach((l) => l());
}

export function docsOf(session: string): SessionDocs {
  return all.get(session) ?? empty;
}

export function useSessionDocs(session: string): SessionDocs {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => docsOf(session),
  );
}

export function currentTab(d: SessionDocs): DocTab | undefined {
  return d.tabs.find((t) => t.info.doc_id === d.current);
}

/**
 * Opens a document in a session's column (or shows it again), and goes to `anchor` in it. An
 * encrypted one finx cannot open without its password shows the password field instead, and
 * this resolves to null.
 */
/** quiet: only adds the document's tab (what the agent opened); the column neither shows nor switches, nor asks for a password. */
export async function openDoc(rpc: RpcClient, session: string, what: { path: string } | { doc_id: string }, anchor?: Anchor, password?: string, quiet = false): Promise<DocTab | null> {
  const known = "doc_id" in what ? docsOf(session).tabs.find((t) => t.info.doc_id === what.doc_id) : undefined;
  let tab = known;
  if (!tab) {
    let r;
    try {
      r = await rpc.request("doc/open", { session_id: session, ...what, password });
    } catch (e) {
      if (!(e instanceof RpcError) || e.kind !== "doc_password") throw e;
      if (quiet) return null;
      const name = "path" in what ? what.path.split(/[\\/]/).pop()! : (docsOf(session).locked?.name ?? "");
      set(session, { ...docsOf(session), shown: true, locked: { what, name, anchor, wrong: password !== undefined } });
      return null;
    }
    const d = docsOf(session);
    tab = d.tabs.find((t) => t.info.doc_id === r.info.doc_id);
    if (tab) tab = { ...tab, info: r.info, token: r.token, password: r.password ?? undefined };
    else tab = { info: r.info, token: r.token, page: 1, password: r.password ?? undefined };
    const tabs = d.tabs.some((t) => t.info.doc_id === tab!.info.doc_id) ? d.tabs.map((t) => (t.info.doc_id === tab!.info.doc_id ? tab! : t)) : [...d.tabs, tab];
    set(session, { ...d, tabs });
  }
  const d = docsOf(session);
  if (quiet) return (set(session, { ...d, current: d.current ?? tab.info.doc_id }), tab);
  set(session, { ...d, current: tab.info.doc_id, shown: true, locked: null, jump: anchor ? { doc_id: tab.info.doc_id, anchor, seq: ++seq } : d.jump });
  return tab;
}

export function showDocs(session: string, shown: boolean) {
  set(session, { ...docsOf(session), shown });
}

/** Switch to an open document, dismissing any password prompt. */
export function switchDoc(session: string, docId: string) {
  set(session, { ...docsOf(session), current: docId, locked: null });
}

/** Close a single document, keeping the nearest remaining tab selected. */
export async function closeDoc(rpc: RpcClient, session: string, docId: string) {
  const d = docsOf(session);
  const index = d.tabs.findIndex((tab) => tab.info.doc_id === docId);
  if (index < 0) return;
  const tabs = d.tabs.filter((tab) => tab.info.doc_id !== docId);
  const current = d.current === docId ? (tabs[Math.min(index, tabs.length - 1)]?.info.doc_id ?? null) : d.current;
  set(session, { ...d, tabs, current, shown: d.shown && (tabs.length > 0 || d.locked !== null), jump: d.jump?.doc_id === docId ? null : d.jump });
  await rpc.request("doc/close", { session_id: session, doc_id: docId }).catch(() => {});
}

/** Close a document whose password has not been supplied. */
export function closeLocked(session: string) {
  const d = docsOf(session);
  set(session, { ...d, locked: null, shown: d.shown && d.tabs.length > 0 });
}

/** The page the column is at, kept for when it comes back. */
export function setPage(session: string, docId: string, page: number) {
  const d = docsOf(session);
  set(session, { ...d, tabs: d.tabs.map((t) => (t.info.doc_id === docId ? { ...t, page } : t)) });
}

export async function closeDocs(rpc: RpcClient, session: string) {
  const d = docsOf(session);
  set(session, { ...empty });
  await Promise.all(d.tabs.map((tab) => rpc.request("doc/close", { session_id: session, doc_id: tab.info.doc_id }).catch(() => {})));
}

/** finx tells a session's clients the agent opened a document: it gets a tab, and the column waits to be opened. */
export function useDocEvents(rpc: RpcClient | null, session: string) {
  useEffect(() => {
    if (!rpc) return;
    return rpc.on("session/event", (p) => {
      if (p.session_id !== session || p.event.type !== "doc_opened") return;
      void openDoc(rpc, session, { path: p.event.info.path }, undefined, undefined, true).catch(() => {});
    });
  }, [rpc, session]);
}

// ---- quotes to the composer ----

/** Puts a quote in the session's composer, a drawn region with its picture (PNG, base64). */
export function quoteToComposer(session: string, quoted: { quote: DocQuote; image?: string }) {
  toComposer(session, [docAttachment(quoted.quote, quoted.image)]);
}

// ---- opening from the conversation ----

/** What a session's conversation opens documents with: file tiles, links, citations. Null outside a session. */
export type DocOpener = {
  session: string;
  /** Opens a document in the column, at `anchor`, or at the block or page `target` (`p12.b3`) names. */
  open: (what: { path: string } | { doc_id: string }, anchor?: Anchor, target?: string) => void;
  /** Where a citation points, for its hover: the file and the anchor; null when it is gone. */
  locate: (docId: string, target: string) => Promise<{ anchor: Anchor; path: string } | null>;
};

export const DocContext = createContext<DocOpener | null>(null);

export function useDocOpener(): DocOpener | null {
  return useContext(DocContext);
}

/** Paths that open in the column rather than in the file manager. */
export function opensAsDoc(path: string): boolean {
  return /\.pdf$/i.test(path);
}

/** A citation link's target: `finxdoc:<doc_id>#p12.b3`. */
export function parseCitation(href: string): { doc_id: string; target: string } | null {
  const m = /^finxdoc:([0-9a-f]{16})(?:#(p\d+(?:\.b\d+)?))?$/.exec(href.trim());
  return m ? { doc_id: m[1], target: m[2] ?? "p1" } : null;
}
