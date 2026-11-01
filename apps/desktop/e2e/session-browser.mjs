#!/usr/bin/env node
// Verify a conversation with no pages opens the browser from its own toolbar.
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
const requests = [];
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => body += chunk);
  req.on("end", () => {
    // Anything but a chat completion (the kernel's model probes) gets an empty answer.
    if (req.method !== "POST" || !body) return res.end(JSON.stringify({ data: [] }));
    const request = JSON.parse(body);
    requests.push(request);
    const delta = { role: "assistant", content: "SESSION_REPLY_DONE" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
fs.writeFileSync(path.join(home, "models.toml"), `[providers.mock]\nname = "Mock"\napi = "openai-chat"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nauth = "none"\n[[providers.mock.models]]\nid = "mock-1"\nname = "Mock One"\ncontext_window = 128000\nmax_output_tokens = 2000\n`);
fs.writeFileSync(path.join(home, "config.toml"), `model = "mock/mock-1"\npermission_mode = "bypass-permissions"\n[models]\nnetwork = false\n[browser]\nenabled = true\n`);
// ── the app, driven over the DevTools protocol (as e2e/stale-model.mjs) ──
let app = null;
async function launch() {
  const port = 9400 + Math.floor(Math.random() * 400);
  app = spawn(electron, [desktop, ...(process.env.FINXWORK_E2E_NO_SANDBOX ? ["--no-sandbox"] : []), `--remote-debugging-port=${port}`], {
    env: { ...env, FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINXWORK_NO_BROWSER: "1" },
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
try {
  const page = await launch();
  // Leave onboarding without configuring a model: browsing must work independently.
  await page.until("app loaded", `!!document.querySelector("button")`);
  // The onboarding page may show up after the first check: keep leaving it until the home page is there.
  await page.until("onboarding left", `(() => { const skip = [...document.querySelectorAll("button")].find(b => /稍后|later|skip/i.test(b.textContent)); if (skip) { skip.click(); return false; } return !!document.querySelector(".ctool button[aria-pressed]"); })()`);
  await page.run(`document.querySelector('.cmp-in').focus()`);
  await page.cdp("Input.insertText", { text: "你好" });
  await page.until("send enabled", `!document.querySelector('button.send')?.disabled`);
  await page.run(`document.querySelector('button.send').click()`);
  await page.until("the reply", `document.body.innerText.includes('SESSION_REPLY_DONE')`, 60000);
  check((await page.run(`window.finx.browserTabs()`)).length === 0, "a tab exists before the button is clicked");
  check(!(await page.run(`!!document.querySelector('.brp')`)), "the panel shows with no tabs");
  const button = `[...document.querySelectorAll('.spage .ctool button')].find(b => /^(Browser|浏览器)$/.test(b.getAttribute('aria-label')))`;
  check(await page.run(`!!(${button})`), "the session page has no browser button");
  await page.run(`(${button}).click()`);
  await page.until("blank session tab", `document.querySelectorAll(".brp-tab").length === 1`);
  const tabs = await page.run(`window.finx.browserTabs()`);
  check(tabs.length === 1 && tabs[0].session && tabs[0].session !== "finxwork:home-browser" && tabs[0].shown, `the tab is not the session's: ${JSON.stringify(tabs)}`);
  await page.shot("session-browser");
  await page.run(`(${button}).click()`);
  await page.until("panel hidden", `!document.querySelector('.brp')`);
  await page.run(`(${button}).click()`);
  await page.until("panel back with the same tab", `document.querySelectorAll('.brp-tab').length === 1`);
  check((await page.run(`window.finx.browserTabs()`)).length === 1, "reopening made another tab");
  // Dragged all the way left, the conversation keeps a 160px strip.
  const grip = await page.run(`(() => { const r = document.querySelector('.brp-grip').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const mouse = (type, x) => page.cdp("Input.dispatchMouseEvent", { type, x, y: grip.y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
  await mouse("mousePressed", grip.x);
  for (let x = grip.x; x > 0; x -= 60) await mouse("mouseMoved", Math.max(1, x));
  await mouse("mouseReleased", 1);
  await sleep(300);
  const widths = await page.run(`({ conversation: document.querySelector('.scol').getBoundingClientRect().width, panel: document.querySelector('.brp').getBoundingClientRect().width })`);
  check(Math.abs(widths.conversation - 160) <= 2, `the conversation kept ${JSON.stringify(widths)}`);
  await page.shot("session-browser-wide");
  page.close();
  console.log("✓ a conversation without pages opens its own browser from the toolbar");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await quit();
  provider.close();
  try { execFileSync("pkill", ["-f", `${home}/run/finx.sock`]); } catch {}
  if (!failed) fs.rmSync(work, { recursive: true, force: true });
  else console.error(`left for inspection: ${work}`);
}
process.exit(failed ? 1 : 0);
