import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { scripts, smoke } from "../e2e/lib/manifest.mjs";
import { plan } from "../e2e/lib/select.mjs";

const e2e = path.resolve(import.meta.dirname, "../e2e");
const root = path.resolve(import.meta.dirname, "../../..");

test("the list of scripts and the folder are the same", () => {
  const onDisk = fs.readdirSync(e2e).filter((f) => f.endsWith(".mjs") && !f.startsWith(".") && f !== "run.mjs").map((f) => f.slice(0, -4)).sort();
  assert.deepEqual(Object.keys(scripts).sort(), onDisk);
});

test("every path a script covers exists", () => {
  for (const [name, script] of Object.entries(scripts)) {
    for (const covered of script.covers) {
      const folder = path.dirname(path.join(root, covered + (covered.endsWith("/") ? "x" : "")));
      const start = covered.endsWith("/") ? "" : path.basename(covered);
      assert.ok(fs.existsSync(folder) && fs.readdirSync(folder).some((f) => f.startsWith(start)), `${name}: ${covered}`);
    }
  }
});

test("the basic scripts can run in the background", () => {
  for (const name of smoke) assert.ok(scripts[name] && !scripts[name].foreground && !scripts[name].manual, name);
});

test("what no app shows needs nothing", () => {
  assert.equal(plan(["docs/kernel/technical-design.md", "AGENT.md", "assets/brand/logo.svg"]).level, 0);
});

test("styles, words and unit tests stop at the unit tests, styles and words to be looked at", () => {
  const css = "apps/desktop/src/renderer/src/styles/markdown.css";
  const words = "apps/desktop/src/locales/zh-CN/session.json";
  const chosen = plan([css, words, "apps/desktop/src/main/git.test.ts"]);
  assert.equal(chosen.level, 1);
  assert.deepEqual(chosen.background, []);
  assert.deepEqual(chosen.look, [css, words]);
});

test("a change runs the scripts that answer for it", () => {
  const chosen = plan(["apps/desktop/src/renderer/src/bots/RoutinesPanel.tsx"]);
  assert.equal(chosen.level, 2);
  assert.deepEqual(chosen.background, ["bot-routines"]);
  assert.deepEqual(chosen.unmatched, []);
});

test("what no script answers for runs the basic ones, and says which files", () => {
  const file = "apps/desktop/src/renderer/src/App.tsx";
  const chosen = plan([file]);
  assert.deepEqual(chosen.background, [...smoke].sort());
  assert.deepEqual(chosen.unmatched, [file]);
});

test("a changed script runs itself", () => {
  assert.deepEqual(plan(["apps/desktop/e2e/resend.mjs"]).background, ["resend"]);
});

test("the runner and its helpers run no script", () => {
  const chosen = plan(["apps/desktop/e2e/run.mjs", "apps/desktop/e2e/lib/port.mjs"]);
  assert.equal(chosen.level, 1);
  assert.deepEqual(chosen.background, []);
});

test("scripts that need the screen are set apart", () => {
  const chosen = plan(["apps/desktop/src/main/clipboard.ts"]);
  assert.deepEqual(chosen.foreground, ["paste-drop"]);
  assert.deepEqual(chosen.background, []);
});
