#!/usr/bin/env node
// Verify a new conversation reads an existing home browser page without reloading it.
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
    const tool = request.messages.findLast((m) => m.role === "tool");
    const delta = tool ? { role: "assistant", content: "HANDOFF_READ_DONE" } : {
      role: "assistant", tool_calls: [{ index: 0, id: "read-current", type: "function", function: { name: "browser_snapshot", arguments: "{}" } }],
    };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
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
let loads = 0;
const site = http.createServer((req, res) => { if (req.url === "/") loads++; res.end("<title>Browser button test</title><h1>HANDOFF_PAGE_CONTENT</h1>"); });
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
try {
  const page = await launch();
  // Leave onboarding without configuring a model: browsing must work independently.
  await page.until("app loaded", `!!document.querySelector("button")`);
  // The onboarding page may show up after the first check: keep leaving it until the home page is there.
  await page.until("onboarding left", `(() => { const skip = [...document.querySelectorAll("button")].find(b => /稍后|later|skip/i.test(b.textContent)); if (skip) { skip.click(); return false; } return !!document.querySelector(".ctool button[aria-pressed]"); })()`);
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
  await page.run(`document.querySelector(${JSON.stringify(button)}).click()`);
  await page.until("panel hidden", `!document.querySelector('.brp')`);
  await page.run(`document.querySelector(${JSON.stringify(button)}).click()`);
  await page.until("tab restored", `document.querySelectorAll('.brp-tab').length === 1 && document.querySelector('.brp-tab-t')?.textContent === 'Browser button test'`, 60000);
  const before = await page.run(`window.finx.browserTabs()`);
  await page.run(`document.querySelector('.cmp-in').focus()`);
  await page.cdp("Input.insertText", { text: "当前浏览器中的内容" });
  await page.until("send enabled", `!document.querySelector('button.send')?.disabled`);
  await page.run(`document.querySelector('button.send').click()`);
  await page.until("browser content read by the conversation", `document.body.innerText.includes('HANDOFF_READ_DONE')`, 60000);
  const after = await page.run(`window.finx.browserTabs()`);
  check(after.length === 1 && after[0].targetId === before[0].targetId, "the original tab was not preserved");
  check(after[0].session !== before[0].session, "the tab was not handed to the new session");
  check(loads === 1, "the page reloaded during handoff");
  const result = requests.at(-1).messages.findLast((m) => m.role === "tool");
  check(JSON.stringify(result).includes("HANDOFF_PAGE_CONTENT"), `snapshot did not read the existing page: ${JSON.stringify(result)}`);
  check(await page.run(`!!document.querySelector('.brp')`), "conversation browser panel is missing");
  page.close();
  console.log("✓ new conversation reads the existing page through browser_snapshot without reloading");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await quit();
  site.close();
  provider.close();
  try { execFileSync("pkill", ["-f", `${home}/run/finx.sock`]); } catch {}
  if (!failed) fs.rmSync(work, { recursive: true, force: true });
  else console.error(`left for inspection: ${work}`);
}
process.exit(failed ? 1 : 0);
