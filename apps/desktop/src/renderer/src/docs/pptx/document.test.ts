import assert from "node:assert/strict";
import { test } from "node:test";
import { PresentationDoc, fromBase64, toBase64 } from "./document.ts";

const file = { data: toBase64(Uint8Array.of(1, 2)), hash: "base", writable: true, font_families: ["Arial"] };

test("a save flushes pending input and serializes edits arriving during an in-flight write", async () => {
  const writes: { data: string; base: string }[] = [];
  let release!: () => void;
  const first = new Promise<void>((r) => { release = r; });
  const doc = new PresentationDoc(file, async (data, base) => {
    writes.push({ data, base });
    if (writes.length === 1) await first;
    return { status: "saved", hash: `saved-${writes.length}` };
  }, () => {});
  let pending = true;
  doc.prepare = async () => { if (pending) { pending = false; doc.edit(); } };
  doc.serialize = async () => Uint8Array.of(doc.revision);
  const saving = doc.flush();
  await new Promise((r) => setImmediate(r));
  assert.equal(writes.length, 1);
  // Typed during the write: unsaved at once, saved once the write in flight ends.
  doc.edit();
  assert.equal(doc.state, "dirty");
  const next = doc.flush();
  assert.notEqual(next, saving);
  release();
  await saving;
  assert.equal(doc.state, "dirty");
  await next;
  assert.equal(doc.state, "clean");
  assert.deepEqual(writes.map((w) => [fromBase64(w.data)[0], w.base]), [[1, "base"], [2, "saved-1"]]);
  assert.equal(doc.dirty, false);
  doc.dispose();
});

test("an external edit blocks saving and retains the live editor until reload is chosen", async () => {
  let writes = 0, disposed = 0;
  const doc = new PresentationDoc(file, async () => { writes++; return { status: "saved", hash: "new" }; }, () => {});
  doc.serialize = async () => Uint8Array.of(3);
  doc.surface = { element: {} as HTMLElement, dispose: () => { disposed++; } };
  doc.edit();
  const external = { ...file, data: toBase64(Uint8Array.of(9)), hash: "external" };
  doc.diskChanged(external);
  await doc.flush();
  assert.equal(doc.state, "conflict");
  assert.equal(writes, 0);
  assert.equal(disposed, 0);
  assert.equal(doc.dirty, true);
  doc.takeDisk(external);
  assert.equal(disposed, 1);
  assert.equal(doc.bytes[0], 9);
  assert.equal(doc.dirty, false);
  assert.equal(doc.serialize, null);
  doc.dispose();
});

test("failed and conflicting writes retain dirty edits without automatic overwrite", async () => {
  let calls = 0;
  const doc = new PresentationDoc(file, async () => {
    calls++;
    if (calls === 1) throw new Error("disk full");
    return { status: "conflict", hash: "external" };
  }, () => {});
  doc.serialize = async () => Uint8Array.of(3);
  doc.edit();
  await doc.flush();
  assert.equal(doc.state, "failed");
  assert.equal(doc.dirty, true);
  await doc.flush();
  assert.equal(doc.state, "conflict");
  await doc.flush();
  assert.equal(calls, 2);
  assert.equal(doc.file.hash, "base");
  doc.dispose();
});

test("save includes acknowledged editor changes before the UI change notification arrives", async () => {
  const writes: string[] = [];
  const doc = new PresentationDoc(file, async (data) => {
    writes.push(data);
    return { status: "saved", hash: "new" };
  }, () => {});
  doc.prepare = async () => {};
  doc.serialize = async () => Uint8Array.of(4, 4);
  assert.equal(doc.dirty, false);
  await doc.flush();
  assert.deepEqual(writes.map(fromBase64), [Uint8Array.of(4, 4)]);
  doc.edit();
  await doc.flush();
  assert.equal(writes.length, 1);
  assert.equal(doc.dirty, false);
  doc.dispose();
});

test("the kernel's dirty flag shows changes the editor did not make, without saving them", async () => {
  let push!: (s: { dirty: boolean; hash: string | null }) => void;
  let saves = 0;
  const kernel = {
    pending: false,
    onState(f: typeof push) { push = f; return () => {}; },
    save: async () => { saves++; return { status: "saved" as const, hash: "k" }; },
    close() {},
  };
  const doc = new PresentationDoc({ ...file, kernel: kernel as never }, async () => ({ status: "saved", hash: "x" }), () => {});
  // An accepted proposal: unsaved, and the editor does not write it on its own.
  push({ dirty: true, hash: null });
  assert.equal(doc.state, "dirty");
  assert.equal(doc.dirty, true);
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(saves, 0);
  // The agent's deck_save: saved, with the file's new hash.
  push({ dirty: false, hash: "after-save" });
  assert.equal(doc.state, "clean");
  assert.equal(doc.file.hash, "after-save");
  // While a local edit waits for its save, the kernel's "clean" does not hide it.
  doc.edit();
  push({ dirty: false, hash: null });
  assert.equal(doc.state, "dirty");
  doc.dispose();
});
