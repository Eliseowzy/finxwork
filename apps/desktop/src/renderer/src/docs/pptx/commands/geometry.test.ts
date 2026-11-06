import { strict as assert } from "node:assert";
import { test } from "node:test";
import { align, changed, distribute, snap, type Placed } from "./geometry.ts";

const item = (id: string, x: number, width: number): Placed => ({ id, rect: { x, y: 0, width, height: 10 } });

test("alignment keeps sizes and centers each object on the reference", () => {
  assert.deepEqual(align([item("a", 5, 10), item("b", 8, 20)], "center", { x: 0, y: 0, width: 100, height: 80 }).map(x => x.rect.x), [45, 40]);
});

test("distributing objects keeps first and last fixed even when the middle is wider", () => {
  const input = [item("a", 0, 10), item("b", 20, 100), item("c", 90, 10)];
  const output = distribute(input, "horizontal", null);
  assert.deepEqual(output.map(x => x.rect.x), [0, 0, 90]);
});

test("distribution without page leaves fewer than three objects unchanged", () => {
  const input = [item("a", 0, 10), item("b", 90, 10)];
  assert.deepEqual(distribute(input, "horizontal", null), input);
});

test("page distribution centers a single object", () => {
  assert.equal(distribute([item("a", 1, 20)], "horizontal", { x: 0, y: 0, width: 100, height: 100 })[0].rect.x, 40);
});

test("snap reports a nearby edge and unchanged geometry is filtered", () => {
  const result = snap({ x: 9, y: 40, width: 10, height: 10 }, [{ x: 20, y: 10, width: 10, height: 10 }], { x: 0, y: 0, width: 100, height: 100 }, 2);
  assert.equal(result.dx, 1);
  assert.ok(result.guides.some(g => g.axis === "x" && g.at === 20));
  const a = [item("a", 0, 10)];
  assert.deepEqual(changed(a, a), []);
});
