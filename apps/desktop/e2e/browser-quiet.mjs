#!/usr/bin/env node
// The person may watch the agent's browser, but it never interrupts them, panel shown or not
// (browser-design §8.3.6): the real app and kernel, a scripted model, and the main process
// asked what has the keyboard. FINXWORK_E2E_WINDOWS names a program that lists the window
// server's on-screen windows as JSON, to also catch what no Electron API reports.
import { cdpPort } from "./lib/port.mjs";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "../..");
const finx = path.join(root, "target/debug/finx");
const electron = createRequire(import.meta.url)("electron");
const lister = process.env.FINXWORK_E2E_WINDOWS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => {
  throw new Error(message);
};
const check = (ok, message) => ok || fail(message);

const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxq-"));
const home = path.join(work, "finx");
const profile = path.join(work, "profile");
const userHome = path.join(work, "home");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(userHome, { recursive: true });
const env = { ...process.env, FINX_HOME: home, HOME: userHome, FINX_CREDENTIAL_STORE: "file", FINX_NO_BROWSER: "1" };

// ── a page with everything that could reach outside its tab ──
const body = `<input aria-label="A" id="a"><textarea aria-label="B" id="b"></textarea>
<button id="go" onclick="window.__clicks = (window.__clicks ?? 0) + 1">Go</button>
<select aria-label="Size" id="size"><option>Small</option><option>Large</option></select>
<input type="color" aria-label="Tint" id="tint">
<input type="file" aria-label="Attachment" id="file">
<button id="pr" onclick="window.print(); window.__printed = true">Print</button>
<button id="big" onclick="document.documentElement.requestFullscreen().then(() => window.__big = 'yes', () => window.__big = 'no')">Big</button>
<button id="ask" onclick="window.__alerted = (alert('x'), true); window.__confirmed = confirm('y')">Ask</button>
<button id="pop" onclick="window.open('/opened')">Pop</button>`;
const site = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<title>${req.url}</title>${body}`);
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const url = (p) => `http://127.0.0.1:${site.address().port}${p}`;

