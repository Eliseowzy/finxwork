#!/usr/bin/env node
// Verify computer use's authorization, as a person meets it: the model asks to read
// Finder's window; the approval names the app by its name and icon (and says so when FinxWork
// lacks Accessibility); "remember" + "allow" writes `[desktop.apps]`; the call runs (a
// snapshot, or PERM_DENIED with the hint to send the user to Settings); Settings › 电脑操控
// lists the remembered app, denies it with one click and removes it. macOS only; everything
// stays in a private HOME. Needs `pnpm build` (which puts agent-desktop beside the debug finx,
// where finx finds it) and `cargo build -p finx-cli`.
import { spawn } from "node:child_process";
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
const program = path.join(path.dirname(finx), "agent-desktop");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => {
  throw new Error(message);
};
const check = (ok, message) => ok || fail(message);
if (process.platform !== "darwin") {
  console.log("desktop approval: macOS only, skipped");
  process.exit(0);
}
check(fs.existsSync(program), `no agent-desktop at ${program}: run pnpm build`);

// Short: the kernel's socket lives under it, and a socket path has at most 103 bytes.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxa-"));
const home = path.join(work, "finx");
const profile = path.join(work, "profile");
const userHome = path.join(work, "home");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(userHome, { recursive: true });
const env = { ...process.env, FINX_HOME: home, HOME: userHome, FINX_CREDENTIAL_STORE: "file", FINX_NO_BROWSER: "1" };

