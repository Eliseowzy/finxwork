import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { folderBuild, heldBuild, manifestState, placeExtension } from "./extension-files.ts";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fx-ext-"));

test("a manifest is ours, gone, another home's, or not there", () => {
  const dir = temp();
  const launcher = path.join(dir, "native-host");
  const other = path.join(dir, "other-host");
  fs.writeFileSync(launcher, "");
  fs.writeFileSync(other, "");
  const manifest = path.join(dir, "m.json");
  assert.equal(manifestState(manifest, launcher), "missing");
  const pointing = (p: string) => fs.writeFileSync(manifest, JSON.stringify({ path: p }));
  pointing(launcher);
  assert.equal(manifestState(manifest, launcher), "ours");
  pointing(other);
  assert.equal(manifestState(manifest, launcher), "other");
  pointing(path.join(dir, "gone"));
  assert.equal(manifestState(manifest, launcher), "dead");
  fs.writeFileSync(manifest, "not json");
  assert.equal(manifestState(manifest, launcher), "dead");
});

test("the extension's folder is replaced only when its files changed, and whole", () => {
  const dir = temp();
  const from = path.join(dir, "from");
  fs.mkdirSync(path.join(from, "src"), { recursive: true });
  fs.writeFileSync(path.join(from, "manifest.json"), "{}");
  fs.writeFileSync(path.join(from, "src/a.js"), "1");
  fs.writeFileSync(path.join(from, "src/a.test.js"), "test");
  const keep = (f: string) => !f.endsWith(".test.js");
  const to = path.join(dir, "FinxWork Extension");
  placeExtension(from, to, keep);
  const first = heldBuild(to);
  assert.equal(first, folderBuild(from, keep));
  assert.ok(!fs.existsSync(path.join(to, "src/a.test.js")));
  assert.deepEqual(fs.readdirSync(dir).sort(), ["FinxWork Extension", "from"], "nothing left beside it");

  // The same files: left as it is.
  const mark = path.join(to, "mark");
  fs.writeFileSync(mark, "");
  placeExtension(from, to, keep);
  assert.ok(fs.existsSync(mark));

  // A change a test file does not count as; a real one does.
  fs.writeFileSync(path.join(from, "src/a.test.js"), "other");
  assert.equal(folderBuild(from, keep), first);
  fs.writeFileSync(path.join(from, "src/a.js"), "2");
  placeExtension(from, to, keep);
  assert.notEqual(heldBuild(to), first);
  assert.equal(fs.readFileSync(path.join(to, "src/a.js"), "utf8"), "2");
  assert.ok(!fs.existsSync(mark));
});

test("every end-to-end script that sets its own finx home keeps away from the real browsers", () => {
  const e2e = path.join(import.meta.dirname, "../../../e2e");
  for (const name of fs.readdirSync(e2e).filter((f) => f.endsWith(".mjs"))) {
    const text = fs.readFileSync(path.join(e2e, name), "utf8");
    // A private HOME is what keeps the app's refresh away from the real Chrome's manifest.
    if (/\bFINX_HOME\s*:/.test(text)) assert.match(text, /\bHOME\s*:/, `${name} sets FINX_HOME without a private HOME`);
  }
});
