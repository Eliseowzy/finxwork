#!/usr/bin/env node
// The conversation page over a long session, in the real app with real finx: a generated log and a
// local model that answers after a pause. What it checks broke silently before: following the end
// after a message is sent, the bar under earlier replies, going back to a session, and what a running
// task costs the page while its model says nothing.
//
//   node apps/desktop/e2e/conversation.mjs
//   FINXWORK_E2E_NO_BUILD=1 node apps/desktop/e2e/conversation.mjs   with what is built already
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fxconv-")));
const home = path.join(work, "finx");
const project = path.join(work, "proj");
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(path.join(work, "home"), { recursive: true });

// ── a session of many tasks: a message, a call with its result, a reply ──
function writeSession(title, tasks) {
  const id = crypto.randomUUID();
  const hex = () => crypto.randomBytes(4).toString("hex");
  let parent = null;
  let ts = Date.now() - tasks * 60_000;
  const lines = [JSON.stringify({ type: "session", version: 2, id, created_at: new Date(ts).toISOString().replace(/\.\d+Z$/, "Z"), cwd: project, finx_version: "0.1.0" })];
  const add = (entry) => {
    const own = hex();
    lines.push(JSON.stringify({ id: own, parent, ts, ...entry }));
    parent = own;
    ts += 3000;
  };
  const cost = { currency: "USD", input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 };
  const usage = { input: 1000, output: 100, cache_read: 0, cache_write: 0, reasoning: 0, cost };
  const assistant = (content) => add({ type: "message", message: { role: "assistant", content, provider: "mock", api: "openai-chat", model: "mock-1", response_id: hex(), usage, stop_reason: "stop", ts, duration_ms: 1000 } });
  add({ type: "system_prompt", text: "You are FinxWork.", tools: [], skills: [], mcp: "" });
  add({ type: "settings", model: "mock/mock-1", thinking: "off", permission_mode: "manual" });
  for (let t = 0; t < tasks; t++) {
    const task = hex();
    add({ type: "task", task_id: task, status: "started" });
    add({ type: "message", message: { role: "user", content: [{ type: "text", text: t === 0 ? title : `第 ${t} 个问题` }], ts } });
    assistant([{ type: "text", text: "先看一下。" }, { type: "tool_call", id: `call_${t}`, name: "read", arguments: { path: "README.md" } }]);
    add({ type: "message", message: { role: "tool_result", call_id: `call_${t}`, tool_name: "read", content: [{ type: "text", text: "内容" }], is_error: false, ts, duration_ms: 100 } });
    // Tall enough that a reply that loses its size moves the conversation by far more than the end's margin.
    assistant([{ type: "text", text: `## 第 ${t} 次回复\n\n` + "这是一段说明文字，模型写完了它。\n\n".repeat(30) + "| 指标 | 数值 |\n|:--|--:|\n| 收入 | 1.5 |" }]);
    add({ type: "task", task_id: task, status: "completed", reason: "done", usage: { per_model: { "mock/mock-1": usage } } });
  }
  const dir = path.join(home, "sessions/2026/11/05");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${new Date(ts).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "")}-${id}.jsonl`), lines.join("\n") + "\n");
}
writeSession("长会话", 120);
writeSession("短会话", 2);

// ── the model: says nothing for `silence` ms, then a line ──
let silence = 200;
let replied = () => {};
const provider = http.createServer((req, res) => {
  req.resume();
  req.on("end", async () => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    await sleep(silence);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "收到。" }, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`);
    replied();
  });
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
fs.writeFileSync(path.join(home, "models.toml"), `[providers.mock]\nname = "Mock"\napi = "openai-chat"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nauth = "none"\n\n[[providers.mock.models]]\nid = "mock-1"\nname = "Mock One"\ncontext_window = 128000\nmax_output_tokens = 2000\n`);
fs.writeFileSync(path.join(home, "config.toml"), `model = "mock/mock-1"\n[models]\nnetwork = false\n`);

