import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { desktopProgramVersion, findApp, locateDesktopProgram, parseDesktopVersion } from "./desktop.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "finx-desktop-"));

function program(dir: string, body = "#!/bin/sh\necho '{\"command\":\"version\",\"data\":{\"version\":\"1.0.2\"},\"ok\":true}'\n"): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "agent-desktop");
  fs.writeFileSync(p, body, { mode: 0o755 });
  return p;
}

test("finx's own copy comes before PATH", () => {
  const home = tmp();
  const own = program(path.join(home, ".finx", "desktop", "bin"));
  const onPath = program(path.join(home, "bin"));
  assert.equal(locateDesktopProgram(undefined, home, path.join(home, "bin")), own);
  fs.rmSync(own);
  assert.equal(locateDesktopProgram(undefined, home, path.join(home, "bin")), onPath);
});

test("the packaged app's own copy comes first", () => {
  const home = tmp();
  program(path.join(home, ".finx", "desktop", "bin"));
  const bundled = program(path.join(home, "FinxWork.app", "Contents", "MacOS"));
  assert.equal(locateDesktopProgram(undefined, home, "", path.dirname(bundled)), bundled);
});

test("a configured program is the only one, and must exist", () => {
  const home = tmp();
  program(path.join(home, ".finx", "desktop", "bin"));
  const mine = program(path.join(home, "opt"));
  assert.equal(locateDesktopProgram(mine, home, ""), mine);
  assert.equal(locateDesktopProgram(path.join(home, "missing"), home, ""), null);
  assert.equal(locateDesktopProgram("relative/agent-desktop", home, ""), null);
});

test("nothing installed", () => {
  assert.equal(locateDesktopProgram(undefined, tmp(), ""), process.platform === "darwin" && fs.existsSync("/opt/homebrew/bin/agent-desktop") ? "/opt/homebrew/bin/agent-desktop" : null);
});

test("the version comes from the envelope", () => {
  assert.equal(parseDesktopVersion('noise\n{"data":{"version":"1.0.2"},"ok":true}\n'), "1.0.2");
  assert.equal(parseDesktopVersion('{"error":{"code":"X"},"ok":false}'), null);
  assert.equal(parseDesktopVersion("command not found"), null);
});

test("a program that is not agent-desktop has no version", { skip: process.platform === "win32" }, async () => {
  const dir = tmp();
  assert.equal(await desktopProgramVersion(program(dir)), "1.0.2");
  assert.equal(await desktopProgramVersion(program(path.join(dir, "x"), "#!/bin/sh\necho hello\n")), null);
  assert.equal(await desktopProgramVersion(path.join(dir, "missing")), null);
});

test("an app is found by its bundle id, and only a bundle id is looked up", { skip: process.platform !== "darwin" }, async () => {
  const found = await findApp("com.apple.TextEdit");
  assert.equal(found?.path, "/System/Applications/TextEdit.app");
  assert.ok(found?.name, "it has a name");
  assert.equal(await findApp('x" || kMDItemFSName == "*'), null);
  assert.equal(await findApp("com.example.not-installed-anywhere"), null);
});
