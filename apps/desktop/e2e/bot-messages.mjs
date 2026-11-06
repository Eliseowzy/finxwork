#!/usr/bin/env node
// What a bot sends besides words (bot-mode-design §6.6.1, §6.6.2, §11 items 19–21): images and
// files in their groups, the large view, a wrong path, a question and its answer, and files gone
// afterwards. A model server on this Mac stands in for the provider, so each step sends exactly
// what it checks; finx and the app are real.
//
// Runs the development build against the repository's target/debug/finx in a temporary
// FINX_HOME and profile. Takes under a minute once built.
//
//   node apps/desktop/e2e/bot-messages.mjs
//   FINXWORK_E2E_SHOTS=<folder> …   also screenshots each step
//   FINXWORK_E2E_NO_BUILD=1 …       uses the builds there are
//   FINXWORK_E2E_APP=dist/FinxWork.app/Contents/MacOS/FinxWork …   the packaged app
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

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
const same = (got, want, what) => check(JSON.stringify(got) === JSON.stringify(want), `${what}: ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);

// Short: the kernel's socket lives under it, and a socket path has at most 103 bytes.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxm-"));
const home = path.join(work, "finx");
// A private HOME: the app registers the extension's host in the browsers under it.
const userHome = path.join(work, "home");
fs.mkdirSync(userHome);
const profile = path.join(work, "profile");
const socket = path.join(home, "run/finx.sock");

// ── what the bot sends ──

/** A real PNG of one colour. */
function png(width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const folder = path.join(work, "out");
fs.mkdirSync(folder);
const at = (name) => path.join(folder, name);
const hues = [[42, 120, 214], [235, 104, 52], [27, 175, 122], [237, 161, 0], [98, 80, 214]];
["a", "b", "c", "d", "e"].forEach((n, i) => fs.writeFileSync(at(`${n}.png`), png(960, 600, hues[i])));
fs.writeFileSync(at("phone.png"), png(750, 1334, [120, 120, 120]));
fs.writeFileSync(at("icon.png"), png(64, 64, [200, 60, 60]));
fs.writeFileSync(at("gone.png"), png(960, 600, [60, 60, 60]));
fs.writeFileSync(at("stays.png"), png(960, 600, [90, 90, 90]));
fs.writeFileSync(at("report.pdf"), Buffer.alloc(2_400_000, 0x20));
fs.writeFileSync(at("gone.pdf"), "%PDF-1.7");
fs.writeFileSync(at("notes.md"), "# 笔记\n\n正文。\n");
fs.writeFileSync(at("page.html"), "<!doctype html><title>Bot 的页面</title><h1>页面</h1>");
const long = "三季度毛利率分析_给管理层汇报用_修订第三版_2026年11月_再改一次.md";
fs.writeFileSync(at(long), "# 很长的名字\n");

const attach = (names, end = true) => ({ type: "attachment", files: names.map((n) => ({ path: n.startsWith("/") ? n : at(n) })), ...(end ? { end_turn: true } : {}) });
const SCRIPT = {
  五张图: attach(["a.png", "b.png", "c.png", "d.png", "e.png"]),
  一张图: attach(["a.png"]),
  竖图: attach(["phone.png"]),
  小图: attach(["icon.png"]),
  混发: attach(["a.png", "notes.md", "b.png", long]),
  发文件: attach(["report.pdf"]),
  发网页: attach(["page.html"]),
  带字的文件: { text: "**报告**做好了。", files: [{ path: at("notes.md") }, { path: at("c.png") }], end_turn: true },
  问名字: { type: "question", text: "发给谁？" },
  图写在文字里: { text: `指数走势：\n\n![指数走势](${at("c.png")})\n\n![不存在的图](${at("nothing.png")})\n\n![网上的图](https://example.com/a.png)\n\n说明在这里。`, end_turn: true },
  会删的: attach(["gone.png", "stays.png", "gone.pdf"]),
  提问: { type: "question", text: "报告要发给谁？", options: [{ label: "先留给我看" }, { label: "发给财务组" }, { label: "发给全部门" }] },
};

let lastRequest = null;
let toldWrong = false;
const textOf = (m) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c) => c.text ?? "").join(""));
// Past the word that follows each of the owner's messages (bot-design §3.14).
const said = (request) => textOf(request.messages.filter((m) => m.role === "user" && !JSON.stringify(m.content).includes("<reminder>")).at(-1));
const sse = (delta, finish) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\ndata: [DONE]\n\n`;
let calls = 0;
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (!req.url?.endsWith("/chat/completions")) return res.writeHead(404).end();
    const request = JSON.parse(body);
    lastRequest = request;
    const owner = said(request);
    const last = request.messages.filter((m) => !JSON.stringify(m.content ?? "").includes("<reminder>")).at(-1);
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (!request.tools?.some((t) => t.function?.name === "send_to_user")) return res.end(sse({ role: "assistant", content: "ok" }, "stop"));
    let args;
    if (owner === "错路径") {
      toldWrong ||= last.role === "tool" && textOf(last).includes("missing.pdf: no such file");
      args = last.role === "tool" ? attach(["notes.md"]) : attach(["notes.md", "missing.pdf"]);
    } else args = SCRIPT[owner] ?? { text: `收到：${owner}`, end_turn: true };
    const call = { index: 0, id: `call_${++calls}`, type: "function", function: { name: "send_to_user", arguments: JSON.stringify(args) } };
    res.end(sse({ role: "assistant", tool_calls: [call] }, "tool_calls"));
  });
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(
  path.join(home, "models.toml"),
  `[providers.mock]\nname = "Mock"\napi = "openai-chat"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nauth = "none"\n\n[[providers.mock.models]]\nid = "mock-1"\nname = "Mock One"\ncontext_window = 128000\nmax_output_tokens = 2000\n`,
);
fs.writeFileSync(path.join(home, "config.toml"), `model = "mock/mock-1"\npermission_mode = "manual"\n[models]\nnetwork = false\n`);

/** One request to finx over its socket: the service the app started outlives the app. */
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
async function launch() {
  const port = 9400 + Math.floor(Math.random() * 400);
  app = spawn(packaged ?? electron, packaged ? [`--remote-debugging-port=${port}`] : [desktop, `--remote-debugging-port=${port}`], {
    env: { ...process.env, FINX_HOME: home, HOME: userHome, FINXWORK_USER_DATA: profile, ...(packaged ? {} : { FINXWORK_FINX: finx }), FINX_CREDENTIAL_STORE: "file" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  let target;
  for (let i = 0; i < 150 && !target; i++) {
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
  const until = async (what, expr, ms = 30000) => {
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
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, "base64"));
  };
  /** A real click at the middle of what `selector` finds, the nth. */
  const click = async (selector, nth = 0) => {
    const box = await run(`(() => { const e = document.querySelectorAll(${JSON.stringify(selector)})[${nth}]; if (!e) return null; e.scrollIntoView({ block: "nearest" }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    check(box, `nothing to click: ${selector}[${nth}]`);
    await sleep(120);
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  };
  const key = async (name) => {
    await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: name, code: name, windowsVirtualKeyCode: { ArrowRight: 39, ArrowLeft: 37, Escape: 27 }[name] });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: name, windowsVirtualKeyCode: { ArrowRight: 39, ArrowLeft: 37, Escape: 27 }[name] });
  };
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 0, mobile: false });
  return { cdp, run, until, shot, click, key, close: page.close };
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
  await exited;
}

