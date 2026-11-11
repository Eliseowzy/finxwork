// The Word editor as a replica of the document the kernel holds (word-design §2, §4), as the
// presentation editor is of its deck (pptx/kernel.ts). The kernel's session is the authority and
// the only writer of the file. Local edits apply at once and go to the kernel in order, one
// `docx/sync` at a time; edits made elsewhere (the agent, an undo) arrive as `docx/sync` notices.
// A save waits for every local edit to be acknowledged, then asks the kernel to write
// (`docx/save`): "saved" shows only once the kernel's write landed.
import type { RpcClient } from "@finx/client";
import type { AsyncCollaborationReplica, CollaborationReplica } from "@betteroffice/docx/collaboration";
import { fromBase64, toBase64 } from "../pptx/document.ts";
import { replicaClientId } from "../pptx/kernel.ts";

export type WordKernelState = { dirty: boolean; revision: number; author: string | null };
/** How `docx/export_pdf` writes: pages from 1, inclusive; `markup` shows tracked changes. */
export type WordPdfOptions = { path: string; from_page?: number; to_page?: number; markup?: boolean };
export type WordPdfResult = { path: string; pages: number; total_pages: number; outlined_fonts: string[] };
export type WordWriteResult = { status: "saved" | "conflict" | "refused"; hash?: string | null; message?: string | null };

/** What `docx/open` hands the editor: the file it opened and the kernel's document as a replica state. */
export type WordFile = {
  /** The file's bytes (base64): the editor keeps the source parts the replica state does not carry. */
  data: string;
  hash: string;
  writable: boolean;
  /** Families the document uses, for the system faces to load (as deck/open's). */
  font_families: string[];
  kernel: DocxKernelLink;
  /** The kernel brought back unsaved edits of an earlier run. */
  recoveredDirty: boolean;
};

// docx/* is not in @finx/protocol yet (word-design §4): the methods are typed here until it is.
type DocxOpenResult = { docx_id: string; state: string; source?: string; hash: string; writable: boolean; dirty: boolean; revision: number; font_families?: string[] };
type DocxRpc = {
  request(method: "docx/open", params: { session_id: string; path: string; replica: true; discard?: true }): Promise<DocxOpenResult>;
  request(method: "docx/sync", params: { session_id: string; docx_id: string; update?: string; state_vector?: string }): Promise<{ revision?: number; update?: string }>;
  request(method: "docx/save", params: { session_id: string; docx_id: string; path?: string; force?: boolean }): Promise<WordWriteResult>;
  request(method: "docx/close", params: { session_id: string; docx_id: string }): Promise<unknown>;
  request(method: "docx/export_pdf", params: { session_id: string; docx_id: string } & WordPdfOptions): Promise<WordPdfResult>;
  on(method: "docx/sync", cb: (p: { docx_id: string; update: string }) => void): () => void;
  on(method: "docx/changed", cb: (p: { docx_id: string; revision: number; dirty: boolean; author?: string | null }) => void): () => void;
};
const docxRpc = (rpc: RpcClient) => rpc as unknown as DocxRpc;

/** Opens the file in the kernel as a replica. `discard` drops the kernel's unsaved edits first. */
export async function openKernelWord(rpc: RpcClient, session: string, path: string, discard = false): Promise<WordFile> {
  const r = await docxRpc(rpc).request("docx/open", { session_id: session, path, replica: true, ...(discard ? { discard: true as const } : {}) });
  if (!r.state || !r.source) throw new Error("the kernel sent no replica state");
  const kernel = new DocxKernelLink(rpc, session, r.docx_id, fromBase64(r.state));
  return { data: r.source, hash: r.hash, writable: r.writable, font_families: r.font_families ?? [], kernel, recoveredDirty: r.dirty };
}

/** The editor's replica as an asynchronous one: the worker editor's carries it as `.async`. */
function asAsync(replica: CollaborationReplica): AsyncCollaborationReplica {
  const hosted = (replica as { async?: AsyncCollaborationReplica }).async;
  if (hosted) return hosted;
  return {
    clientId: replica.clientId,
    encodeStateVector: async () => replica.encodeStateVector(),
    encodeStateAsUpdate: async (vector) => replica.encodeStateAsUpdate(vector),
    applyUpdate: async (update) => replica.applyUpdate(update),
    onUpdate: (listener) => replica.onUpdate(listener),
  };
}

export class DocxKernelLink {
  readonly clientId = replicaClientId();
  private replica: AsyncCollaborationReplica | null = null;
  private queue: Uint8Array[] = [];
  private sending: Promise<void> | null = null;
  /** A sync failed: the kernel may lack some of ours, so the next one sends the whole state. */
  private resync = false;
  private stops: (() => void)[] = [];
  private failure: Error | null = null;
  private closed = false;
  /** Local edits the editor has not yet counted as its own (see `local()`). */
  private unseen = 0;
  private stateListeners = new Set<(state: WordKernelState) => void>();

