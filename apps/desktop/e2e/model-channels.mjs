#!/usr/bin/env node
// What people meet when a channel's models come through the kernel's one merge
// (model-catalog-design §18): the composer's thinking menu shows only the levels
// a model can really take, for models the plan's list named, and what is chosen
// reaches the provider the way that model takes it.
//
// Runs the development build against the repository's target/debug/finx in a
// temporary FINX_HOME and profile, with a server on this Mac standing in for the
// Bailian Token Plan. The window shows up while it runs. Under a minute once built.
//
//   node apps/desktop/e2e/model-channels.mjs
//   FINXWORK_E2E_SHOTS=<folder> node apps/desktop/e2e/model-channels.mjs   also screenshots
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
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const step = (s) => console.log(`\n▶ ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => {
  throw new Error(message);
};
const check = (ok, message) => ok || fail(message);

// Short: the kernel's socket lives under it, and a socket path has at most 103 bytes.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxc-"));
const home = path.join(work, "finx");
const profile = path.join(work, "profile");
const socket = path.join(home, "run/finx.sock");

// The plan: an OpenAI-style server that remembers what each request asked for.
const asked = [];
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (!req.url?.endsWith("/chat/completions")) return res.writeHead(404).end();
    const { messages: _messages, tools: _tools, ...controls } = JSON.parse(body);
    asked.push(controls);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = { choices: [{ index: 0, delta: { role: "assistant", content: "pong" }, finish_reason: null }] };
    const end = { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } };
    res.end(`data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`);
  });
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${provider.address().port}/v1`;

fs.mkdirSync(path.join(home, "models/lists"), { recursive: true });
fs.writeFileSync(path.join(home, "models.toml"), `[providers.bailian-token-plan]\nbase_url = "${base}"\n`);
fs.writeFileSync(path.join(home, "config.toml"), `model = "bailian-token-plan/glm-5.3"\n[models]\nnetwork = false\n`);
// The plan's own list, as a saved key's check leaves it: only ids, and not all of them chat.
fs.writeFileSync(
  path.join(home, "models/lists/bailian-token-plan.json"),
  JSON.stringify({
    version: 1,
    fetched_at: new Date().toISOString(),
    checked_at: new Date().toISOString(),
    source: "provider",
    models: ["glm-5.3", "qwen3.8-max", "qwen3.7-max", "deepseek-v4.1-flash-1017", "wan2.7-image"].map((id) => ({ id })),
  }),
);

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
  app = spawn(electron, [desktop, `--remote-debugging-port=${port}`], {
    env: { ...process.env, FINX_HOME: home, FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINX_CREDENTIAL_STORE: "file", BAILIAN_TOKEN_PLAN_API_KEY: "sk-e2e" },
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
      await sleep(150);
    }
  };
  const shot = async (name) => {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, "base64"));
  };
  // Electron's DevTools cannot size the window; the page's viewport is made that narrow instead (it gets a resize, as from the window).
  const resize = (width, height) => cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 0, mobile: false });
  return { cdp, run, until, shot, resize, close: page.close };
}

/** A DevTools connection: `call` sends a command and resolves to its result. */
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

const locale = (l, file) => JSON.parse(fs.readFileSync(path.join(desktop, "src/locales", l, `${file}.json`), "utf8"));
const modelTitles = ["en", "zh-CN"].map((l) => locale(l, "session").composer.model);
const thinkingTitles = ["en", "zh-CN"].map((l) => locale(l, "session").composer.thinking);
const picker = `[...document.querySelectorAll("button.mb")].find((b) => ${JSON.stringify(modelTitles)}.includes(b.title))`;
const row = (text) => `[...document.querySelectorAll("button.mi")].find((b) => b.textContent.startsWith(${JSON.stringify(text)}))`;

/** The rows of the thinking submenu, with the menu open: their level labels, in order. */
const levelsOf = async (page) => {
  await page.run(`[...document.querySelectorAll("button.mi")].find((b) => ${JSON.stringify(thinkingTitles)}.some((t) => b.textContent.startsWith(t)) || b.title && ${JSON.stringify(thinkingTitles)}.includes(b.title)).click()`);
  await page.until("the thinking submenu", `document.querySelectorAll(".vmenu").length >= 2`);
  await sleep(100);
  return page.run(`[...[...document.querySelectorAll(".vmenu")].at(-1).querySelectorAll("button.mi")].map((b) => b.textContent.trim())`);
};

