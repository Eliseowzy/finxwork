#!/usr/bin/env node
// A model whose local connection is gone (desktop-design P15), the way people
// meet it: a new session's model is a local connection's, the app quits, the
// connection is removed, and the next new session is sent from the reopened
// app. The page must start it on the default model, never show finx's raw
// error, and the toast must stay inside a narrow window.
//
// Runs the development build (electron-vite build) against the repository's
// target/debug/finx in a temporary FINX_HOME and profile, with a model server
// on this Mac standing in for the provider, so the person's own finxwork, its
// settings and their finx are not touched. The window shows up while it runs.
// Takes under a minute once built.
//
//   node apps/desktop/e2e/stale-model.mjs
//   FINXWORK_E2E_SHOTS=<folder> node apps/desktop/e2e/stale-model.mjs   also screenshots
import { cdpPort } from "./lib/port.mjs";
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
const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxs-"));
const home = path.join(work, "finx");
// A private HOME: the app registers the extension's host in the browsers under it.
fs.mkdirSync(path.join(work, "home"), { recursive: true });
const profile = path.join(work, "profile");
const socket = path.join(home, "run/finx.sock");
const connection = "35e57942-0000-4000-8000-00000000e2e0";
const flash = `local-${connection}/flash`;

// The provider: an OpenAI-style server that answers every request with one line.
const asked = [];
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (!req.url?.endsWith("/chat/completions")) return res.writeHead(404).end();
    asked.push(JSON.parse(body).model);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = { choices: [{ index: 0, delta: { role: "assistant", content: "pong" }, finish_reason: null }] };
    const end = { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } };
    res.end(`data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`);
  });
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${provider.address().port}/v1`;

fs.mkdirSync(path.join(home, "connections"), { recursive: true });
fs.writeFileSync(
  path.join(home, "models.toml"),
  `[providers.mock]\nname = "Mock"\napi = "openai-chat"\nbase_url = "${base}"\nauth = "none"\n\n[[providers.mock.models]]\nid = "mock-1"\nname = "Mock One"\ncontext_window = 128000\nmax_output_tokens = 2000\n`,
);
fs.writeFileSync(path.join(home, "config.toml"), `model = "mock/mock-1"\n[models]\nnetwork = false\n`);
// A QwenWork connection written before provider IDs were kept: its models are `local-<connection_id>/…`, as in the report.
fs.writeFileSync(
  path.join(home, "connections/config.json"),
  JSON.stringify({
    schema: 1,
    connections: [{ connection_id: connection, adapter_id: "qwenwork", identity_key: "e2e", enabled: true, idempotency_key: "e2e", models: [{ id: "flash", name: "Flash", context_window: 1000000, max_output_tokens: null }] }],
  }),
);

// ── finx over its socket, as kernel-call.mjs talks to it ──
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
    // A kernel told to shut down may go before it answers.
    s.on("close", () => reject(new Error("the kernel closed the connection")));
  });
}

// ── the app, driven over the DevTools protocol ──
let app = null;
async function launch() {
  const port = cdpPort();
  app = spawn(electron, [desktop, `--remote-debugging-port=${port}`], {
    env: { ...process.env, FINX_HOME: home, HOME: path.join(work, "home"), FINXWORK_DEFAULT_MODE: "sessions", FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINX_CREDENTIAL_STORE: "file" },
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

// The model picker is the composer's button titled "Model" in the app's language.
const modelTitles = ["en", "zh-CN"].map((l) => JSON.parse(fs.readFileSync(path.join(desktop, "src/locales", l, "session.json"), "utf8")).composer.model);
const picker = `[...document.querySelectorAll("button.mb")].find((b) => ${JSON.stringify(modelTitles)}.includes(b.title))`;
const pickerLabel = `(${picker})?.querySelector(".lbl")?.textContent ?? ""`;

let failed = false;
try {
  if (!process.env.FINXWORK_E2E_NO_BUILD) {
    step("building finx and the app");
    sh("cargo", ["build", "-p", "finx-cli"], { cwd: root });
    sh("pnpm", ["--dir", desktop, "build"]);
  }

  step("a new session's model is the local connection's Flash");
  let page = await launch();
  await page.until("the new session page with its models", `(${pickerLabel}) === "Mock One"`);
  await page.run(`(${picker}).click()`);
  await page.until("Flash in the model menu", `!![...document.querySelectorAll("button.mi")].find((b) => b.textContent.startsWith("Flash"))`);
  await page.run(`[...document.querySelectorAll("button.mi")].find((b) => b.textContent.startsWith("Flash")).click()`);
  await page.until("Flash chosen", `(${pickerLabel}) === "Flash"`);
  await page.until("the choice saved", `JSON.parse(localStorage.getItem("main-view") ?? "{}").draft?.model === ${JSON.stringify(flash)}`);
  await sleep(500);
  page.close();
  await quit();

  step("the connection is disconnected and removed while the app is closed");
  // finx outlives the app (it exits when idle), as for people.
  for (const method of ["connections/disconnect", "connections/remove"]) {
    const r = await finxCall(method, { connection_id: connection });
    check(!r.error, `${method}: ${r.error?.message}`);
  }
  const unavailable = await finxCall("session/new", { model: flash });
  check(unavailable.error?.data?.kind === "model_unavailable", `finx answers a gone model with ${JSON.stringify(unavailable.error ?? unavailable.result)}`);
  check(unavailable.error.data.provider === `local-${connection}`, "model_unavailable names the provider");

  step("the reopened app still remembers Flash, and shows the default instead");
  page = await launch();
  await page.until("the new session page", `!!document.querySelector(".cmp-in")`);
  check(await page.run(`JSON.parse(localStorage.getItem("main-view")).draft.model`) === flash, "the profile should still hold the gone model (the reported state)");
  await page.until("the default model in the picker", `(${pickerLabel}) === "Mock One"`);
  await page.shot("1-fallback");

  step("sending starts the session on the default model");
  await page.run(`document.querySelector(".cmp-in").focus()`);
  await page.cdp("Input.insertText", { text: "ping" });
  await page.until("send enabled", `!document.querySelector("button.send")?.disabled`);
  await page.run(`document.querySelector("button.send").click()`);
  await page.until("the reply", `document.body.innerText.includes("pong")`);
  const raw = await page.run(`document.body.innerText`);
  for (const text of ["unknown provider", "invalid params", `local-${connection}`]) check(!raw.includes(text), `the page shows finx's raw error (${text})`);
  check(!(await page.run(`!!document.querySelector(".toast.bad")`)), "an error toast showed");
  check(asked.length === 1 && asked[0] === "mock-1", `the provider was asked for ${JSON.stringify(asked)}`);
  const list = await finxCall("session/list", {});
  check(list.result.sessions.length === 1 && list.result.sessions[0].model === "mock/mock-1", `the session runs on ${list.result.sessions[0]?.model}`);
  check(await page.run(`JSON.parse(localStorage.getItem("main-view")).draft.model`) === null, "the gone model stays remembered");
  await page.shot("2-sent");

  step("a long error toast stays inside a narrow window");
  await page.resize(480, 640);
  await page.until("the narrow layout", `innerWidth <= 480`);
  // The sidebar gives way first (layout.ts); measure once the content has stopped moving.
  await page.until("the content to settle", `new Promise((r) => { const x = document.querySelector(".content").getBoundingClientRect().left; setTimeout(() => r(x === document.querySelector(".content").getBoundingClientRect().left), 400); })`);
  // The toast as ToastView renders it, with the friendly message and a raw error four times its length.
  const friendly = JSON.parse(fs.readFileSync(path.join(desktop, "src/locales/zh-CN/common.json"), "utf8")).model.unavailable;
  for (const text of [friendly, `invalid params: unknown provider 'local-${connection}' (known: ${"anthropic, deepseek, deepseek-anthropic, glm, kimi, ollama, openai, openrouter, qwen, ".repeat(4)}mock)`]) {
    const box = await page.run(`(() => {
      const content = document.querySelector(".content");
      content.insertAdjacentHTML("beforeend", '<div class="toast bad" id="e2e-toast" role="status"><svg class="ic" viewBox="0 0 16 16"></svg><span></span></div>');
      const toast = document.getElementById("e2e-toast");
      toast.style.animation = "none";
      toast.querySelector("span").textContent = ${JSON.stringify(text)};
      const t = toast.getBoundingClientRect(), c = content.getBoundingClientRect(), s = toast.querySelector("span");
      const lines = Math.round(s.getBoundingClientRect().height / parseFloat(getComputedStyle(s).lineHeight || "18"));
      return { left: t.left, right: t.right, contentLeft: c.left, contentRight: c.right, width: innerWidth, lines, clipped: s.scrollHeight > s.clientHeight };
    })()`);
    await page.shot(text === friendly ? "3-toast-friendly" : "4-toast-long");
    await page.run(`document.getElementById("e2e-toast").remove()`);
    console.log(`  toast ${Math.round(box.right - box.left)} px wide in content ${Math.round(box.contentLeft)}–${Math.round(box.contentRight)}, ${box.lines} line(s)${box.clipped ? ", clamped" : ""}`);
    check(box.left >= box.contentLeft && box.right <= box.contentRight && box.right <= box.width, `the toast overflows: ${JSON.stringify(box)}`);
    check(box.lines <= 3, `the toast runs to ${box.lines} lines`);
  }
  page.close();
  console.log("\n✔ a gone local model falls back to the default; no raw error; the toast fits a narrow window");
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
