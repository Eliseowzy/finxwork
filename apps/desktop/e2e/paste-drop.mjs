#!/usr/bin/env node
// Attaching by paste and by drop (composer/Composer.tsx, attachments.ts, main/clipboard.ts):
// files dropped on the window attach — the composer shows it takes them while they are dragged
// over — images as images; files copied in Finder and pasted attach by path; a screenshot
// pasted attaches as an image; text pastes as text.
//
// Uses the system clipboard (macOS): its text is put back at the end. Runs the development
// build against target/debug/finx in a temporary FINX_HOME and profile.
//
//   node apps/desktop/e2e/paste-drop.mjs
//   FINXWORK_E2E_SHOTS=<folder> node apps/desktop/e2e/paste-drop.mjs   also screenshots
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "../..");
const finx = path.join(root, "target/debug/finx");
const electron = path.join(desktop, "node_modules/.bin/electron");
const shots = process.env.FINXWORK_E2E_SHOTS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => {
  throw new Error(message);
};
const check = (ok, message) => ok || fail(message);
if (process.platform !== "darwin") {
  console.log("paste-drop: macOS only, skipped");
  process.exit(0);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxp-"));
const home = path.join(work, "finx");
const profile = path.join(work, "profile");
const files = path.join(work, "files");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(files, { recursive: true });
fs.writeFileSync(path.join(home, "models.toml"), `[providers.mock]\nname = "Mock"\napi = "openai-chat"\nbase_url = "http://127.0.0.1:9/v1"\nauth = "none"\n\n[[providers.mock.models]]\nid = "mock-1"\nname = "Mock One"\ncontext_window = 128000\nmax_output_tokens = 2000\n`);
fs.writeFileSync(path.join(home, "config.toml"), `model = "mock/mock-1"\n[models]\nnetwork = false\n`);
// A 2×2 red PNG.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==", "base64");
const notes = path.join(files, "notes.txt");
const picture = path.join(files, "picture.png");
const report = path.join(files, "季度报告.md");
fs.writeFileSync(notes, "notes");
fs.writeFileSync(picture, png);
fs.writeFileSync(report, "# 报告");

const clipboardText = (() => {
  try {
    return execFileSync("pbpaste", { encoding: "utf8" });
  } catch {
    return "";
  }
})();
const osa = (script) => execFileSync("osascript", ["-e", script]);

let app = null;
try {
  const port = 9400 + Math.floor(Math.random() * 400);
  app = spawn(electron, [desktop, `--remote-debugging-port=${port}`], {
    env: { ...process.env, FINX_HOME: home, FINXWORK_DEFAULT_MODE: "sessions", FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINX_CREDENTIAL_STORE: "file" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(200);
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => []);
    target = list.find((t) => t.type === "page" && !t.url.includes("#settings") && !t.url.startsWith("devtools"));
  }
  check(target, "the main window never showed up");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  const waiting = new Map();
  let next = 0;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result);
  };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => (waiting.set(++next, { resolve, reject }), ws.send(JSON.stringify({ id: next, method, params }))));
  const run = async (expr) => {
    const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) fail(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const until = async (what, expr, ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await run(expr);
      if (v) return v;
      if (Date.now() > end) fail(`timed out waiting for ${what}`);
      await sleep(150);
    }
  };
  const shot = async (name) => {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    await sleep(250);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, "base64"));
  };
  const tiles = `[...document.querySelectorAll('.cmp .tile')].map(t => (t.classList.contains('img') ? 'img:' : 'file:') + (t.querySelector('.tile-name')?.textContent ?? t.querySelector('button')?.getAttribute('aria-label') ?? ''))`;
  const paste = async () => {
    await run(`document.querySelector('.cmp-in').focus()`);
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "v", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: 4, commands: ["paste"] });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "v", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: 4 });
  };

  // First run shows onboarding for a moment; past it, the home page's composer.
  await sleep(1500);
  await until("onboarding left", `(() => { const skip = [...document.querySelectorAll("button")].find(b => /稍后|later|skip/i.test(b.textContent)); if (skip) { skip.click(); return false; } return !!document.querySelector('.cmp-in'); })()`);
  await sleep(500);

  // 1. Files dragged over the window: the composer says it takes them; dropped, they attach.
  await sleep(800);
  const at = await run(`(() => { const r = document.querySelector('.cmp').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const data = { items: [], files: [notes, picture], dragOperationsMask: 1 };
  await cdp("Input.dispatchDragEvent", { type: "dragEnter", ...at, data });
  for (let i = 0; i < 40 && !(await run(`!!document.querySelector('.cmp.dropping .cmp-drop')`)); i++) {
    await cdp("Input.dispatchDragEvent", { type: "dragOver", ...at, data });
    await sleep(100);
  }
  await until("the composer taking the drop", `!!document.querySelector('.cmp.dropping .cmp-drop')`, 1000);
  await cdp("Input.dispatchDragEvent", { type: "dragOver", ...at, data });
  await shot("1-dragging");
  await cdp("Input.dispatchDragEvent", { type: "drop", ...at, data });
  await until("the dropped files", `${tiles}.length === 2`);
  check(!(await run(`!!document.querySelector('.cmp-drop')`)), "the drop's overlay stayed");
  const dropped = await run(tiles);
  check(dropped.some((t) => t === "file:notes.txt") && dropped.some((t) => t.startsWith("img:")), `dropped: ${JSON.stringify(dropped)}`);
  check(await run(`location.protocol !== 'file:' || !location.href.includes('notes.txt')`), "the window opened the dropped file");

  // 2. A file copied in Finder, pasted: attached by path, not pasted as its name.
  osa(`set the clipboard to POSIX file "${report}"`);
  await paste();
  await until("the pasted file", `${tiles}.length === 3`);
  check((await run(tiles)).includes("file:季度报告.md"), `pasted file: ${JSON.stringify(await run(tiles))}`);
  check(!(await run(`document.querySelector('.cmp-in').innerText`)).includes("季度报告"), "the file's name was pasted as text");

  // 3. A screenshot (a picture with no file), pasted: an image.
  osa(`set the clipboard to (read (POSIX file "${picture}") as «class PNGf»)`);
  await paste();
  await until("the pasted picture", `${tiles}.filter(t => t.startsWith('img:')).length === 2`);

  // 4. Text pastes as text.
  execFileSync("pbcopy", { input: "just words" });
  await paste();
  await until("the pasted text", `document.querySelector('.cmp-in').innerText.includes('just words')`);
  check((await run(tiles)).length === 4, "text attached something");
  await shot("2-attached");
  console.log("paste-drop: ok");
} finally {
  execFileSync("pbcopy", { input: clipboardText });
  if (app && app.exitCode === null) {
    const exited = new Promise((r) => app.once("exit", r));
    app.kill("SIGTERM");
    await exited;
  }
}
