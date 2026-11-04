#!/usr/bin/env node
// A bot's request fails (bot-mode-design §11 item 12): the failure card shows in its conversation
// in place of the busy bubble; 重试 goes on from where it stopped and the answer comes; the
// failure stays as a quiet line. A real model cannot be made to fail on cue, so a model server on
// this Mac stands in for the provider: it fails the first request for a message with 400 (not
// retried) and answers the next with send_to_user.
//
// Runs the development build against the repository's target/debug/finx in a temporary
// FINX_HOME and profile. Takes under a minute once built.
//
//   node apps/desktop/e2e/bot-failure.mjs
//   FINXWORK_E2E_SHOTS=<folder> …   also screenshots each step
//   FINXWORK_E2E_NO_BUILD=1 …       uses the builds there are
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
const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxf-"));
const home = path.join(work, "finx");
const profile = path.join(work, "profile");
const socket = path.join(home, "run/finx.sock");

// The provider: a bot's request for a message is refused once, then answered with send_to_user.
const asked = new Map();
const sse = (delta, finish) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\ndata: [DONE]\n\n`;
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (!req.url?.endsWith("/chat/completions")) return res.writeHead(404).end();
    const request = JSON.parse(body);
    const last = request.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
    const said = typeof last === "string" ? last : last.map((c) => c.text ?? "").join("");
    const times = (asked.get(said) ?? 0) + 1;
    asked.set(said, times);
    if (times === 1) return res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "mock: this request is refused once" } }));
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (!request.tools?.some((t) => t.function?.name === "send_to_user")) return res.end(sse({ role: "assistant", content: "ok" }, "stop"));
    const call = { index: 0, id: `call_${times}`, type: "function", function: { name: "send_to_user", arguments: JSON.stringify({ text: `接着回了：${said}`, end_turn: true }) } };
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
  app = spawn(electron, [desktop, `--remote-debugging-port=${port}`], {
    env: { ...process.env, FINX_HOME: home, FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINX_CREDENTIAL_STORE: "file" },
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
      await sleep(250);
    }
  };
  const shot = async (name) => {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, "base64"));
  };
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 0, mobile: false });
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
  await exited;
}

const bubbles = `[...document.querySelectorAll(".tr.bots .bm:not(.working) .bbub")].map((b) => b.innerText.trim())`;
const busy = `!!document.querySelector(".tr.bots .bm.working")`;

async function say(page, text) {
  await page.run(`document.querySelector(".cmp-in").focus()`);
  await page.cdp("Input.insertText", { text });
  await page.until("Send enabled", `!document.querySelector("button.send")?.disabled`);
  await page.run(`document.querySelector("button.send").click()`);
}

let failed = false;
try {
  if (!process.env.FINXWORK_E2E_NO_BUILD) {
    step("building finx and the app");
    sh("cargo", ["build", "-p", "finx-cli"], { cwd: root });
    sh("pnpm", ["--dir", desktop, "build"]);
  }

  step("Bot mode, FinxBot");
  const page = await launch();
  await page.until("the window", `!!document.querySelector(".seg.mode")`, 60000);
  await page.run(`document.querySelector('.seg.mode button[role=tab]:last-child').click()`);
  // First time in Bot mode: asks about Full Access.
  await page.until("the question", `!!document.querySelector("dialog.sheet[open] .btn.danger")`);
  await page.run(`document.querySelector("dialog.sheet[open] .btn:not(.danger)").click()`);
  await page.until("FinxBot's page", `!!document.querySelector(".bempty") || document.querySelectorAll(".tr.bots > *").length > 0`, 30000);

  step("12. the request fails: a failure card, nothing busy");
  await say(page, "帮我看看这句");
  await page.until("the failure card", `!!document.querySelector(".tr.bots .fcard")`, 30000);
  check(!(await page.run(busy)), "the busy bubble gave way to the card");
  check((await page.run(bubbles)).length === 0, "no message from the bot");
  console.log(`  · ${await page.run(`document.querySelector(".tr.bots .fcard .fc-tx").innerText.replace(/\\s+/g, " ")`)}`);
  await page.shot("01-failure");

  step("12. 重试: it goes on and answers; the failure stays as a quiet line");
  await page.run(`document.querySelector(".tr.bots .fcard .fc-side .btn.primary").click()`);
  await page.until("the answer", `${bubbles}.some((t) => t.includes("接着回了：帮我看看这句"))`, 30000);
  await page.until("not busy", `!${busy}`);
  check(!(await page.run(`!!document.querySelector(".tr.bots .fcard")`)), "the card is gone");
  check(await page.run(`!!document.querySelector(".tr.bots .fpast")`), "a quiet line says it failed once");
  await page.shot("02-retried");
  page.close();
  console.log("\n✔ a bot's failure card and its retry work end to end");
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