const busy = `!!document.querySelector(".tr.bots .bm.working")`;
const messages = `[...document.querySelectorAll(".tr.bots > .bm:not(.working)")]`;
const lastMessage = `${messages}.at(-1)`;
const rowLine = `document.querySelector(".brow.sel .bprev")?.textContent`;
const size = (e) => `(() => { const r = ${e}?.getBoundingClientRect(); return r ? [Math.round(r.width), Math.round(r.height)] : null; })()`;

async function say(page, text) {
  // Back at the end: a click above may have scrolled up, and then the page does not follow.
  await page.run(`(() => { const s = document.querySelector(".cscroll"); s.scrollTop = s.scrollHeight; })()`);
  await sleep(80);
  await page.run(`document.querySelector(".cmp-in").focus()`);
  await page.cdp("Input.insertText", { text });
  await page.until("Send enabled", `!document.querySelector("button.send")?.disabled`);
  await page.run(`document.querySelector("button.send").click()`);
}

/** Says something and waits for the bot to be done with it: `count` more messages from it. */
async function ask(page, text, count = 1) {
  const before = await page.run(`${messages}.length`);
  await say(page, text);
  await page.until(`the answer to ${text}`, `${messages}.length >= ${before + count} && !${busy}`);
  await sleep(250);
}