let failed = false;
try {
  if (!process.env.FINXWORK_E2E_NO_BUILD) {
    step("building finx and the app");
    sh("cargo", ["build", "-p", "finx-cli"], { cwd: root });
    sh("pnpm", ["--dir", desktop, "build"]);
  }

  step("the plan's models carry what the catalog says about each");
  const page = await launch();
  await page.until("the new session page", `!!document.querySelector(".cmp-in")`);
  await page.until("the plan's GLM-5.3 in the picker", `(${picker})?.textContent.includes("GLM-5.3")`);
  const models = (await finxCall("models/list")).result.models.filter((m) => m.provider === "bailian-token-plan");
  const levels = (id) => models.find((m) => m.id === `bailian-token-plan/${id}`)?.thinking_levels;
  check(JSON.stringify(levels("glm-5.3")) === '["low","high","max"]', `glm-5.3 offers ${levels("glm-5.3")}`);
  check(JSON.stringify(levels("qwen3.8-max")) === '["off","low","medium","xhigh"]', `qwen3.8-max offers ${levels("qwen3.8-max")}`);
  check(JSON.stringify(levels("deepseek-v4.1-flash-1017")) === '["off","low","high","max"]', `the dated build offers ${levels("deepseek-v4.1-flash-1017")}`);
  check(!models.some((m) => m.id.endsWith("wan2.7-image")), "a model that does not chat is listed");

  // Labels in the app's language: the kernel's levels, as the menu words them.
  const words = await page.run(`document.documentElement.lang`).then((lang) => locale(lang?.startsWith("zh") ? "zh-CN" : "en", "common").thinking);
  const expect = (levels) => [words.default, ...levels.map((l) => words[l])];

  step("GLM-5.3 always thinks: its menu has no way to switch it off");
  await page.run(`(${picker}).click()`);
  await page.until("the model menu", `!!${row("GLM-5.3")}`);
  const glm = await levelsOf(page);
  await page.shot("1-glm-levels");
  check(expect(["low", "high", "max"]).every((w) => glm.some((r) => r.startsWith(w))), `GLM-5.3's levels: ${glm}`);
  check(glm.length === 4 && !glm.some((r) => r.startsWith(words.off)), `GLM-5.3's levels: ${glm}`);

  step("choosing High on it and sending: the effort reaches the plan, and no switch");
  await page.run(`[...[...document.querySelectorAll(".vmenu")].at(-1).querySelectorAll("button.mi")].find((b) => b.textContent.trim().startsWith(${JSON.stringify(words.high)})).click()`);
  await page.until("the level beside the model", `(${picker}).textContent.includes(${JSON.stringify(words.high)})`);
  await page.run(`document.querySelector(".cmp-in").focus()`);
  await page.cdp("Input.insertText", { text: "ping" });
  await page.until("send enabled", `!document.querySelector("button.send")?.disabled`);
  await page.run(`document.querySelector("button.send").click()`);
  await page.until("the reply", `document.body.innerText.includes("pong")`);
  const first = asked.at(-1);
  check(first.model === "glm-5.3" && first.reasoning_effort === "high", `the plan was asked ${JSON.stringify(first)}`);
  check(!("enable_thinking" in first) && !("thinking_budget" in first), `the plan was asked ${JSON.stringify(first)}`);
  await page.shot("2-sent");

  step("Qwen3.8-Max in the same session: its own levels, its switch and effort");
  await page.run(`(${picker}).click()`);
  await page.until("the model menu", `!!${row("Qwen3.8-Max")}`);
  await page.run(`${row("Qwen3.8-Max")}.click()`);
  await page.until("Qwen3.8-Max chosen", `(${picker}).textContent.includes("Qwen3.8-Max")`);
  await page.run(`(${picker}).click()`);
  await page.until("the model menu", `!!${row("Qwen3.8-Max")}`);
  const qwen = await levelsOf(page);
  await page.shot("3-qwen-levels");
  check(expect(["off", "low", "medium", "xhigh"]).every((w) => qwen.some((r) => r.startsWith(w))), `Qwen3.8-Max's levels: ${qwen}`);
  await page.run(`[...[...document.querySelectorAll(".vmenu")].at(-1).querySelectorAll("button.mi")].find((b) => b.textContent.trim().startsWith(${JSON.stringify(words.xhigh)})).click()`);
  await page.until("the level beside the model", `(${picker}).textContent.includes(${JSON.stringify(words.xhigh)})`);
  const before = asked.length;
  await page.run(`document.querySelector(".cmp-in").focus()`);
  await page.cdp("Input.insertText", { text: "ping again" });
  await page.until("send enabled", `!document.querySelector("button.send")?.disabled`);
  await page.run(`document.querySelector("button.send").click()`);
  for (let i = 0; i < 100 && asked.length === before; i++) await sleep(100);
  const second = asked.at(-1);
  check(second.model === "qwen3.8-max" && second.reasoning_effort === "xhigh" && second.enable_thinking === true, `the plan was asked ${JSON.stringify(second)}`);
  check(!("thinking_budget" in second), `a budget would keep it below its default: ${JSON.stringify(second)}`);
  await page.shot("4-sent");
  page.close();
  console.log("\n✔ the menu shows the levels each model can take; what is chosen reaches the provider the way it takes it");
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
