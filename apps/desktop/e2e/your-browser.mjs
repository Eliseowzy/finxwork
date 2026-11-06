#!/usr/bin/env node
// Verify the user's own browser in a session (browser-design §8.4.7), with the real app, a real
// Chrome with the extension and the real finx, driven by a scripted model: a manifest that points
// at nothing is repaired and another home's left alone; the info card's row appears with the
// session's tabs and goes to them; the row moves to the top bar when the card does not show; a
// page handed to the user asks above the composer, with a system notification when the app is not
// in front, and goes on when they are done; the host dying is repaired by itself and the session
// finds its tab; Chrome being gone makes the task wait, starts it quietly, and asks after a while;
// the user taking control back shows, and allowing it again works; a tab offered from the extension
// goes to the conversation; Close All closes the tabs; a second browser stands by, Settings lists
// both, and the one chosen stays chosen when it is away. Everything stays in a private HOME, so the
// developer's own Chrome is never touched. Needs `pnpm build`, `cargo build -p finx-cli` and Google
// Chrome. FINXWORK_E2E_APP=<FinxWork.app> runs the packaged app instead.
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
const chromeExe = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const electron = createRequire(import.meta.url)("electron");
const packaged = process.env.FINXWORK_E2E_APP ? path.resolve(process.env.FINXWORK_E2E_APP) : null;
const shots = process.env.FINXWORK_E2E_SHOTS;
const theme = process.env.FINXWORK_E2E_THEME;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => {
  throw new Error(message);
};
const check = (ok, message) => ok || fail(message);
const step = (s) => console.log(`\n▶ ${s}`);
if (!fs.existsSync(chromeExe)) {
  console.log("no Google Chrome; skipping");
  process.exit(0);
}

// Short: the kernel's socket lives under it, and a socket path has at most 103 bytes.
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fxy-")));
const home = path.join(work, "finx");
const profile = path.join(work, "profile");
const userHome = path.join(work, "home");
const chromeData = path.join(userHome, "Library/Application Support/Google/Chrome");
const opened = path.join(work, "opened.jsonl");
const notified = path.join(work, "notified.jsonl");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(path.join(chromeData, "NativeMessagingHosts"), { recursive: true });
const manifestFile = path.join(chromeData, "NativeMessagingHosts/com.finxwork.browser.json");
const env = {
  ...process.env,
  FINX_HOME: home,
  HOME: userHome,
  FINX_CREDENTIAL_STORE: "file",
  FINX_NO_BROWSER: "1",
  FINXWORK_E2E_OPENED: opened,
  FINXWORK_E2E_NOTIFIED: notified,
};
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