/** The default bot asks for its model the first time (bot-setup.mjs): what it starts with will do here. */
async function pastSetup(page) {
  await page.until("the bot's page, its models known", `!!document.querySelector(".cmp-zone.bot") && !document.querySelector(".bsetup .btn.primary:disabled")`, 30000);
  await page.run(`document.querySelector(".bsetup .btn.primary")?.click()`);
  await page.until("past the first time", `!document.querySelector(".bsetup")`);
}

let failed = false;
try {
  if (!process.env.FINXWORK_E2E_NO_BUILD && !packaged) {
    step("building finx and the app");
    sh("cargo", ["build", "-p", "finx-cli"], { cwd: root });
    sh("pnpm", ["--dir", desktop, "build"]);
  }

  step("Bot mode, FinxBot");
  let page = await launch();
  await page.until("the window", `!!document.querySelector(".seg.mode")`, 60000);
  await page.run(`document.querySelector('.seg.mode [data-mode=bots]').click()`);
  await page.until("FinxBot's page", `!!document.querySelector(".bempty") || document.querySelectorAll(".tr.bots > *").length > 0`, 30000);
  await pastSetup(page);
  // The first-time note sits over the conversation's end until it is closed.
  await page.until("the first-time note", `!!document.querySelector(".knote .btn.primary")`);
  await page.run(`document.querySelector(".knote .btn.primary").click()`);
  await page.until("the note closed", `!document.querySelector(".knote")`);

  step("19. five images: rows of two then three, one height in a row, pictures read");
  await ask(page, "五张图");
  const rows = `[...${lastMessage}.querySelectorAll(".bims-r")]`;
  same(await page.run(`${rows}.map((r) => r.children.length)`), [2, 3], "rows");
  same(await page.until("the pictures", `(() => { const all = [...${lastMessage}.querySelectorAll(".bim img")]; return all.length === 5 && all.every((i) => i.complete && i.naturalWidth === 960) && all.length; })()`), 5, "pictures");
  same(await page.run(`${size(`${lastMessage}.querySelector(".bims")`)}[0]`), 640, "the group's width");
  check(await page.run(`${rows}.every((r) => new Set([...r.children].map((c) => Math.round(c.getBoundingClientRect().height))).size === 1)`), "a row shares one height");
  same(await page.run(rowLine), "[图片]", "the list's line");
  await page.shot("01-five-images");

  step("narrow conversation gives long messages the available width");
  const widths = await page.run(`(() => {
    const container = document.createElement("div");
    container.className = "bm-b";
    container.style.cssText = "width:300px;position:fixed;top:0;left:0";
    const line = ${lastMessage}.querySelector(".bline").cloneNode(true);
    const bubble = document.createElement("div");
    bubble.className = "bbub";
    bubble.textContent = "你好，我在。刚才正在拆你给的文件，已经认出它的流结构：PowerPoint Document 87,600 字节。".repeat(3);
    line.firstElementChild.replaceWith(bubble);
    container.append(line);
    document.body.append(container);
    const long = bubble.getBoundingClientRect().width;
    bubble.textContent = "你好";
    const short = bubble.getBoundingClientRect().width;
    container.remove();
    return [long, short];
  })()`);
  check(widths[0] >= 298 && widths[1] < 150, `narrow long and short bubbles: ${widths}`);

  step("19. the large view steps through them");
  await page.click(`.tr.bots > .bm:last-of-type .bim`, 1);
  await page.until("the large view", `!!document.querySelector(".lightbox.many")`);
  same(await page.run(`document.querySelector(".lb-cap").textContent.replace(/\\s+/g, " ")`), "2 / 5 · b.png", "the caption");
  await page.key("ArrowRight");
  await page.until("the next", `document.querySelector(".lb-cap").textContent.startsWith("3 / 5")`);
  await page.click(".lb-go.next");
  await page.until("the next again", `document.querySelector(".lb-cap").textContent.startsWith("4 / 5")`);
  check(await page.run(`!!document.querySelector(".lightbox")`), "an arrow does not close it");
  await page.shot("02-large");
  await page.key("Escape");
  await page.until("closed", `!document.querySelector(".lightbox")`);

  step("19. one image keeps its shape and is not enlarged");
  await ask(page, "一张图");
  same(await page.run(size(`${lastMessage}.querySelector(".bims.one")`)), [480, 300], "a chart");
  await ask(page, "竖图");
  same(await page.run(size(`${lastMessage}.querySelector(".bims.one")`)), [236, 420], "a phone's shot");
  await ask(page, "小图");
  same(await page.run(size(`${lastMessage}.querySelector(".bims.one")`)), [64, 64], "a small picture");
  await page.shot("03-one-image");
  await page.click(`.tr.bots > .bm:last-of-type .bim`);
  await page.until("the large view", `!!document.querySelector(".lightbox")`);
  check(!(await page.run(`!!document.querySelector(".lb-go")`)), "one image has no arrows");
  await page.key("Escape");
  await page.until("closed", `!document.querySelector(".lightbox")`);

  step("19. images and files together: images first, each group in its order");
  await ask(page, "混发");
  same(await page.run(`${lastMessage}.querySelectorAll(".bim").length`), 2, "images");
  same(await page.run(`[...${lastMessage}.querySelectorAll(".bfiles .tile-name")].map((n) => n.textContent)`), ["notes.md", long], "files");
  same(await page.run(`getComputedStyle(${lastMessage}.querySelectorAll(".bfiles .tile-ext")[1]).flexShrink`), "0", "a long name keeps its extension");
  same(await page.run(`[...${lastMessage}.querySelectorAll(".bfiles .tile-ext")][1].textContent`), ".md", "the extension");
  await page.shot("04-mixed");

  step("19. a file opens beside the conversation");
  await page.click(`.tr.bots > .bm:last-of-type .bfiles .tile-open`);
  await page.until("the file panel", `document.querySelector(".bgp")?.innerText.includes("notes.md")`);
  await page.shot("05-file-panel");
  // Its own button, at the panel's end while it is open.
  await page.run(`[...document.querySelectorAll('.bgp button.tb.on[aria-pressed="true"]')].at(-1).click()`);
  await page.until("the panel closed", `!document.querySelector(".bgp")`);

  step("19. an HTML file opens as its page in the conversation's browser, not as its source");
  await ask(page, "发网页");
  await page.click(`.tr.bots > .bm:last-of-type .bfiles .tile-open`);
  await page.until("its page in a tab of this conversation", `window.finx.browserTabs().then((t) => t.some((x) => x.session && x.title === "Bot 的页面" && x.url.endsWith("/page.html")))`);
  await page.until("the browser panel, not the file panel", `!!document.querySelector(".brp:not(.fpn)") && !document.querySelector(".fpn")`);
  await page.shot("05a-html-page");
  await page.run(`[...document.querySelectorAll('.bgp button.tb.on[aria-pressed="true"]')].at(-1).click()`);
  await page.until("the panel closed", `!document.querySelector(".bgp")`);

  step("19. one file: a row with its size; the list names it");
  await ask(page, "发文件");
  same(await page.run(`${lastMessage}.querySelector(".tile-kind").textContent`), "2.3 MB", "the size");
  same(await page.run(size(`${lastMessage}.querySelector(".bfiles")`)), [320, 52], "the bubble");
  same(await page.run(rowLine), "[文件] report.pdf", "the list's line");

  step("19. words with files: a bubble above them, no type needed; the list shows the words");
  await ask(page, "带字的文件");
  same(await page.run(`${lastMessage}.querySelector(".batt > .bbub").innerText.trim()`), "报告做好了。", "the words");
  same(await page.run(`[...${lastMessage}.querySelector(".batt").children].map((c) => c.className.split(" ")[0])`), ["bbub", "bims", "bfiles"], "the order");
  same(await page.run(rowLine), "报告做好了。", "the list's line");
  await page.shot("05b-words-and-files");

  step("19. an image on this computer written in the words shows; a missing or remote one is its alt text");
  await ask(page, "图写在文字里");
  await page.until("the picture", `(() => { const i = ${lastMessage}.querySelector(".bbub .md-img img"); return i?.complete && i.naturalWidth === 960; })()`);
  same(await page.run(`${lastMessage}.querySelectorAll(".md-img").length`), 1, "only the one that exists");
  await page.until("the page following to the end", `(() => { const s = document.querySelector(".cscroll"); return s.scrollHeight - s.scrollTop - s.clientHeight < 2; })()`, 3000);
  check(await page.run(`(() => { const t = ${lastMessage}.innerText; return t.includes("不存在的图") && t.includes("网上的图") && t.includes("说明在这里"); })()`), "the others are their alt text");
  same(await page.run(size(`${lastMessage}.querySelector(".md-img")`)), [480, 300], "as wide as one sent as a file");
  await page.shot("05c-image-in-words");
  await page.click(`.tr.bots > .bm:last-of-type .md-img`);
  await page.until("the large view", `!!document.querySelector(".lightbox")`);
  same(await page.run(`document.querySelector(".lb-cap").textContent`), "指数走势", "its caption");
  await page.key("Escape");
  await page.until("closed", `!document.querySelector(".lightbox")`);

  step("20. a wrong path: the model is told, sends again, and nothing extra shows");
  const before = await page.run(`${messages}.length`);
  await ask(page, "错路径");
  same(await page.run(`${messages}.length`), before + 1, "one message");
  same(await page.run(`[...${lastMessage}.querySelectorAll(".tile-name")].map((n) => n.textContent)`), ["notes.md"], "what it sent in the end");
  check(toldWrong, "the model was told which path is wrong");

  step("21. a question: tap an answer, it is the owner's message, the options fold away");
  await ask(page, "提问");
  same(await page.run(`[...document.querySelectorAll(".bq-opt")].map((b) => b.textContent)`), ["先留给我看", "发给财务组", "发给全部门"], "the options");
  same(await page.run(size(`${lastMessage}.querySelector(".bq")`)).then((s) => s[0]), 320, "as wide as files");
  same(await page.run(rowLine), "报告要发给谁？", "the list's line");
  await page.shot("06-question");
  await page.click(".bq-opt", 1);
  await page.until("the answer's reply", `${messages}.at(-1).innerText.includes("收到：发给财务组")`);
  same(await page.run(`[...document.querySelectorAll(".tr.bots > .um")].at(-1).querySelector(".bub").textContent`), "发给财务组", "the owner's message");
  await page.until("the options gone", `document.querySelectorAll(".bq-opt").length === 0`);
  check(await page.run(`[...document.querySelectorAll(".bq")].at(-1).innerText.includes("报告要发给谁")`), "the question stays");
  same(said(lastRequest), "发给财务组", "the model got the answer as the owner's message");
  await page.shot("07-answered");

  step("21. a question whose answers cannot be listed: a bubble, and the turn ends");
  await ask(page, "问名字");
  same(await page.run(`${lastMessage}.querySelectorAll(".bq-opt").length`), 0, "no options");
  check(await page.run(`${lastMessage}.innerText.includes("发给谁")`), "the question");

  step("21. writing something else closes it too");
  await ask(page, "提问");
  check(await page.run(`document.querySelectorAll(".bq-opt").length === 3`), "open");
  await ask(page, "先不发了");
  await page.until("the options gone", `document.querySelectorAll(".bq-opt").length === 0`);

  step("21. reopened: an open question stays open, an answered one stays closed");
  await ask(page, "提问");
  await page.run(`location.reload()`);
  await page.until("the conversation", `document.querySelectorAll(".tr.bots > .bm").length > 0`, 30000);
  await page.until("the question open", `document.querySelectorAll(".bq-opt").length === 3`);
  same(await page.run(`document.querySelectorAll(".bq").length`), 4, "four questions in all");
  await page.click(".bq-opt", 0);
  await page.until("the options gone", `document.querySelectorAll(".bq-opt").length === 0`);
  await page.until("not busy", `!${busy}`);

  // The tab has stayed through the pictures above; a page reloaded below would bring its panel out.
  for (const tab of await page.run(`window.finx.browserTabs()`)) await page.run(`window.finx.browserTabCommand(${JSON.stringify(tab.targetId)}, { command: "close" })`);
  await page.until("the page's tab closed", `window.finx.browserTabs().then((t) => t.length === 0)`);

  step("19. files gone afterwards: a grey row, no hole");
  await ask(page, "会删的");
  same(await page.run(`${lastMessage}.querySelectorAll(".bim").length`), 2, "two images at first");
  fs.rmSync(at("gone.png"));
  fs.rmSync(at("gone.pdf"));
  await page.run(`location.reload()`);
  await page.until("the conversation", `document.querySelectorAll(".tr.bots > .bm").length > 0`, 30000);
  await page.until("gone rows", `${lastMessage}.querySelectorAll(".tile.gone").length === 2`, 15000);
  same(await page.run(`[...${lastMessage}.querySelectorAll(".tile.gone .tile-kind")].map((k) => k.textContent)`), ["文件已不在", "文件已不在"], "the rows");
  same(await page.run(`${lastMessage}.querySelectorAll(".bims.one .bim").length`), 1, "one image left, alone");
  await page.click(`.tr.bots > .bm:last-of-type .tile.gone .tile-open`);
  await sleep(300);
  check(!(await page.run(`!!document.querySelector(".bgp")`)), "a gone file opens nothing");
  await page.shot("08-gone");

  page.close();
  console.log("\n✔ a bot's files, images and questions work end to end");
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
