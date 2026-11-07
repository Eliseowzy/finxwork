import assert from "node:assert/strict";
import { test } from "node:test";
import { onWordHandles, registerWordHandle, wordHandle, wordHandleOf } from "./handle.ts";

test("an editor is found by its document and its path until it goes", () => {
  let told = 0;
  const stop = onWordHandles(() => told++);
  const editor = {} as never;
  const release = registerWordHandle({ docxId: "d1", path: "/a/r.docx", editor });
  assert.equal(wordHandle("d1")?.editor, editor);
  assert.equal(wordHandleOf("/a/r.docx")?.docxId, "d1");
  // A newer editor of the same document is not taken back by the older one's release.
  const newer = registerWordHandle({ docxId: "d1", path: "/a/r.docx", editor: {} as never });
  release();
  assert.ok(wordHandle("d1"));
  newer();
  assert.equal(wordHandle("d1"), undefined);
  assert.equal(told, 3);
  stop();
});
