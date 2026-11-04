#!/usr/bin/env node
// Verify the app quits at once after its browser panel has shown a page: the hidden window
// tabs wait in must not come back while the windows close. A SIGTERM is a quit, as ⌘Q is;
// nothing here falls back to SIGKILL, which would hide an app that never finishes quitting.
// Second, closing the main window: on macOS the app and its tab stay (the agent may still be
// browsing) and a quit then ends both; elsewhere the app quits with its last window.
// FINXWORK_E2E_APP=<executable> runs a packaged app instead of this checkout's build.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "../..");
const finx = path.join(root, "target/debug/finx");
const packaged = process.env.FINXWORK_E2E_APP;
const electron = packaged ? null : createRequire(import.meta.url)("electron");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => {
  throw new Error(message);
};
const check = (ok, message) => ok || fail(message);

// Short: the kernel's socket lives under it, and a socket path has at most 103 bytes.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxc-"));
const home = path.join(work, "finx");
// One profile per launch, so each starts at the first-run page.
const profile = path.join(work, "profile");
const userHome = path.join(work, "home");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(userHome, { recursive: true });
const env = { ...process.env, FINX_HOME: home, HOME: userHome, FINX_CREDENTIAL_STORE: "file", FINX_NO_BROWSER: "1" };
// No model key either, so the first-run page always opens, once the models arrive, and can be left.
for (const k of Object.keys(env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete env[k];

let app = null;
let port = 0;
let launches = 0;
async function launch() {
  port = 9400 + Math.floor(Math.random() * 400);
  const args = [...(process.env.FINXWORK_E2E_NO_SANDBOX ? ["--no-sandbox"] : []), `--remote-debugging-port=${port}`];
  app = spawn(packaged ?? electron, packaged ? args : [desktop, ...args], {
    env: { ...env, FINXWORK_DEFAULT_MODE: "sessions", FINXWORK_USER_DATA: `${profile}-${++launches}`, FINXWORK_FINX: finx, FINXWORK_NO_BROWSER: "1" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(200);
    target = (await targets()).find((t) => t.type === "page" && /^(app:|file:)/.test(t.url) && !t.url.includes("#settings"));
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
  return { cdp, run, until, close: page.close };
}

const targets = () => fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => []);

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
  // Calls left unanswered when the app goes away fail rather than hang.
  ws.onclose = () => {
    for (const w of waiting.values()) w.reject(new Error("closed"));
    waiting.clear();
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      waiting.set(++next, { resolve, reject });
      ws.send(JSON.stringify({ id: next, method, params }));
    });
  return { call, close: () => ws.close() };
}

/** Whether the app has exited within `ms`, and how. */
async function exits(ms) {
  if (app.exitCode !== null || app.signalCode !== null) return { code: app.exitCode, signal: app.signalCode };
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    app.once("exit", (code, signal) => (clearTimeout(timer), resolve({ code, signal })));
  });
}

/** SIGTERM, as a quit: the app must end within 5 seconds, by itself and cleanly. */
async function quitsCleanly(what) {
  app.kill("SIGTERM");
  const exit = await exits(5000);
  check(exit, `${what}: the app was still running 5 seconds after SIGTERM`);
  check(exit.code === 0 && !exit.signal, `${what}: the app ended with code ${exit.code}, signal ${exit.signal}`);
}

/** Opens the home browser and loads the test site in it. */
async function showPage(page, url) {
  await page.until("app loaded", `!!document.querySelector("button")`);
  const skip = `[...document.querySelectorAll("button")].find(b => /稍后|later|skip/i.test(b.textContent))`;
  await page.until("the first-run page", `!!${skip}`);
  await page.run(`${skip}.click()`);
  const button = '.ctool button[aria-pressed]';
  await page.until("home browser button", `!!document.querySelector(${JSON.stringify(button)})`);
  await page.run(`document.querySelector(${JSON.stringify(button)}).click()`);
  await page.until("blank browser tab", `document.querySelectorAll(".brp-tab").length === 1 && !!document.querySelector(".brp-url")`);
  await page.run(`(() => {
    const input = document.querySelector('.brp-url');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(url)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await page.run(`document.querySelector('.brp-addr').requestSubmit()`);
  await page.until("page shown in the panel", `document.querySelector('.brp-tab-t')?.textContent === 'Quit test'`, 60000);
  // The tab is placed in the window once its page has come.
  await sleep(1500);
}

let failed = false;
const site = http.createServer((_req, res) => res.end("<title>Quit test</title><h1>A page in the panel</h1>"));
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${site.address().port}/`;
try {
  // 1. Quit with a page in the panel.
  let page = await launch();
  await showPage(page, url);
  page.close();
  await quitsCleanly("quit with a page in the panel");
  console.log("✓ quits at once after the panel has shown a page");

  // 2. Close the main window first.
  page = await launch();
  await showPage(page, url);
  void page.run("window.close()").catch(() => {});
  if (process.platform === "darwin") {
    check(!(await exits(3000)), "the app quit when its window closed");
    const list = await targets();
    check(!list.some((t) => t.type === "page" && /^app:/.test(t.url)), "the main window is still open");
    check(list.some((t) => t.url === url), "the tab did not stay after the window closed");
    await quitsCleanly("quit after the window closed");
    console.log("✓ the tab stays when the window closes, and the app quits afterwards");
  } else {
    const exit = await exits(5000);
    check(exit && exit.code === 0, `the app did not quit with its last window: ${JSON.stringify(exit)}`);
    console.log("✓ the app quits with its last window");
  }
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  // Only a failed run gets here with the app still up.
  if (app && app.exitCode === null && app.signalCode === null) app.kill("SIGKILL");
  site.close();
  try { execFileSync("pkill", ["-f", `${home}/run/finx.sock`]); } catch {}
  if (!failed) fs.rmSync(work, { recursive: true, force: true });
  else console.error(`left for inspection: ${work}`);
}
process.exit(failed ? 1 : 0);
