import assert from "node:assert/strict";
import { test } from "node:test";
import { isGrid, isPresentation, opensAsDoc, previewable, readsAsResult, wraps } from "./kind.ts";

test("documents open in finx, text in the editor", () => {
  for (const p of ["/a/r.PDF", "/a/b.xlsx", "/a/b.xlsm", "/a/b.xls", "/a/b.csv", "/a/b.tsv"]) assert.ok(opensAsDoc(p), p);
  for (const p of ["/a/b.md", "/a/b.docx", "/a/pdf", "/a/b.xlsb"]) assert.ok(!opensAsDoc(p), p);
  assert.ok(isGrid("/a/b.csv") && !isGrid("/a/b.pdf"));
  assert.ok(isPresentation("/a/deck.PPTX") && !isPresentation("/a/deck.ppt") && !isGrid("/a/deck.pptx"));
  assert.ok(previewable("x.MD") && previewable("x.svg") && !previewable("x.txt"));
  assert.ok(wraps("README") && wraps("notes.txt") && !wraps("main.rs"));
});

test("a report, a picture, a PDF, a table or a page is a result; code and plain text are not", () => {
  for (const p of ["/a/r.md", "/a/r.MARKDOWN", "/a/c.png", "/a/c.JPEG", "/a/c.svg", "/a/r.pdf", "/a/t.xlsx", "/a/t.xls", "/a/t.csv", "/a/t.tsv", "/a/p.html", "/a/p.HTM"]) assert.ok(readsAsResult(p), p);
  for (const p of ["/a/app.ts", "/a/main.rs", "/a/run.sh", "/a/notes.txt", "/a/out.log", "/a/README", "/a/d.docx", "/a/deck.pptx", "/a/x.zip"]) assert.ok(!readsAsResult(p), p);
});
