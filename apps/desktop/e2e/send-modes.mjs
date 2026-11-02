#!/usr/bin/env node
// Writing while a task runs (session/Dock.tsx, Queue.tsx): what is sent waits
// in the tray above the composer, interjected with ↩ or queued with ⌥↩ (the
// placeholder says which is which), until the kernel takes it in; then it
// shows in the conversation, interjections at the task's next turn, queued
// messages once it would finish. Send now ends the step under way; ↑ takes the
// last one back to edit; × deletes one; a stop or a failure hands back what
// still waits.
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

// The provider: answers "re: <the last user message>", a word every 300 ms; the first answer and
// any to a message starting "long" slowly, and "after fail" with an error that is not retried.
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
    if (said === "after fail") return res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "bad request" } }));
    res.writeHead(200, { "content-type": "text/event-stream" });
    const words = said === "first" || said.startsWith("long") ? 14 : 3;
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

const queued = `[...document.querySelectorAll(".cq-row")].map((r) => [r.dataset.mode, r.querySelector(".cq-t").textContent])`;
const bubbles = `[...document.querySelectorAll(".um .bub")].map((b) => b.textContent)`;
const composerText = `document.querySelector(".cmp-in").innerText.trim()`;
const strings = Object.fromEntries(["en", "zh-CN"].map((l) => [l, JSON.parse(fs.readFileSync(path.join(desktop, "src/locales", l, "session.json"), "utf8"))]));
const either = (pick) => JSON.stringify(Object.values(strings).map(pick));
const idle = `${either((s) => s.composer.reply)}.includes(document.querySelector(".cmp-in")?.getAttribute("aria-placeholder"))`;
/** Waits on this side for the provider to be asked `text`; how long it took. */
const askedFor = async (text, ms = 15000) => {
  const start = Date.now();
  while (!asked.includes(text)) {
    if (Date.now() - start > ms) fail(`the provider was never asked "${text}": ${JSON.stringify(asked)}`);
    await sleep(25);
  }
  return Date.now() - start;
};

