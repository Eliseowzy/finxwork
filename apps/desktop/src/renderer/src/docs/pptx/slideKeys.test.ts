import assert from "node:assert/strict";
import { test } from "node:test";
import { slideStep } from "./slideKeys.ts";

test("arrow and page keys step one page, clamped to the deck", () => {
  assert.equal(slideStep("ArrowDown", 1, 5), 2);
  assert.equal(slideStep("ArrowRight", 1, 5), 2);
  assert.equal(slideStep("PageDown", 1, 5), 2);
  assert.equal(slideStep("ArrowUp", 1, 5), 0);
  assert.equal(slideStep("ArrowLeft", 1, 5), 0);
  assert.equal(slideStep("ArrowUp", 0, 5), 0);
  assert.equal(slideStep("ArrowDown", 4, 5), 4);
});

test("other keys and an unknown position do not page", () => {
  assert.equal(slideStep("Enter", 1, 5), null);
  assert.equal(slideStep("ArrowDown", -1, 5), null);
  assert.equal(slideStep("ArrowDown", 0, 0), null);
});
