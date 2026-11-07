import assert from "node:assert/strict";
import { test } from "node:test";
import { changedSlides, deckEditDetails, firstShown } from "./deckEdit.ts";

test("deck_edit details parse, and those of no change or malformed do not", () => {
  const d = deckEditDetails({ deck_id: "d", path: "/a.pptx", edit: 3, revision: 3, applied: true, note: "改标题", slides: [{ index: 2, slide_id: "s3", status: "changed" }, { index: 0, slide_id: "s1", status: "deleted" }] });
  assert.ok(d);
  assert.equal(d.edit, 3);
  assert.equal(d.note, "改标题");
  assert.deepEqual(changedSlides(d).map((s) => s.index), [0, 2]);
  assert.equal(firstShown(d), 2, "a deleted page cannot be shown");
  assert.equal(deckEditDetails({ deck_id: "d", path: "/a.pptx", edit: null, applied: false, slides: [] }), null);
  assert.equal(deckEditDetails({ deck_id: "d", path: "/a.pptx", proposal_id: "p", slides: [] }), null);
  assert.equal(deckEditDetails(undefined), null);
});
