import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import zlib from "node:zlib";
import { createYrsSession, type YrsAuthor } from "@nimbleoffice/docx/yrs";
import { serializeDocx, serializeFiles } from "./serialize.ts";

const source = new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, "fixtures/demo.docx")));

/** A zip's parts by name. */
function unzip(bytes: Uint8Array): Map<string, Buffer> {
  const b = Buffer.from(bytes);
  let end = b.length - 22;
  while (b.readUInt32LE(end) !== 0x06054b50) end--;
  const parts = new Map<string, Buffer>();
  for (let n = b.readUInt16LE(end + 10), p = b.readUInt32LE(end + 16); n > 0; n--) {
    const method = b.readUInt16LE(p + 10), size = b.readUInt32LE(p + 20), nameLength = b.readUInt16LE(p + 28);
    const local = b.readUInt32LE(p + 42);
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const raw = b.subarray(start, start + size);
    parts.set(b.toString("utf8", p + 46, p + 46 + nameLength), method === 0 ? raw : zlib.inflateRawSync(raw));
    p += 46 + nameLength + b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32);
  }
  return parts;
}

/** The kernel's side, as its engine does it: open the source, edit, encode. */
async function edited(text: string, suggesting?: YrsAuthor) {
  const session = await createYrsSession({ clientId: 1 });
  try {
    session.seedFromDocx(source);
    const [first] = session.paragraphs("body");
    session.insertText({ story: "body", paraId: first.paraId, offset: 0 }, text, suggesting);
    // And, when suggesting, a deletion of the paragraph's next two characters.
    if (suggesting) {
      const at = text.length;
      session.deleteRange({ story: "body", start: { paraId: first.paraId, offset: at }, end: { paraId: first.paraId, offset: at + 2 } }, suggesting);
    }
    return { state: session.encodeState(), metadata: session.encodePeerMetadata() };
  } finally {
    session.destroy();
  }
}

/** The parts that differ from the source's. */
function changed(saved: Map<string, Buffer>): string[] {
  return [...unzip(source)].filter(([name, bytes]) => !saved.get(name)?.equals(bytes)).map(([name]) => name).sort();
}

test("an edit is saved and the parts it did not touch keep their bytes", async () => {
  const { state, metadata } = await edited("已修改：");
  for (const withMetadata of [false, true]) {
    const saved = unzip(await serializeDocx(source, state, withMetadata ? metadata : undefined));
    assert.match(saved.get("word/document.xml")!.toString(), /已修改：/);
    // The edit, and the modified date.
    assert.deepEqual(changed(saved), ["docProps/core.xml", "word/document.xml"]);
    assert.ok(["word/styles.xml", "word/numbering.xml", "word/header1.xml"].every((part) => saved.has(part)));
  }
});

test("suggested edits are saved as tracked changes", async () => {
  const { state } = await edited("建议加上", { name: "FinxWork AI", date: "2026-11-07T00:00:00Z" });
  const xml = unzip(await serializeDocx(source, state)).get("word/document.xml")!.toString();
  assert.match(xml, /<w:ins [^>]*w:author="FinxWork AI"[^>]*>(?:(?!<\/w:ins>).)*建议加上/s);
  assert.match(xml, /<w:del [^>]*w:author="FinxWork AI"[^>]*>(?:(?!<\/w:del>).)*<w:delText/s);
});

test("the request's files: out_path is written whole, and nothing on failure", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finx-docx-"));
  try {
    const { state } = await edited("文件");
    fs.writeFileSync(path.join(dir, "source.docx"), source);
    fs.writeFileSync(path.join(dir, "state.bin"), state);
    const out = path.join(dir, "out.docx");
    const bytes = await serializeFiles({ source_path: path.join(dir, "source.docx"), state_path: path.join(dir, "state.bin"), out_path: out });
    assert.equal(bytes, fs.statSync(out).size);
    assert.match(unzip(fs.readFileSync(out)).get("word/document.xml")!.toString(), /文件/);

    fs.writeFileSync(path.join(dir, "bad.bin"), new Uint8Array([1, 2, 3]));
    const bad = path.join(dir, "bad.docx");
    await assert.rejects(serializeFiles({ source_path: path.join(dir, "source.docx"), state_path: path.join(dir, "bad.bin"), out_path: bad }));
    assert.deepEqual(fs.readdirSync(dir).sort(), ["bad.bin", "out.docx", "source.docx", "state.bin"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
