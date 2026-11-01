#!/usr/bin/env node
// Writing while a task runs (session/Dock.tsx): what is sent waits above the
// composer, marked Interject or Queue as the switch under the text says (⌥↩
// the other way), until the kernel takes it in; then it shows in the
// conversation, interjections at the task's next turn, queued messages once
// it would finish.
//
// Runs the development build against the repository's target/debug/finx in a
// temporary FINX_HOME and profile, with a slow model server on this Mac
// standing in for the provider. Takes under a minute once built.
//
//   node apps/desktop/e2e/send-modes.mjs
//   FINXWORK_E2E_SHOTS=<folder> node apps/desktop/e2e/send-modes.mjs   also screenshots
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxq-"));
const home = path.join(work, "finx");
const profile = path.join(work, "profile");
const socket = path.join(home, "run/finx.sock");

// The provider: answers "re: <the last user message>", a word every 300 ms, the first answer slowly.
const asked = [];
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    if (!req.url?.endsWith("/chat/completions")) return res.writeHead(404).end();
    const messages = JSON.parse(body).messages.filter((m) => m.role === "user");
    const last = messages.at(-1).content;
    const said = typeof last === "string" ? last : last.map((c) => c.text ?? "").join("");
    asked.push(said);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const words = said === "first" ? 14 : 3;
    for (let i = 0; i < words; i++) {
      const text = i === 0 ? `re: ${said}` : " …";
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
      await sleep(300);
    }
    const end = { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } };
    res.end(`data: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`);
  });
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${provider.address().port}/v1`;
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(
  path.join(home, "models.toml"),
  `[providers.mock]\nname = "Mock"\napi = "openai-chat"\nbase_url = "${base}"\nauth = "none"\n\n[[providers.mock.models]]\nid = "mock-1"\nname = "Mock One"\ncontext_window = 128000\nmax_output_tokens = 2000\n`,
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
async function launch() {
  const port = 9400 + Math.floor(Math.random() * 400);
  app = spawn(electron, [desktop, `--remote-debugging-port=${port}`], {
    env: { ...process.env, FINX_HOME: home, FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINX_CREDENTIAL_STORE: "file" },
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

const queued = `[...document.querySelectorAll(".qd-i")].map((i) => [i.querySelector(".qd-m").className.replace("qd-m ", ""), i.querySelector(".qd-t").textContent])`;
const bubbles = `[...document.querySelectorAll(".um .bub")].map((b) => b.textContent)`;

let failed = false;
try {
  if (!process.env.FINXWORK_E2E_NO_BUILD) {
    step("building finx and the app");
    sh("cargo", ["build", "-p", "finx-cli"], { cwd: root });
    sh("pnpm", ["--dir", desktop, "build"]);
  }
  const page = await launch();
  const write = async (text, alt = false) => {
    await page.run(`document.querySelector(".cmp-in").focus()`);
    await page.cdp("Input.insertText", { text });
    await page.until("send enabled", `!document.querySelector("button.send")?.disabled`);
    const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: alt ? 1 : 0 };
    await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", ...key });
    await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...key });
  };

  step("a task starts and is still answering");
  await page.until("the new session page", `!!document.querySelector(".cmp-in")`);
  await write("first");
  await page.until("the answer streaming", `document.body.innerText.includes("re: first")`);
  await page.until("the send-mode switch", `!!document.querySelector(".cmp-sendmode")`);
  check(await page.run(`document.querySelector(".cmp-sendmode button.on").textContent`) !== "", "a mode is picked");

  step("↩ interjects: the message waits above the composer");
  await write("interject me");
  await page.until("it waits", `${queued}.length === 1`);
  check(JSON.stringify(await page.run(queued)) === JSON.stringify([["steer", "interject me"]]), `waiting: ${JSON.stringify(await page.run(queued))}`);
  check(!(await page.run(bubbles)).includes("interject me"), "it is in the conversation before the task took it in");

  step("the switch set to Queue; ⌥↩ still interjects");
  await page.run(`document.querySelectorAll(".cmp-sendmode button")[1].click()`);
  check(await page.run(`localStorage.getItem("send-mode")`) === "follow_up", "the choice is kept");
  const placeholders = ["en", "zh-CN"].map((l) => JSON.parse(fs.readFileSync(path.join(desktop, "src/locales", l, "session.json"), "utf8")).composer.follow_up);
  await page.until("the placeholder says so", `${JSON.stringify(placeholders)}.includes(document.querySelector(".cmp-in")?.getAttribute("aria-placeholder"))`);
  await write("queue me");
  await write("also now", true);
  await page.until("three waiting", `${queued}.length === 3`);
  const waiting = await page.run(queued);
  check(JSON.stringify(waiting.map((q) => q[0])) === JSON.stringify(["steer", "follow_up", "steer"]), `waiting: ${JSON.stringify(waiting)}`);
  await page.shot("1-waiting");

  step("they go into the conversation as the task takes them in");
  await page.until("the queue emptied", `${queued}.length === 0 && !document.querySelector(".qd")`, 40000);
  await page.until("the last answer", `document.body.innerText.includes("re: queue me")`, 20000);
  const said = await page.run(bubbles);
  check(JSON.stringify(said) === JSON.stringify(["first", "interject me", "also now", "queue me"]), `the conversation: ${JSON.stringify(said)}`);
  // Interjections at the next turn (both at once), the queued one after that answer.
  check(JSON.stringify(asked) === JSON.stringify(["first", "also now", "queue me"]), `the provider was asked: ${JSON.stringify(asked)}`);
  await page.shot("2-taken-in");
  page.close();
  console.log("\n✔ messages sent during a task wait in view, by mode, and join the conversation when taken in");
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
