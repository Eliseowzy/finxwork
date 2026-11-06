import assert from "node:assert/strict";
import { test } from "node:test";
import { slideInsertionIndex } from "./slideReorder.ts";

test("insertion positions account for removing the dragged slide", () => {
  assert.equal(slideInsertionIndex(3, 2), 2); // fourth page before third
  assert.equal(slideInsertionIndex(1, 4), 3); // second page after fourth
  assert.equal(slideInsertionIndex(0, 4), 3); // first to end
  assert.equal(slideInsertionIndex(3, 0), 0); // last to start
  assert.equal(slideInsertionIndex(2, 2), 2); // either side of itself is a no-op
  assert.equal(slideInsertionIndex(2, 3), 2);
});
