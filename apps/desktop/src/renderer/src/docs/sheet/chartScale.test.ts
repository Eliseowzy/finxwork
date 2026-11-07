import assert from "node:assert/strict";
import test from "node:test";
import { niceTicks } from "./chartScale.ts";

test("ticks cover the data and ascend", () => {
  const t = niceTicks(0, 78.9);
  assert.equal(t[0], 0);
  assert.ok(t.at(-1)! >= 78.9 && t.length <= 12);
  assert.deepEqual([...t].sort((a, b) => a - b), t);
});
test("a flat range still gives an axis", () => {
  assert.ok(niceTicks(5, 5).length >= 2);
  assert.ok(niceTicks(0, 0).length >= 2);
});
test("negative data includes zero", () => {
  assert.ok(niceTicks(-30, 50).includes(0));
});