// ── the websites ──
const site = http.createServer((req, res) => {
  const page = { "/": ["Kept page", "KEPT_PAGE_CONTENT"], "/login": ["Sign in", "SIGN_IN_FORM"], "/mine": ["My own page", "MY_OWN_PAGE"] }[req.url] ?? ["Other", "OTHER"];
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html><title>${page[0]}</title><h1>${page[1]}</h1>`);
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const url = (p = "/") => `http://127.0.0.1:${site.address().port}${p}`;

// ── the model: its next step by the last thing the user said and how far it got ──
const requests = [];
let holdFinish = 0;
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    if (req.method !== "POST" || !body) return res.end(JSON.stringify({ data: [] }));
    const request = JSON.parse(body);
    requests.push(request);
    const last = request.messages.findLastIndex((m) => m.role === "user");
    const said = JSON.stringify(request.messages[last].content);
    const done = request.messages.slice(last).filter((m) => m.role === "tool").length;
    const call = (name, args) => ({ role: "assistant", tool_calls: [{ index: 0, id: `c${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
    let delta;
    if (done > 0) {
      await sleep(holdFinish);
      const result = JSON.stringify(request.messages.findLast((m) => m.role === "tool").content);
      delta = { role: "assistant", content: `TURN_DONE ${result.slice(0, 400)}` };
    } else if (said.includes("打开页面")) delta = call("browser_navigate", { url: url(), browser: "yours" });
    else if (said.includes("读标签页")) delta = call("browser_snapshot", { tab: "y1" });
    // As a model does: the browser's tools are deferred, and run through call_tool.
    else if (said.includes("请你登录")) delta = call("call_tool", { name: "browser_wait", arguments: { user: "sign in to the test site" } });
    else if (said.includes("列标签页")) delta = call("browser_tabs", {});
    else delta = { role: "assistant", content: "TURN_DONE nothing to do" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`);
  });
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
fs.writeFileSync(path.join(home, "models.toml"), `[providers.mock]\nname = "Mock"\napi = "openai-chat"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nauth = "none"\n[[providers.mock.models]]\nid = "mock-1"\nname = "Mock One"\ncontext_window = 128000\nmax_output_tokens = 2000\n`);
fs.writeFileSync(path.join(home, "config.toml"), `model = "mock/mock-1"\npermission_mode = "bypass-permissions"\n[models]\nnetwork = false\n[browser]\nenabled = true\nextension = true\ndefault = "yours"\n[browser.sites]\n"*" = "act"\n`);

// ── the app, driven over the DevTools protocol ──
let app = null;
const port = cdpPort();

async function devtools(wsUrl) {
  const ws = new WebSocket(wsUrl);
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
  return { call };
}

async function attach(match, what) {
  let target;
  for (let i = 0; i < 150 && !target; i++) {
    await sleep(200);
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => []);
    target = list.find(match);
  }
  check(target, `${what} never showed up`);
  const { call: cdp } = await devtools(target.webSocketDebuggerUrl);
  const run = async (expr) => {
    const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) fail(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const shot = async (name) => {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    await sleep(350);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, "base64"));
  };
  const until = async (label, expr, ms = 30000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await run(expr);
      if (v) return v;
      if (Date.now() > end) {
        await shot("failed");
        fail(`timed out waiting for ${label}: ${await run("document.body.innerText.slice(-900)")}`);
      }
      await sleep(100);
    }
  };
  return { cdp, run, until, shot };
}

// ── Chrome with the extension, over its pipe ──
let chrome = null;
let send = null;
let nextId = 1;
const others = [];

/** A Chrome on a profile, with the extension from `folder`. */
async function chromeOn(dataDir, folder) {
  const process = spawn(
    chromeExe,
    ["--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${dataDir}`, "--headless=new", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--password-store=basic", "about:blank"],
    { env, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  const answers = new Map();
  let buffer = "";
  process.stdio[4].on("data", (chunk) => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf("\0")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (message.id) answers.get(message.id)?.(message);
    }
  });
  const toThis = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      answers.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      process.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  const loaded = await toThis("Extensions.loadUnpacked", { path: folder });
  check(loaded.id === "fgaadfmkicjchgjlomjemofnllanlcoo", `the extension did not load: ${JSON.stringify(loaded)}`);
  return { process, send: toThis };
}

async function startChrome(folder) {
  const started = await chromeOn(chromeData, folder);
  chrome = started.process;
  send = started.send;
}