if (!process.env.FINXWORK_E2E_NO_BUILD) {
  execFileSync("cargo", ["build", "-p", "finx-cli"], { cwd: root, stdio: "inherit" });
  execFileSync("pnpm", ["--dir", desktop, "build"], { stdio: "inherit" });
}
const port = 9400 + Math.floor(Math.random() * 400);
const app = spawn(path.join(desktop, "node_modules/.bin/electron"), [desktop, `--remote-debugging-port=${port}`, "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"], {
  env: { ...process.env, FINX_HOME: home, HOME: path.join(work, "home"), FINXWORK_DEFAULT_MODE: "sessions", FINXWORK_USER_DATA: path.join(work, "profile"), FINXWORK_FINX: path.join(root, "target/debug/finx"), FINX_CREDENTIAL_STORE: "file" },
  stdio: ["ignore", "ignore", "inherit"],
});
let socket;
let failed = false;
try {
  let page;
  for (let i = 0; i < 300 && !page; i++) {
    await sleep(200);
    page = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => [])).find((t) => t.type === "page" && !t.url.includes("#settings") && !t.url.startsWith("devtools"));
  }
  assert.ok(page, "the main window never showed up");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => ((socket.onopen = r), (socket.onerror = j)));
  let seq = 0;
  const waiting = new Map();
  socket.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result);
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    waiting.set(++seq, { resolve, reject });
    socket.send(JSON.stringify({ id: seq, method, params }));
  });
  const run = async (expression) => {
    const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (what, expression, ms = 30000) => {
    for (const end = Date.now() + ms; !(await run(`Boolean(${expression})`)); await sleep(60)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
  };
  const scroller = `document.querySelector(".cscroll.markdown-chat")`;
  const below = () => run(`(() => { const el = ${scroller}; return Math.round(el.scrollHeight - el.scrollTop - el.clientHeight); })()`);
  const rows = `document.querySelectorAll("[data-step-key]").length`;
  const open = async (title) => {
    await until(`the row of ${title}`, `[...document.querySelectorAll("aside *, [class*=side] *")].find((e) => e.children.length === 0 && e.textContent.trim() === ${JSON.stringify(title)})`);
    await run(`[...document.querySelectorAll("aside *, [class*=side] *")].find((e) => e.children.length === 0 && e.textContent.trim() === ${JSON.stringify(title)}).click()`);
    await until(`${title} open`, `document.querySelector(".ctitle")?.textContent.includes(${JSON.stringify(title)}) && ${rows} > 0`);
  };
  const send = async () => {
    await run(`document.querySelector(".cmp-in").focus()`);
    await call("Input.insertText", { text: "继续" });
    const done = new Promise((r) => (replied = r));
    await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    return done;
  };
  await call("Performance.enable");
  await call("Emulation.setFocusEmulationEnabled", { enabled: true });
  await call("Emulation.setDeviceMetricsOverride", { width: 1240, height: 860, deviceScaleFactor: 0, mobile: false });
  await until("the app", `document.querySelector(".cmp-in")`);

  // Rows settle their heights while it opens, and how far that moves it depends on the timing: several times.
  for (let i = 0; i < 5; i++) {
    await open(i % 2 ? "短会话" : "长会话");
    await sleep(500 + i * 200);
    const left = await below();
    if (i % 2 === 0) assert.ok(left < 80, `opened ${left}px from the end`);
  }

  console.log("▶ a sent message and its reply stay in view");
  for (let i = 0; i < 2; i++) {
    await send();
    await sleep(700);
    const left = await below();
    assert.ok(left < 80, `${left}px below the end after message ${i + 1}`);
  }

  console.log("▶ going up while a reply comes in stays where the person went, until they go back");
  silence = 1500;
  const coming = send();
  await sleep(500);
  const box = await run(`(() => { const r = ${scroller}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  for (let i = 0; i < 6; i++) await call("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: -240 });
  await sleep(300);
  const away = await run(`${scroller}.scrollTop`);
  await coming;
  await sleep(600);
  assert.ok((await below()) > 240, "the reply pulled the conversation back to its end");
  assert.ok(Math.abs((await run(`${scroller}.scrollTop`)) - away) < 80, "the reply moved what the person was reading");
  await until("the way back", `document.querySelector(".tobottom.on")`);
  await run(`document.querySelector(".tobottom").click()`);
  await until("back at the end", `${scroller}.scrollHeight - ${scroller}.scrollTop - ${scroller}.clientHeight < 80`);
  silence = 200;
  await send();
  await sleep(700);
  assert.ok((await below()) < 80, "going back to the end follows again");

  console.log("▶ the bar under an earlier reply can be reached");
  const hit = await run(`(() => {
    const row = [...document.querySelectorAll(".tr>.am")].filter((r) => r.querySelector(".msg-act")).at(-2);
    row.scrollIntoView({ block: "center" });
    const bar = row.querySelector(".msg-act").getBoundingClientRect();
    return !!document.elementFromPoint(bar.left + 10, bar.top + bar.height / 2)?.closest(".msg-act");
  })()`);
  assert.ok(hit, "the reply's containment cuts off its bar");
  await run(`${scroller}.scrollTop = ${scroller}.scrollHeight`);
  await sleep(500);

  console.log("▶ a running task costs the page nothing while its model is silent");
  silence = 5000;
  const silent = send();
  await sleep(1200);
  const metrics = async () => Object.fromEntries((await call("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  const before = await metrics();
  await sleep(3000);
  const after = await metrics();
  const script = (after.ScriptDuration - before.ScriptDuration) * 1000;
  // A mark drawn over and over took about 250 ms here; this allows for a busy machine.
  assert.ok(script < 60, `${Math.round(script)} ms of script in 3 s with nothing arriving`);
  const moving = await run(`document.getAnimations().filter((a) => a.effect.getKeyframes().some((k) => Object.keys(k).some((p) => p.startsWith("mask") || p.startsWith("webkitMask")))).length`);
  assert.equal(moving, 0, "an animation that only the main thread can run");
  console.log(`  ${Math.round(script)} ms of script in 3 s`);
  await silent;
  silence = 200;
  await sleep(500);

  console.log("▶ going back to a session draws its latest page, not all that was loaded");
  await run(`(async () => {
    const el = ${scroller};
    for (let i = 0; i < 1200 && ${rows} < 300; i++) { el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 })); el.scrollTop = 0; await new Promise((r) => setTimeout(r, 30)); }
  })()`);
  const loaded = await run(rows);
  assert.ok(loaded >= 300, `only ${loaded} rows of history came`);
  await open("短会话");
  await run(`window.__most = 0; new MutationObserver(() => { window.__most = Math.max(window.__most, ${rows}); }).observe(document.body, { childList: true, subtree: true })`);
  await open("长会话");
  await sleep(800);
  const most = await run("window.__most");
  assert.ok(most < 150, `${most} rows drawn on going back, of ${loaded} loaded`);

  console.log(`✔ the conversation follows, its bars show, a silent task costs little, going back draws ${most} of ${loaded} rows`);
} catch (e) {
  failed = true;
  console.error(`✘ ${e.message}\n  kept ${work}`);
} finally {
  socket?.close();
  app.kill("SIGTERM");
  await sleep(1000);
  try { execFileSync("pkill", ["-f", `remote-debugging-port=${port}`]); } catch {}
  provider.close();
  if (!failed) fs.rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
