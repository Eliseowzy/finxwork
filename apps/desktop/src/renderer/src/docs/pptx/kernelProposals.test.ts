import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { initWasm, openPresentation, type ProposalEdit } from "@betteroffice/pptx";
import { KernelProposals, type PreviewEngine } from "./kernelProposals.ts";

type Entry = { id: string; status: "pending" | "accepted" | "rejected"; agentId: string; note: string | null; edits: unknown[]; changes: unknown[]; staleTargets: string[] };
const entry = (id: string, status: Entry["status"] = "pending"): Entry => ({ id, status, agentId: "agent", note: null, edits: [{ type: "setSlideNotes", slideId: "s", text: id }], changes: [], staleTargets: [] });

function fakeRpc() {
  let list: Entry[] = [];
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let changed: (p: { deck_id: string }) => void = () => {};
  const rpc = {
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "deck/proposals") return { proposals: list };
      if (method === "deck/proposal/accept") { list = list.map((p) => p.id === params.proposal_id ? { ...p, status: "accepted" } : p); return { revision: 2, acceptance: { proposalId: params.proposal_id, applied: true } }; }
      if (method === "deck/proposal/reject") { list = list.map((p) => p.id === params.proposal_id ? { ...p, status: "rejected" } : p); return { revision: 2, rejected: true }; }
      throw new Error(method);
    },
    on: (_: string, cb: (p: { deck_id: string }) => void) => { changed = cb; return () => {}; },
  };
  return { rpc: rpc as never, calls, set: (l: Entry[]) => { list = l; }, changed: (deck_id: string) => changed({ deck_id }) };
}

function fakeEngine() {
  const previews = new Map<string, string>();
  let n = 0, refreshed = 0;
  const engine: PreviewEngine = {
    propose: async (_a, _n, edits) => { const id = `local${++n}`; previews.set(id, JSON.stringify(edits)); return { id }; },
    rejectProposal: async (id) => previews.delete(id),
    refresh: () => { refreshed++; },
  };
  return { engine, previews, refreshed: () => refreshed };
}

test("pending kernel proposals are previewed once; decided ones lose their preview", async () => {
  const k = fakeRpc(), e = fakeEngine();
  k.set([entry("p1"), entry("p0", "accepted")]);
  const mirror = new KernelProposals(k.rpc, "S", "D");
  mirror.attach(e.engine);
  await mirror.sync();
  assert.deepEqual([...e.previews.keys()], ["local1"]);
  assert.equal(mirror.kernelId("local1"), "p1");
  k.changed("D");
  await mirror.sync();
  assert.equal(e.previews.size, 1, "not proposed twice");
  k.set([entry("p1", "rejected"), entry("p2")]);
  k.changed("other deck");
  await mirror.sync();
  assert.deepEqual([...e.previews.keys()], ["local2"]);
  assert.equal(mirror.kernelId("local1"), null);
  assert.ok(e.refreshed() >= 2);
});

test("the review's accept and reject go to the kernel with the kernel's id", async () => {
  const k = fakeRpc(), e = fakeEngine();
  k.set([entry("p1"), entry("p2")]);
  const mirror = new KernelProposals(k.rpc, "S", "D");
  mirror.attach(e.engine);
  await mirror.sync();
  assert.deepEqual(await mirror.decide("local1", "accept"), { ok: true });
  assert.deepEqual(await mirror.decide("local2", "reject"), { ok: true });
  const decided = k.calls.filter((c) => c.method !== "deck/proposals");
  assert.deepEqual(decided.map((c) => [c.method, c.params.proposal_id, c.params.session_id, c.params.deck_id]), [["deck/proposal/accept", "p1", "S", "D"], ["deck/proposal/reject", "p2", "S", "D"]]);
  assert.equal(e.previews.size, 0, "both previews dropped");
  assert.equal((await mirror.decide("nope", "accept")).ok, false);
});

test("a click on a preview drawn but not yet recorded waits for it", async () => {
  const k = fakeRpc(), e = fakeEngine();
  k.set([entry("p1")]);
  let shown: () => void = () => {};
  const drawn = new Promise<void>((r) => { shown = r; });
  // The engine draws the preview, then takes a while to answer with its id.
  const slow: PreviewEngine = { ...e.engine, propose: async (a, n, edits) => { const made = await e.engine.propose(a, n, edits); shown(); await new Promise((r) => setTimeout(r, 20)); return made; } };
  const mirror = new KernelProposals(k.rpc, "S", "D");
  mirror.attach(slow);
  await drawn;
  assert.deepEqual(await mirror.decide("local1", "reject"), { ok: true });
  assert.deepEqual(k.calls.filter((c) => c.method === "deck/proposal/reject").map((c) => c.params.proposal_id), ["p1"]);
});

test("a preview's propose and reject write nothing to the Yrs document; only an accept would", async () => {
  const dist = path.dirname(import.meta.resolve("@betteroffice/pptx").replace("file://", ""));
  await initWasm(readFileSync(path.join(dist, "generated/pptx_wasm_bg.wasm")));
  const fixture = path.join(import.meta.dirname, "../../../../../../../crates/finx-slide/tests/fixtures/editor.pptx");
  const h = openPresentation(new Uint8Array(readFileSync(fixture)), { clientId: 4242 });
  const slideId = h.snapshot().slides[0].id;
  const updates: string[] = [];
  h.onUpdate((_u, origin) => updates.push(origin));
  const before = h.encodeStateVector();
  const edits: ProposalEdit[] = [{ type: "setSlideNotes", slideId, text: "preview" }];
  const p = h.propose("agent", null, edits);
  assert.equal(h.listProposals().length, 1);
  assert.equal(h.rejectProposal(p.id), true);
  assert.deepEqual(updates, []);
  assert.deepEqual(h.encodeStateVector(), before);
  // The reason the review's accept must not run here.
  h.acceptProposal(h.propose("agent", null, edits).id);
  assert.deepEqual(updates, ["local"]);
  h.dispose();
});