/** Runs an expression in the extension's worker, or in one of its pages. */
async function inTarget(targetId, expression, via = send) {
  const { sessionId } = await via("Target.attachToTarget", { targetId, flatten: true });
  const r = await via("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  await via("Target.detachFromTarget", { sessionId }).catch(() => {});
  if (r.exceptionDetails) fail(`extension: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

async function inWorker(expression, via = send) {
  for (let i = 0; i < 100; i++) {
    const { targetInfos } = await via("Target.getTargets");
    const worker = targetInfos.find((t) => t.type === "service_worker" && t.url.includes("fgaadfmkicjchgjlomjemofnllanlcoo"));
    // Right after the first attach to a worker, an evaluation can run before `chrome` is there.
    if (worker && (await inTarget(worker.targetId, "typeof chrome", via)) === "object") return inTarget(worker.targetId, expression, via);
    await sleep(100);
  }
  fail("the extension's worker is not running");
}

const untilIn = async (label, read, ok, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) fail(`timed out waiting for ${label}: ${JSON.stringify(v)}`);
    await sleep(150);
  }
};

async function quit() {
  chrome?.kill("SIGKILL");
  for (const other of others) other.kill("SIGKILL");
  if (!app || app.exitCode !== null) return;
  const exited = new Promise((r) => app.once("exit", r));
  app.kill("SIGTERM");
  const timeout = setTimeout(() => app.kill("SIGKILL"), 3000);
  await exited;
  clearTimeout(timeout);
}

const row = `document.querySelector('.yr .insp-row')`;
const rowText = `${row}?.innerText.replace(/\\s+/g, ' ').trim()`;
const topButton = `document.querySelector('.ctool .tb .yb-mark')?.closest('button')`;
/** A button by its label in either language. */
const button = (...labels) => `[...document.querySelectorAll('button')].find(b => ${JSON.stringify(labels)}.some(l => b.textContent.trim().startsWith(l)))`;

let failed = false;
try {
  // ── a manifest pointing at nothing, as a test with its own home used to leave ──
  fs.writeFileSync(manifestFile, JSON.stringify({ name: "com.finxwork.browser", path: "/nonexistent/native-host", type: "stdio" }));
  const executable = packaged ? path.join(packaged, "Contents/MacOS/FinxWork") : electron;
  // A session's events reach the page on the next frame, and a window covered by another gets none.
  const args = [...(packaged ? [] : [desktop]), `--remote-debugging-port=${port}`, "--disable-backgrounding-occluded-windows"];
  app = spawn(executable, args, {
    env: { ...env, FINXWORK_DEFAULT_MODE: "sessions", FINXWORK_USER_DATA: profile, ...(packaged ? {} : { FINXWORK_FINX: finx }), FINXWORK_NO_BROWSER: "1" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const main = await attach((t) => t.type === "page" && /^(app:|file:)/.test(t.url) && !t.url.includes("#settings"), "the main window");
  await main.cdp("Emulation.setDeviceMetricsOverride", { width: 1240, height: 820, deviceScaleFactor: 0, mobile: false });
  if (theme) await main.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
  await main.until("the composer", `(() => { const skip = [...document.querySelectorAll("button")].find(b => /稍后|later|skip/i.test(b.textContent)); if (skip) { skip.click(); return false; } return !!document.querySelector(".cmp-in"); })()`);
  const say = async (text) => {
    await main.run(`document.querySelector('.cmp-in').focus()`);
    await main.cdp("Input.insertText", { text });
    await main.until("send enabled", `!document.querySelector('button.send')?.disabled`);
    await main.run(`document.querySelector('button.send').click()`);
  };

  step("a manifest that points at nothing is repaired; another home's is left alone");
  const launcher = path.join(home, "browser/native-host");
  await untilIn("the repaired manifest", () => JSON.parse(fs.readFileSync(manifestFile, "utf8")).path, (p) => p === launcher, 30000);
  const other = path.join(work, "another-home-host");
  fs.writeFileSync(other, "");
  fs.writeFileSync(manifestFile, JSON.stringify({ name: "com.finxwork.browser", path: other, type: "stdio" }));
  await main.run(`window.finx.repairSystemBrowser()`);
  check(JSON.parse(fs.readFileSync(manifestFile, "utf8")).path === other, "another home's manifest was overwritten");
  await main.run(`window.finx.setUpSystemBrowser()`);
  check(JSON.parse(fs.readFileSync(manifestFile, "utf8")).path === launcher, "the guide did not take the manifest over");
  const folder = path.join(home, "browser/FinxWork Extension");
  check(fs.existsSync(path.join(folder, "build.json")) && fs.existsSync(path.join(folder, "src/popup.html")), "the extension folder is not ready");
  check(!fs.existsSync(`${folder}.new`) && !fs.existsSync(`${folder}.old`), "the folder's replacement left something beside it");
  await startChrome(folder);

  step("no tabs yet: the card has no row and the top bar no button");
  await say("没用到浏览器的问题");
  await main.until("the answer", `document.body.innerText.includes('TURN_DONE nothing to do')`);
  await main.until("the info card", `!!document.querySelector('.insp-stack')`);
  check(await main.run(`!document.querySelector('.yr') && !${topButton}`), "something shows with no tabs");
  await main.shot("1-no-tabs");

  step("a task opens a page in Chrome: the row appears, with its work");
  holdFinish = 3000;
  await say("打开页面");
  await main.until("the row", rowText, 40000);
  await main.until("the row at work", `!!document.querySelector('.yr .insp-sub.shimmer')`);
  await main.shot("2-working");
  const atWork = await untilIn("the group", () => inWorker(`chrome.tabs.query({url: ${JSON.stringify(url())}}).then(t => t[0]?.groupId ?? -1)`), (g) => g > 0);
  await untilIn("the group blue while at work", () => inWorker(`chrome.tabGroups.get(${atWork}).then(g => g.color)`), (c) => c === "blue", 2500);
  await main.until("the task's end", `document.body.innerText.includes('KEPT_PAGE_CONTENT')`, 40000);
  holdFinish = 0;
  await main.until("one tab, at rest", `/Chrome · 1\\b/.test(${rowText}) && !document.querySelector('.yr .insp-sub.shimmer')`);
  check(await main.run(`!${topButton}`), "the row and the button both show");
  await main.shot("3-at-rest");
  const session = await main.run(`document.querySelector('.srow.sel') && JSON.parse(localStorage.getItem('main-view')).selection.id`);
  check(session, "no session selected");
  // The debugger let go, so Chrome's bar is gone; the tab stays, in a group named after the session.
  const pageTab = () => inWorker(`chrome.tabs.query({url: ${JSON.stringify(url())}}).then(t => t[0] ? ({id: t[0].id, active: t[0].active, group: t[0].groupId}) : null)`);
  const tab = await untilIn("the tab", pageTab, (t) => t);
  await untilIn("the debugger gone", async () => (await send("Target.getTargets")).targetInfos.find((t) => t.url === url())?.attached, (a) => a === false);
  const groupOf = (id) => inWorker(`chrome.tabGroups.get(${id}).then(g => ({title: g.title, color: g.color}))`);
  await untilIn("the group's name", () => groupOf(tab.group), (g) => g.title.includes("没用到浏览器") && g.color === "grey");

  step("the row goes to the browser");
  fs.rmSync(opened, { force: true });
  await send("Target.createTarget", { url: "about:blank" });
  await main.run(`${row}.click()`);
  await untilIn("the tab in front", pageTab, (t) => t?.active);
  await untilIn("the browser brought forward", () => lines(opened), (l) => l.some((o) => o.browser.includes("/Applications/Google Chrome.app")));

  step("the card closed: the row moves to the top bar");
  await main.run(`document.querySelector('.ctool button[aria-pressed="true"]').click()`);
  await main.until("the button", `!!${topButton} && !document.querySelector('.yr')`);
  await main.shot("4-top-bar");
  await send("Target.createTarget", { url: "about:blank" });
  await main.run(`${topButton}.click()`);
  await untilIn("the tab in front again", pageTab, (t) => t?.active);
  await main.run(`document.querySelector('.ctool button[aria-pressed="false"]').click()`);
  await main.until("the row back", `!!document.querySelector('.yr') && !${topButton}`);

  step("the tabs menu lists them and goes to one");
  await main.run(`document.querySelector('.yr-more').click()`);
  await main.until("the menu", `document.querySelector('.vmenu')?.innerText.includes('Kept page')`);
  const [menuTop, buttonBottom] = await main.run(`[document.querySelector('.vmenu').getBoundingClientRect().top, document.querySelector('.yr-more').getBoundingClientRect().bottom]`);
  check(menuTop >= buttonBottom, `the menu opens away from its button: ${menuTop} above ${buttonBottom}`);
  await main.shot("5-menu");
  await main.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await main.run(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);

  step("a page handed to the user: above the composer, and a notification when the app is not in front");
  await main.run(`document.hasFocus = () => false`);
  await say("请你登录");
  await main.until("the card", `document.querySelector('.appr')?.innerText.includes('sign in to the test site')`);
  await main.until("the row says so", `!!document.querySelector('.yr .sdot.w')`);
  await main.shot("6-handoff");
  await untilIn("the notification", () => lines(notified), (l) => l.some((n) => n.group === `session:${session}`));
  await untilIn("the group says so", () => groupOf(tab.group), (g) => g.color === "orange");
  await main.run(`document.hasFocus = () => true`);
  fs.rmSync(opened, { force: true });
  check(await main.run(`!${button("我处理好了", "I'm Done")}`), "done before going there");
  await main.run(`document.querySelector('.appr .btn.primary').click()`);
  await untilIn("Chrome brought forward", () => lines(opened), (l) => l.length > 0);
  await main.until("done, now", `!!${button("我处理好了", "I'm Done")}`);
  await main.shot("7-handoff-went");
  await main.run(`${button("我处理好了", "I'm Done")}.click()`);
  await main.until("the task goes on", `document.body.innerText.includes('The user says they are done')`, 40000);
  await untilIn("the group back", () => groupOf(tab.group), (g) => g.color === "grey");
  await main.until("the row at rest", `!document.querySelector('.yr .sdot')`);

  step("the host dies: it comes back by itself, and the session finds its tab");
  const hosts = execFileSync("/usr/bin/pgrep", ["-P", String(chrome.pid), "-f", "native-host"], { encoding: "utf8" }).trim().split("\n");
  const died = Date.now();
  process.kill(Number(hosts[0]), "SIGKILL");
  await main.until("reconnecting", `/正在重新连接|reconnecting/.test(${rowText})`, 5000);
  await main.shot("8-reconnecting");
  await main.until("back", `/Chrome · 1\\b/.test(${rowText})`, 10000);
  console.log(`  back after ${Date.now() - died} ms`);
  await say("读标签页");
  await main.until("the tab read", `[...document.querySelectorAll('.am')].some(a => a.innerText.includes('KEPT_PAGE_CONTENT') && a.innerText.includes('still open'))`, 40000);

  step("the user takes control back: the row says so, and allowing it again works");
  await inWorker(`chrome.debugger.onDetach.dispatch({tabId: ${tab.id}}, 'canceled_by_user')`);
  await main.until("revoked", `/已收回控制|taken back/.test(${rowText})`);
  await main.shot("9-revoked");
  await say("读标签页");
  await main.until("the agent is told", `document.body.innerText.includes('took back control')`, 40000);
  await main.run(`document.querySelector('.yr-act').click()`);
  await main.until("allowed", `/Chrome · 1\\b/.test(${rowText})`);

  step("Chrome goes away: the task waits, Chrome is started quietly, and after a while the user is asked");
  fs.rmSync(opened, { force: true });
  chrome.kill("SIGKILL");
  await main.until("not connected", `/正在重新连接|reconnecting|正在打开|opening/.test(${rowText}) || !${row}`, 10000);
  await say("打开页面");
  await untilIn("Chrome started in the background", () => lines(opened), (l) => l.some((o) => o.browser[0] === "-g"), 20000);
  await main.until("the working line", `/等你的浏览器连上|Waiting for your browser/.test(document.body.innerText)`, 20000);
  await main.until("the card", `/FinxWork 扩展没有连上|FinxWork extension in/.test(document.querySelector('.appr')?.innerText ?? '')`, 20000);
  await main.shot("10-extension-away");
  // A host of another program is refused, and says why: what is left is the user's.
  const older = path.join(work, "older-finx");
  fs.copyFileSync(finx, older);
  const stale = spawn(older, ["browser", "native-host"], { env, stdio: ["pipe", "ignore", "ignore"] });
  const said = Buffer.from(JSON.stringify({ hello: { browser: "Google Chrome 141", extension_version: "0.1.0" } }));
  const size = Buffer.alloc(4);
  size.writeUInt32LE(said.length);
  stale.stdin.write(Buffer.concat([size, said]));
  await main.until("the card says what to do", `/旧程序|old program/.test(document.querySelector('.appr')?.innerText ?? '')`, 20000);
  stale.kill("SIGKILL");
  await main.run(`document.querySelector('.appr .btn:not(.primary)').click()`);
  await main.until("the agent hears the user's choice", `document.body.innerText.includes('chose not to use')`, 30000);
  await startChrome(folder);
  await main.until("Chrome back, no tabs left", `!document.querySelector('.appr') && !${row}`, 30000);

  step("the browser comes back: a task opens a page again");
  await say("打开页面");
  await main.until("the row again", `/Chrome · 1\\b/.test(${rowText})`, 40000);

  step("a tab offered from the extension goes to the conversation");
  const popup = (await send("Target.createTarget", { url: "chrome-extension://fgaadfmkicjchgjlomjemofnllanlcoo/src/popup.html", background: true })).targetId;
  // A new target starts on a blank document: its page comes next.
  await untilIn("the extension's page", () => inTarget(popup, "location.pathname + document.readyState").catch(() => ""), (v) => v === "/src/popup.htmlcomplete");
  const mine = (await send("Target.createTarget", { url: url("/mine") })).targetId;
  await send("Target.activateTarget", { targetId: mine });
  await sleep(600);
  await inTarget(popup, `chrome.runtime.sendMessage({do: 'offer'})`);
  await main.until("the offer", `document.querySelector('.yours-offer')?.innerText.includes('My own page')`);
  await main.shot("11-offer");
  await say("列标签页");
  await main.until("two tabs", `/Chrome · 2\\b/.test(${rowText})`, 40000);
  await main.until("both listed", `[...document.querySelectorAll('.am')].some(a => a.innerText.includes('My own page'))`, 40000);
  check(await main.run(`!document.querySelector('.yours-offer')`), "the offer stayed");
  const told = JSON.stringify(requests.at(-1).messages);
  check(told.includes("handed you a tab of their own browser"), "the model was not told about the tab");

  step("back to the conversation, from the extension");
  await main.run(`document.querySelector('.side-nav button').click()`);
  await main.until("the new session page", `!!document.querySelector('.cmp-zone.new')`);
  await inTarget(popup, `chrome.runtime.sendMessage({do: 'back', session: ${JSON.stringify(session)}})`);
  await main.until("the session open", `!!document.querySelector('.cmp-zone.session') && !!document.querySelector('.yr')`);

  step("Close All closes the agent's tabs");
  await main.run(`document.querySelector('.yr-more').click()`);
  await main.until("the menu", `[...document.querySelectorAll('.vmenu .mi')].some(m => /全部关闭|Close All/.test(m.textContent))`);
  await main.run(`[...document.querySelectorAll('.vmenu .mi')].find(m => /全部关闭|Close All/.test(m.textContent)).click()`);
  await main.until("no row", `!${row}`);
  const urls = (await send("Target.getTargets")).targetInfos.map((t) => t.url);
  check(!urls.includes(url()) && !urls.includes(url("/mine")), `tabs left: ${urls}`);

  step("Settings shows each link from the browser to the service");
  await main.run(`window.finx.openSettings("browser")`);
  const set = await attach((t) => t.type === "page" && t.url.includes("#settings"), "the settings window");
  if (theme) await set.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
  await set.until("the page, connected", `!!document.querySelector('.browser-set .yours-row .badge.ok')`);
  await set.run(`[...document.querySelectorAll('.browser-set .qb')].find(b => /诊断|Diagnostics/.test(b.textContent)).click()`);
  const diagnosis = await set.until("the diagnosis", `document.querySelector('.browser-diag')?.textContent`);
  check(diagnosis.includes("manifest ours") && diagnosis.includes("extension: Google Chrome"), `the diagnosis: ${diagnosis}`);
  await set.shot("12-diagnosis");

  step("a second browser: it stands by, Settings lists both, and the one chosen stays chosen");
  const otherData = path.join(work, "other-chrome");
  fs.mkdirSync(path.join(otherData, "NativeMessagingHosts"), { recursive: true });
  fs.copyFileSync(manifestFile, path.join(otherData, "NativeMessagingHosts/com.finxwork.browser.json"));
  const second = await chromeOn(otherData, folder);
  others.push(second.process);
  await set.until("both listed", `document.querySelectorAll('.ext-row').length === 2`, 30000);
  check(await set.run(`!!document.querySelector('.ext-row:first-child .badge') && !!document.querySelector('.ext-row:last-child .btn')`), "the first should stay in use");
  await set.run(`[...document.querySelectorAll('.browser-diag-bar .qb')].at(-1).click(); document.querySelector('.ext-row').scrollIntoView({ block: 'center' })`);
  await set.shot("13-two-browsers");
  await set.run(`document.querySelector('.ext-row:last-child .btn').click()`);
  await set.until("the second in use", `!!document.querySelector('.ext-row:last-child .badge') && !!document.querySelector('.ext-row:first-child .btn')`);
  await untilIn("the first stands by", () => inWorker(`chrome.action.getTitle({})`), (title) => /没有在用|standby|not in use/i.test(title));
  await say("打开页面");
  const inSecond = () => second.send("Target.getTargets").then((r) => r.targetInfos.some((t) => t.url === url()));
  await untilIn("the page in the second browser", inSecond, (found) => found, 40000);
  check(!(await send("Target.getTargets")).targetInfos.some((t) => t.url === url()), "the page opened in the browser not chosen");
  await main.until("the task done", `!document.querySelector('.cmp-zone.session button.send.stop, .cmp-zone.session button.stop')`, 40000);

  // The chosen one goes away: the agent does not move to the other's account by itself, and asks.
  second.process.kill("SIGKILL");
  await set.until("the chosen one gone", `document.querySelectorAll('.ext-row').length === 0 || !document.querySelector('.ext-row .badge')`, 15000);
  await set.run(`window.close()`).catch(() => {});
  await say("打开页面");
  await main.until("the card offers the other", `/改用它|Use That One/.test(document.querySelector('.appr')?.innerText ?? '')`, 30000);
  check(!(await send("Target.getTargets")).targetInfos.some((t) => t.url === url()), "the agent moved to the other browser by itself");
  await main.shot("14-chosen-away");
  await main.run(`document.querySelector('.appr .btn.primary').click()`);
  await untilIn("the page in the first browser now", () => send("Target.getTargets").then((r) => r.targetInfos.some((t) => t.url === url())), (found) => found, 40000);
  await main.until("no card", `!document.querySelector('.appr')`);
  console.log("\nyour browser: ok");
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await quit();
  site.close();
  provider.close();
  try {
    execFileSync("pkill", ["-f", `${home}/run/finx.sock`]);
  } catch {
    // It stopped with the app.
  }
  if (!failed) fs.rmSync(work, { recursive: true, force: true });
  else console.error(`kept ${work}`);
}
process.exit(failed ? 1 : 0);
