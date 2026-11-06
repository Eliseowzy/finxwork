// The editor as a replica of the deck the kernel holds (presentation-kernel-authority §4–§6).
// The kernel's DeckSession is the authority and the only writer of the file; the editor's
// engine is a Yrs replica of it. Local edits apply at once and go to the kernel in order, one
// `deck/sync` at a time; edits made elsewhere arrive as `deck/sync` notices. A save waits for
// every local edit to be acknowledged, then asks the kernel to write (`deck/save`): nothing
// is serialized here, and "saved" shows only once the kernel's write landed (I4).
import type { RpcClient } from "@finx/client";
import type { AsyncCollaborationReplica } from "@betteroffice/pptx";
import { fromBase64, toBase64, type PresentationFile } from "./document.ts";

type WriteResult = { status: "saved" | "conflict" | "refused"; hash?: string | null; message?: string | null };

/** Off unless turned on: `localStorage["finx.deck.kernelAuthority"] = "1"` (§11.2, internal first). */
export function kernelAuthority(): boolean {
  try { return globalThis.localStorage?.getItem("finx.deck.kernelAuthority") === "1"; } catch { return false; }
}

/** A Yrs client id for this replica: fresh on every open (K5), never the engine's standalone id 0. */
export function replicaClientId(): number {
  const words = crypto.getRandomValues(new Uint32Array(2));
  // 53 bits, the safe integers.
  return (words[0] & 0x1f_ffff) * 0x1_0000_0000 + words[1] + 1;
}

/** Opens the file in the kernel as a replica. `discard` drops the kernel's unsaved edits first. */
export async function openKernelPresentation(rpc: RpcClient, session: string, path: string, discard = false): Promise<PresentationFile> {
  const r = await rpc.request("deck/open", { session_id: session, path, replica: true, ...(discard ? { discard: true } : {}) });
  if (!r.state || !r.source) throw new Error("the kernel sent no replica state");
  const link = new KernelLink(rpc, session, r.deck_id, fromBase64(r.state));
  return { data: r.source, hash: r.hash, writable: r.writable, font_families: r.font_families, kernel: link, recoveredDirty: r.dirty };
}

export class KernelLink {
  readonly clientId = replicaClientId();
  private replica: AsyncCollaborationReplica | null = null;
  private queue: Uint8Array[] = [];
  private sending: Promise<void> | null = null;
  /** A sync failed: the kernel may lack some of ours, so the next one sends the whole state. */
  private resync = false;
  private stops: (() => void)[] = [];
  private failure: Error | null = null;
  private closed = false;

  private rpc: RpcClient;
  private session: string;
  readonly deckId: string;
  readonly initialState: Uint8Array;

  constructor(rpc: RpcClient, session: string, deckId: string, initialState: Uint8Array) {
    this.rpc = rpc;
    this.session = session;
    this.deckId = deckId;
    this.initialState = initialState;
    this.stops.push(rpc.on("deck/sync", (notice) => {
      if (notice.deck_id !== this.deckId || !this.replica) return;
      void this.replica.applyUpdate(fromBase64(notice.update)).catch(() => { this.resync = true; });
    }));
  }

  /** The editor's replica is ready (or gone, with null). */
  attach(replica: AsyncCollaborationReplica | null) {
    for (const stop of this.stops.splice(1)) stop();
    this.replica = replica;
    if (!replica) return;
    this.stops.push(replica.onUpdate((update, origin) => {
      if (origin !== "local" || this.closed) return;
      this.queue.push(update.slice());
      void this.pump();
    }));
    // Whatever the replica has that the kernel lacks: nothing after a fresh open, everything
    // typed meanwhile after a reconnect.
    void this.pullMissing();
  }

  private async pullMissing() {
    const replica = this.replica;
    if (!replica) return;
    try {
      const r = await this.rpc.request("deck/sync", { session_id: this.session, deck_id: this.deckId, state_vector: toBase64(await replica.encodeStateVector()) });
      if (r.update && this.replica === replica) await replica.applyUpdate(fromBase64(r.update));
    } catch { this.resync = true; }
  }

  private pump(): Promise<void> {
    if (this.sending) return this.sending;
    this.sending = (async () => {
      while (this.queue.length && !this.closed) {
        const update = this.resync && this.replica ? await this.replica.encodeStateAsUpdate() : this.queue[0];
        const whole = this.resync;
        try {
          await this.rpc.request("deck/sync", { session_id: this.session, deck_id: this.deckId, update: toBase64(update) });
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

  /** Resolves once the kernel holds every local edit; throws when it cannot be reached. */
  async drained() {
    if (this.queue.length) await this.pump();
    if (this.queue.length) throw this.failure ?? new Error("the kernel did not take the edits");
  }

  /** `deck/save` after every local edit is in, as a write result for PresentationDoc. */
  async save(): Promise<WriteResult> {
    await this.drained();
    try {
      const r = await this.rpc.request("deck/save", { session_id: this.session, deck_id: this.deckId });
      return { status: "saved", hash: r.hash };
    } catch (e) {
      const kind = (e as { kind?: string }).kind;
      if (kind === "doc_conflict") {
        const deleted = /deleted/.test((e as Error).message);
        return { status: "conflict", hash: deleted ? null : "changed", message: (e as Error).message };
      }
      if (kind === "doc_refused") return { status: "refused", message: (e as Error).message };
      throw e;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const stop of this.stops.splice(0)) stop();
    this.replica = null;
    void this.rpc.request("deck/close", { session_id: this.session, deck_id: this.deckId }).catch(() => {});
  }
}
