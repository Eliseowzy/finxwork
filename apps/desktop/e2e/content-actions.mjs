#!/usr/bin/env node
// What a reply points at (docs/desktop/content-actions-design.md): files as tags, web pages
// with icons, code blocks with a bar, and the menus of all of them, in the real app.
//
// A project folder with a few files; a model server on this Mac that first reads a file and
// runs `echo`, then answers with a reply that writes files, links and code blocks every way
// the design reads (and some it must not). The test clicks and right-clicks them and checks
// what happened. Native menus and what opens outside the app go through the app's two test
// hooks (design §10.3): menus are written down and answered from a file; opening is written
// down instead of done. The model is also checked to have been told the app's format.
//
// Runs the development build against the repository's target/debug/finx in a temporary
// FINX_HOME and profile. Takes under a minute once built.
//
//   node apps/desktop/e2e/content-actions.mjs
//   FINXWORK_E2E_SHOTS=<folder> node apps/desktop/e2e/content-actions.mjs   also screenshots
//   FINXWORK_E2E_APP=dist/FinxWork.app node apps/desktop/e2e/content-actions.mjs   the packaged app, with its own finx
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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fxc-")));
const home = path.join(work, "finx");
// A private HOME: the app registers the extension's host in the browsers under it.
fs.mkdirSync(path.join(work, "home"), { recursive: true });
const profile = path.join(work, "profile");
const socket = path.join(home, "run/finx.sock");
const opened = path.join(work, "opened.jsonl");
const menus = path.join(work, "menus");
fs.mkdirSync(menus, { recursive: true });

