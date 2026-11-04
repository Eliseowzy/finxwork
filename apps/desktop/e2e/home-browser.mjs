#!/usr/bin/env node
// Verify the home toolbar opens and controls a real embedded browser.
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
const shots = process.env.FINXWORK_E2E_SHOTS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => {
  throw new Error(message);
};
const check = (ok, message) => ok || fail(message);

// Short: the kernel's socket lives under it, and a socket path has at most 103 bytes.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxc-"));
const home = path.join(work, "finx");
const profile = path.join(work, "profile");
const userHome = path.join(work, "home");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(userHome, { recursive: true });
const env = { ...process.env, FINX_HOME: home, HOME: userHome, FINX_CREDENTIAL_STORE: "file", FINX_NO_BROWSER: "1" };
// No model key either, so the first-run page always opens, once the models arrive, and can be left.
for (const k of Object.keys(env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete env[k];
// ── the app, driven over the DevTools protocol (as e2e/stale-model.mjs) ──
let app = null;
async function launch() {
  const port = 9400 + Math.floor(Math.random() * 400);
  app = spawn(electron, [desktop, ...(process.env.FINXWORK_E2E_NO_SANDBOX ? ["--no-sandbox"] : []), `--remote-debugging-port=${port}`], {
    env: { ...env, FINXWORK_DEFAULT_MODE: "sessions", FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINXWORK_NO_BROWSER: "1" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(200);
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => []);
    target = list.find((t) => t.type === "page" && /^(app:|file:)/.test(t.url) && !t.url.includes("#settings"));
  }
  check(target, "the main window never showed up");
  const page = await devtools(target.webSocketDebuggerUrl);
  const cdp = page.call;
  // Expressions answer with plain values (a DOM node cannot cross).
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
    await sleep(450); // sections fade in
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, "base64"));
  };
  const theme = (dark) => cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1240, height: 820, deviceScaleFactor: 0, mobile: false });
  return { cdp, run, until, shot, theme, close: page.close };
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
  const timeout = setTimeout(() => app.kill("SIGKILL"), 3000);
  await exited;
  clearTimeout(timeout);
}


let failed = false;
const site = http.createServer((_req, res) => res.end("<title>Browser button test</title><h1>Browser opened</h1>"));
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
try {
  const page = await launch();
  // Leave onboarding without configuring a model: browsing must work independently.
  await page.until("app loaded", `!!document.querySelector("button")`);
  // It opens only once the models have arrived, after the home page has shown: wait for it, then leave it.
  const skip = `[...document.querySelectorAll("button")].find(b => /稍后|later|skip/i.test(b.textContent))`;
  await page.until("the first-run page", `!!${skip}`);
  await page.run(`${skip}.click()`);
  const button = '.ctool button[aria-pressed]';
  await page.until("home browser button", `!!document.querySelector(${JSON.stringify(button)})`);
  await page.run(`document.querySelector(${JSON.stringify(button)}).click()`);
  await page.until("blank browser tab", `document.querySelectorAll(".brp-tab").length === 1 && !!document.querySelector(".brp-url")`);
  check(await page.run(`document.activeElement === document.querySelector(".brp-url")`), "address field is not focused");
  const url = `http://127.0.0.1:${site.address().port}/`;
  await page.run(`(() => {
    const input = document.querySelector('.brp-url');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(url)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await page.run(`document.querySelector('.brp-addr').requestSubmit()`);
  await page.until("real page loaded", `document.querySelector('.brp-tab-t')?.textContent === 'Browser button test'`, 60000);
  await page.shot("home-browser");
  // While the panel is open, the Browser button is at its right end and puts it away.
  const stripEnd = `[...document.querySelectorAll(".brp .brp-strip > button")].at(-1)`;
  if (await page.run(`!!document.querySelector(${JSON.stringify(button)})`)) throw new Error("the bar's Browser button stayed while the panel is open");
  await page.run(`(${stripEnd}).click()`);
  await page.until("panel hidden", `!document.querySelector('.brp') && !!document.querySelector(${JSON.stringify(button)})`);
  await page.run(`document.querySelector(${JSON.stringify(button)}).click()`);
  await page.until("tab restored", `document.querySelectorAll('.brp-tab').length === 1 && document.querySelector('.brp-tab-t')?.textContent === 'Browser button test'`, 60000);
  await page.run(`document.querySelector('.brp-tab-x').click()`);
  await page.until("last tab closed", `!document.querySelector('.brp')`);
  await page.run(`document.querySelector(${JSON.stringify(button)}).click()`);
  await page.until("new blank tab after closing", `document.querySelectorAll('.brp-tab').length === 1 && document.querySelector('.brp-url')?.value === ''`);
  page.close();
  console.log("✓ home browser opens, navigates, hides, restores and reopens after closing");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await quit();
  site.close();
  try { execFileSync("pkill", ["-f", `${home}/run/finx.sock`]); } catch {}
  if (!failed) fs.rmSync(work, { recursive: true, force: true });
  else console.error(`left for inspection: ${work}`);
}
process.exit(failed ? 1 : 0);
