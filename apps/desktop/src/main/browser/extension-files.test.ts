import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { folderBuild, heldBuild, launcherTarget, manifestState, placeExtension } from "./extension-files.ts";

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

test("a launcher whose program or home is gone is dead, whoever wrote it", () => {
  const dir = temp();
  const program = path.join(dir, "it's finx");
  const home = path.join(dir, "home");
  fs.writeFileSync(program, "");
  fs.mkdirSync(home);
  const script = (exe: string, h: string) => {
    const q = (p: string) => `'${p.replaceAll("'", String.raw`'\''`)}'`;
    return `#!/bin/sh\n# Written by \`finx browser extension install\`\nFINX_HOME=${q(h)} exec ${q(exe)} browser native-host "$@"\n`;
  };
  assert.deepEqual(launcherTarget(script(program, home)), { program, home });
  assert.equal(launcherTarget("#!/bin/sh\nexec /usr/bin/true\n"), null);

  const launcher = path.join(dir, "native-host");
  const other = path.join(dir, "other-host");
  const manifest = path.join(dir, "m.json");
  fs.writeFileSync(manifest, JSON.stringify({ path: other }));
  fs.writeFileSync(other, script(program, home));
  assert.equal(manifestState(manifest, launcher), "other", "another home that works stays");
  // A test's temporary home: the script is left, the build it ran is gone.
  fs.writeFileSync(other, script(path.join(dir, "gone/finx"), home));
  assert.equal(manifestState(manifest, launcher), "dead");
  fs.writeFileSync(other, script(program, path.join(dir, "gone-home")));
  assert.equal(manifestState(manifest, launcher), "dead");
  fs.writeFileSync(manifest, JSON.stringify({ path: launcher }));
  fs.writeFileSync(launcher, script(path.join(dir, "gone/finx"), home));
  assert.equal(manifestState(manifest, launcher), "dead", "this home's, after its app went");
  fs.writeFileSync(other, "#!/bin/sh\nexec /some/other/host\n");
  fs.writeFileSync(manifest, JSON.stringify({ path: other }));
  assert.equal(manifestState(manifest, launcher), "other", "a script not of finx is not judged");
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
