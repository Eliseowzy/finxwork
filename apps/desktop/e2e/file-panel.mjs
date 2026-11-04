#!/usr/bin/env node
// The file panel (docs/desktop/file-panel-design.md), in the real app: a reply's files open
// beside the conversation at their lines; text is edited and saved on its own or with ⌘S;
// changes from elsewhere are taken, or (with edits not saved) offered as a choice; Markdown
// shows rendered, images show, GBK text is read-only, other files say why they are not
// shown; the tree opens folders; the panel takes the browser's place and gives it back.
//
// A project folder with such files, and a model server on this Mac that reads one file and
// then answers with links to them. The files on disk are checked after each save. What would
// open outside the app is written down instead (FINXWORK_E2E_OPENED), and native menus are
// answered from a file (FINXWORK_E2E_MENU).
//
//   node apps/desktop/e2e/file-panel.mjs
//   FINXWORK_E2E_SHOTS=<folder> node apps/desktop/e2e/file-panel.mjs   also screenshots
//   FINXWORK_E2E_APP=dist/FinxWork.app node apps/desktop/e2e/file-panel.mjs   the packaged app
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "../..");
const finx = path.join(root, "target/debug/finx");
const electron = path.join(desktop, "node_modules/.bin/electron");
const shots = process.env.FINXWORK_E2E_SHOTS;
const packaged = process.env.FINXWORK_E2E_APP ? path.resolve(process.env.FINXWORK_E2E_APP) : null;
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const step = (s) => console.log(`\n▶ ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => {
  throw new Error(message);
};
const check = (ok, message) => ok || fail(message);

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fxf-")));
const home = path.join(work, "finx");
const profile = path.join(work, "profile");
const socket = path.join(home, "run/finx.sock");
const opened = path.join(work, "opened.jsonl");
const menus = path.join(work, "menus");
fs.mkdirSync(menus, { recursive: true });

// ── the project ──
const proj = path.join(work, "proj");
const put = (rel, body) => {
  const p = path.join(proj, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};
const appLines = Array.from({ length: 12 }, (_, i) => `export const line${i + 1} = ${i + 1};`);
put("src/app.ts", appLines.join("\n") + "\n");
put("docs/notes.md", "# 标题\n\n正文，见 [入口](../src/app.ts)。\n");
put("crlf.txt", "first\r\nsecond\r\n");
// "报告,1" in GBK.
put("data/gbk.csv", Buffer.from([0xb1, 0xa8, 0xb8, 0xe6, 0x2c, 0x31, 0x0a]));
put("bin/blob.bin", Buffer.from([0, 1, 2, 3, 0, 5]));
put("assets/logo.png", Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c636000020000050001e9fadcd80000000049454e44ae426082", "hex"));
fs.copyFileSync(path.join(root, "crates/finx-sheet/tests/fixtures/gen/dcf_model.xlsx"), path.join(proj, "model.xlsx"));
const disk = (rel) => fs.readFileSync(path.join(proj, rel), "utf8");

// ── the model: reads a file, then answers with links ──
const reply = [
  "改好了：[入口](src/app.ts:3)，说明在 [说明](docs/notes.md)。",
  "",
  "其他：`crlf.txt`、[图](assets/logo.png)、[数据](data/gbk.csv)、[二进制](bin/blob.bin)、[模型](model.xlsx)、`src/`。",
].join("\n");
const sse = (delta, finish) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`;
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (!req.url?.endsWith("/chat/completions")) return res.writeHead(404).end();
    const messages = JSON.parse(body).messages;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (!messages.some((m) => m.role === "tool")) {
      const call = { index: 0, id: "call_read", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "src/app.ts", offset: 5, limit: 2 }) } };
      return res.end(sse({ role: "assistant", tool_calls: [call] }, "tool_calls"));
    }
    res.end(sse({ role: "assistant", content: reply }, "stop"));
  });
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(
  path.join(home, "models.toml"),
  `[providers.mock]\nname = "Mock"\napi = "openai-chat"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nauth = "none"\n\n[[providers.mock.models]]\nid = "mock-1"\nname = "Mock One"\ncontext_window = 128000\nmax_output_tokens = 2000\n`,
);
fs.writeFileSync(path.join(home, "config.toml"), `model = "mock/mock-1"\n[models]\nnetwork = false\n`);

function finxCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(socket);
    let buf = "";
    const send = (id, m, p) => s.write(JSON.stringify({ jsonrpc: "2.0", id, method: m, params: p }) + "\n");
    s.on("connect", () => send(1, "initialize", { protocol_version: 2, client_info: { name: "e2e" } }));
    s.on("data", (c) => {
      buf += c;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (msg.id === 1) send(2, method, params);
        if (msg.id === 2) {
          s.end();
          resolve(msg);
        }
      }
    });
    s.on("error", reject);
  });
}

// ── the app, driven over the DevTools protocol ──
let app = null;
let port = 0;
async function launch() {
  port = 9400 + Math.floor(Math.random() * 400);
  const program = packaged ? path.join(packaged, "Contents/MacOS/FinxWork") : electron;
  app = spawn(program, [...(packaged ? [] : [desktop]), `--remote-debugging-port=${port}`], {
    env: { ...process.env, FINX_HOME: home, FINXWORK_USER_DATA: profile, ...(!packaged && { FINXWORK_FINX: finx }), FINX_CREDENTIAL_STORE: "file", FINXWORK_E2E_OPENED: opened, FINXWORK_E2E_MENU: menus },
    stdio: ["ignore", "ignore", "inherit"],
  });
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(200);
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => []);
    target = list.find((t) => t.type === "page" && !t.url.includes("#settings") && !t.url.startsWith("devtools"));
  }
  check(target, "the main window never showed up");
  const page = await devtools(target.webSocketDebuggerUrl);
  const cdp = page.call;
  const run = async (expr) => {
    const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) fail(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const until = async (what, expr, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await run(expr);
      if (v) return v;
      if (Date.now() > end) fail(`timed out waiting for ${what}`);
      await sleep(120);
    }
  };
  const shot = async (name) => {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, "base64"));
  };
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1240, height: 860, deviceScaleFactor: 0, mobile: false });
  return { cdp, run, until, shot, close: page.close };
}

async function devtools(url) {
  const ws = new WebSocket(url);
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
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      waiting.set(++next, { resolve, reject });
      ws.send(JSON.stringify({ id: next, method, params }));
    });
  return { call, close: () => ws.close() };
}

async function quit() {
  if (!app || app.exitCode !== null) return;
  const exited = new Promise((r) => app.once("exit", r));
  app.kill("SIGTERM");
  const timeout = setTimeout(() => app.kill("SIGKILL"), 3000);
  await exited;
  clearTimeout(timeout);
  // The launcher is gone; the app it started may not be.
  try {
    execFileSync("pkill", ["-f", `remote-debugging-port=${port}`]);
  } catch {}
}


