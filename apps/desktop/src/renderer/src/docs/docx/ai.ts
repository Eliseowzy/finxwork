// The in-document AI's plumbing (word-design §5.2). A request is a turn of the conversation the
// document belongs to: it goes through the session's own `prompt`, with its model, permissions,
// history and stop; nothing here calls a model. The editor sits in a React root of its own, so
// the app hands over what it needs (setWordAiHost); requests and their revisions are kept here
// per document for the editor's overlay to show.
import type { RpcClient } from "@finx/client";
import type { Op, UserContent } from "@finx/protocol";
import { onWordHandles, wordHandleOf } from "./handle.ts";
import { requestEvent, requestLive, requestSent, requestStarted, type RequestState, type RevisionId } from "./aiPrompt.ts";

export type WordAiHost = {
  rpc: RpcClient;
  op: (session: string, op: Op) => Promise<boolean>;
  /** Whether the session runs a task now: a request then steers it. */
  live: (session: string) => boolean;
};

let host: WordAiHost | null = null;
/** The app's session plumbing, for the editor's root; null when it goes. */
export function setWordAiHost(h: WordAiHost | null) { host = h; }

// docx/review and docx/undo are not in @finx/protocol yet (word-design §4).
type DocxReviewRpc = {
  request(method: "docx/review", params: { session_id: string; docx_id: string; action: "accept" | "reject"; ids?: RevisionId[] }): Promise<unknown>;
  request(method: "docx/undo", params: { session_id: string; docx_id: string; edit: number | string }): Promise<{ revision?: number }>;
};
const review = (rpc: RpcClient) => rpc as unknown as DocxReviewRpc;

/** Accepts or rejects revisions in the kernel's document; with no ids, all of them. The person's own act: it does not go through the model. */
export function reviewRevisions(rpc: RpcClient, session: string, docxId: string, action: "accept" | "reject", ids?: RevisionId[]) {
  return review(rpc).request("docx/review", { session_id: session, docx_id: docxId, action, ...(ids && { ids }) });
}

/** Takes an agent's change back (`docx_edit`'s details.edit). */
export function undoEdit(rpc: RpcClient, session: string, docxId: string, edit: number | string) {
  return review(rpc).request("docx/undo", { session_id: session, docx_id: docxId, edit });
}

// ── requests, per document ──

/** Where a request was made: the selection's paragraphs, and where on screen to show its state. */
export type WordAiRequest = RequestState & { id: number; session: string; docxId: string; path: string; paragraphs0: string[] };

const requests = new Map<string, WordAiRequest>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());
let counter = 0;

/** The latest request made in document `docxId`, while it is shown. */
export const wordRequestOf = (docxId: string) => requests.get(docxId);
export function onWordRequests(f: () => void): () => void {
  listeners.add(f);
  return () => { listeners.delete(f); };
}
/** The request's result has been dealt with (or put away). */
export function dismissWordRequest(docxId: string, id: number) {
  if (requests.get(docxId)?.id !== id) return;
  requests.delete(docxId);
  emit();
}

function update(docxId: string, id: number, f: (r: WordAiRequest) => RequestState) {
  const r = requests.get(docxId);
  if (!r || r.id !== id) return;
  requests.set(docxId, { ...r, ...f(r) });
  emit();
}

/** Sends a request as a turn of `session`'s conversation and follows it to its end. */
export async function sendWordRequest(session: string, docxId: string, path: string, paragraphs: string[], input: UserContent[]): Promise<void> {
  const id = ++counter;
  requests.set(docxId, { ...requestStarted(), id, session, docxId, path, paragraphs0: paragraphs });
  emit();
  const h = host;
  if (!h?.rpc) return update(docxId, id, (r) => requestSent(r, false, "no session"));
  const off = h.rpc.on("session/event", (p) => {
    if (p.session_id !== session) return;
    update(docxId, id, (r) => requestEvent(r, p.event, docxId, path));
    const now = requests.get(docxId);
    if (!now || now.id !== id || !requestLive(now)) off();
  });
  let ok = false;
  let error: string | undefined;
  try {
    ok = await h.op(session, { type: "prompt", input, mode: h.live(session) ? "steer" : undefined });
  } catch (e) { error = e instanceof Error ? e.message : String(e); }
  update(docxId, id, (r) => requestSent(r, ok, error));
  if (!ok) off();
}

/** Stops the turn a request runs in. */
export function stopWordRequest(r: WordAiRequest) {
  void host?.op(r.session, { type: "interrupt" });
}

/** "Accept all" / "reject all" of one request: only its own revisions. */
export async function reviewWordRequest(r: WordAiRequest, action: "accept" | "reject") {
  if (!host?.rpc || !r.revisions.length) return;
  await reviewRevisions(host.rpc, r.session, r.docxId, action, r.revisions);
  dismissWordRequest(r.docxId, r.id);
}

// ── going to a change ──
// A step's "show the change" opens the file; an editor not yet ready takes it once it is.

const wanted = new Map<string, { paragraph?: string; revision?: RevisionId }>();
let following = false;

function go(path: string) {
  const want = wanted.get(path);
  const h = wordHandleOf(path);
  if (!want || !h) return;
  wanted.delete(path);
  const byRevision = want.revision !== undefined && Number.isFinite(Number(want.revision));
  const done = byRevision ? h.editor.scrollToChange(Number(want.revision)) : Promise.resolve(false);
  void done.then((shown) => { if (!shown && want.paragraph) void h.editor.scrollToParagraph(want.paragraph, { highlight: {} }); });
}

/** Shows a change in the editor of `path`: its first revision, else its first paragraph; now, or once the editor is up. */
export function showWordChange(path: string, where: { paragraph?: string; revision?: RevisionId }) {
  wanted.set(path, where);
  if (!following) {
    following = true;
    onWordHandles(() => { for (const p of [...wanted.keys()]) go(p); });
  }
  go(path);
}
