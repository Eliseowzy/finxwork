#!/usr/bin/env node
// Adding another subject's bot (bot-contacts-design §4.2–§4.3, §5): the link, the card, the
// confirmation, the conversation, and the error a card that cannot be read gives. The fake A2A
// peer stands in for the other side; no model is needed for it.
//
//   node apps/desktop/e2e/bot-external.mjs
//   FINXWORK_E2E_SHOTS=<folder> …   also screenshots each step
//   FINXWORK_E2E_NO_BUILD=1 …       uses the builds there are
// Choosing a bot's model and how hard it thinks (bot-mode-design §6.3, §6.4): the form that makes a
// bot has them, its menus work inside the dialog, and what is chosen is what the first request uses;
// a model without a key stops the form until it has one; the default bot, which nobody chose a model
// for, asks the first time and takes no message until then. A model server on the Mac stands in for
// the provider.
//
//   node apps/desktop/e2e/bot-setup.mjs
//   FINXWORK_E2E_SHOTS=<folder> …   also screenshots each step
//   FINXWORK_E2E_NO_BUILD=1 …       uses the builds there are
import { cdpPort } from "./lib/port.mjs";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
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

const sse = (delta, finish) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\ndata: [DONE]\n\n`;
const send = (text) => ({ role: "assistant", tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name: "send_to_user", arguments: JSON.stringify({ text, end_turn: true }) } }] });
let lastRequest = null;
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url?.endsWith("/models")) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [] }));
    if (!req.url?.endsWith("/chat/completions")) return res.writeHead(404).end();
    const asked = JSON.parse(body);
    // Checking a key is no conversation.
    if (!asked.tools?.length) return res.writeHead(200, { "content-type": "text/event-stream" }).end(sse({ role: "assistant", content: "ok" }, "stop"));
    lastRequest = asked;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse(send("好的。"), "tool_calls"));
  });
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));

const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxs-"));
// A private HOME: the app registers the extension's host in the browsers under it.
const userHome = path.join(work, "home");
fs.mkdirSync(userHome);
const place = (name, model) => {
  const home = path.join(work, name);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "models.toml"),
    `[providers.mock]\nname = "Mock"\napi = "openai-chat"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nauth = "none"\ncompat = { thinking_format = "openai" }\n\n[[providers.mock.models]]\nid = "mock-1"\nname = "Mock One"\ncontext_window = 128000\nmax_output_tokens = 2000\n\n[[providers.mock.models]]\nid = "mock-2"\nname = "Mock Two"\nreasoning = true\nthinking = ["off", "high"]\ncontext_window = 128000\nmax_output_tokens = 2000\n\n[providers.deepseek]\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\n`,
  );
  fs.writeFileSync(path.join(home, "config.toml"), `model = "${model}"\n[models]\nnetwork = false\n\n[bots]\nexternal = true\nallow_local = true\n`);
  return { home, profile: path.join(work, `${name}-profile`) };
};

// ── the app, driven over the DevTools protocol ──
let app = null;
async function launch({ home, profile }) {
  const port = cdpPort();
  const env = { ...process.env, FINX_HOME: home, HOME: userHome, FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINX_CREDENTIAL_STORE: "file" };
  delete env.DEEPSEEK_API_KEY;
  // A terminal that runs Node through Electron would keep Electron from opening a window.
  delete env.ELECTRON_RUN_AS_NODE;
  app = spawn(electron, [desktop, `--remote-debugging-port=${port}`], { env, stdio: ["ignore", "ignore", "inherit"] });
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
  // A menu closes when the window loses the focus, and this window runs behind whatever else is in front.
  await cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
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

/** A click with the mouse, where the element is on screen: what is over it gets it. */
async function press(page, expr) {
  const at = await page.run(`(() => { const r = (${expr}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
  await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", clickCount: 1 });
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", clickCount: 1 });
}
const key = async (page, k) => {
  const code = { Enter: 13, Escape: 27 }[k];
  await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: code, text: k === "Enter" ? "\r" : undefined });
  await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: code });
};
const $ = (s) => `document.querySelector(${JSON.stringify(s)})`;
const row = (scope, n) => `document.querySelectorAll(${JSON.stringify(`${scope} .bmodel .frow`)})[${n}]`;
const menuItem = (text) => `[...document.querySelectorAll(".vmenu .mi")].find((b) => b.textContent.includes(${JSON.stringify(text)}))`;
/** Whether the mouse would reach what `expr` finds: nothing lies over it, a dialog's backdrop included. */
const reachable = (expr) => `(() => { const e = ${expr}; if (!e) return false; const r = e.getBoundingClientRect(); return e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })()`;

