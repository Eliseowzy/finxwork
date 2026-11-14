#!/usr/bin/env node
// Quoting a message from the conversation (docs/desktop/message-quote-design.md): a selection's
// right-click menu, the hover bar's Quote, the composer and bubble tiles, what the model is told,
// the jump back with its light on the words, a quote whose message was taken back, and how a
// restored session's old messages are sent conservatively while new ones are not.
//
// A local model stands in for the provider and keeps what each request carried. Native menus go
// through the app's test hook (FINXWORK_E2E_MENU): items are written down and answered from a file.
//
// Runs the development build against the repository's target/debug/finx in a temporary FINX_HOME.
//
//   node apps/desktop/e2e/message-quote.mjs
//   FINXWORK_E2E_SHOTS=<folder> node apps/desktop/e2e/message-quote.mjs   also screenshots
//   FINXWORK_E2E_NO_BUILD=1 node apps/desktop/e2e/message-quote.mjs       with what is built already
import { cdpPort } from "./lib/port.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "../..");
const finx = path.join(root, "target/debug/finx");
const cargo = fs.existsSync(path.join(os.homedir(), ".cargo/bin/cargo")) ? path.join(os.homedir(), ".cargo/bin/cargo") : "cargo";
const electron = path.join(desktop, "node_modules/.bin/electron");
const shots = process.env.FINXWORK_E2E_SHOTS;
const step = (s) => console.log(`\n▶ ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => {
  throw new Error(message);
};
const check = (ok, message) => ok || fail(message);

const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxq-"));
const home = path.join(work, "finx");
// A private HOME: the app registers the extension's host in the browsers under it.
fs.mkdirSync(path.join(work, "home"), { recursive: true });
const profile = path.join(work, "profile");
const socket = path.join(home, "run/finx.sock");
const menus = path.join(work, "menus");
fs.mkdirSync(menus, { recursive: true });
fs.mkdirSync(home, { recursive: true });

// ── what the model answers ──
const PLAN = "第一步：先备份数据。第二步：检查依赖清单。第三步：先备份数据。第四步：灰度发布。第五步：观察指标。";
const PHRASE = "第三步：先备份数据。";
const LONG = "这是一段很长的回复，" + "指标正常，继续观察。".repeat(40);
const OLD = "旧".repeat(9000);
const requests = [];
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (!req.url?.endsWith("/chat/completions")) return res.writeHead(404).end();
    const messages = JSON.parse(body).messages.filter((m) => m.role !== "system");
    requests.push(messages);
    const said = partsOf(messages.filter((m) => m.role === "user").at(-1)).join("\n");
    const reply = said.includes("长回复") ? LONG : said.includes("方案") ? PLAN : "收到。";
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    chunk({ role: "assistant", content: reply });
    chunk({}, "stop");
    res.end(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`);
  });
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${provider.address().port}/v1`;
fs.writeFileSync(
  path.join(home, "models.toml"),
  `[providers.mock]\nname = "Mock"\napi = "openai-chat"\nbase_url = "${base}"\nauth = "none"\n\n[[providers.mock.models]]\nid = "mock-1"\nname = "Mock One"\ncontext_window = 128000\nmax_output_tokens = 20000\ninput = ["text", "image"]\n`,
);
fs.writeFileSync(path.join(home, "config.toml"), `model = "mock/mock-1"\n[models]\nnetwork = false\n`);

const textOf = (m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((c) => c.text ?? "").join(""));
const partsOf = (m) => (typeof m.content === "string" ? [m.content] : (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text));
const QUOTE_PREFACE = "The user is pointing at these earlier parts of this conversation";

/** The quote block a request carried: the last user message's, parsed. */
function quoteOf(messages) {
  const user = messages.filter((m) => m.role === "user").at(-1);
  const text = textOf(user);
  const at = text.indexOf(QUOTE_PREFACE);
  check(at >= 0, `no message quote block in the request: ${JSON.stringify(text.slice(0, 300))}`);
  const list = JSON.parse(text.slice(text.indexOf("[", at)));
  check(Array.isArray(list) && list.length === 1, `one quote expected, got ${JSON.stringify(list)}`);
  return list[0];
}

// ── a session restored from disk: an old long reply, a compaction, a newer reply ──
const info = { cwd: path.join(work, "proj"), id: crypto.randomUUID() };
fs.mkdirSync(info.cwd, { recursive: true });
const usage = { input: 1000, output: 100, cache_read: 0, cache_write: 0, cost: { currency: "USD", input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 } };
const cost = usage.cost;
{
  const hex = () => crypto.randomBytes(4).toString("hex");
  let parent = null;
  let ts = Date.now() - 300_000;
  const lines = [JSON.stringify({ type: "session", version: 2, id: info.id, created_at: new Date(ts).toISOString().replace(/\.\d+Z$/, "Z"), cwd: info.cwd, finx_version: "0.1.0" })];
  const add = (entry) => {
    const own = hex();
    lines.push(JSON.stringify({ id: own, parent, ts, ...entry }));
    parent = own;
    ts += 3000;
    return own;
  };
  const assistant = (id, text) => add({ type: "message", message: { role: "assistant", content: [{ type: "text", text }], provider: "mock", api: "openai-chat", model: "mock-1", response_id: hex(), usage, stop_reason: "stop", ts, duration_ms: 1000 } });
  add({ type: "system_prompt", text: "You are FinxWork.", tools: [], skills: [], mcp: "" });
  add({ type: "settings", model: "mock/mock-1", thinking: "off", permission_mode: "manual" });
  add({ type: "title", title: "压缩会话" });
  const task1 = hex();
  add({ type: "task", task_id: task1, status: "started" });
  add({ type: "message", message: { role: "user", content: [{ type: "text", text: "请写一个很长的方案" }], ts } });
  info.oldId = assistant(null, OLD);
  add({ type: "task", task_id: task1, status: "completed", reason: "done", usage: { per_model: { "mock/mock-1": usage } } });
  add({ type: "compaction", seq: 1, reason: "threshold", summary: "之前聊过一个很长的方案。", retained: [], model: "mock/mock-1", usage, tokens_before: 20_000, tokens_after: 500 });
  const task2 = hex();
  add({ type: "task", task_id: task2, status: "started" });
  add({ type: "message", message: { role: "user", content: [{ type: "text", text: "压缩之后再问一句" }], ts } });
  assistant(null, "压缩之后的一句话。");
  add({ type: "task", task_id: task2, status: "completed", reason: "done", usage: { per_model: { "mock/mock-1": usage } } });
  const dir = path.join(home, "sessions/2026/11/14");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${new Date(ts).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "")}-${info.id}.jsonl`), lines.join("\n") + "\n");
}

