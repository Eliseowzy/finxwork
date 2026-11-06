// The kernel's proposals, previewed in the editor's replica (presentation-deck-edit §6).
// The engine keeps pending proposals in memory, not in the Yrs document, so `deck_edit`'s
// proposal never reaches the replica by sync. The editor asks `deck/proposals` (on open and on
// every `deck/changed`) and proposes each pending one again in its own engine, only to show it.
// Local propose / reject write nothing to the Yrs document (checked by kernelProposals.test.ts),
// so nothing of a preview syncs back. Accepting one locally would: it would apply the change a
// second time next to the kernel's own accept. The review's accept and reject therefore go to
// the kernel (`decide`), and the change arrives as the kernel's `deck/sync` update.
import type { RpcClient } from "@finx/client";
import type { DeckProposalEntry } from "@finx/protocol";
import type { ProposalEdit } from "@betteroffice/pptx";

/** What of the editor's engine this needs. */
export type PreviewEngine = {
  propose(agentId: string, note: string | null, edits: readonly ProposalEdit[]): Promise<{ id: string }>;
  rejectProposal(id: string): Promise<boolean>;
  /** The review UI lists proposals again. */
  refresh(): void;
};

export type DecideResult = { ok: true } | { ok: false; stale: boolean; message?: string };

export class KernelProposals {
  /** kernel id → local preview id, and back. */
  private local = new Map<string, string>();
  private kernel = new Map<string, string>();
  private chain: Promise<void> = Promise.resolve();
  private stop: () => void;
  private engine: PreviewEngine | null = null;
  private closed = false;

  private rpc: RpcClient;
  private session: string;
  private deckId: string;

  constructor(rpc: RpcClient, session: string, deckId: string) {
    this.rpc = rpc;
    this.session = session;
    this.deckId = deckId;
    this.stop = rpc.on("deck/changed", (n) => { if (n.deck_id === deckId) void this.sync(); });
  }

  /** The editor's engine is ready (or gone, with null). */
  attach(engine: PreviewEngine | null) {
    this.engine = engine;
    this.local.clear();
    this.kernel.clear();
    if (engine) void this.sync();
  }

  /** The kernel's id for a local preview; null for a proposal the kernel did not make. */
  kernelId(localId: string): string | null { return this.kernel.get(localId) ?? null; }

  /** Brings the previews in line with the kernel's list. One at a time, in order. */
  sync(): Promise<void> {
    this.chain = this.chain.then(() => this.syncNow()).catch(() => {});
    return this.chain;
  }

  private async syncNow() {
    const engine = this.engine;
    if (!engine || this.closed) return;
    const { proposals } = await this.rpc.request("deck/proposals", { session_id: this.session, deck_id: this.deckId });
    if (engine !== this.engine) return;
    const pending = new Map<string, DeckProposalEntry>(proposals.filter((p) => p.status === "pending").map((p) => [p.id, p]));
    let changed = false;
    for (const [kernelId, localId] of [...this.local]) {
      if (pending.has(kernelId)) continue;
      this.forget(kernelId);
      await engine.rejectProposal(localId).catch(() => false);
      changed = true;
    }
    for (const [kernelId, p] of pending) {
      if (this.local.has(kernelId)) continue;
      try {
        const made = await engine.propose(p.agentId, p.note, p.edits as ProposalEdit[]);
        this.local.set(kernelId, made.id);
        this.kernel.set(made.id, kernelId);
        changed = true;
      } catch {
        // The replica cannot draw it (not caught up yet, say): the next deck/changed tries again;
        // the conversation's card still decides it.
      }
    }
    if (changed) engine.refresh();
  }

  private forget(kernelId: string) {
    const localId = this.local.get(kernelId);
    this.local.delete(kernelId);
    if (localId) this.kernel.delete(localId);
  }

  /** The review's accept or reject of a local preview, done by the kernel. */
  async decide(localId: string, action: "accept" | "reject", force = false): Promise<DecideResult> {
    const proposal_id = this.kernel.get(localId);
    if (!proposal_id) return { ok: false, stale: false, message: "not a kernel proposal" };
    const params = { session_id: this.session, deck_id: this.deckId, proposal_id, ...(force ? { force: true } : {}) };
    try {
      if (action === "accept") {
        const r = await this.rpc.request("deck/proposal/accept", params);
        if (!r.acceptance.applied) return { ok: false, stale: (r.acceptance.staleTargets?.length ?? 0) > 0 };
      } else {
        await this.rpc.request("deck/proposal/reject", params);
      }
    } catch (e) {
      return { ok: false, stale: false, message: e instanceof Error ? e.message : String(e) };
    }
    // Decided: the preview goes now; the kernel's update for an accept follows by deck/sync.
    await this.sync();
    return { ok: true };
  }

  close() {
    this.closed = true;
    this.stop();
    this.engine = null;
  }
}

/** The review controls whose clicks go to the kernel instead of the replica's engine. */
const controls: Record<string, { action: "accept" | "reject"; force: boolean; canvas: boolean }> = {
  "pptx-proposal-accept": { action: "accept", force: false, canvas: false },
  "pptx-proposal-force": { action: "accept", force: true, canvas: false },
  "pptx-proposal-reject": { action: "reject", force: false, canvas: false },
  "pptx-canvas-proposal-accept": { action: "accept", force: false, canvas: true },
  "pptx-canvas-proposal-reject": { action: "reject", force: false, canvas: true },
};

/**
 * The library offers no accept/reject callback, so its buttons are caught on the way down: a
 * capture listener on the window sees the click before React's listener on the editor's root,
 * and stops it there. The panel's buttons sit in a section carrying `data-proposal-id`; the
 * canvas's act on the selected proposal.
 */
export function interceptReview(root: () => HTMLElement | null, selected: () => string | null, decide: (localId: string, action: "accept" | "reject", force: boolean) => void): () => void {
  const onClick = (e: MouseEvent) => {
    const target = e.target instanceof Element ? e.target.closest("[data-testid]") : null;
    const control = target && controls[target.getAttribute("data-testid") ?? ""];
    const editor = root();
    // Another editor's controls are its own; a control portaled out of any editor is this one's.
    const shell = target?.closest(".pptx-editor-shell");
    if (!control || !editor?.isConnected || (shell && shell !== editor)) return;
    const id = control.canvas ? selected() : target.closest("[data-proposal-id]")?.getAttribute("data-proposal-id") ?? null;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (id) decide(id, control.action, control.force);
  };
  window.addEventListener("click", onClick, true);
  return () => window.removeEventListener("click", onClick, true);
}
