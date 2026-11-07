import assert from "node:assert/strict";
import { test } from "node:test";
import { toBase64 } from "../pptx/document.ts";
import { WordDoc } from "./document.ts";
import { DocxKernelLink, openKernelWord } from "./kernel.ts";

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

/** The worker editor's replica: synchronous methods that throw, the real ones on `.async`. */
function fakeReplica() {
  let emit: (u: Uint8Array, o: "local" | "remote") => void = () => {};
  const applied: number[][] = [];
  const hosted = {
    clientId: 7,
    encodeStateVector: async () => Uint8Array.of(9),
    encodeStateAsUpdate: async () => Uint8Array.of(0xaa),
    applyUpdate: async (u: Uint8Array) => { applied.push([...u]); },
    onUpdate: (l: typeof emit) => { emit = l; return () => { emit = () => {}; }; },
  };
  const unavailable = () => { throw new Error("use .async"); };
  const replica = { clientId: 7, async: hosted, encodeStateVector: unavailable, encodeStateAsUpdate: unavailable, applyUpdate: hosted.applyUpdate, onUpdate: hosted.onUpdate };
  return { replica, applied, local: (...b: number[]) => emit(Uint8Array.of(...b), "local"), remote: (...b: number[]) => emit(Uint8Array.of(...b), "remote") };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("docx/open asks for a replica and hands back the kernel's state", async () => {
  const { rpc, calls } = fakeRpc(() => ({ docx_id: "w1", state: toBase64(Uint8Array.of(1, 2)), source: "UEs=", hash: "h", writable: true, dirty: true, revision: 3 }));
  const file = await openKernelWord(rpc, "s", "/a/r.docx", true);
  assert.deepEqual(calls[0], { method: "docx/open", params: { session_id: "s", path: "/a/r.docx", replica: true, discard: true } });
  assert.equal(file.kernel.docxId, "w1");
  assert.deepEqual([...file.kernel.initialState], [1, 2]);
  assert.ok(file.recoveredDirty && file.writable && file.hash === "h");
  assert.deepEqual(file.font_families, []);
});

test("local updates go to the kernel in order; remote ones are not echoed, and the kernel's reach the replica", async () => {
  const { rpc, calls, notify } = fakeRpc(() => ({ revision: 1 }));
  const link = new DocxKernelLink(rpc, "s", "w", Uint8Array.of());
  const r = fakeReplica();
  link.attach(r.replica as never);
  r.local(1);
  r.local(2);
  r.remote(3);
  await link.drained();
  const sent = calls.filter((c) => c.method === "docx/sync" && c.params.update).map((c) => c.params.update);
  assert.deepEqual(sent, [toBase64(Uint8Array.of(1)), toBase64(Uint8Array.of(2))]);
  assert.ok(calls.every((c) => c.params.docx_id === "w" && c.params.session_id === "s"));
  notify("docx/sync", { docx_id: "w", update: toBase64(Uint8Array.of(5)) });
  notify("docx/sync", { docx_id: "other", update: toBase64(Uint8Array.of(6)) });
  await tick();
  assert.deepEqual(r.applied, [[5]]);
});

test("after a failed sync the whole state is sent, covering the queue", async () => {
  let fail = true;
  const { rpc, calls } = fakeRpc((c) => (c.method === "docx/sync" && c.params.update && fail ? new Error("gone") : { revision: 1 }));
  const link = new DocxKernelLink(rpc, "s", "w", Uint8Array.of());
  const r = fakeReplica();
  link.attach(r.replica as never);
  r.local(1);
  await assert.rejects(link.drained(), /gone/);
  fail = false;
  r.local(2);
  await link.drained();
  const updates = calls.filter((c) => c.params.update).map((c) => c.params.update);
  assert.equal(updates.at(-1), toBase64(Uint8Array.of(0xaa)));
  assert.equal(updates.filter((u) => u === toBase64(Uint8Array.of(0xaa))).length, 1);
  assert.equal(link.pending, true); // not yet counted by the editor
  assert.ok(link.local() && !link.pending);
});

test("a save waits for every local edit; conflicts wait for overwrite or reload", async () => {
  let status = "saved";
  const { rpc, calls } = fakeRpc((c) => c.method === "docx/save" ? { status, hash: status === "saved" ? "h2" : null, message: status === "saved" ? null : "changed on disk" } : { revision: 1 });
  const link = new DocxKernelLink(rpc, "s", "w", Uint8Array.of());
  const r = fakeReplica();
  link.attach(r.replica as never);
  const doc = new WordDoc({ data: "", hash: "h1", writable: true, font_families: [], kernel: link, recoveredDirty: false }, () => {});
  r.local(1);
  doc.edit();
  await doc.flush();
  assert.equal(doc.state, "clean");
  assert.equal(doc.file.hash, "h2");
  const order = calls.map((c) => c.method);
  assert.ok(order.lastIndexOf("docx/sync") < order.indexOf("docx/save"));
  status = "conflict";
  r.local(2);
  doc.edit();
  await doc.flush();
  assert.equal(doc.state, "conflict");
  assert.ok(doc.dirty);
  status = "saved";
  await doc.overwrite();
  assert.equal(doc.state, "clean");
  assert.deepEqual(calls.filter((c) => c.method === "docx/save").at(-1)!.params, { session_id: "s", docx_id: "w", force: true });
});

test("the kernel's own changes show as unsaved, and its saves as saved", () => {
  const { rpc, notify } = fakeRpc(() => ({}));
  const link = new DocxKernelLink(rpc, "s", "w", Uint8Array.of());
  const doc = new WordDoc({ data: "", hash: "h", writable: true, font_families: [], kernel: link, recoveredDirty: false }, () => {});
  notify("docx/changed", { docx_id: "w", revision: 2, dirty: true, author: "FinxWork AI" });
  assert.equal(doc.state, "dirty");
  notify("docx/changed", { docx_id: "w", revision: 2, dirty: false, author: null });
  assert.equal(doc.state, "clean");
  const recovered = new WordDoc({ data: "", hash: "h", writable: true, font_families: [], kernel: link, recoveredDirty: true }, () => {});
  assert.equal(recovered.state, "dirty");
});

test("a file changed on disk reloads when clean and asks when dirty", () => {
  const { rpc } = fakeRpc(() => ({}));
  const doc = new WordDoc({ data: "", hash: "h", writable: true, font_families: [], kernel: new DocxKernelLink(rpc, "s", "w", Uint8Array.of()), recoveredDirty: false }, () => {});
  assert.equal(doc.diskChanged("h"), false);
  assert.equal(doc.diskChanged("h2"), true);
  doc.revision++;
  assert.equal(doc.diskChanged("h2"), false);
  assert.equal(doc.state, "conflict");
});

test("reloading keeps the kernel's entry open: the new link has the same document id", () => {
  const { rpc, calls } = fakeRpc(() => ({}));
  const old = new DocxKernelLink(rpc, "s", "w", Uint8Array.of());
  const doc = new WordDoc({ data: "", hash: "h", writable: true, font_families: [], kernel: old, recoveredDirty: false }, () => {});
  doc.takeDisk({ data: "", hash: "h2", writable: true, font_families: [], kernel: new DocxKernelLink(rpc, "s", "w", Uint8Array.of()), recoveredDirty: false });
  assert.equal(calls.filter((c) => c.method === "docx/close").length, 0);
  const other = new DocxKernelLink(rpc, "s", "w", Uint8Array.of());
  const moved = new WordDoc({ data: "", hash: "h", writable: true, font_families: [], kernel: other, recoveredDirty: false }, () => {});
  moved.takeDisk({ data: "", hash: "h3", writable: true, font_families: [], kernel: new DocxKernelLink(rpc, "s", "v", Uint8Array.of()), recoveredDirty: false });
  assert.deepEqual(calls.filter((c) => c.method === "docx/close").map((c) => c.params.docx_id), ["w"]);
});