let failed = false;
try {
  if (!process.env.FINXWORK_E2E_NO_BUILD) {
    step("building finx and the app");
    sh("cargo", ["build", "-p", "finx-cli"], { cwd: root });
    sh("pnpm", ["--dir", desktop, "build"]);
  }
  const page = await launch();
  const key = async (k, code, vk, modifiers = 0) => {
    const ev = { key: k, code, windowsVirtualKeyCode: vk, modifiers };
    await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", ...ev });
    await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...ev });
  };
  const press = (alt = false) => key("Enter", "Enter", 13, alt ? 1 : 0);
  const write = async (text, alt = false) => {
    await page.run(`document.querySelector(".cmp-in").focus()`);
    await page.cdp("Input.insertText", { text });
    await page.until("send enabled", `!document.querySelector("button.send")?.disabled`);
    await press(alt);
  };
  /** Starts a task whose answer streams for a few seconds. */
  const longTask = async (text) => {
    await page.until("no task running", idle, 30000);
    await write(text);
    await page.until(`the answer to "${text}" streaming`, `document.body.innerText.includes("re: ${text}")`);
  };

  step("a task starts and is still answering");
  await page.until("the new session page", `!!document.querySelector(".cmp-in")`);
  await write("first");
  await page.until("the answer streaming", `document.body.innerText.includes("re: first")`);
  await page.until("the placeholder tells ↩ from ⌥↩", `${either((s) => s.composer.steer)}.includes(document.querySelector(".cmp-in")?.getAttribute("aria-placeholder"))`);
  check(!(await page.run(`!!document.querySelector(".cmp-sendmode")`)), "a send-mode switch is back");

  step("↩ interjects: the message waits in the tray above the composer");
  await write("interject me");
  await page.until("it waits", `${queued}.length === 1`);
  check(JSON.stringify(await page.run(queued)) === JSON.stringify([["steer", "interject me"]]), `waiting: ${JSON.stringify(await page.run(queued))}`);
  check(!(await page.run(bubbles)).includes("interject me"), "it is in the conversation before the task took it in");

  step("⌥↩ queues; interjections are listed first, as they go in");
  await write("queue me", true);
  await write("also now");
  await page.until("three waiting", `${queued}.length === 3`);
  const waiting = await page.run(queued);
  check(JSON.stringify(waiting) === JSON.stringify([["steer", "interject me"], ["steer", "also now"], ["follow_up", "queue me"]]), `waiting: ${JSON.stringify(waiting)}`);
  await page.shot("1-waiting");

  step("they go into the conversation as the task takes them in");
  await page.until("the queue emptied", `${queued}.length === 0 && !document.querySelector(".cq")`, 40000);
  await page.until("the last answer", `document.body.innerText.includes("re: queue me")`, 20000);
  const said = await page.run(bubbles);
  check(JSON.stringify(said) === JSON.stringify(["first", "interject me", "also now", "queue me"]), `the conversation: ${JSON.stringify(said)}`);
  // Interjections at the next turn (both at once), the queued one after that answer.
  check(JSON.stringify(asked) === JSON.stringify(["first", "also now", "queue me"]), `the provider was asked: ${JSON.stringify(asked)}`);
  await page.shot("2-taken-in");

  step("Send now ends the step under way: the interjection goes in at once and the task goes on");
  await longTask("long cut");
  await write("cut in");
  await page.until("it waits", `${queued}.length === 1`);
  await page.run(`document.querySelector(".cq-row[data-mode=steer] .cq-b").click()`);
  const took = await askedFor("cut in");
  check(took < 1500, `the interjection went in after ${took} ms, not at once`);
  await page.until("its answer", `document.body.innerText.includes("re: cut in")`);
  await page.until("the task done", idle, 20000);
  const interrupted = Object.values(strings).map((s) => s.chat.interrupted);
  check(!(await page.run(`${JSON.stringify(interrupted)}.some((t) => document.body.innerText.includes(t))`)), "the task was stopped, not just the step");

  step("↑ in the empty composer takes the last waiting message back to edit");
  await longTask("long edit");
  await write("edit me", true);
  await page.until("it waits", `${queued}.length === 1`);
  await key("ArrowUp", "ArrowUp", 38);
  await page.until("it is back in the composer", `${queued}.length === 0 && ${composerText} === "edit me"`);
  await page.shot("3-edit");
  await press();
  await askedFor("edit me");
  await page.until("the task done", idle, 20000);

  step("× deletes a waiting message: it never goes in");
  await longTask("long delete");
  await write("drop me", true);
  await page.until("it waits", `${queued}.length === 1`);
  await page.run(`[...document.querySelectorAll(".cq-row .cq-ib")].at(-1).click()`);
  await page.until("it is gone, with Undo offered", `${queued}.length === 0 && ${either((s) => s.queued.deleted)}.some((t) => document.querySelector(".toast")?.innerText.includes(t))`);
  await page.until("the task done", idle, 20000);
  check(!asked.includes("drop me"), `the deleted message was sent: ${JSON.stringify(asked)}`);

  step("Stop hands what waits back to the composer");
  await longTask("long stop");
  await write("long again", true);
  await page.until("it waits", `${queued}.length === 1`);
  await page.run(`document.querySelector("button.send.stop").click()`);
  await page.until("it is back in the composer", `${composerText} === "long again"`);
  check(await page.run(`${JSON.stringify([strings.en.queued.returned_one, strings["zh-CN"].queued.returned_other.replace("{{count}}", "1")])}.some((t) => document.querySelector(".toast")?.innerText.includes(t))`), "no word on what came back");
  await page.shot("4-stopped");

  step("A failed task hands what still waits back too");
  // What came back goes out as it is: a long answer, and two messages wait meanwhile.
  await press();
  await page.until("its answer streaming", `document.body.innerText.includes("re: long again")`);
  await write("after fail", true);
  await write("kept", true);
  await page.until("two wait", `${queued}.length === 2`);
  await askedFor("after fail");
  await page.until("the one left is back in the composer", `${composerText} === "kept"`, 20000);
  check(!asked.includes("kept"), `the message handed back was sent: ${JSON.stringify(asked)}`);
  await page.shot("5-failed");
  page.close();
  console.log("\n✔ messages sent during a task wait in the tray, go in by mode, can be sent now, edited or deleted, and come back on a stop or a failure");
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