  private rpc: DocxRpc;
  readonly session: string;
  readonly docxId: string;
  readonly initialState: Uint8Array;

  constructor(rpc: RpcClient, session: string, docxId: string, initialState: Uint8Array) {
    this.rpc = docxRpc(rpc);
    this.session = session;
    this.docxId = docxId;
    this.initialState = initialState;
    this.stops.push(this.rpc.on("docx/sync", (notice) => {
      if (notice.docx_id !== this.docxId || !this.replica) return;
      void this.replica.applyUpdate(fromBase64(notice.update)).catch(() => { this.resync = true; });
    }));
    this.stops.push(this.rpc.on("docx/changed", (notice) => {
      if (notice.docx_id !== this.docxId || this.closed) return;
      const state = { dirty: notice.dirty, revision: notice.revision, author: notice.author ?? null };
      for (const f of this.stateListeners) f(state);
    }));
  }

  /** The kernel's own view of the file: unsaved edits made elsewhere, and saves made elsewhere (docx_save). */
  onState(f: (state: WordKernelState) => void): () => void {
    this.stateListeners.add(f);
    return () => { this.stateListeners.delete(f); };
  }

  /** Local edits not yet acknowledged by the kernel. */
  get pending(): boolean { return this.queue.length > 0 || this.unseen > 0; }

  /** The editor's replica is ready (or gone, with null). */
  attach(replica: CollaborationReplica | null) {
    for (const stop of this.stops.splice(2)) stop();
    this.replica = replica && asAsync(replica);
    if (!this.replica) return;
    this.stops.push(this.replica.onUpdate((update, origin) => {
      if (origin !== "local" || this.closed) return;
      this.unseen++;
      this.queue.push(update.slice());
      void this.pump();
    }));
    // Whatever the kernel has that the replica lacks: nothing after a fresh open.
    void this.pullMissing();
  }

  private async pullMissing() {
    const replica = this.replica;
    if (!replica) return;
    try {
      const r = await this.rpc.request("docx/sync", { session_id: this.session, docx_id: this.docxId, state_vector: toBase64(await replica.encodeStateVector()) });
      if (r.update && this.replica === replica) await replica.applyUpdate(fromBase64(r.update));
    } catch { this.resync = true; }
  }

  private pump(): Promise<void> {
    if (this.sending) return this.sending;
    this.sending = (async () => {
      while (this.queue.length && !this.closed) {
        const whole = this.resync && !!this.replica;
        const update = whole ? await this.replica!.encodeStateAsUpdate() : this.queue[0];
        try {
          await this.rpc.request("docx/sync", { session_id: this.session, docx_id: this.docxId, update: toBase64(update) });
          // The whole state covers every queued update.
          if (whole) { this.queue.length = 0; this.resync = false; } else this.queue.shift();
          this.failure = null;
        } catch (e) {
          // Kept for the next try; the next attempt sends the whole state.
          this.resync = true;
          this.failure = e instanceof Error ? e : new Error(String(e));
          return;
        }
      }
    })().finally(() => { this.sending = null; });
    return this.sending;
  }

  /** Whether the document's latest change was made here, not by the kernel (the agent, another editor). */
  local(): boolean {
    if (!this.unseen) return false;
    this.unseen = 0;
    return true;
  }

  /** Resolves once the kernel holds every local edit; throws when it cannot be reached. */
  async drained() {
    if (this.queue.length) await this.pump();
    if (this.queue.length) throw this.failure ?? new Error("the kernel did not take the edits");
  }

  /** `docx/save` after every local edit is in. `force` writes over a file changed on disk; `path` saves a copy elsewhere. */
  async save(options: { path?: string; force?: boolean } = {}): Promise<WordWriteResult> {
    await this.drained();
    try {
      const r = await this.rpc.request("docx/save", { session_id: this.session, docx_id: this.docxId, ...options });
      return { status: r.status, hash: r.hash ?? null, message: r.message ?? null };
    } catch (e) {
      // As deck/save: a refusal may also come back as an error of its kind.
      const kind = (e as { kind?: string }).kind;
      if (kind === "doc_conflict") return { status: "conflict", hash: /deleted/.test((e as Error).message) ? null : "changed", message: (e as Error).message };
      if (kind === "doc_refused") return { status: "refused", message: (e as Error).message };
      throw e;
    }
  }

  /** `docx/export_pdf` after every local edit is in: the document as it is now, as a PDF. */
  async exportPdf(options: WordPdfOptions): Promise<WordPdfResult> {
    await this.drained();
    return this.rpc.request("docx/export_pdf", { session_id: this.session, docx_id: this.docxId, ...options });
  }

  /** `keep`: the kernel's entry stays open, as when a link on the same document replaces this one. */
  close(keep = false) {
    if (this.closed) return;
    this.closed = true;
    for (const stop of this.stops.splice(0)) stop();
    this.replica = null;
    if (keep) return;
    void this.rpc.request("docx/close", { session_id: this.session, docx_id: this.docxId }).catch(() => {});
  }
}
