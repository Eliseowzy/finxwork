import { createContext, useContext, useSyncExternalStore } from "react";
import type { DocQuote, RpcClient } from "@finx/client";
import type { Anchor, DocInfo } from "@finx/protocol";
import { docAttachment } from "../composer/attachments";
import { toComposer } from "../composer/inbox";
import { isRpcKind } from "../rpcError";
import { RANGE, splitRef } from "./cellref";

// The documents each session opened (document-editor-design §7.1), shown in its file panel:
// which ones, and on which page. That is the session's view; the document itself
// is the file's, the same in every session, and kept by finx.

/** `password`: an encrypted document's, from finx, for pdf.js; in memory only (§9.4.3). */
export type DocTab = { info: DocInfo; token: string; page: number; password?: string };

/** A workbook selection is a local document anchor until the protocol exposes cell anchors. */
export type CellAnchor = { kind: "cells"; sheet: string; range: string; text?: string };
export type DocAnchor = Anchor | CellAnchor;

/** Where to go in a document, and what to light up there; `seq` tells two jumps to the same place apart. */
export type Jump = { doc_id: string; anchor: DocAnchor; seq: number };

/** Which tab shows a document, and in what order, is the file panel's (files/state). */
export type SessionDocs = { tabs: DocTab[]; jump: Jump | null };

const empty: SessionDocs = { tabs: [], jump: null };
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

export function docTab(session: string, docId: string | null | undefined): DocTab | undefined {
  return docId ? docsOf(session).tabs.find((t) => t.info.doc_id === docId) : undefined;
}

/**
 * Opens a document for a session (or finds it open), and goes to `anchor` in it. An encrypted
 * one finx cannot open without its password resolves to null.
 */
export async function openDoc(rpc: RpcClient, session: string, what: { path: string } | { doc_id: string }, anchor?: DocAnchor, password?: string): Promise<DocTab | null> {
  const known = "doc_id" in what ? docTab(session, what.doc_id) : docsOf(session).tabs.find((t) => t.info.path === what.path);
  let tab = known;
  if (!tab) {
    let r;
    try {
      r = await rpc.request("doc/open", { session_id: session, ...what, password });
    } catch (e) {
      if (isRpcKind(e, "doc_password")) return null;
      throw e;
    }
    const d = docsOf(session);
    const had = d.tabs.find((t) => t.info.doc_id === r.info.doc_id);
    tab = { info: r.info, token: r.token, page: had?.page ?? 1, password: r.password ?? undefined };
    set(session, { ...d, tabs: had ? d.tabs.map((t) => (t === had ? tab! : t)) : [...d.tabs, tab] });
  }
  if (anchor) set(session, { ...docsOf(session), jump: { doc_id: tab.info.doc_id, anchor, seq: ++seq } });
  return tab;
}

/**
 * A workbook's file changed on disk: asked for again without letting go of it, so its view,
 * sheet, selection and undo stay. finx keeps the same document when the change is its own save,
 * or when there are unsaved edits; otherwise it loads the new contents, and the view reads them.
 */
export async function refreshDoc(rpc: RpcClient, session: string, docId: string) {
  const had = docTab(session, docId);
  if (!had) return;
  const r = await rpc.request("doc/open", { session_id: session, path: had.info.path });
  const d = docsOf(session);
  set(session, { ...d, tabs: d.tabs.map((t) => (t.info.doc_id === docId ? { ...t, info: r.info, token: r.token } : t)) });
}

/** A document's tab closed: finx lets go of it for this session. */
export async function closeDoc(rpc: RpcClient | null, session: string, docId: string) {
  const d = docsOf(session);
  set(session, { tabs: d.tabs.filter((tab) => tab.info.doc_id !== docId), jump: d.jump?.doc_id === docId ? null : d.jump });
  await rpc?.request("doc/close", { session_id: session, doc_id: docId }).catch(() => {});
}

