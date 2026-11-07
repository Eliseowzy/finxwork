import assert from "node:assert/strict";
import { test } from "node:test";
import { PresentationDoc, toBase64 } from "./document.ts";
import { KernelLink, replicaClientId } from "./kernel.ts";

type Call = { method: string; params: Record<string, unknown> };

/** An RPC client that records requests and answers through `answer`. */
function fakeRpc(answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  const listeners = new Map<string, (p: unknown) => void>();
  const rpc = {
    request: async (method: string, params: Record<string, unknown>) => {
      const call = { method, params };
      calls.push(call);
      const reply = answer(call);
      if (reply instanceof Error) throw reply;
      return reply;
    },
    on: (method: string, cb: (p: unknown) => void) => { listeners.set(method, cb); return () => listeners.delete(method); },
  };
  return { rpc: rpc as never, calls, notify: (method: string, p: unknown) => listeners.get(method)?.(p) };
}

/** A replica that records what it applies and emits updates on demand. */
function fakeReplica() {
  let emit: (u: Uint8Array, o: "local" | "remote") => void = () => {};
  const applied: number[][] = [];
  const replica = {
    clientId: 7,
    encodeStateVector: async () => Uint8Array.of(9),
    encodeStateAsUpdate: async () => Uint8Array.of(0xaa),
    applyUpdate: async (u: Uint8Array) => { applied.push([...u]); },
    onUpdate: (l: typeof emit) => { emit = l; return () => { emit = () => {}; }; },
  };
  return { replica, applied, local: (...b: number[]) => emit(Uint8Array.of(...b), "local"), remote: (...b: number[]) => emit(Uint8Array.of(...b), "remote") };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("replica client ids are fresh safe integers, never the standalone 0", () => {
  const ids = new Set(Array.from({ length: 100 }, replicaClientId));
  assert.equal(ids.size, 100);
  for (const id of ids) assert.ok(Number.isSafeInteger(id) && id > 0);
});

test("local updates go to the kernel in order; remote ones are not echoed", async () => {
  const { rpc, calls, notify } = fakeRpc(() => ({ version: "1" }));
  const link = new KernelLink(rpc, "s", "d", Uint8Array.of());
  const r = fakeReplica();
  link.attach(r.replica as never);
  r.local(1);
  r.local(2);
  r.remote(3);
  await link.drained();
  const sent = calls.filter((c) => c.method === "deck/sync" && c.params.update).map((c) => c.params.update);
  assert.deepEqual(sent, [toBase64(Uint8Array.of(1)), toBase64(Uint8Array.of(2))]);
  // Edits made elsewhere reach the replica.
  notify("deck/sync", { deck_id: "d", update: toBase64(Uint8Array.of(5)), version: "2", origin: "agent" });
  notify("deck/sync", { deck_id: "other", update: toBase64(Uint8Array.of(6)), version: "2", origin: "agent" });
  await tick();
  assert.deepEqual(r.applied, [[5]]);
});

test("after a failed sync the whole state is sent, covering the queue", async () => {
  let fail = true;
  const { rpc, calls } = fakeRpc((c) => (c.method === "deck/sync" && c.params.update && fail ? new Error("gone") : { version: "1" }));
  const link = new KernelLink(rpc, "s", "d", Uint8Array.of());
  const r = fakeReplica();
  link.attach(r.replica as never);
  r.local(1);
  await assert.rejects(link.drained(), /gone/);
  fail = false;
  r.local(2);
  await link.drained();
  const last = calls.filter((c) => c.params.update).at(-1)!;
  assert.equal(last.params.update, toBase64(Uint8Array.of(0xaa)));
});

test("a save waits for the edits, then the kernel writes; conflicts map to states", async () => {
  let conflict = false;
  const { rpc, calls } = fakeRpc((c) => {
    if (c.method === "deck/save") return conflict ? Object.assign(new Error("changed on disk: x"), { kind: "doc_conflict" }) : { path: "x", hash: "h2", version: "1" };
    return { version: "1" };
  });
  const link = new KernelLink(rpc, "s", "d", Uint8Array.of());
  const r = fakeReplica();
  link.attach(r.replica as never);
  const doc = new PresentationDoc({ data: "", hash: "h1", writable: true, font_families: [], kernel: link }, async () => { throw new Error("no browser writes"); }, () => {});
  r.local(1);
  doc.edit();
  await doc.flush();
  assert.equal(doc.state, "clean");
  assert.equal(doc.file.hash, "h2");
  const order = calls.map((c) => c.method);
  assert.ok(order.lastIndexOf("deck/sync") < order.indexOf("deck/save"));
  conflict = true;
  r.local(2);
  doc.edit();
  await doc.flush();
  assert.equal(doc.state, "conflict");
});

test("edits the kernel recovered start dirty", () => {
  const { rpc } = fakeRpc(() => ({}));
  const link = new KernelLink(rpc, "s", "d", Uint8Array.of());
  const doc = new PresentationDoc({ data: "", hash: "h", writable: true, font_families: [], kernel: link, recoveredDirty: true }, async () => ({ status: "saved" }), () => {});
  assert.ok(doc.dirty);
  assert.equal(doc.state, "dirty");
});
