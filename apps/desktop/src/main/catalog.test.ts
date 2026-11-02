import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogProblems } from "../../scripts/catalog-hash.mjs";
import { catalogConnectors, catalogSkills, commandLine } from "../shared/catalog.ts";

test("the catalog's skills ship with the files it describes", () => {
  assert.deepEqual(catalogProblems(catalogSkills), []);
});

test("catalog connectors have names finx accepts and ways to sign in", () => {
  const ids = new Set<string>();
  for (const c of catalogConnectors) {
    assert.match(c.id, /^[A-Za-z0-9_-]{1,32}$/, c.id);
    assert.ok(!ids.has(c.id), `${c.id} twice`);
    ids.add(c.id);
    if ("url" in c.install) assert.match(c.install.url, /^https:\/\//, c.id);
    else assert.ok(commandLine(c)?.startsWith(c.install.command), c.id);
    assert.ok(c.install.auth.length > 0, `${c.id}: no way to sign in`);
    assert.equal(new Set(c.install.auth.map((a) => a.kind)).size, c.install.auth.length, `${c.id}: a way twice`);
    for (const auth of c.install.auth) {
      if (auth.kind === "token") assert.ok("url" in c.install ? auth.header : auth.env, `${c.id}: where the token goes`);
      if (auth.kind === "oauth") assert.ok("url" in c.install, `${c.id}: signing in needs an address`);
      if (auth.kind === "oauth" && auth.url) assert.match(auth.url, /^https:\/\//, c.id);
    }
  }
});