/** A password pdf.js needed and finx did not pass on, kept with the tab (in memory only) for when it lays the document out again. */
export function setDocPassword(session: string, docId: string, password: string) {
  const d = docsOf(session);
  set(session, { ...d, tabs: d.tabs.map((t) => (t.info.doc_id === docId ? { ...t, password } : t)) });
}

/** What finx says a document is now: a workbook's revision and unsaved state after an edit, the agent's included. */
export function setDocInfo(session: string, info: DocInfo) {
  const d = docsOf(session);
  if (!d.tabs.some((t) => t.info.doc_id === info.doc_id)) return;
  set(session, { ...d, tabs: d.tabs.map((t) => (t.info.doc_id === info.doc_id ? { ...t, info } : t)) });
}

/** `doc/changed`: a document changed, in this session or another; every session showing it takes the new info. */
export function docChanged(info: DocInfo) {
  for (const session of all.keys()) setDocInfo(session, info);
}

/** The page the document is at, kept for when it comes back. */
export function setPage(session: string, docId: string, page: number) {
  const d = docsOf(session);
  set(session, { ...d, tabs: d.tabs.map((t) => (t.info.doc_id === docId ? { ...t, page } : t)) });
}

// ---- quotes to the composer ----

/** Puts a quote in the session's composer, a drawn region with its picture (PNG, base64). */
export function quoteToComposer(session: string, quoted: { quote: DocQuote; image?: string }) {
  toComposer(session, [docAttachment(quoted.quote, quoted.image)]);
}

export type SheetViewing = { doc_id: string; path: string; sheet: string; range: string; text: string };
const sheetViews = new Map<string, SheetViewing>();

/** The live workbook selection included with the next message from this session. */
export function setSheetViewing(session: string, view: SheetViewing | null, docId?: string) {
  if (view) sheetViews.set(session, view);
  else if (!docId || sheetViews.get(session)?.doc_id === docId) sheetViews.delete(session);
}

export function sheetViewingOf(session: string): SheetViewing | undefined {
  return sheetViews.get(session);
}

// ---- opening from the conversation ----

/** What a session's conversation opens documents with: file tiles, links, citations. Null outside a session. */
export type DocOpener = {
  session: string;
  /** Opens a document in the file panel, at `anchor`, or at the block or page `target` (`p12.b3`) names. */
  open: (what: { path: string } | { doc_id: string }, anchor?: DocAnchor, target?: string) => void;
  /** Where a citation points, for its hover: the file and the anchor; only the file while it wants its password; null when it is gone. */
  locate: (docId: string, target: string) => Promise<{ anchor: DocAnchor; path: string } | { locked: true; path: string } | null>;
};

export const DocContext = createContext<DocOpener | null>(null);

export function useDocOpener(): DocOpener | null {
  return useContext(DocContext);
}

/** The file finx would not open without its password, when it says which (a document asked for by its id). */
export function lockedPath(e: unknown): string | null {
  if (!isRpcKind(e, "doc_password")) return null;
  const path = (e.data as { path?: unknown } | null)?.path;
  return typeof path === "string" ? path : null;
}

/** A citation link's target: `finxdoc:<doc_id>#p12.b3`. */
export function parseCitation(href: string): { doc_id: string; target: string } | null {
  const m = /^finxdoc:([0-9a-f]{16})(?:#(.+))?$/.exec(href.trim());
  if (!m) return null;
  let target = m[2] ?? "p1";
  try { target = decodeURIComponent(target); } catch { /* keep the target as written */ }
  return /^p\d+(?:\.b\d+)?$/.test(target) || cellTarget(target) ? { doc_id: m[1], target } : null;
}

/** A citation's cells, `Sheet!A1:C3`, as a workbook anchor. */
export function cellTarget(target: string): CellAnchor | null {
  const ref = splitRef(target);
  return ref && RANGE.test(ref.cell) ? { kind: "cells", sheet: ref.sheet, range: ref.cell.toUpperCase() } : null;
}
