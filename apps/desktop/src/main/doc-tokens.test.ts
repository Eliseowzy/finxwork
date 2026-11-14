import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseRange, tokenFile } from "./doc-tokens.ts";

test("a token stands for its document's working copy, and for nothing else", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "finxdoc-"));
  const token = "0123456789abcdef0123456789abcdef";
  fs.mkdirSync(path.join(home, "docs", ".tokens"), { recursive: true });
  fs.writeFileSync(path.join(home, "docs", ".tokens", token), "652f9b08f5e8db76");
  assert.equal(tokenFile(home, `finxdoc://${token}/current.pdf`), path.join(home, "docs", "652f9b08f5e8db76", "current.pdf"));
  assert.equal(tokenFile(home, `finxdoc://${token}/spatial/index.json`), path.join(home, "cache", "spatial", "652f9b08f5e8db76", "volume", "index.json"));
  assert.equal(tokenFile(home, `finxdoc://${token}/spatial/bricks.bin`), path.join(home, "cache", "spatial", "652f9b08f5e8db76", "volume", "bricks.bin"));
  assert.equal(
    tokenFile(home, `finxdoc://${token}/spatial/mesh/lung_left/0.bin`),
    path.join(home, "cache", "spatial", "652f9b08f5e8db76", "mesh", "lung_left", "0.bin"),
  );
  assert.equal(tokenFile(home, `finxdoc://${token}/spatial/mesh/../secret/0.bin`), null);
  assert.equal(tokenFile(home, `finxdoc://${token}/spatial/mesh/lung/bad.bin`), null);
  assert.equal(tokenFile(home, `finxdoc://${token}/base.pdf`), null);
  assert.equal(tokenFile(home, `finxdoc://${token}/../../etc/passwd`), null);
  assert.equal(tokenFile(home, "finxdoc://ffffffffffffffffffffffffffffffff/current.pdf"), null);
  assert.equal(tokenFile(home, "finxdoc://not-a-token/current.pdf"), null);
  fs.writeFileSync(path.join(home, "docs", ".tokens", token), "../../secret");
  assert.equal(tokenFile(home, `finxdoc://${token}/current.pdf`), null);
});

test("ranges are read as HTTP has them", () => {
  assert.equal(parseRange(null, 100), null);
  assert.deepEqual(parseRange("bytes=0-9", 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=95-200", 100), { start: 95, end: 99 });
  assert.equal(parseRange("bytes=100-", 100), "bad");
  assert.equal(parseRange("bytes=5-1", 100), "bad");
  assert.equal(parseRange("items=0-1", 100), "bad");
});
