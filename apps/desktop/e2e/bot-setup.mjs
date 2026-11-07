#!/usr/bin/env node
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
  fs.writeFileSync(path.join(home, "config.toml"), `model = "${model}"\n[models]\nnetwork = false\n`);
  return { home, profile: path.join(work, `${name}-profile`) };
};

// ── the app, driven over the DevTools protocol ──
let app = null;
async function launch({ home, profile }) {
  const port = cdpPort();
  const env = { ...process.env, FINX_HOME: home, HOME: userHome, FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINX_CREDENTIAL_STORE: "file" };
  delete env.DEEPSEEK_API_KEY;
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

let failed = false;
try {
  if (!process.env.FINXWORK_E2E_NO_BUILD) {
    step("building finx and the app");
    sh("cargo", ["build", "-p", "finx-cli"], { cwd: root });
    sh("pnpm", ["--dir", desktop, "build"]);
  }

  const one = place("one", "mock/mock-1");
  let page = await launch(one);
  step("the default bot, the first time: it asks, and takes no message until it is answered");
  await intoBots(page);
  await page.until("the card", `!!${$(".bsetup")}`);
  const said = await page.run(`${$(".bsetup")}.textContent`);
  check(said.includes("先给 FinxBot 选个模型") && said.includes("Mock One"), `the card: ${said}`);
  check(!(await page.run(`!!${row(".bsetup", 1)}`)), "a model without levels has no level's row");
  await sleep(400);
  await page.shot("s1-first-time");
  await page.run(`document.querySelector(".cmp-in").focus()`);
  await page.cdp("Input.insertText", { text: "你好" });
  await sleep(300);
  check(await page.run(`document.querySelector("button.send").disabled`), "no sending yet");
  await key(page, "Enter");
  await sleep(500);
  check(lastRequest === null, "Enter sends nothing either");
  await choose(page, ".bsetup", "Mock Two", "高");
  await page.shot("s2-first-time-chosen");
  await press(page, `${$(".bsetup .btn.primary")}`);
  await page.until("the card gone, the note about access next", `!${$(".bsetup")} && !!${$(".knote")}`);
  await page.until("Send enabled", `!document.querySelector("button.send")?.disabled`);
  await page.run(`document.querySelector("button.send").click()`);
  await page.until("the answer", `[...document.querySelectorAll(".tr.bots .bm:not(.working) .bbub")].some((b) => b.innerText.includes("好的"))`);
  check(lastRequest.model === "mock-2" && lastRequest.reasoning_effort === "high", `the first request: ${lastRequest.model}, ${lastRequest.reasoning_effort}`);
  await page.run(`${$(".knote .btn.primary")}?.click()`);

  step("the form has the model and the level; its menus work inside the dialog; Esc closes the menu alone");
  await openForm(page);
  check(!!(await page.run(`${row(".bsheet", 0)}.textContent.includes("Mock One")`)), "the default model on show");
  check(await page.run(`${create}.disabled`), "no name, no bot");
  await sleep(400);
  await page.shot("s3-form");
  await press(page, `${row(".bsheet", 0)}.querySelector(".mb")`);
  await page.until("the model menu over the form", reachable(menuItem("Mock Two")));
  await sleep(300);
  await page.shot("s4-form-menu");
  check(await page.run(`!!document.querySelector("dialog.bsheet[open]") && !document.querySelector("dialog.bsheet form").contains(document.querySelector(".vmenu"))`), "opening the menu does not submit the form");
  await key(page, "Escape");
  await page.until("the menu closed", `!document.querySelector(".vmenu")`);
  check(await page.run(`!!document.querySelector("dialog.bsheet[open]")`), "the form is still there");
  await choose(page, ".bsheet", "Mock Two", "高");
  check(await page.run(`!document.querySelector("dialog.bsheet .bmodel-why")`), "a model that can answer: nothing to say");
  await named(page, "研究员");
  await sleep(200);
  await page.shot("s5-form-filled");
  await key(page, "Enter");
  await page.until("its page", opened("研究员"));
  check(!(await page.run(`!!${$(".bsetup")}`)), "a bot that chose has nothing to ask");
  await press(page, `${$(".bhead")}`);
  await page.until("its settings, as chosen", `${row(".bpn", 0)}?.textContent.includes("Mock Two") && ${row(".bpn", 1)}?.textContent.includes("高")`);
  await press(page, `${$(".bhead")}`);
  lastRequest = null;
  await say(page, "你好");
  check(lastRequest.model === "mock-2" && lastRequest.reasoning_effort === "high", `its first request: ${lastRequest.model}, ${lastRequest.reasoning_effort}`);

  step("a name and ↩ make a bot on the default model");
  await openForm(page);
  await named(page, "快手");
  await key(page, "Enter");
  await page.until("its page", opened("快手"));
  lastRequest = null;
  await say(page, "你好");
  check(lastRequest.model === "mock-1", `its first request: ${lastRequest.model}`);

  step("once is enough: the default bot does not ask again after a restart");
  await quit();
  await sleep(1000);
  page = await launch(one);
  await page.until("the window", `!!document.querySelector(".seg.mode")`, 60000);
  await page.until("a bot's page", `!!document.querySelector(".cmp-zone.bot")`);
  await page.run(`[...document.querySelectorAll(".brow")].find((r) => r.querySelector(".bname").textContent === "FinxBot").click()`);
  await page.until("FinxBot", `document.querySelector(".bhead-n")?.textContent === "FinxBot" && !!document.querySelector(".cmp-zone.bot")`);
  await sleep(500);
  check(!(await page.run(`!!${$(".bsetup")}`)), "no card a second time");
  await quit();
  await sleep(1000);

  const two = place("two", "deepseek/deepseek-flash");
  page = await launch(two);
  step("a default model without a key: the card waits for one that can answer");
  await intoBots(page);
  await page.until("the card", `!!${$(".bsetup .bmodel-why")}`);
  check(await page.run(`${$(".bsetup .btn.primary")}.disabled`), "this model cannot answer yet");
  await sleep(400);
  await page.shot("s6-first-time-no-key");
  await choose(page, ".bsetup", "Mock One");
  await page.until("ready", `!${$(".bsetup .bmodel-why")} && !${$(".bsetup .btn.primary")}.disabled`);
  await press(page, `${$(".bsetup .btn.primary")}`);
  await page.until("the card gone", `!${$(".bsetup")}`);

  step("the form: no key, no bot; the key comes over the form, and the form carries on");
  await openForm(page);
  await named(page, "没有 Key");
  await page.until("the reason", `${$("dialog.bsheet .bmodel-why")}?.textContent.includes("Key")`);
  check(await page.run(`${create}.disabled`), "this model cannot answer yet");
  await key(page, "Enter");
  await sleep(400);
  check(await page.run(`!!document.querySelector("dialog.bsheet[open]")`), "↩ makes nothing");
  await page.shot("s7-form-no-key");
  await press(page, `${$("dialog.bsheet .bmodel-why .link")}`);
  await page.until("the key's form on top", reachable(`document.querySelector(".keyform input")`));
  await page.run(`document.querySelector(".keyform input").focus()`);
  await page.cdp("Input.insertText", { text: "sk-test" });
  await press(page, `${$(".keyform .btn.primary")}`);
  await page.until("the form is ready", `!document.querySelector(".keyform") && !${create}.disabled && !${$("dialog.bsheet .bmodel-why")}`);
  check(await page.run(`document.querySelector("dialog.bsheet input.field").value === "没有 Key"`), "the name is still there");
  await press(page, create);
  await page.until("its page", opened("没有 Key"));
  console.log("\nok");
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await quit();
  provider.close();
  if (!failed) fs.rmSync(work, { recursive: true, force: true });
  else console.error(`left in ${work}`);
}
process.exit(failed ? 1 : 0);
