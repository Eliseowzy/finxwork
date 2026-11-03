import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { bundle, launches, relativeIn, resolveFrom } from "./paths.ts";

test("a reply's paths resolve under its session's folder", () => {
  const base = "/work/demo";
  assert.equal(resolveFrom(base, "src/a.ts"), "/work/demo/src/a.ts");
  assert.equal(resolveFrom(base, "./src/../b.ts"), "/work/demo/b.ts");
  assert.equal(resolveFrom(base, "/etc/hosts"), "/etc/hosts");
  assert.equal(resolveFrom(base, "~/notes/a.md"), path.join(os.homedir(), "notes/a.md"));
  assert.equal(resolveFrom(base, "~"), os.homedir());
  assert.equal(relativeIn(base, "/work/demo/src/a.ts"), "src/a.ts");
  assert.equal(relativeIn(base, "/work/demo"), null);
  assert.equal(relativeIn(base, "/work/demo-2/a.ts"), null);
  assert.equal(relativeIn(base, "/etc/hosts"), null);
});

test("what a default app would run is known by its extension or its execute bit", () => {
  for (const f of ["x.command", "Setup.app", "a.pkg", "profile.mobileconfig", "run.sh", "tool.py", "go.webloc", "x.scpt", "X.APP"]) assert.ok(launches(f, 0o644, "darwin"), f);
  for (const f of ["report.xlsx", "notes.md", "page.html", "photo.png", "main.ts", "a.js", "data.json"]) assert.ok(!launches(f, 0o644, "darwin"), f);
  // With the execute bit, anything; on Windows the bit means nothing, its extensions do.
  assert.ok(launches("build", 0o755, "darwin"));
  assert.ok(launches("notes.md", 0o744, "linux"));
  assert.ok(!launches("notes.md", 0o755, "win32"));
  assert.ok(launches("a.js", 0o644, "win32") && launches("setup.exe", 0o644, "win32") && launches("x.lnk", 0o644, "win32"));
  assert.ok(launches("x.desktop", 0o644, "linux") && !launches("x.desktop", 0o644, "darwin"));
  assert.ok(bundle("/Applications/Xcode.app") && bundle("/a/b.app/") && bundle("x.pkg"));
  assert.ok(!bundle("/a/apps") && !bundle("/a/b.application"));
});