// ── the scripted model: each message names a plan, one tool call a round ──
let snapshot = "";
const ref = (name) => /\[ref=(e\d+)\]/.exec(snapshot.split("\n").find((l) => l.includes(`"${name}"`)) ?? "")?.[1] ?? fail(`no ref for ${name} in ${snapshot}`);
const click = (name) => () => ["browser_act", { action: "click", ref: ref(name) }];
const open = (p) => () => ["browser_navigate", { url: url(p) }];
const plans = {
  first: [open("/one")],
  input: [() => ["browser_snapshot", {}], click("Go"), () => ["browser_act", { action: "fill", ref: ref("A"), text: "filled" }], () => ["browser_act", { action: "type", ref: ref("B"), text: "typed" }], () => ["browser_act", { action: "press", keys: "Tab" }], () => ["browser_screenshot", {}]],
  newTab: [() => ["browser_tabs", { action: "open", url: url("/two") }]],
  blankTab: [() => ["browser_tabs", { action: "open" }]],
  useBlank: [open("/three")],
  select: [() => ["browser_tabs", { action: "select", tab: "1" }]],
  popups: [() => ["browser_snapshot", {}], click("Size"), click("Tint"), click("Attachment"), click("Print"), click("Big"), click("Ask")],
  pop: [() => ["browser_snapshot", {}], click("Pop")],
  fourth: [open("/four")],
  // A look first: the person is in the address field by the time the tab comes.
  fifth: [() => ["browser_snapshot", {}], () => ["browser_snapshot", {}], () => ["browser_tabs", { action: "open", url: url("/five") }]],
  sixth: [() => ["browser_tabs", { action: "open", url: url("/six") }]],
  seventh: [() => ["browser_tabs", { action: "open", url: url("/seven") }]],
  eighth: [() => ["browser_tabs", { action: "open", url: url("/eight") }]],
  parkedInput: [() => ["browser_snapshot", {}], click("Go"), () => ["browser_act", { action: "fill", ref: ref("A"), text: "parked" }]],
  other: [],
};
const results = {};
const finished = new Set();
const textOf = (m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((c) => c.text ?? "").join("\n"));
const provider = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    if (req.method !== "POST" || !raw) return res.end(JSON.stringify({ data: [] }));
    const request = JSON.parse(raw);
    const messages = request.messages ?? [];
    let u = messages.length - 1;
    while (u >= 0 && !(messages[u].role === "user" && /RUN (\w+)/.test(textOf(messages[u])))) u--;
    const plan = /RUN (\w+)/.exec(textOf(messages[u] ?? {}))?.[1];
    const tools = messages.slice(u + 1).filter((m) => m.role === "tool");
    let delta = { role: "assistant", content: "A title" };
    let finish = "stop";
    if (plan && request.tools?.length) {
      const last = tools.at(-1);
      if (last) {
        const text = textOf(last);
        if (/\[ref=/.test(text) && !/^Changes:/m.test(text)) snapshot = text;
        (results[plan] ??= []).push(text);
      }
      await sleep(120);
      if (tools.length < plans[plan].length) {
        const [name, args] = plans[plan][tools.length]();
        delta = { role: "assistant", tool_calls: [{ index: 0, id: `${plan}-${tools.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
        finish = "tool_calls";
      } else {
        delta = { role: "assistant", content: `Done with ${plan}.` };
        finished.add(plan);
      }
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
  });
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
fs.writeFileSync(path.join(home, "models.toml"), `[providers.mock]\nname = "Mock"\napi = "openai-chat"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nauth = "none"\n[[providers.mock.models]]\nid = "mock-1"\nname = "Mock One"\ncontext_window = 128000\nmax_output_tokens = 2000\ninput = ["text", "image"]\n`);
fs.writeFileSync(path.join(home, "config.toml"), `model = "mock/mock-1"\npermission_mode = "bypass-permissions"\n[models]\nnetwork = false\n[browser]\nenabled = true\n`);

// ── the app, and its main process through the inspector ──
async function devtools(u) {
  const ws = new WebSocket(u);
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
const evaluate = async (conn, expression, extra = {}) => {
  const r = await conn.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, ...extra });
  if (r.exceptionDetails) fail(`eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
};
const port = cdpPort();
const inspect = port + 400;
const app = spawn(electron, [`--inspect=${inspect}`, desktop, ...(process.env.FINXWORK_E2E_NO_SANDBOX ? ["--no-sandbox"] : []), `--remote-debugging-port=${port}`], {
  env: { ...env, FINXWORK_DEFAULT_MODE: "sessions", FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINXWORK_NO_BROWSER: "1" },
  stdio: ["ignore", "ignore", "ignore"],
});
const targets = () => fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => []);

let failed = false;
const log = [];
try {
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(200);
    target = (await targets()).find((t) => t.type === "page" && /^(app:|file:)/.test(t.url) && !t.url.includes("#settings"));
  }
  check(target, "the main window never showed up");
  const page = await devtools(target.webSocketDebuggerUrl);
  const run = (e) => evaluate(page, e);
  // This window may run behind whatever else is in front, where focus events would not fire.
  await page.call("Emulation.setFocusEmulationEnabled", { enabled: true });
  const until = async (what, e, ms = 30000) => {
    const end = Date.now() + ms;
    for (;;) {
      if (await run(e)) return;
      if (Date.now() > end) fail(`timed out waiting for ${what}`);
      await sleep(100);
    }
  };
  const main = await devtools((await fetch(`http://127.0.0.1:${inspect}/json/list`).then((r) => r.json()))[0].webSocketDebuggerUrl);
  const mrun = (e) => evaluate(main, e, { includeCommandLineAPI: true });
  await mrun(`(() => { const { app, BrowserWindow, webContents } = require('electron');
    globalThis.__e = { app, BrowserWindow, webContents };
    globalThis.__win = () => BrowserWindow.getAllWindows().find((w) => /^(app|file):/.test(w.webContents.getURL()));
    globalThis.__events = [];
    for (const w of BrowserWindow.getAllWindows()) for (const name of ['show', 'enter-full-screen', 'enter-html-full-screen']) w.on(name, () => __events.push(name + ':' + w.id));
  })()`);
  // Every change of what has the focus in the page, kept from before the first message.
  await run(`(() => { window.__left = []; const watch = () => { const a = document.activeElement; if (window.__watching && a !== document.querySelector('.cmp-in')) window.__left.push(a?.className || a?.tagName); };
    document.addEventListener('focusin', watch, true); setInterval(watch, 20); })()`);
  await until("the app", `!!document.querySelector("button")`);
  await until("the home page", `(() => { const skip = [...document.querySelectorAll("button")].find(b => /稍后|later|skip/i.test(b.textContent)); if (skip) { skip.click(); return false; } return !!document.querySelector(".ctool button[aria-pressed]"); })()`);

  const windows = () => (lister ? JSON.parse(execFileSync(lister, [String(app.pid)], { encoding: "utf8" })).map((w) => `${w.layer}|${w.w}x${w.h}`) : []);
  const tabs = () => run(`window.finx.browserTabs()`);
  const path_ = (u) => u.replace(/^.*:\d+/, "");
  const shownTab = async () => path_((await tabs()).find((t) => t.shown).url);
  const inTab = async (p, expression) => {
    const t = (await targets()).find((x) => x.type === "page" && x.url.endsWith(`:${site.address().port}${p}`)) ?? fail(`no tab at ${p}`);
    const c = await devtools(t.webSocketDebuggerUrl);
    const v = await evaluate(c, expression);
    c.close();
    return v;
  };
  const panel = () => run(`!!document.querySelector('.brp:not(.fpn)')`);
  // The keyboard for real: the window's first responder, not only the page's active element.
  await mrun(`(() => { globalThis.__native = []; let last = '';
    setInterval(() => { const w = __win(); const s = w.isFocused() ? __e.webContents.getAllWebContents().filter((x) => !x.isDestroyed() && x.isFocused()).map((x) => x.getURL().replace(/^.*:\\d+/, '')).join() : 'not key';
      if (s !== last) { last = s; __native.push(s); } }, 10); })()`);
  const composer = async () => {
    await mrun(`__win().webContents.focus()`);
    await run(`document.querySelector('.cmp-in').focus(); window.__left = []; window.__watching = true`);
    await sleep(120);
    await mrun(`__native.length = 0`);
  };
  const say = async (plan, meanwhile) => {
    await composer();
    await page.call("Input.insertText", { text: `RUN ${plan}` });
    await until("send enabled", `!document.querySelector('button.send')?.disabled`);
    finished.delete(plan);
    await run(`document.querySelector('button.send').click()`);
    await meanwhile?.();
    const end = Date.now() + 60000;
    while (!finished.has(plan)) {
      if (Date.now() > end) fail(`the plan ${plan} did not finish`);
      await sleep(50);
    }
    await sleep(700);
  };
  // The message goes out from the page side only: the window's real keyboard stays in the tab.
  const sendWithoutComposer = async (plan) => {
    finished.delete(plan);
    await run(`document.querySelector('.cmp-in').focus()`);
    await page.call("Input.insertText", { text: `RUN ${plan}` });
    await until("send enabled", `!document.querySelector('button.send')?.disabled`);
    await run(`document.querySelector('button.send').click()`);
    const end = Date.now() + 60000;
    while (!finished.has(plan)) {
      if (Date.now() > end) fail(`the plan ${plan} did not finish`);
      await sleep(50);
    }
    await sleep(700);
  };
  const stayed = async (what) => {
    const native = await mrun(`__native`);
    log.push(`${what}: ${JSON.stringify(native)}`);
    const taken = native.filter((n) => n !== "not key" && !/index\.html/.test(n));
    check(taken.length === 0, `${what}: the keyboard went to ${JSON.stringify(taken)}`);
    const left = await run(`window.__left`);
    check(left.length === 0, `${what}: the composer lost the keyboard to ${JSON.stringify(left)}`);
    check(await run(`document.activeElement === document.querySelector('.cmp-in')`), `${what}: the composer has not the keyboard`);
  };
  const hide = `[...document.querySelectorAll(".brp:not(.fpn) .brp-strip > button")].at(-1).click()`;
  const showButton = `[...document.querySelectorAll('.ctool button')].find(b => /^(Built-in Browser|内置浏览器)$/.test(b.getAttribute('aria-label')))`;

  // The first message turns the home page into the conversation's, a composer of its own.
  await say("other");
  // The agent's first page brings the panel out, and the keyboard stays with the composer.
  await say("first");
  check(await panel(), "the first page did not bring the panel out");
  await stayed("the first page");
  // Its actions in the open tab.
  await say("input");
  await stayed("clicking and typing");
  check((await inTab("/one", `document.getElementById('a').value`)) === "filled", "the agent's input did not arrive");
  // Its new tabs: the panel follows, as long as the person is not at work in it.
  await say("newTab");
  await stayed("a new tab");
  check((await shownTab()) === "/two", "the panel does not follow the agent's new tab");
  await say("blankTab");
  await stayed("a new blank tab");
  await say("useBlank");
  await stayed("navigating the blank tab");
  await say("select");
  await stayed("selecting a tab");
  check((await shownTab()) === "/one", "the panel does not follow the agent's selection");

  // What a click would open on the person's screen, with the tab in the panel.
  const beforeShown = windows();
  await mrun(`__events.length = 0`);
  await say("popups");
  await stayed("native popups");
  check(!(await mrun(`__win().isFullScreen()`)), "a page took the window full screen");
  const shownEvents = await mrun(`__events`);
  check(shownEvents.length === 0, `windows moved: ${shownEvents}`);
  const appearedShown = windows().filter((w) => !beforeShown.includes(w));
  check(appearedShown.length === 0, `windows appeared on screen: ${appearedShown}`);
  const said = results.popups.join("\n");
  for (const words of ["is a dropdown", "is a color picker", "Use upload", "alert dialog", "confirm dialog"]) check(said.includes(words), `the agent was not told "${words}": ${said}`);
  check(await inTab("/one", `window.__printed === true && window.__alerted === true && window.__confirmed === false && window.__big !== 'yes'`), `the page: ${await inTab("/one", "JSON.stringify([window.__printed, window.__alerted, window.__confirmed, window.__big])")}`);

  // A person at work in the panel keeps it: typing an address.
  const typing = async () => {
    await run(`document.querySelector('.brp-url').focus(); window.__watching = false`);
    await sleep(150);
    await page.call("Input.insertText", { text: "still-typing" });
    await sleep(100);
  };
  await say("fourth");
  const before = await shownTab();
  await say("fifth", typing);
  check((await shownTab()) === before, "the agent's new tab took the panel from the person typing an address");
  check((await run(`document.querySelector('.brp-url').value`)).includes("still-typing"), "the agent's new tab lost what the person was typing");
  // Away from it, the panel follows again.
  await say("sixth");
  check((await shownTab()) === "/six", `the panel does not follow once the person left the address field: ${JSON.stringify({ shown: await shownTab(), active: await run(`document.activeElement.className`), key: await mrun(`__win().isFocused()`), focused: await mrun(`__e.webContents.getAllWebContents().filter((w) => w.isFocused()).map((w) => w.getURL())`), tabs: (await tabs()).map((t) => path_(t.url)) })}`);
  // A person who clicked in the page has the keyboard there: its navigation keeps it there, and
  // the agent's tabs do not take the panel. (Not the agent's click: a mouse event of its own.)
  await say("select");
  await say("input");
  // A real click makes the window key before anything else; this stand-in for one needs it done first.
  await mrun(`__e.app.focus({ steal: true }); __win().focus()`);
  for (let i = 0; i < 40 && !(await mrun(`__win().isFocused()`)); i++) await sleep(25);
  await mrun(`(() => { const wc = __e.webContents.getAllWebContents().find((w) => __win().contentView.children.some((v) => v.webContents === w)); wc.sendInputEvent({ type: "mouseDown", x: 300, y: 300, button: "left", clickCount: 1 }); wc.sendInputEvent({ type: "mouseUp", x: 300, y: 300, button: "left", clickCount: 1 }); })()`);
  await sleep(300);
  const clicked = await shownTab();
  const inPage = () => mrun(`__win().isFocused() ? __e.webContents.getAllWebContents().filter((w) => w.isFocused()).map((w) => w.getURL()).join() : "not key"`);
  const inPageBefore = await inPage();
  check(inPageBefore === "not key" || inPageBefore.includes(clicked), `the person's click did not give the page the keyboard: ${inPageBefore}`);
  await sendWithoutComposer("seventh");
  check((await shownTab()) === clicked, "the agent's new tab took the panel from the person in the page");
  const inPageAfter = await inPage();
  check(inPageAfter === "not key" || inPageAfter.includes(clicked), `the agent's tab took the keyboard from the person in the page: ${inPageAfter}`);
  // Back in the conversation, the agent's new tabs show again.
  await say("eighth");
  check((await shownTab()) === "/eight", "the panel does not follow once the person left the page");

  // A blank tab the person opens still waits for its address.
  await run(`document.querySelector('.cmp-in').focus(); window.__watching = false`);
  await run(`document.querySelector('.brp-tabs ~ button').click()`);
  await until("the address waiting for the person", `document.activeElement === document.querySelector('.brp-url')`, 5000);

  // Panel put away: nothing stops, and nothing brings it back.
  await say("select");
  await run(hide);
  await until("the panel away", `!document.querySelector('.brp:not(.fpn)')`);
  await sleep(300);
  await mrun(`__events.length = 0`);
  await say("parkedInput");
  await stayed("acting with the panel away");
  check((await inTab("/four", `document.getElementById('a').value`)) === "parked", "the agent could not act with the panel away");
  check(!(await panel()), "acting brought the panel back");
  // A parked tab's dialogs and windows stay out of sight too.
  const beforeParked = windows();
  await say("popups");
  await stayed("native popups, panel away");
  const parkedEvents = await mrun(`__events`);
  check(parkedEvents.length === 0, `windows moved, panel away: ${parkedEvents}`);
  const parking = await mrun(`__e.BrowserWindow.getAllWindows().filter((w) => w !== __win() && w.isVisible()).length`);
  check(parking === 0, "the hidden window came out");
  const appearedParked = windows().filter((w) => !beforeParked.includes(w));
  check(appearedParked.length === 0, `windows appeared on screen, panel away: ${appearedParked}`);
  await say("newTab");
  check(!(await panel()), "a new tab brought the panel back");
  // It stays away in this conversation, across another one, until the person brings it back.
  await run(`[...document.querySelectorAll(".side-nav button")][0].click()`);
  await sleep(600);
  await say("other");
  await run(`document.querySelectorAll(".side .srow")[1].click()`);
  await sleep(800);
  check(!(await panel()), "coming back brought the put-away panel back");
  await run(`(${showButton}).click()`);
  await until("the panel back", `!!document.querySelector('.brp:not(.fpn)')`);
  await run(`document.querySelectorAll(".side .srow")[0].click()`);
  await sleep(600);
  await run(`document.querySelectorAll(".side .srow")[1].click()`);
  await sleep(800);
  check(await panel(), "the panel the person brought back did not stay");

  page.close();
  main.close();
  if (process.env.FINXWORK_E2E_VERBOSE) console.log(log.join("\n"));
  console.log("✓ the agent's browser never interrupts the person, panel shown or not");
} catch (error) {
  failed = true;
  console.error(error);
  console.error(log.join("\n"));
} finally {
  const exited = new Promise((r) => app.once("exit", r));
  app.kill("SIGTERM");
  const timeout = setTimeout(() => app.kill("SIGKILL"), 3000);
  await exited;
  clearTimeout(timeout);
  provider.close();
  site.close();
  try {
    execFileSync("pkill", ["-f", `${home}/run/finx.sock`]);
  } catch {}
  if (!failed) fs.rmSync(work, { recursive: true, force: true });
  else console.error(`left for inspection: ${work}`);
}
process.exit(failed ? 1 : 0);