const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const pick = (id) => fs.writeFileSync(path.join(menus, "pick"), id);
async function until(what, test, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await test();
    if (v) return v;
    if (Date.now() > end) fail(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

const strings = Object.fromEntries(["en", "zh-CN"].map((l) => [l, JSON.parse(fs.readFileSync(path.join(desktop, "src/locales", l, "session.json"), "utf8"))]));
const either = (pick) => JSON.stringify(Object.values(strings).map(pick));

const chip = (name) => `[...document.querySelectorAll(".am .fref")].find((c) => c.querySelector(".fref-n").textContent === ${JSON.stringify(name)})`;
const editorText = `(document.querySelector(".fpn .cm-content")?.innerText ?? "")`;
const activeTab = `(document.querySelector(".fpn-tab.on .brp-tab-t")?.textContent ?? null)`;
const status = `(document.querySelector(".fpn-state")?.textContent ?? "")`;
const note = `(document.querySelector(".fpn-note")?.className ?? "")`;

let failed = false;
try {
  if (!process.env.FINXWORK_E2E_NO_BUILD && !packaged) {
    step("building finx and the app");
    sh("cargo", ["build", "-p", "finx-cli"], { cwd: root });
    sh("pnpm", ["--dir", desktop, "build"]);
  }
  const page = await launch();
  // A common window: the panel has room for the tree beside the code (narrower, the tree starts closed).
  await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 0, mobile: false });
  const key = async (k, code, vk, modifiers = 0) => {
    const ev = { key: k, code, windowsVirtualKeyCode: vk, modifiers };
    await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", ...ev });
    await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...ev });
  };
  const META = 4;
  /** Puts the cursor at the end of the open file and types. */
  const typeAtEnd = async (text) => {
    await page.run(`document.querySelector(".fpn .cm-content").focus()`);
    await key("ArrowDown", "ArrowDown", 40, META);
    await page.cdp("Input.insertText", { text });
  };
  await page.until("the new session page", `!!document.querySelector(".cmp-in")`);
  await page.run(`localStorage.setItem("main-view", JSON.stringify({ ...JSON.parse(localStorage.getItem("main-view") ?? "{}"), draft: { cwd: ${JSON.stringify(proj)}, model: null, thinking: null, permission: "manual" } }))`);
  await page.run(`location.reload()`);
  await page.until("the new session page again", `!!document.querySelector(".cmp-in")`);

  step("a task reads a file and answers with links to files");
  await page.run(`document.querySelector(".cmp-in").focus()`);
  await page.cdp("Input.insertText", { text: "看看项目" });
  await page.until("send enabled", `!document.querySelector("button.send")?.disabled`);
  await page.run(`document.querySelector("button.send").click()`);
  await page.until("the reply", `document.querySelectorAll(".am .fref").length >= 5`, 30000);
  await page.until("the task ended", `!document.querySelector(".working")`, 20000);

  step("a file tag opens the file in the panel, at its line, with the tree open to it");
  await page.run(`${chip("入口")}.click()`);
  await page.until("the panel with app.ts", `${activeTab} === "app.ts" && (${editorText}).includes("line12")`);
  const target = await page.until("the marked line", `document.querySelector(".fpn .cm-line.cm-target")?.textContent ?? null`);
  check(target === appLines[2], `the marked line is ${JSON.stringify(target)}`);
  await page.until("the tree, src open with app.ts marked", `document.querySelector(".fpt-row.on .fpt-name")?.textContent === "app.ts"`);
  const tree = await page.run(`[...document.querySelectorAll(".fpt-row .fpt-name")].map((n) => n.textContent)`);
  check(JSON.stringify(tree.slice(0, 4)) === JSON.stringify(["assets", "bin", "data", "docs"]) && tree.includes("crlf.txt") && tree.includes("app.ts"), `the tree: ${JSON.stringify(tree)}`);
  check(!(await page.run(`!!document.querySelector(".insp")`)), "the info card is still over the conversation");
  const sides = await page.run(`(() => { const f = document.querySelector(".fpn-main").getBoundingClientRect(), t = document.querySelector(".fpt").getBoundingClientRect(); return { file: f.left, tree: t.left, treeEnd: t.right, panelEnd: document.querySelector(".fpn").getBoundingClientRect().right }; })()`);
  check(sides.file < sides.tree && Math.abs(sides.treeEnd - sides.panelEnd) < 2, `the file is not on the left with the tree on the right: ${JSON.stringify(sides)}`);
  await page.shot("1-opened");

  step("an Excel workbook shows as a grid, edits a cell, saves, and quotes the selection");
  await page.run(`${chip("模型")}.click()`);
  await page.until("the workbook grid", `${activeTab} === "model.xlsx" && !!document.querySelector(".sht-canvas") && [...document.querySelectorAll(".sht-tab")].some((x) => x.textContent.includes("假设"))`);
  await page.run(`document.querySelector(".sht-name").select()`);
  await page.cdp("Input.insertText", { text: "B6" });
  await key("Enter", "Enter", 13);
  await page.until("WACC selected", `document.querySelector('.sht-c[data-cell="B6"]')?.textContent === "8.5%"`).catch(async (e) => {
    fail(`${e.message}: address ${await page.run(`document.querySelector(".sht-name")?.value`)}, B6 ${JSON.stringify(await page.run(`document.querySelector('.sht-c[data-cell="B6"]')?.textContent ?? null`))}, cells ${JSON.stringify(await page.run(`[...document.querySelectorAll(".sht-c[data-cell]")].slice(0,8).map((x) => [x.dataset.cell,x.textContent])`))}, note ${JSON.stringify(await page.run(`document.querySelector(".fpn-note")?.textContent ?? null`))}`);
  });
  await page.run(`(() => { const x = document.querySelector(".sht-formula"); x.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(x, "9%"); x.dispatchEvent(new Event("input", { bubbles: true })); x.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
  await page.until("WACC changed", `document.querySelector('.sht-c[data-cell="B6"]')?.textContent === "9.0%" && !!document.querySelector(".fpn-tab.on.dirty")`, 10000);
  await page.run(`document.querySelector(".sht-selection-tools button").click()`);
  await page.until("the cell quote in the composer", `!!document.querySelector(".tile.quote")`);
  await page.run(`[...document.querySelectorAll(".sht-bar .tb")].find((b) => ${either((s) => s.sheet.save)}.includes(b.getAttribute("aria-label"))).click()`);
  await page.until("the workbook saved", `!document.querySelector(".fpn-tab.on.dirty")`, 10000).catch(async (e) => {
    fail(`${e.message}: note ${JSON.stringify(await page.run(`document.querySelector(".fpn-note")?.textContent ?? null`))}, toast ${JSON.stringify(await page.run(`document.querySelector(".toast")?.textContent ?? null`))}, save disabled ${await page.run(`[...document.querySelectorAll(".sht-bar .tb")].find((b) => ${either((s) => s.sheet.save)}.includes(b.getAttribute("aria-label")))?.disabled`)}`);
  });
  await page.shot("1-workbook");
  await page.run(`[...document.querySelectorAll(".fpn-tab")].find((x) => x.textContent.includes("app.ts")).click()`);
  await page.until("app.ts back in front", `${activeTab} === "app.ts"`);

  step("typing saves after a pause; ⌘S saves at once");
  await typeAtEnd("// one\n");
  await page.until("unsaved", `${either((s) => s.files.unsaved)}.includes(${status})`, 3000);
  await until("the edit on disk", () => disk("src/app.ts").includes("// one"), 5000);
  await page.until("saved", `${either((s) => s.files.saved)}.includes(${status})`);
  await typeAtEnd("// two\n");
  const pressed = Date.now();
  await key("s", "KeyS", 83, META);
  await until("the ⌘S save on disk", () => disk("src/app.ts").includes("// two"), 3000);
  check(Date.now() - pressed < 900, `⌘S took ${Date.now() - pressed} ms`);

  step("a change from elsewhere comes in when nothing is edited");
  fs.writeFileSync(path.join(proj, "src/app.ts"), appLines.join("\n") + "\n// from elsewhere\n");
  await page.until("the editor shows it", `(${editorText}).includes("// from elsewhere") && !(${editorText}).includes("// two")`, 10000);

  step("with edits not saved, a change from elsewhere is a choice: load the disk's version");
  await typeAtEnd("// mine\n");
  fs.writeFileSync(path.join(proj, "src/app.ts"), appLines.join("\n") + "\n// theirs\n");
  await page.until("the conflict note", `${note}.includes("warn")`, 10000);
  check(disk("src/app.ts").includes("// theirs") && !disk("src/app.ts").includes("// mine"), "an edit overwrote the change from elsewhere");
  await page.shot("2-conflict");
  await page.run(`document.querySelectorAll(".fpn-note .btn")[0].click()`);
  await page.until("the disk's version taken", `!document.querySelector(".fpn-note") && (${editorText}).includes("// theirs") && !(${editorText}).includes("// mine")`);

  step("…or save anyway");
  await typeAtEnd("// keep me\n");
  fs.writeFileSync(path.join(proj, "src/app.ts"), "elsewhere again\n");
  await page.until("the conflict note again", `${note}.includes("warn")`, 10000);
  await page.run(`document.querySelectorAll(".fpn-note .btn")[1].click()`);
  await until("this side's text on disk", () => disk("src/app.ts").includes("// keep me") && !disk("src/app.ts").includes("elsewhere again"), 5000);
  await page.until("no note", `!document.querySelector(".fpn-note")`);

  step("Markdown shows rendered, its source a click away");
  await page.run(`${chip("说明")}.click()`);
  await page.until("notes.md rendered", `${activeTab} === "notes.md" && document.querySelector(".fpn-md h1")?.textContent === "标题"`);
  await page.shot("3-markdown");
  await page.run(`document.querySelector('.fpn-tools .tb[aria-pressed]').click()`);
  await page.until("its source in the editor", `(${editorText}).includes("# 标题")`);

  step("\\r\\n line ends stay as they were");
  await page.run(`${chip("crlf.txt")}.click()`);
  await page.until("crlf.txt open", `${activeTab} === "crlf.txt" && (${editorText}).includes("second")`);
  await typeAtEnd("third");
  await key("s", "KeyS", 83, META);
  await until("saved with \\r\\n", () => disk("crlf.txt") === "first\r\nsecond\r\nthird", 4000);

  step("an image shows; GBK text is read-only; a binary file says why and opens elsewhere");
  await page.run(`${chip("图")}.click()`);
  await page.until("the image", `!!document.querySelector(".fpn-img img")?.src.startsWith("data:image/png;base64,")`);
  // A pinch (Chromium's control-modified wheel) zooms it; a double click takes it back to fitted.
  const imgWidth = `document.querySelector(".fpn-img img").getBoundingClientRect().width`;
  await page.until("the image laid out", `${imgWidth} > 0`);
  const fitted = await page.run(imgWidth);
  await page.run(`(() => { const r = document.querySelector(".fpn-img img").getBoundingClientRect(); document.querySelector(".fpn-img").dispatchEvent(new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, clientX: r.left, clientY: r.top, bubbles: true, cancelable: true })); })()`);
  await page.until("pinched larger", `${imgWidth} > ${fitted} * 2 && document.querySelector(".fpn-img").classList.contains("zoomed")`);
  await page.run(`document.querySelector(".fpn-img").dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 1, clientY: 1 }))`);
  await page.until("back to fitted", `Math.abs(${imgWidth} - ${fitted}) < 0.01`);
  await page.run(`${chip("数据")}.click()`);
  await page.until("GBK read-only", `${activeTab} === "gbk.csv" && (${editorText}).includes("报告,1") && ${either((s) => s.files.readOnlyEncoding.replace("{{encoding}}", "GBK"))}.includes(${status})`);
  await typeAtEnd("x");
  await sleep(300);
  check(!(await page.run(`(${editorText}).includes("x")`)), "a read-only file took typing");
  await page.run(`${chip("二进制")}.click()`);
  await page.until("the card", `!!document.querySelector(".fpn-card") && ${activeTab} === "blob.bin"`);
  const before = lines(opened).length;
  await page.run(`document.querySelector(".fpn-card .btn").click()`);
  await until("opened in its app", () => lines(opened).length > before, 4000);
  check(JSON.stringify(lines(opened).at(-1)) === JSON.stringify({ kind: "open", path: path.join(proj, "bin/blob.bin") }), `opened: ${JSON.stringify(lines(opened).at(-1))}`);

  step("the tree: a folder closes and opens, a file opens from it; a tab closes");
  const docsRow = `[...document.querySelectorAll(".fpt-row")].find((r) => r.querySelector(".fpt-name").textContent === "docs")`;
  const notesShown = `[...document.querySelectorAll(".fpt-row .fpt-name")].some((n) => n.textContent === "notes.md")`;
  // Opening notes.md opened docs on the way.
  check(await page.run(`(${docsRow}).getAttribute("aria-expanded") === "true" && ${notesShown}`), "the tree did not open the way to notes.md");
  await page.run(`(${docsRow}).click()`);
  await page.until("docs closed", `!${notesShown}`);
  await page.run(`(${docsRow}).click()`);
  await page.until("docs open", notesShown);
  await page.run(`[...document.querySelectorAll(".fpt-row")].find((r) => r.querySelector(".fpt-name").textContent === "notes.md").click()`);
  await page.until("notes.md in front", `${activeTab} === "notes.md"`);
  const tabs = () => page.run(`[...document.querySelectorAll(".fpn-tab .brp-tab-t")].map((n) => n.textContent)`);
  const count = (await tabs()).length;
  await page.run(`document.querySelector(".fpn-tab.on .brp-tab-x").click()`);
  await page.until("the tab closed", `document.querySelectorAll(".fpn-tab").length === ${count - 1}`);

  step("⌘F in the editor finds in the file");
  await page.run(`[...document.querySelectorAll(".fpn-tab")].find((x) => x.textContent.includes("app.ts")).click()`);
  await page.until("app.ts in front", `${activeTab} === "app.ts"`);
  await page.run(`document.querySelector(".fpn .cm-content").focus(); window.dispatchEvent(new Event("finx:find"))`);
  await page.until("the editor's search", `!!document.querySelector(".fpn .cm-search")`);

  step("the Files button sits at the panel's right end while it is open, and puts it away");
  const browserButton = `[...document.querySelectorAll('.spage .ctool button')].find((b) => ${either((s) => s.browser.builtIn)}.includes(b.getAttribute('aria-label')))`;
  const filesButton = `[...document.querySelectorAll('.spage .ctool button')].find((b) => ${either((s) => s.files.title)}.includes(b.getAttribute('aria-label')))`;
  const stripEnd = `[...document.querySelectorAll(".fpn .brp-strip > button")].at(-1)`;
  check(!(await page.run(`!!(${filesButton})`)), "the bar's Files button stayed while the panel is open");
  check(await page.run(`${either((s) => s.files.hide)}.includes((${stripEnd}).getAttribute("aria-label")) && (${stripEnd}).getAttribute("aria-pressed") === "true"`), "the panel's last button is not Files");
  check(await page.run(`${either((s) => s.browser.maximize)}.includes([...document.querySelectorAll(".fpn .brp-strip > button")].at(-2).getAttribute("aria-label"))`), "Expand is not just left of Files");
  check(await page.run(`innerWidth - (${stripEnd}).getBoundingClientRect().right < 16`), "the Files button is not at the window's right end");
  const kept = (await tabs()).length;
  await page.run(`(${stripEnd}).click()`);
  await page.until("the panel away, the bar's button back", `!document.querySelector(".fpn") && !!(${filesButton})`);

  step("the bar reads Session info, Browser, Files from left to right, each with a tip that shows soon");
  const labels = await page.run(`[...document.querySelectorAll('.spage .ctool button.tb')].map((b) => b.getAttribute('aria-label')).slice(-3)`);
  check(either((s) => s.page.info).includes(labels[0]) && either((s) => s.browser.builtIn).includes(labels[1]) && either((s) => s.files.title).includes(labels[2]), `the bar's buttons are ${labels.join(", ")}`);
  const point = async (expr) => {
    const { x, y } = await page.run(`(() => { const r = (${expr}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  };
  const infoButton = `[...document.querySelectorAll('.spage .ctool button')].find((b) => ${either((s) => s.page.info)}.includes(b.getAttribute('aria-label')))`;
  let since = Date.now();
  await point(infoButton);
  await page.until("the info button's tip", `${either((s) => s.page.info)}.some((w) => document.querySelector(".tip")?.textContent.startsWith(w))`, 1500);
  check(Date.now() - since < 1000, `the first tip took ${Date.now() - since} ms`);
  check(await page.run(`!(${infoButton}).hasAttribute("title")`), "the system's own tip can still show over ours");
  since = Date.now();
  await point(browserButton);
  await page.until("the browser button's tip", `${either((s) => s.browser.builtIn)}.includes(document.querySelector(".tip")?.textContent)`, 1000);
  check(Date.now() - since < 250, `moving along the bar, the next tip took ${Date.now() - since} ms`);
  await page.shot("0-tip");
  await point(`document.querySelector(".dmain")`);
  await page.until("the tip gone, the title back", `!document.querySelector(".tip") && (${browserButton}).hasAttribute("title")`, 1000);

  await page.run(`(${filesButton}).click()`);
  await page.until("the panel back with its tabs", `!!document.querySelector(".fpn") && document.querySelectorAll(".fpn-tab").length === ${kept} && !(${filesButton})`);

  step("the browser takes the panel's place, and gives it back with the tabs");
  await page.run(`(${browserButton}).click()`);
  await page.until("the browser instead", `!!document.querySelector(".brp:not(.fpn)") && !document.querySelector(".fpn")`);
  await page.run(`(${filesButton}).click()`);
  await page.until("the files again", `!!document.querySelector(".fpn") && document.querySelectorAll(".fpn-tab").length === ${count - 1}`);

  step("a step's file opens in the panel at the line it read from");
  await page.run(`[...document.querySelectorAll(".fpn-tab")].find((x) => x.textContent.includes("crlf.txt")).click()`);
  await page.run(`[...document.querySelectorAll(".tgroup .tg-h, .tool .th")].forEach((b) => b.getAttribute("aria-expanded") === "false" && b.closest(".tgroup") && b.click())`);
  const readStep = `[...document.querySelectorAll(".tool")].find((t) => t.querySelector(".sm2")?.textContent.includes("src/app.ts"))`;
  await page.until("the read step", `!!(${readStep})`);
  pick("open");
  await page.run(`(${readStep}).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
  await page.until("app.ts at line 5", `${activeTab} === "app.ts" && (document.querySelector(".fpn .cm-line.cm-target")?.textContent ?? "").startsWith("export const line5")`, 8000).catch(async (e) => {
    fail(`${e.message}: marked ${await page.run(`document.querySelector(".fpn .cm-line.cm-target")?.textContent ?? null`)}`);
  });
  await page.shot("4-step");
  if (shots) {
    await page.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
    await sleep(300);
    await page.shot("5-light");
    await page.cdp("Emulation.setEmulatedMedia", { features: [] });
  }

  page.close();
  console.log("\n✔ files open beside the conversation at their lines, save on their own and with ⌘S, take changes from elsewhere or offer the choice, and show what they are");
} catch (e) {
  failed = true;
  console.error(`\n✘ ${e.message}`);
} finally {
  await quit();
  await finxCall("server/shutdown", {}).catch(() => {});
  provider.close();
  if (!failed) fs.rmSync(work, { recursive: true, force: true });
  else console.error(`  kept ${work} (finx's log is in finx/logs)`);
}
process.exit(failed ? 1 : 0);
