import assert from "node:assert/strict";
import { test } from "node:test";
import { WordDoc } from "./document.ts";
import type { WordFile, WordWriteResult } from "./kernel.ts";

/** A kernel link whose saves wait until the test lets each one finish. */
function fakeKernel() {
  const saves: Array<(r: WordWriteResult) => void> = [];
  const kernel = {
    pending: false,
    onState: () => () => {},
    close: () => {},
    save: () => new Promise<WordWriteResult>((resolve) => saves.push(resolve)),
  };
  return { kernel, saves };
}

const tick = () => new Promise((r) => setImmediate(r));

test("typing during a save leaves it unsaved, and the next save makes it saved", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { kernel, saves } = fakeKernel();
  const file = { data: "", hash: "h0", writable: true, font_families: [], kernel, recoveredDirty: false } as unknown as WordFile;
  const doc = new WordDoc(file, () => {});

  doc.edit();
  assert.equal(doc.state, "dirty");
  t.mock.timers.tick(1200);
  await tick();
  assert.equal(doc.state, "saving");
  assert.equal(saves.length, 1);

  // Typed while the first save is out: unsaved at once, not "saving" until typing stops.
  doc.edit();
  assert.equal(doc.state, "dirty");
  // Its timer fires during the save: it waits for it, no second write at the same time.
  t.mock.timers.tick(1200);
  await tick();
  assert.equal(saves.length, 1);

  saves[0]({ status: "saved", hash: "h1" });
  await tick(); await tick();
  // The first snapshot is written; the edit after it is saved next, and nothing is lost.
  assert.equal(saves.length, 2);
  assert.equal(doc.state, "saving");
  saves[1]({ status: "saved", hash: "h2" });
  await tick(); await tick();
  assert.equal(doc.state, "clean");
  assert.equal(doc.dirty, false);
  assert.equal(saves.length, 2);
});

test("a save that ends with an edit still pending shows unsaved", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { kernel, saves } = fakeKernel();
  const file = { data: "", hash: "h0", writable: true, font_families: [], kernel, recoveredDirty: false } as unknown as WordFile;
  const doc = new WordDoc(file, () => {});
  doc.edit();
  void doc.flush();
  await tick();
  doc.edit();
  saves[0]({ status: "saved", hash: "h1" });
  await tick(); await tick();
  assert.equal(doc.state, "dirty");
  t.mock.timers.tick(1200);
  await tick();
  saves[1]({ status: "saved", hash: "h2" });
  await tick(); await tick();
  assert.equal(doc.state, "clean");
});