// ── the kernel, from another window: to take a message back the way a second window would ──
function finxCalls(calls) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(socket);
    let buf = "";
    let next = 0;
    const send = () => {
      const [method, params] = calls[next];
      s.write(JSON.stringify({ jsonrpc: "2.0", id: next + 2, method, params }) + "\n");
    };
    s.on("connect", () => s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocol_version: 2, client_info: { name: "e2e" } } }) + "\n"));
    s.on("data", (c) => {
      buf += c;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (msg.id === undefined) continue;
        if (msg.error) reject(new Error(`${msg.error.message}`));
        if (msg.id === 1) send();
        else if (++next === calls.length) {
          s.end();
          resolve(msg.result);
        } else send();
      }
    });
    s.on("error", reject);
    s.on("close", () => reject(new Error("the kernel closed the connection")));
  });
}

/** Every session log under the home, newest modified last. */
function logs() {
  const found = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith(".jsonl")) found.push(path.join(d, e.name));
    }
  };
  walk(path.join(home, "sessions"));
  return found.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}
/** The session being read: the log written to last. */
function openSession() {
  const files = logs();
  check(files.length > 0, "no session log yet");
  const lines = fs.readFileSync(files.at(-1), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { id: lines[0].id, lines: lines.slice(1) };
}
const entryWith = (words) => openSession().lines.find((e) => e.type === "message" && e.message?.role === "user" && textOf(e.message).includes(words));

// ── the app, driven over the DevTools protocol ──
let app = null;
let pageHandle = null;
async function launch() {
  const port = cdpPort();
  // A harness that runs this script inside Electron would otherwise start the app as plain Node.
  const env = { ...process.env, FINX_HOME: home, HOME: path.join(work, "home"), FINXWORK_DEFAULT_MODE: "sessions", FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINX_CREDENTIAL_STORE: "file", FINXWORK_E2E_MENU: menus };
  delete env.ELECTRON_RUN_AS_NODE;
  app = spawn(electron, [desktop, `--remote-debugging-port=${port}`], { env, stdio: ["ignore", "ignore", "inherit"] });
  let target;
  for (let i = 0; i < 300 && !target; i++) {
    await sleep(200);
    target = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => [])).find((t) => t.type === "page" && !t.url.includes("#settings") && !t.url.startsWith("devtools"));
  }
  check(target, "the main window never showed up");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  const waiting = new Map();
  let seq = 0;
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result);
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      waiting.set(++seq, { resolve, reject });
      ws.send(JSON.stringify({ id: seq, method, params }));
    });
  const run = async (expression) => {
    const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) fail(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const until = async (what, expression, ms = 30000) => {
    for (const end = Date.now() + ms; !(await run(`Boolean(${expression})`)); await sleep(60)) if (Date.now() > end) fail(`timed out waiting for ${what}`);
  };
  const shot = async (name) => {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    const { data } = await call("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, "base64"));
  };
  await call("Emulation.setFocusEmulationEnabled", { enabled: true });
  await call("Emulation.setDeviceMetricsOverride", { width: 1240, height: 860, deviceScaleFactor: 0, mobile: false });
  const page = { call, run, until, shot, close: () => ws.close() };
  pageHandle = page;
  return page;
}

async function quit() {
  pageHandle?.close();
  if (!app || app.exitCode !== null) return;
  const exited = new Promise((r) => app.once("exit", r));
  app.kill("SIGTERM");
  // A window still busy can outlast the polite signal.
  await Promise.race([exited, sleep(4000)]);
  if (app.exitCode === null) app.kill("SIGKILL");
}

const strings = Object.fromEntries(["en", "zh-CN"].map((l) => [l, JSON.parse(fs.readFileSync(path.join(desktop, "src/locales", l, "session.json"), "utf8"))]));
/** A label in either language, as page code compares it. */
const labels = (pick) => JSON.stringify(Object.values(strings).map(pick));

let failed = false;
try {
  if (!process.env.FINXWORK_E2E_NO_BUILD) {
    step("building finx and the app");
    execFileSync(cargo, ["build", "-p", "finx-cli"], { cwd: root, stdio: "inherit" });
    execFileSync("pnpm", ["--dir", desktop, "build"], { stdio: "inherit" });
  }
  const page = await launch();
  const { run, until } = page;
  const idle = `${labels((s) => s.composer.reply)}.includes(document.querySelector(".cmp-in")?.getAttribute("aria-placeholder"))`;
  const composer = `document.querySelector(".cmp-in").innerText.trim()`;
  const tiles = `[...document.querySelectorAll(".cmp-att .tile.said")]`;
  const menuItems = () => {
    const lines = fs.readFileSync(path.join(menus, "shown.jsonl"), "utf8").trim().split("\n");
    return JSON.parse(lines.at(-1));
  };
  /** Right-clicks the selection in the conversation and takes `pick` from the menu it shows. */
  const contextMenu = async (pick) => {
    const shown = fs.existsSync(path.join(menus, "shown.jsonl")) ? fs.statSync(path.join(menus, "shown.jsonl")).size : 0;
    if (pick) fs.writeFileSync(path.join(menus, "pick"), pick);
    await run(`document.querySelector(".dwrap").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
    await until("the menu", `true`);
    for (let i = 0; i < 100 && (!fs.existsSync(path.join(menus, "shown.jsonl")) || fs.statSync(path.join(menus, "shown.jsonl")).size === shown); i++) await sleep(30);
    return menuItems();
  };
  /** Selects `text` in the last reply that has it. */
  const select = (text) =>
    run(`(() => {
      const walk = document.createTreeWalker(document.querySelector(".dwrap"), NodeFilter.SHOW_TEXT);
      for (let n; (n = walk.nextNode());) {
        const at = n.data.indexOf(${JSON.stringify(text)});
        if (at < 0) continue;
        const r = document.createRange();
        r.setStart(n, at);
        r.setEnd(n, at + ${JSON.stringify(text)}.length);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        return true;
      }
      return false;
    })()`);
  const type = async (text) => {
    await run(`document.querySelector(".cmp-in").focus()`);
    const first = text[0];
    await page.call("Input.dispatchKeyEvent", { type: "keyDown", key: first, text: first, unmodifiedText: first });
    await page.call("Input.dispatchKeyEvent", { type: "keyUp", key: first });
    if (text.length > 1) await page.call("Input.insertText", { text: text.slice(1) });
  };
  const send = async (text) => {
    const before = requests.length;
    await type(text);
    await until("send enabled", `!document.querySelector("button.send")?.disabled`);
    await page.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await page.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    for (let i = 0; i < 300 && requests.length === before; i++) await sleep(50);
    check(requests.length > before, "the model never got the message");
    await until("the task ended", idle, 30000);
    return requests.at(-1);
  };
  /** The hover bar's Quote, on the row whose words are `text` (or the last reply when omitted). */
  const quoteFromBar = async (text) => {
    const picked = await run(`(() => {
      const bars = [...document.querySelectorAll(".vrow")].map((r) => ({ r, b: r.querySelector(".msg-act") })).filter((x) => x.b);
      const hit = ${text === undefined ? "bars.at(-1)" : `bars.find((x) => x.r.textContent.includes(${JSON.stringify(text)}))`};
      if (!hit) return false;
      const quote = ${labels((s) => s.chat.quote)};
      const b = [...hit.b.querySelectorAll("button")].find((el) => quote.includes(el.getAttribute("aria-label")));
      if (!b) return false;
      b.click();
      return true;
    })()`);
    check(picked, `no Quote on the bar of ${text ?? "the last reply"}`);
  };
  const open = async (title) => {
    await until(`the row of ${title}`, `[...document.querySelectorAll("aside *, [class*=side] *")].find((e) => e.children.length === 0 && e.textContent.trim() === ${JSON.stringify(title)})`);
    await run(`[...document.querySelectorAll("aside *, [class*=side] *")].find((e) => e.children.length === 0 && e.textContent.trim() === ${JSON.stringify(title)}).click()`);
    await until(`${title} open`, `document.querySelector(".ctitle")?.textContent.includes(${JSON.stringify(title)}) && document.querySelectorAll("[data-step-key]").length > 0`);
  };

  await until("the app", `document.querySelector(".cmp-in")`);
  await page.shot("01-app");

  // ── a restored session: the old message goes conservatively, a new one is known ──
  step("a restored session's old message is sent conservatively; one after the snapshot is not");
  await open("压缩会话");
  await run(`document.querySelector(".cscroll").scrollTop = 0`);
  await until("the old long reply drawn", `[...document.querySelectorAll(".vrow>.am .md")].some((m) => m.textContent.length > 8000)`);
  await quoteFromBar("旧");
  await until("the composer's tile", `${tiles}.length === 1`);
  let got = await send("这条旧回复怎么看");
  let quote = quoteOf(got);
  check(quote.whole === true, "a whole quote from the bar");
  check(quote.cut === true && quote.excerpt === undefined, `the old message should be cut: ${JSON.stringify(quote).slice(0, 200)}`);
  check(Array.from(quote.text).length <= 8000, `cut to 8000 at most, got ${Array.from(quote.text).length}`);
  check(quote.key === `${info.oldId}:0`, `the old message's step key, got ${quote.key}`);

  step("a reply that came after the snapshot is still in the context");
  got = await send("再给我一段长回复");
  check(textOf(got.filter((m) => m.role === "user").at(-1)).includes("长回复"), "the request was the long reply's");
  await until("the long reply drawn", `[...document.querySelectorAll(".vrow")].some((r) => r.textContent.includes("这是一段很长的回复"))`);
  await quoteFromBar("这是一段很长的回复");
  await until("the composer's tile", `${tiles}.length === 1`);
  got = await send("这段整体看呢");
  quote = quoteOf(got);
  check(quote.whole === true, "a whole quote from the bar");
  check(quote.excerpt === true && quote.cut === undefined, `the fresh message should be an excerpt: ${JSON.stringify(quote).slice(0, 200)}`);
  check(Array.from(quote.text).length <= 200, `at most 200 characters, got ${Array.from(quote.text).length}`);
  check(LONG.startsWith(quote.text.replace(/…$/, "")), "the excerpt is the start of the reply");
  await page.shot("02-excerpt-sent");

  // ── a fragment by right-click, sent, and its light on the words ──
  step("a selected part is quoted from the right-click menu");
  await send("写一份方案");
  await until("the plan drawn", `[...document.querySelectorAll(".md")].some((m) => m.textContent.includes(${JSON.stringify(PHRASE)}))`);
  const menu = await select(PHRASE).then(() => contextMenu());
  const ids = menu.filter((m) => m.id).map((m) => m.id);
  check(ids[0] === "copySel" && ids[1] === "quoteSel", `copy then quote first, got ${JSON.stringify(ids)}`);
  check(["引用", "Quote"].includes(menu[1].label), `the label says Quote, got ${menu[1].label}`);
  await contextMenu("quoteSel");
  await until("the composer's tile", `${tiles}.length === 1`);
  await until("the caret back in the composer", `document.activeElement?.closest(".cmp") !== null`);
  const name = await run(`${tiles}[0].textContent`);
  check(name.includes(PHRASE), `the tile names the words, got ${name}`);
  if (shots) {
    // The pointer over the card shows its words (§4.4).
    const box = await run(`(() => { const r = ${tiles}[0].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
    await sleep(300);
    await page.shot("03-composer-tile");
    await page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 10, y: 10 });
  }
  got = await send("这一步展开讲");
  quote = quoteOf(got);
  check(quote.whole === undefined && quote.excerpt === undefined && quote.cut === undefined, `a plain fragment quote: ${JSON.stringify(quote)}`);
  check(quote.text === PHRASE, `the selection's words, got ${JSON.stringify(quote.text)}`);
  check(/^[0-9a-f]+:0$/.test(quote.key), `the reply's step key, got ${quote.key}`);
  await page.shot("03-fragment-sent");

  step("the card in the sent bubble goes back to the words and lights them");
  await until("the fragment's message drawn", `[...document.querySelectorAll(".um")].some((u) => u.querySelector(".bub")?.textContent === "这一步展开讲" && u.querySelector(".um-att .tile.said"))`);
  const card = `[...document.querySelectorAll(".um")].find((u) => u.querySelector(".bub")?.textContent === "这一步展开讲").querySelector(".um-att .tile.said .tile-open")`;
  await run(`${card}.click()`);
  await until("the light on the words", `CSS.highlights.has("finx-quote")`, 8000);
  const lit = await run(`[...CSS.highlights.get("finx-quote")].map((r) => r.toString()).join("")`);
  check(lit === PHRASE, `the quoted words are lit, got ${JSON.stringify(lit)}`);
  await page.shot("04-highlight");
  await until("the light gone", `!CSS.highlights.has("finx-quote")`, 8000);

  step("a whole reply's card flashes its message");
  await run(`document.querySelector(".cscroll").scrollTop = document.querySelector(".cscroll").scrollHeight`);
  await until("the first quoted message drawn", `[...document.querySelectorAll(".um")].some((u) => u.querySelector(".bub")?.textContent === "这条旧回复怎么看" && u.querySelector(".um-att .tile.said"))`);
  await run(`[...document.querySelectorAll(".um")].find((u) => u.querySelector(".bub")?.textContent === "这条旧回复怎么看").querySelector(".um-att .tile.said .tile-open").click()`);
  let flashed = false;
  for (let i = 0; i < 40 && !flashed; i++) {
    flashed = (await run(`!!document.querySelector(".vrow.qflash")`)) === true;
    if (!flashed) await sleep(50);
  }
  check(flashed, "the message flashed when jumped back to");

  await run(`document.querySelector(".cscroll").scrollTop = document.querySelector(".cscroll").scrollHeight`);
  await until("the sent messages drawn", `document.querySelectorAll(".um-att .tile.said").length > 0`);
  // ── a selection that crosses messages, and one on a tile, are not quoted ──
  step("a selection across two messages offers only Copy");
  const cross = await run(`(() => {
    const rows = [...document.querySelectorAll(".vrow>.am .md")];
    const a = rows.at(-3), b = rows.at(-2);
    if (!a || !b) return false;
    const r = document.createRange();
    const first = document.createTreeWalker(a, NodeFilter.SHOW_TEXT).nextNode();
    const last = document.createTreeWalker(b, NodeFilter.SHOW_TEXT).nextNode();
    if (!first || !last) return false;
    r.setStart(first, 0);
    r.setEnd(last, Math.min(3, last.data.length));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    return true;
  })()`);
  check(cross, "a selection across rows");
  let crossMenu = await contextMenu();
  check(crossMenu.filter((m) => m.id).map((m) => m.id).join() === "copySel", `only copy, got ${JSON.stringify(crossMenu)}`);

  step("a selection on an attachment's words offers only Copy");
  await run(`document.querySelector(".cscroll").scrollTop = document.querySelector(".cscroll").scrollHeight`);
  const onTile = await run(`(() => {
    const tile = [...document.querySelectorAll(".um-att .tile.said")].at(-1);
    const name = tile.querySelector(".tile-name");
    const node = document.createTreeWalker(name, NodeFilter.SHOW_TEXT).nextNode();
    if (!node) return false;
    const r = document.createRange();
    r.setStart(node, 0);
    r.setEnd(node, Math.min(4, node.data.length));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    return true;
  })()`);
  check(onTile, "a selection on the tile");
  crossMenu = await contextMenu();
  check(crossMenu.filter((m) => m.id).map((m) => m.id).join() === "copySel", `only copy on a tile, got ${JSON.stringify(crossMenu)}`);
  await page.shot("06-only-copy");

  step("a sent message written again brings its quote back");
  await run(`document.querySelector(".cscroll").scrollTop = document.querySelector(".cscroll").scrollHeight`);
  await until("the quoted message drawn", `[...document.querySelectorAll(".um .bub")].some((b) => b.textContent === "这一步展开讲")`);
  const quoted = await run(`(() => {
    const row = [...document.querySelectorAll(".um")].find((u) => u.querySelector(".bub")?.textContent === "这一步展开讲");
    const again = ${labels((s) => s.chat.resend)};
    const b = [...row.querySelector(".msg-act").querySelectorAll("button")].find((el) => again.includes(el.getAttribute("aria-label")));
    b?.click();
    return !!b;
  })()`);
  check(quoted, "the message can be written again");
  await until("the quote back in the composer", `${tiles}.length === 1 && ${composer}.includes("这一步展开讲")`);
  await page.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });

  step("a quote whose message was taken back is grey and opens nothing");
  await quoteFromBar("写一份方案");
  await until("the composer's tile", `${tiles}.length === 1`);
  const target = entryWith("写一份方案");
  check(target, "the quoted message is in the log");
  const session = openSession().id;
  await finxCalls([
    ["session/attach", { session_id: session }],
    ["session/op", { session_id: session, op: { type: "resend", message_id: target.id, input: [{ type: "text", text: "改写这一条" }] } }],
  ]);
  await until("the tile greyed", `document.querySelector(".cmp-att .tile.said.gone")`, 15000);
  // The rewritten message's rows settle before where the conversation sits can be judged.
  await until("the rewritten task ended", idle);
  await sleep(400);
  const scroll = await run(`document.querySelector(".cscroll").scrollTop`);
  await run(`document.querySelector(".cmp-att .tile.said.gone .tile-open").click()`);
  await sleep(400);
  check((await run(`CSS.highlights.has("finx-quote")`)) === false, "a grey card lights nothing");
  check(Math.abs((await run(`document.querySelector(".cscroll").scrollTop`)) - scroll) < 2, "a grey card goes nowhere");
  await page.shot("05-gone");

  step("done");
  console.log("\n✅ message quotes: menu, composer, bubble, model content, jump, grey, copy-only");
} catch (error) {
  failed = true;
  console.error(`\n\u2718 ${error.message}`);
} finally {
  await quit();
  await finxCalls([["server/shutdown", {}]]).catch(() => {});
  provider.close();
  if (!failed) {
    // Telling the hook's folder apart from a real person's menu.
    console.log(`menus: ${menus}`);
    fs.rmSync(work, { recursive: true, force: true });
  } else console.error(`  kept ${work} (finx's log is in finx/logs)`);
}
process.exit(failed ? 1 : 0);