// ── the project the session works in ──
const proj = path.join(work, "proj");
const write = (rel, body, mode = 0o644) => {
  const p = path.join(proj, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  fs.chmodSync(p, mode);
};
write("src/app.ts", Array.from({ length: 12 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join("\n") + "\n");
write("docs/报告 草稿.md", "# 报告\n");
write("run.command", "#!/bin/sh\necho ran > /tmp/should-not-run\n", 0o755);
write("scripts/build.sh", "#!/bin/sh\necho build\n", 0o755);
write("assets/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
fs.mkdirSync(path.join(proj, "apps/web"), { recursive: true });

// ── a web server on this Mac, as a project's dev server ──
const dev = http.createServer((_, res) => res.writeHead(200, { "content-type": "text/html" }).end("<title>Dev Page</title><h1>dev</h1>"));
await new Promise((r) => dev.listen(0, "127.0.0.1", r));
const devURL = `http://127.0.0.1:${dev.address().port}/`;

// ── the model: reads a file and runs echo, then replies; the reply waits before its last block closes ──
const reply = [
  "改好了。入口在 [应用入口](src/app.ts:3)，说明见 [报告草稿](docs/%E6%8A%A5%E5%91%8A%20%E8%8D%89%E7%A8%BF.md)，旧的 [不存在](src/missing.ts) 已删掉。",
  "",
  "行内：`src/app.ts:5`、`apps/web/`、`feat/x`、`cargo test`、`src/nope.ts`、`run.command`、`scripts/build.sh`、`assets/logo.png`。",
  "",
  `开发服务 ${devURL} 已启动，文档见 [Electron 文档](https://www.electronjs.org/docs/latest/api/shell)，有问题 [写信](mailto:a@b.co)。`,
  "",
  "```bash",
  'echo "hi from block"',
  "```",
  "",
  "```sh",
  "rm\u200B -rf build",
  "```",
  "",
  "```python",
  "print(1)",
].join("\n");
const rest = "\n```\n\n就这些。";
const systems = [];
let pausing = false;
const sse = (delta, finish) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`;
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    if (!req.url?.endsWith("/chat/completions")) return res.writeHead(404).end();
    const messages = JSON.parse(body).messages;
    const system = messages.find((m) => m.role === "system");
    systems.push(typeof system?.content === "string" ? system.content : JSON.stringify(system?.content ?? ""));
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (!messages.some((m) => m.role === "tool")) {
      const calls = [
        { index: 0, id: "call_read", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "src/app.ts", offset: 3, limit: 2 }) } },
        { index: 1, id: "call_echo", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo hello" }) } },
      ];
      return res.end(sse({ role: "assistant", tool_calls: calls }, "tool_calls"));
    }
    const chunk = (text) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
    for (let i = 0; i < reply.length; i += 40) {
      chunk(reply.slice(i, i + 40));
      await sleep(20);
    }
    pausing = true;
    await sleep(3000);
    pausing = false;
    chunk(rest);
    res.end(sse({}, "stop").split("\n\n").slice(1).join("\n\n"));
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
    env: { ...process.env, FINX_HOME: home, HOME: path.join(work, "home"), FINXWORK_USER_DATA: profile, ...(!packaged && { FINXWORK_FINX: finx }), FINX_CREDENTIAL_STORE: "file", FINXWORK_E2E_OPENED: opened, FINXWORK_E2E_MENU: menus },
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

// ── what the test hooks wrote down ──
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const openedNow = () => lines(opened);
const shownNow = () => lines(path.join(menus, "shown.jsonl"));
const pick = (id) => fs.writeFileSync(path.join(menus, "pick"), id);
const ids = (items) => items.map((it) => (it === "-" ? "-" : it.id));
async function nextOpened(what, before) {
  for (let i = 0; i < 100; i++) {
    const all = openedNow();
    if (all.length > before) return all[before];
    await sleep(80);
  }
  fail(`nothing opened for ${what}`);
}
async function nextMenu(what, before) {
  for (let i = 0; i < 100; i++) {
    const all = shownNow();
    if (all.length > before) return all[before];
    await sleep(80);
  }
  fail(`no menu for ${what}`);
}

const strings = Object.fromEntries(["en", "zh-CN"].map((l) => [l, JSON.parse(fs.readFileSync(path.join(desktop, "src/locales", l, "session.json"), "utf8"))]));
const toastSays = (pick) => `${JSON.stringify(Object.values(strings).map(pick))}.some((s) => (document.querySelector(".toast")?.innerText ?? "").includes(s.replace(/\\{\\{name\\}\\}.*/, "")))`;

// Elements of the reply, by what they show.
const chip = (name) => `[...document.querySelectorAll(".am .fref")].find((c) => c.querySelector(".fref-n").textContent === ${JSON.stringify(name)})`;
const link = (text) => `[...document.querySelectorAll(".am a.wl")].find((a) => a.textContent === ${JSON.stringify(text)})`;
const rightClick = (el) => `(${el}).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))`;

let failed = false;
try {
  if (!process.env.FINXWORK_E2E_NO_BUILD && !packaged) {
    step("building finx and the app");
    sh("cargo", ["build", "-p", "finx-cli"], { cwd: root });
    sh("pnpm", ["--dir", desktop, "build"]);
  }
  const page = await launch();
  await page.until("the new session page", `!!document.querySelector(".cmp-in")`);
  // The project, as picked before: a new session works in it.
  await page.run(`localStorage.setItem("main-view", JSON.stringify({ ...JSON.parse(localStorage.getItem("main-view") ?? "{}"), draft: { cwd: ${JSON.stringify(proj)}, model: null, thinking: null, permission: "manual" } }))`);
  await page.run(`location.reload()`);
  await page.until("the new session page again", `!!document.querySelector(".cmp-in")`);
  // Copies are written down here, so the Mac's clipboard is left alone.
  const watchCopies = `navigator.clipboard.writeText = async (t) => void (window.__copied ??= []).push(t)`;
  await page.run(watchCopies);
  const copied = () => page.run(`(window.__copied ?? []).at(-1) ?? null`);

  step("a task reads a file, runs echo and answers");
  await page.run(`document.querySelector(".cmp-in").focus()`);
  await page.cdp("Input.insertText", { text: "看看这个项目" });
  await page.until("send enabled", `!document.querySelector("button.send")?.disabled`);
  await page.run(`document.querySelector("button.send").click()`);

  step("while the last block is still being written, it has no buttons; the finished ones do");
  await page.until("the reply paused in its last block", `document.querySelectorAll(".am .cblock").length === 3`, 30000);
  check(pausing, "the reply was not paused in its last block");
  const draftBars = await page.run(`[...document.querySelectorAll(".am .cblock")].map((b) => [b.querySelector(".cb-lang")?.textContent ?? "", b.querySelectorAll(".cb-b").length, !!b.querySelector(".cb-warn")])`);
  check(same(draftBars, [["bash", 2, false], ["sh", 2, true], ["python", 0, false]]), `the blocks while writing: ${JSON.stringify(draftBars)}`);
  await page.shot("1-writing");
  await page.until("the reply done", `document.body.innerText.includes("就这些")`, 20000);
  await page.until("the task ended", `!document.querySelector(".working")`, 20000);

  step("the model was told the app's format");
  check(systems.length >= 1 && systems[0].includes("In the FinxWork app") && systems[0].includes("[prompt.rs](src/prompt.rs:11)"), "the system prompt has no app section");

  step("files: links always, inline code only when the file is there");
  await page.until("the tags looked up", `document.querySelectorAll(".am .fref").length === 8`);
  const tags = await page.run(`[...document.querySelectorAll(".am .fref")].map((c) => [c.querySelector(".fref-n").textContent, c.querySelector(".fref-l")?.textContent ?? "", c.classList.contains("gone"), c.classList.contains("mono")])`);
  check(
    same(tags, [
      ["应用入口", ":3", false, false],
      ["报告草稿", "", false, false],
      ["不存在", "", true, false],
      ["src/app.ts", ":5", false, true],
      ["apps/web/", "", false, true],
      ["run.command", "", false, true],
      ["scripts/build.sh", "", false, true],
      ["assets/logo.png", "", false, true],
    ]),
    `the tags: ${JSON.stringify(tags)}`,
  );
  const plain = await page.run(`[...document.querySelectorAll(".am .md code")].filter((c) => !c.closest(".fref, .cblock, a")).map((c) => c.textContent)`);
  check(same(plain, ["feat/x", "cargo test", "src/nope.ts"]), `left as code: ${JSON.stringify(plain)}`);
  check((await page.run(`${chip("应用入口")}.title`)) === `src/app.ts · ${strings["zh-CN"].content.line.replace("{{line}}", "3")}` || (await page.run(`${chip("应用入口")}.title`)) === `src/app.ts · ${strings.en.content.line.replace("{{line}}", "3")}`, `the tag's tip: ${await page.run(`${chip("应用入口")}.title`)}`);

  step("web pages: real links with icons, a bare one shortened; mailto stays words");
  const links = await page.run(`[...document.querySelectorAll(".am a.wl")].map((a) => [a.textContent, a.getAttribute("href"), !!a.querySelector(".wl-i svg"), !!a.querySelector(".wl-i img")])`);
  check(
    same(links, [
      [devURL.replace("http://", "").replace(/\/$/, ""), devURL, true, false],
      ["Electron 文档", "https://www.electronjs.org/docs/latest/api/shell", true, false],
    ]),
    `the links: ${JSON.stringify(links)}`,
  );
  check(!(await page.run(`!!document.querySelector('.am a[href^="mailto:"]')`)) && (await page.run(`document.querySelector(".am .md").innerText.includes("写信")`)), "mailto became a link, or its words went");
  await page.shot("2-reply");
  if (shots) {
    await page.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
    await sleep(300);
    await page.shot("2-reply-light");
    await page.cdp("Emulation.setEmulatedMedia", { features: [] });
  }

  step("a click opens a file in the file panel; a folder in its tree (file-panel-design DD-91)");
  const activeTab = `(document.querySelector(".fpn-tab.on .brp-tab-t")?.textContent ?? null)`;
  let before = openedNow().length;
  await page.run(`${chip("应用入口")}.click()`);
  await page.until("app.ts in the file panel", `${activeTab} === "app.ts"`);
  // What would run only shows as text there.
  await page.run(`${chip("run.command")}.click()`);
  await page.until("run.command in the file panel", `${activeTab} === "run.command" && (document.querySelector(".fpn .cm-content")?.innerText ?? "").includes("echo ran")`);
  await page.run(`${chip("apps/web/")}.click()`);
  await page.until("apps/web open in the tree", `[...document.querySelectorAll(".fpt-row")].some((r) => r.querySelector(".fpt-name").textContent === "web" && r.getAttribute("aria-expanded") === "true")`);
  check(openedNow().length === before, `a click opened something outside the app: ${JSON.stringify(openedNow().slice(before))}`);
  await page.run(`${chip("不存在")}.click()`);
  await page.until("the word that it is missing", toastSays((s) => s.content.missing));
  check(openedNow().length === before, "a missing file was opened");

  step("Open With › Default App: what would run is only shown in Finder");
  let shown = shownNow().length;
  pick("app:system");
  await page.run(rightClick(chip("run.command")));
  await nextMenu("run.command", shown);
  check(same(await nextOpened("run.command", before), { kind: "reveal", path: path.join(proj, "run.command") }), `run.command: ${JSON.stringify(openedNow().at(-1))}`);
  await page.until("the word that it was only shown", toastSays((s) => s.content.revealed));
  before = openedNow().length;
  shown = shownNow().length;
  pick("app:system");
  await page.run(rightClick(chip("scripts/build.sh")));
  await nextMenu("build.sh", shown);
  check(same(await nextOpened("build.sh", before), { kind: "reveal", path: path.join(proj, "scripts/build.sh") }), `build.sh: ${JSON.stringify(openedNow().at(-1))}`);
  before = openedNow().length;
  shown = shownNow().length;
  pick("app:system");
  await page.run(rightClick(chip("应用入口")));
  await nextMenu("app.ts", shown);
  check(same(await nextOpened("the entry file", before), { kind: "open", path: path.join(proj, "src/app.ts") }), `opened: ${JSON.stringify(openedNow().at(-1))}`);
  check(!fs.existsSync("/tmp/should-not-run") || fs.statSync("/tmp/should-not-run").mtimeMs < Date.now() - 60_000, "run.command ran");

  step("a file's menu, Copy Relative Path, and an editor this once");
  shown = shownNow().length;
  pick("copyRel");
  await page.run(rightClick(chip("应用入口")));
  const fileItems = await nextMenu("the file", shown);
  check(same(ids(fileItems), ["open", "with", "reveal", "-", "copyPath", "copyRel"]), `the file's menu: ${JSON.stringify(ids(fileItems))}`);
  const withItems = fileItems.find((it) => it.id === "with").submenu;
  check(withItems[0].id === "app:system" && withItems.every((it) => it === "-" || it.checked === undefined), `Open With: ${JSON.stringify(withItems)}`);
  await page.until("the relative path copied", `(window.__copied ?? []).at(-1) === "src/app.ts"`);
  const editor = withItems.find((it) => it !== "-" && it.id !== "app:system");
  if (editor) {
    shown = shownNow().length;
    before = openedNow().length;
    pick(editor.id);
    await page.run(rightClick(chip("应用入口")));
    await nextMenu("the file again", shown);
    const inEditor = await nextOpened(`the file in ${editor.label}`, before);
    check(inEditor.kind === "editor" && inEditor.editor === editor.id.slice(4) && inEditor.path === path.join(proj, "src/app.ts") && inEditor.line === 3, `in the editor: ${JSON.stringify(inEditor)}`);
    // This once: a click still opens it in the app.
    before = openedNow().length;
    await page.run(`${chip("src/app.ts")}.click()`);
    await page.until("app.ts in the panel again", `${activeTab} === "app.ts"`);
    await sleep(300);
    check(openedNow().length === before, "a click after choosing an editor opened it outside the app");
    console.log(`  (editor: ${editor.label})`);
  } else console.log("  (no editor installed here: the editor part is skipped)");
  shown = shownNow().length;
  await page.run(rightClick(chip("apps/web/")));
  const folderItems = ids(await nextMenu("the folder", shown));
  check(same(folderItems.filter((id) => id !== "with"), ["open", "openFolder", "terminal", "-", "copyPath", "copyRel"]), `the folder's menu: ${JSON.stringify(folderItems)}`);
  shown = shownNow().length;
  await page.run(rightClick(chip("不存在")));
  check(same(ids(await nextMenu("the missing file", shown)), ["copyPath", "copyRel"]), "the missing file's menu");

  step("a link opens in the session's browser, once; ⌘ opens the default browser");
  const session = await page.run(`JSON.parse(localStorage.getItem("main-view")).selection.id`);
  await page.run(`${link(devURL.replace("http://", "").replace(/\/$/, ""))}.click()`);
  await page.until("the page in the session's browser", `window.finx.browserTabs().then((t) => t.filter((x) => x.session === ${JSON.stringify(session)} && x.url === ${JSON.stringify(devURL)}).length === 1)`);
  await page.until("the browser panel", `!!document.querySelector(".brp:not(.fpn)")`);
  await page.run(`${link(devURL.replace("http://", "").replace(/\/$/, ""))}.click()`);
  await sleep(600);
  check((await page.run(`window.finx.browserTabs()`)).filter((x) => x.url === devURL).length === 1, "a second click opened another tab");
  await page.shot("3-browser");
  before = openedNow().length;
  await page.run(`${link("Electron 文档")}.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }))`);
  check(same(await nextOpened("the default browser", before), { kind: "external", url: "https://www.electronjs.org/docs/latest/api/shell" }), `⌘-click: ${JSON.stringify(openedNow().at(-1))}`);
  shown = shownNow().length;
  pick("copy");
  await page.run(rightClick(link("Electron 文档")));
  const linkItems = await nextMenu("the link", shown);
  check(same(ids(linkItems), ["panel", "external", "-", "copy"]), `the link's menu: ${JSON.stringify(ids(linkItems))}`);
  await page.until("the link copied", `(window.__copied ?? []).at(-1) === "https://www.electronjs.org/docs/latest/api/shell"`);
  // Its icon is only one already kept: the site was never asked for it.
  const icons = path.join(home, "browser/icons");
  const kept = fs.existsSync(icons) ? fs.readdirSync(icons).map((f) => fs.readFileSync(path.join(icons, f), "utf8")) : [];
  check(!kept.some((k) => k.includes("electronjs")), "the linked site was asked for its icon");

  step("code blocks: Copy, and Open in Terminal for a shell's; hidden characters are told of and kept");
  await page.run(`document.querySelectorAll(".am .cblock")[1].querySelector(".cb-b").click()`);
  check((await copied()) === "rm\u200B -rf build", `the block with a hidden character was copied as ${JSON.stringify(await copied())}`);
  await page.run(`document.querySelector(".am .cblock .cb-b").click()`);
  check((await copied()) === 'echo "hi from block"', `copied: ${await copied()}`);
  before = openedNow().length;
  await page.run(`document.querySelectorAll(".am .cblock")[0].querySelectorAll(".cb-b")[1].click()`);
  check(same(await nextOpened("the terminal", before), { kind: "terminal", path: proj }), `the terminal: ${JSON.stringify(openedNow().at(-1))}`);
  check((await copied()) === 'echo "hi from block"', "the command was not copied for the terminal");
  await page.until("the word to paste it", toastSays((s) => s.content.commandCopied));
  shown = shownNow().length;
  await page.run(rightClick(`document.querySelectorAll(".am .cblock")[0]`));
  check(same(ids(await nextMenu("the shell block", shown)), ["copy", "terminal"]), "the shell block's menu");
  shown = shownNow().length;
  await page.run(rightClick(`document.querySelectorAll(".am .cblock")[2]`));
  const pyItems = await nextMenu("the python block", shown);
  check(same(ids(pyItems), ["copy"]) && Object.values(strings).some((s) => s.content.copyCode === pyItems[0].label), `the python block's menu: ${JSON.stringify(pyItems)}`);

  step("steps: a file's menu for the read, a command's for echo");
  await page.run(`[...document.querySelectorAll(".tgroup .tg-h")].forEach((b) => b.getAttribute("aria-expanded") === "false" && b.click())`);
  await page.until("the steps opened", `[...document.querySelectorAll(".tool .sm2")].some((s) => s.textContent.includes("src/app.ts"))`);
  shown = shownNow().length;
  pick("open");
  before = openedNow().length;
  await page.run(rightClick(`[...document.querySelectorAll(".tool")].find((t) => t.querySelector(".sm2")?.textContent.includes("src/app.ts"))`));
  check(same(ids(await nextMenu("the read step", shown)), ["open", "with", "reveal", "-", "copyPath", "copyRel"]), "the read step's menu");
  await page.until("the read step's file in the panel", `${activeTab} === "app.ts" && !!document.querySelector(".fpn")`);
  check(openedNow().length === before, "the read step's file opened outside the app");
  shown = shownNow().length;
  pick("output");
  await page.run(rightClick(`[...document.querySelectorAll(".tool")].find((t) => t.querySelector("code.cmd")?.textContent.includes("echo hello"))`));
  check(same(ids(await nextMenu("the echo step", shown)), ["copy", "output", "-", "terminal"]), "the echo step's menu");
  await page.until("its output copied", `((window.__copied ?? []).at(-1) ?? "").includes("hello")`);

  step("selected text: Copy, first in any menu over it");
  await page.run(`(() => { const p = document.querySelector(".am .md p"); const r = document.createRange(); r.setStart(p.firstChild, 0); r.setEnd(p.firstChild, 3); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()`);
  shown = shownNow().length;
  pick("copySel");
  await page.run(rightClick(`document.querySelector(".am .md p")`));
  check(same(ids(await nextMenu("the selection", shown)), ["copySel"]), "the selection's menu");
  await page.until("the selection copied", `(window.__copied ?? []).at(-1) === "改好了"`);
  shown = shownNow().length;
  await page.run(rightClick(link("Electron 文档")));
  check(same(ids(await nextMenu("a link under a selection", shown)), ["copySel", "-", "panel", "external", "-", "copy"]), "Copy is not first over a selection");
  await page.run(`getSelection().removeAllRanges()`);
  shown = shownNow().length;
  await page.run(rightClick(`document.querySelector(".am .md p")`));
  await sleep(500);
  check(shownNow().length === shown, "a menu showed with nothing selected");

  page.close();
  console.log("\n✔ a reply's files, links and code blocks open, copy and show their menus as designed; the model is told the format");
} catch (e) {
  failed = true;
  console.error(`\n✘ ${e.message}`);
} finally {
  await quit();
  await finxCall("server/shutdown", {}).catch(() => {});
  provider.close();
  dev.close();
  if (!failed) fs.rmSync(work, { recursive: true, force: true });
  else console.error(`  kept ${work} (finx's log is in finx/logs)`);
}
process.exit(failed ? 1 : 0);
