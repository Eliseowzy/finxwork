#!/usr/bin/env node
// A page script asks once per site and session (bypass too: crates/finx-core/tests/browser.rs), and the answer keeps that
// site's scripts allowed for the session only (browser-design §7.6, D-561).
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
let siteUrl = "";
const call = (id, name, args) => ({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => body += chunk);
  req.on("end", () => {
    // Anything but a chat completion (the kernel's model probes) gets an empty answer.
    if (req.method !== "POST" || !body) return res.end(JSON.stringify({ data: [] }));
    const request = JSON.parse(body);
    requests.push(request);
    // What this turn did so far: the tool results after the person's last message.
    const last = request.messages.findLastIndex((m) => m.role === "user");
    const said = JSON.stringify(request.messages[last]?.content ?? "");
    const done = request.messages.slice(last + 1).filter((m) => m.role === "tool").length;
    const first = said.includes("SCRIPT_GO");
    const steps = first
      ? [call("open", "browser_navigate", { url: siteUrl }), call("eval-1", "browser_eval", { expression: "document.title" })]
      : [call("eval-2", "browser_eval", { expression: "document.querySelector('h1').textContent" })];
    const delta = steps[done] ?? { role: "assistant", content: first ? "SCRIPT_DONE_ONE" : "SCRIPT_DONE_TWO" };
    const finish = steps[done] ? "tool_calls" : "stop";
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
  });
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
fs.writeFileSync(path.join(home, "models.toml"), `[providers.mock]\nname = "Mock"\napi = "openai-chat"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nauth = "none"\n[[providers.mock.models]]\nid = "mock-1"\nname = "Mock One"\ncontext_window = 128000\nmax_output_tokens = 2000\n`);
fs.writeFileSync(path.join(home, "config.toml"), `model = "mock/mock-1"\npermission_mode = "bypass-permissions"\n[models]\nnetwork = false\n[browser]\nenabled = true\n`);
// ── the app, driven over the DevTools protocol (as e2e/stale-model.mjs) ──
let app = null;
async function launch() {
  const port = cdpPort();
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
const site = http.createServer((req, res) => res.end("<title>Script test page</title><h1>SCRIPT_PAGE_HEADING</h1>"));
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
siteUrl = `http://127.0.0.1:${site.address().port}/`;
const origin = siteUrl.slice(0, -1);
try {
  const page = await launch();
  await page.until("app loaded", `!!document.querySelector("button")`);
  await page.until("onboarding left", `(() => { const skip = [...document.querySelectorAll("button")].find(b => /稍后|later|skip/i.test(b.textContent)); if (skip) { skip.click(); return false; } return !!document.querySelector('.cmp-in'); })()`);
  const send = async (text) => {
    await page.run(`document.querySelector('.cmp-in').focus()`);
    await page.cdp("Input.insertText", { text });
    await page.until("send enabled", `!document.querySelector('button.send')?.disabled`);
    await page.run(`document.querySelector('button.send').click()`);
  };
  await send("SCRIPT_GO");

  // The first script on the site asks: the site in the question, the script itself shown,
  // one button that keeps the site's scripts for the session, and nothing to keep in the configuration.
  await page.until("script question", `!!document.querySelector('.appr')`, 60000);
  const card = await page.run(`(() => {
    const a = document.querySelector('.appr');
    return { title: a.querySelector('.appr-h b').textContent, pre: a.querySelector('.appr-pre')?.textContent ?? "",
      keep: !!a.querySelector('.appr-keep'), buttons: [...a.querySelectorAll('.appr-f button')].map((b) => b.textContent) };
  })()`);
  check(card.title.includes(origin.replace("http://", "")), `the question names the site: ${JSON.stringify(card)}`);
  check(card.pre.includes("document.title"), `the script is shown: ${JSON.stringify(card)}`);
  check(!card.keep, "a page script offers nothing to keep in the configuration");
  check(card.buttons.length === 3, `deny, allow scripts on the site, allow once: ${JSON.stringify(card.buttons)}`);
  await page.shot("script-question");
  await page.run(`document.querySelectorAll('.appr-f button')[1].click()`);
  await page.until("first script ran", `document.body.innerText.includes('SCRIPT_DONE_ONE')`, 60000);
  const first = JSON.stringify(requests.at(-1).messages.findLast((m) => m.role === "tool"));
  check(first.includes("Script test page"), `the script ran: ${first}`);

  // The site's next script runs without a question.
  await page.run(`window.__asked = false; new MutationObserver(() => { if (document.querySelector('.appr')) window.__asked = true; }).observe(document.body, { childList: true, subtree: true })`);
  await send("SCRIPT_AGAIN");
  await page.until("second script ran", `window.__asked || document.body.innerText.includes('SCRIPT_DONE_TWO')`, 60000);
  check(!(await page.run(`window.__asked`)), "the second script on the same site asked again");
  const second = JSON.stringify(requests.at(-1).messages.findLast((m) => m.role === "tool"));
  check(second.includes("SCRIPT_PAGE_HEADING"), `the second script ran: ${second}`);
  const saved = fs.readFileSync(path.join(home, "config.toml"), "utf8");
  check(!saved.includes(origin), `the site's scripts were written into the configuration: ${saved}`);
  page.close();
  console.log("✓ a page script asks once per site, then the site's scripts run for the session without asking");
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