/** Model `name`, then level `level` when given, from the rows in `scope`, with the mouse. */
async function choose(page, scope, name, level) {
  await press(page, `${row(scope, 0)}.querySelector(".mb")`);
  await page.until("the model menu", reachable(menuItem(name)));
  await press(page, menuItem(name));
  await page.until("the model", `${row(scope, 0)}.textContent.includes(${JSON.stringify(name)})`);
  if (!level) return;
  await page.until("the level's row", `!!${row(scope, 1)}`);
  await press(page, `${row(scope, 1)}.querySelector(".mb")`);
  await page.until("the level menu", reachable(menuItem(level)));
  await press(page, menuItem(level));
  await page.until("the level", `${row(scope, 1)}.textContent.includes(${JSON.stringify(level)})`);
}
async function say(page, text) {
  await page.run(`document.querySelector(".cmp-in").focus()`);
  await page.cdp("Input.insertText", { text });
  await page.until("Send enabled", `!document.querySelector("button.send")?.disabled`);
  await page.run(`document.querySelector("button.send").click()`);
  await page.until("the answer", `[...document.querySelectorAll(".tr.bots .bm:not(.working) .bbub")].some((b) => b.innerText.includes("好的"))`);
}
const intoBots = async (page) => {
  await page.until("the window", `!!document.querySelector(".seg.mode")`, 60000);
  await page.run(`document.querySelector('.seg.mode [data-mode=bots]').click()`);
  await page.until("FinxBot's page", `document.querySelector(".bhead-n")?.textContent === "FinxBot" && !!document.querySelector(".cmp-zone.bot")`);
};
const openForm = async (page) => {
  await page.run(`[...document.querySelectorAll(".nav-i")].find((b) => b.textContent.includes("新建 Bot")).click()`);
  await page.until("the form", `!!document.querySelector("dialog.bsheet[open] input.field")`);
};
const named = async (page, name) => {
  await page.run(`document.querySelector("dialog.bsheet input.field").focus()`);
  await page.cdp("Input.insertText", { text: name });
};
const create = `document.querySelector("dialog.bsheet .sheet-foot .btn.primary")`;
const opened = (name) => `document.querySelector(".bhead-n")?.textContent === ${JSON.stringify(name)} && !document.querySelector("dialog.bsheet") && !!document.querySelector(".cmp-zone.bot")`;


// ── the fake A2A peer ──
function fakePeer() {
  const server = path.join(root, "tools/a2a-fake/server.mjs");
  const child = spawn("node", [server, "--port", "0", "--images", "--provider"], { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((resolve, reject) => {
    let text = "";
    child.stdout.on("data", (chunk) => {
      text += chunk;
      const line = text.split("\n")[0];
      if (line.startsWith("listening on ")) resolve({ child, url: line.slice("listening on ".length).trim() });
    });
    child.on("exit", () => reject(new Error("the fake peer ended")));
  });
}

const openAddTab = async (page) => {
  await page.run(`[...document.querySelectorAll(".nav-i")].find((b) => /Bot/.test(b.textContent)).click()`);
  await page.until("the form", `!!document.querySelector("dialog.bsheet[open]")`);
  const tabs = await page.run(`[...document.querySelectorAll("dialog.bsheet .bs-tabs button")].map((b) => b.textContent)`);
  check(tabs.length === 2, `the form has both ways in: ${tabs}`);
  await page.run(`[...document.querySelectorAll("dialog.bsheet .bs-tabs button")][1].click()`);
  await page.until("the link's field", `!!document.querySelector("dialog.bsheet input.field")`);
};
const readLink = async (page, url) => {
  await page.run(`document.querySelector("dialog.bsheet input.field").focus()`);
  await page.cdp("Input.insertText", { text: url });
  await press(page, `document.querySelector("dialog.bsheet .sheet-foot .btn.primary")`);
};
const confirmAdd = `document.querySelector(".bs-confirm .sheet-foot .btn.primary")`;
const inChat = (name) => `document.querySelector(".bhead-n")?.textContent.includes(${JSON.stringify(name)}) && !document.querySelector("dialog.bsheet") && !!document.querySelector(".cmp-zone.bot")`;

let fake = null;
let failed = false;
try {
  if (!process.env.FINXWORK_E2E_NO_BUILD) {
    step("building finx and the app");
    sh("cargo", ["build", "-p", "finx-cli"], { cwd: root });
    sh("pnpm", ["--dir", desktop, "build"]);
  }
  fake = await fakePeer();
  const one = place("one", "mock/mock-1");
  const page = await launch(one);

  step("the add form offers both ways in; the link reads a card and shows it");
  await intoBots(page);
  await openAddTab(page);
  await readLink(page, fake.url);
  await page.until("the confirmation", `!!document.querySelector(".bs-confirm")`);
  const shown = await page.run(`document.querySelector(".bs-confirm").innerText`);
  check(shown.includes("A2A Fake"), `the card's name: ${shown}`);
  check(shown.includes(fake.url.replace("http://", "")), `its domain: ${shown}`);
  await page.shot("external-confirm");

  step("adding it opens its conversation, marked as someone else's");
  await press(page, confirmAdd);
  await page.until("its page", inChat("A2A Fake"));
  check(await page.run(`!!document.querySelector(".bhead-h")`), "the domain is under its name");
  check(await page.run(`!!document.querySelector(".bext")`), "the list marks it");
  await page.shot("external-chat");

  step("a first message is answered by the other side");
  await page.run(`document.querySelector(".cmp-in").focus()`);
  await page.cdp("Input.insertText", { text: "你好" });
  await page.until("Send enabled", `!document.querySelector("button.send")?.disabled`);
  await page.run(`document.querySelector("button.send").click()`);
  await page.until("the other side's answer", `[...document.querySelectorAll(".bbub")].some((b) => b.innerText.includes("hello (1)"))`);
  await page.shot("external-answer");

  step("a link that leads nowhere says why, in the form");
  await openAddTab(page);
  await readLink(page, "http://localhost:1/");
  await page.until("the reason", `!!document.querySelector(".bs-problem")`);
  const problem = await page.run(`document.querySelector(".bs-problem").textContent`);
  check(/名片/.test(problem), `the form says what is wrong: ${problem}`);
  await page.shot("external-error");
  console.log("\nok");
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await quit();
  fake?.child.kill();
  provider.close();
  if (!failed) fs.rmSync(work, { recursive: true, force: true });
  else console.error(`left in ${work}`);
}
process.exit(failed ? 1 : 0);