// The model: first a snapshot of Finder (through call_tool), then what the tool said.
const sse = (delta, finish) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`;
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    if (req.method !== "POST" || !body) return res.end(JSON.stringify({ data: [] }));
    const messages = JSON.parse(body).messages ?? [];
    const last = messages[messages.length - 1];
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (last?.role === "tool") {
      const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
      return res.end(sse({ role: "assistant", content: `DESKTOP_DONE ${text.slice(0, 400)}` }, "stop"));
    }
    // Computer use's tools are deferred: the model runs them through call_tool.
    const call = { index: 0, id: "call_desktop_1", type: "function", function: { name: "call_tool", arguments: JSON.stringify({ name: "cua_snapshot", arguments: { app: "com.apple.finder" } }) } };
    res.end(sse({ role: "assistant", tool_calls: [call] }, "tool_calls"));
  });
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
fs.writeFileSync(path.join(home, "models.toml"), `[providers.mock]\nname = "Mock"\napi = "openai-chat"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nauth = "none"\n[[providers.mock.models]]\nid = "mock-1"\nname = "Mock One"\ncontext_window = 128000\nmax_output_tokens = 2000\n`);
fs.writeFileSync(path.join(home, "config.toml"), `model = "mock/mock-1"\npermission_mode = "manual"\n[models]\nnetwork = false\n[desktop]\nenabled = true\n`);
const config = () => fs.readFileSync(path.join(home, "config.toml"), "utf8");

let app = null;
const port = 9400 + Math.floor(Math.random() * 400);

async function attach(match, what) {
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(200);
    target = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => [])).find(match);
  }
  check(target, `${what} never showed up`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
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
  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      waiting.set(++next, { resolve, reject });
      ws.send(JSON.stringify({ id: next, method, params }));
    });
  const run = async (expr) => {
    const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) fail(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const until = async (label, expr, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await run(expr);
      if (v) return v;
      if (Date.now() > end) fail(`timed out waiting for ${label}: ${await run("document.body.innerText.slice(0, 800)")}`);
      await sleep(150);
    }
  };
  const shot = async (name) => {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    await sleep(400);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, "base64"));
  };
  return { cdp, run, until, shot };
}

async function quit() {
  if (!app || app.exitCode !== null) return;
  const exited = new Promise((r) => app.once("exit", r));
  app.kill("SIGTERM");
  const timeout = setTimeout(() => app.kill("SIGKILL"), 3000);
  await exited;
  clearTimeout(timeout);
}

const shows = (...texts) => `${JSON.stringify(texts)}.some(t => document.body.innerText.includes(t))`;
const finderRow = `[...document.querySelectorAll('.desktop-set .mrow')].find(r => r.querySelector('[title="com.apple.finder"]'))`;

let failed = false;
try {
  app = spawn(electron, [desktop, `--remote-debugging-port=${port}`], {
    env: { ...env, FINXWORK_DEFAULT_MODE: "sessions", FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINXWORK_NO_BROWSER: "1" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const main = await attach((t) => t.type === "page" && /^(app:|file:|http:)/.test(t.url) && !t.url.includes("#settings"), "the main window");
  await main.cdp("Emulation.setDeviceMetricsOverride", { width: 1240, height: 820, deviceScaleFactor: 0, mobile: false });
  await main.until("app loaded", `!!document.querySelector("button")`);
  await main.until("onboarding left", `(() => { const skip = [...document.querySelectorAll("button")].find(b => /稍后|later|skip/i.test(b.textContent)); if (skip) { skip.click(); return false; } return !!document.querySelector('.cmp-in'); })()`);
  const status = await main.run(`window.finx.desktopControlStatus()`);
  console.log(`FinxWork's Accessibility here: ${status.accessibility}`);

  // The model asks to read Finder: the approval names it, with its icon.
  await main.run(`document.querySelector('.cmp-in').focus()`);
  await main.cdp("Input.insertText", { text: "看看访达里有什么" });
  await main.until("send enabled", `!document.querySelector('button.send')?.disabled`);
  await main.run(`document.querySelector('button.send').click()`);
  await main.until("the approval naming Finder", `/访达|Finder/.test(document.querySelector('.appr .appr-app')?.textContent ?? '')`, 60000);
  check(await main.run(`document.querySelector('.appr .appr-app img')?.src.startsWith('data:image/') === true`), "the approval shows no app icon");
  // One question per app: allowing it allows reading and acting in it.
  const grant = `[...document.querySelectorAll('.appr button')].find(b => /允许使用 (访达|Finder)|Allow (访达|Finder) for This Session/.test(b.textContent))`;
  check(await main.run(`!!(${grant})`), `no grant button by the app's name: ${await main.run(`document.querySelector('.appr').innerText`)}`);
  const warned = await main.run(`!!document.querySelector('.appr .appr-warn')`);
  check(warned === (status.accessibility === "denied"), `the permission warning is ${warned ? "shown" : "missing"} with Accessibility ${status.accessibility}`);
  await main.shot("1-approval");

  // Remember, and allow Finder.
  await main.run(`document.querySelector('.appr .appr-keep input').click()`);
  await main.run(`(${grant}).click()`);
  await main.until("the reply", shows("DESKTOP_DONE"), 60000);
  const reply = await main.run(`document.body.innerText`);
  check(
    // Granted, the CLI reads Finder (whose desktop window may not be exposed: its own error, not a permission's).
    status.accessibility === "granted" ? !reply.includes("PERM_DENIED") : /PERM_DENIED[\s\S]*The user has to grant it/.test(reply),
    `the call's result does not match Accessibility ${status.accessibility}: ${reply.slice(reply.indexOf("DESKTOP_DONE"), reply.indexOf("DESKTOP_DONE") + 400)}`,
  );
  check(/\[desktop\.apps\][\s\S]*"com\.apple\.finder" = "allow"/.test(config()), `the grant was not remembered: ${config()}`);
  await main.shot("2-after");

  // Settings › 电脑操控 lists it, allowed; one click denies it; removing it asks again.
  await main.run(`window.finx.openSettings("desktop")`);
  const set = await attach((t) => t.type === "page" && t.url.includes("#settings"), "the settings window");
  await set.cdp("Emulation.setDeviceMetricsOverride", { width: 820, height: 760, deviceScaleFactor: 0, mobile: false });
  await set.until("Finder in the app list", `/访达|Finder/.test(${finderRow}?.querySelector('.fn')?.textContent ?? '')`);
  const toggle = `${finderRow}?.querySelector('.app-toggle')`;
  check((await set.run(`${toggle}.getAttribute('aria-pressed')`)) === "true", "Finder is not listed as allowed");
  check(await set.run(`${finderRow}.querySelector('img.app-icon')?.src.startsWith('data:image/') === true`), "the app list shows no icon");
  await set.shot("3-apps");
  check(await set.run(`/添加应用|Add App/.test(document.querySelector('.desktop-set .mrow-add')?.textContent ?? '')`), "no way to add an app in Settings");
  await set.run(`${toggle}.click()`);
  for (let i = 0; i < 50 && !/"com\.apple\.finder" = "deny"/.test(config()); i++) await sleep(100);
  check(/"com\.apple\.finder" = "deny"/.test(config()), `not denied: ${config()}`);
  await set.until("shown as denied", `${toggle}?.getAttribute('aria-pressed') === 'false'`);
  await set.run(`[...${finderRow}.querySelectorAll('button')].pop().click()`);
  await set.until("forgotten", `!${finderRow} && ${shows("还没有应用", "No apps yet")}`);
  check(!config().includes("com.apple.finder"), `not forgotten: ${config()}`);
  await set.shot("4-forgotten");
  // Switched off, the rest of the page is shown but cannot be changed. Without Accessibility the
  // switch asks for it instead (computer-use.mjs).
  if (status.accessibility === "granted") {
    await set.run(`document.querySelector('.desktop-set button.sw').click()`);
    await set.until("switched off", `document.querySelector('.desktop-sub')?.disabled === true`);
    check(await set.run(`document.querySelector('.desktop-sub .mrow-add').matches(':disabled')`), "Add App works while computer use is off");
    await set.shot("5-off");
  }
  console.log("desktop approval: ok");
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await quit();
  provider.close();
  if (!failed) fs.rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
