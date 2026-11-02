#!/usr/bin/env node
// Verify the desktop tools on an app that shows nothing through accessibility, the case of most
// chat apps: in a real conversation, in bypass mode, a scripted model starts OpaqueChat
// (e2e/fixtures/OpaqueChat), is told by the snapshot to use screenshots, clicks a contact and
// the message field at screenshot coordinates, types Chinese text and presses return; the
// message must reach the right contact (the shadow around the window must not shift the
// clicks), nothing may ask, no CLI flag may reach the model, and the user's clipboard is put
// back. Then a window that moved after its screenshot must be refused, not clicked off target.
// macOS only, with the screen unlocked; it moves the pointer for a few seconds. Needs `pnpm
// build` (which puts agent-desktop beside the debug finx), `cargo build -p finx-cli` and swiftc;
// FinxWork (Electron here) needs Accessibility and Screen Recording.
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
const program = path.join(path.dirname(finx), "agent-desktop");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => {
  throw new Error(message);
};
const check = (ok, message) => ok || fail(message);
if (process.platform !== "darwin") {
  console.log("desktop opaque: macOS only, skipped");
  process.exit(0);
}
check(fs.existsSync(program), `no agent-desktop at ${program}: run pnpm build`);
const locked = execFileSync("ioreg", ["-n", "Root", "-d1", "-a"], { encoding: "utf8" });
check(!/CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(locked), "the screen is locked: unlock it and run again");

// ── OpaqueChat, built and made known to LaunchServices (which ignores apps under /tmp) ──
const BUNDLE = "com.finxwork.e2e.opaquechat";
const fixture = path.join(desktop, "node_modules/.cache/opaque-chat/OpaqueChat.app");
const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const chatDir = "/tmp/finx-opaque-chat";
fs.rmSync(fixture, { recursive: true, force: true });
fs.mkdirSync(path.join(fixture, "Contents/MacOS"), { recursive: true });
execFileSync("swiftc", ["-O", "-o", path.join(fixture, "Contents/MacOS/OpaqueChat"), path.join(import.meta.dirname, "fixtures/OpaqueChat/main.swift")], { stdio: "inherit" });
fs.writeFileSync(path.join(fixture, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${BUNDLE}</string>
<key>CFBundleName</key><string>OpaqueChat</string>
<key>CFBundleExecutable</key><string>OpaqueChat</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
</dict></plist>
`);
execFileSync("codesign", ["--sign", "-", "--force", fixture]);
execFileSync(lsregister, ["-f", fixture]);
const quitChat = () => {
  try {
    execFileSync("pkill", ["-x", "OpaqueChat"]);
  } catch {}
};
quitChat();
fs.rmSync(chatDir, { recursive: true, force: true });

// ── a private home, with the real agent-desktop ──
const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxo-"));
const home = path.join(work, "finx");
const profile = path.join(work, "profile");
const userHome = path.join(work, "home");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(userHome, { recursive: true });
const env = { ...process.env, FINX_HOME: home, HOME: userHome, FINX_CREDENTIAL_STORE: "file", FINX_NO_BROWSER: "1" };

// ── the model: a fixed script per task, each step one tool call, coordinates from the fixture's layout ──
const titleBar = () => JSON.parse(fs.readFileSync(path.join(chatDir, "layout.json"), "utf8")).title_bar;
const textOf = (m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((c) => c.text ?? "").join("\n"));
const tasks = {
  OPAQUE_SEND: [
    () => ["cua_launch", { app: BUNDLE }],
    () => ["cua_snapshot", { app: BUNDLE }],
    () => ["cua_screenshot", { app: BUNDLE }],
    (shot) => ["cua_act", { app: BUNDLE, action: "click_at", shot, x: 100, y: titleBar() + 90 }], // Bob
    (shot) => ["cua_act", { app: BUNDLE, action: "click_at", shot, x: 400, y: titleBar() + 352 }], // the field
    (shot) => ["cua_act", { app: BUNDLE, action: "type_text", shot, text: "你好，这是 finx" }],
    (shot) => ["cua_act", { app: BUNDLE, action: "press", shot, text: "return" }],
  ],
  OPAQUE_MOVED: [
    () => ["cua_screenshot", { app: BUNDLE }],
    (shot) => {
      execFileSync("pkill", ["-USR1", "-x", "OpaqueChat"]);
      execFileSync("sleep", ["0.6"]);
      return ["cua_act", { app: BUNDLE, action: "click_at", shot, x: 100, y: titleBar() + 30 }];
    },
  ],
};
const transcripts = {};
const sse = (delta, finish) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`;
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    if (req.method !== "POST" || !body) return res.end(JSON.stringify({ data: [] }));
    const messages = JSON.parse(body).messages ?? [];
    // The task's word on its own: screenshots come back in user messages naming their call, call_OPAQUE_SEND_2.
    const names = (m) => Object.keys(tasks).find((k) => new RegExp(`(?<!\\w)${k}(?!\\w)`).test(textOf(m)));
    const at = messages.findLastIndex((m) => m.role === "user" && names(m));
    const task = names(messages[at]);
    const after = messages.slice(at + 1);
    const step = after.filter((m) => m.role === "assistant").length;
    const results = after.filter((m) => m.role === "tool").map(textOf);
    transcripts[task] = results;
    const shot = [...results.join("\n").matchAll(/Screenshot (p\d+)/g)].pop()?.[1];
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (step >= tasks[task].length) return res.end(sse({ role: "assistant", content: `${task}_DONE` }, "stop"));
    const [name, args] = tasks[task][step](shot);
    const call = { index: 0, id: `call_${task}_${step}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
    res.end(sse({ role: "assistant", tool_calls: [call] }, "tool_calls"));
  });
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
fs.writeFileSync(path.join(home, "models.toml"), `[providers.mock]\nname = "Mock"\napi = "openai-chat"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nauth = "none"\n[[providers.mock.models]]\nid = "mock-1"\nname = "Mock One"\ncontext_window = 128000\nmax_output_tokens = 2000\ninput = ["text", "image"]\n`);
fs.writeFileSync(path.join(home, "config.toml"), `model = "mock/mock-1"\npermission_mode = "bypass-permissions"\n[models]\nnetwork = false\n[desktop]\nenabled = true\n`);

// ── the app, over the DevTools protocol (as e2e/desktop-approval.mjs) ──
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
  const shot = async (name) => {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, "base64"));
  };
  return { cdp, run, shot };
}

async function quit() {
  if (!app || app.exitCode !== null) return;
  const exited = new Promise((r) => app.once("exit", r));
  app.kill("SIGTERM");
  const timeout = setTimeout(() => app.kill("SIGKILL"), 3000);
  await exited;
  clearTimeout(timeout);
}

/** Sends `prompt` and waits for `done` in the page, failing if an approval ever shows. */
async function task(main, prompt, done, ms = 90000) {
  await main.run(`document.querySelector('.cmp-in').focus()`);
  await main.cdp("Input.insertText", { text: prompt });
  for (let i = 0; i < 50 && (await main.run(`!!document.querySelector('button.send')?.disabled`)); i++) await sleep(100);
  await main.run(`document.querySelector('button.send').click()`);
  const end = Date.now() + ms;
  while (!(await main.run(`document.body.innerText.includes(${JSON.stringify(done)})`))) {
    check(!(await main.run(`!!document.querySelector('.appr')`)), `something asked in bypass: ${await main.run(`document.querySelector('.appr')?.innerText`)}`);
    check(Date.now() < end, `timed out waiting for ${done}: ${JSON.stringify(transcripts)}`);
    await sleep(200);
  }
}

// The user's clipboard, to put back whatever happens; a marker in it meanwhile.
const clipboard = execFileSync("pbpaste", { encoding: "utf8" });
const marker = `finx-e2e-clipboard-${Date.now()}`;
execFileSync("pbcopy", { input: marker });

let failed = false;
try {
  app = spawn(electron, [desktop, `--remote-debugging-port=${port}`], {
    env: { ...env, FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINXWORK_NO_BROWSER: "1" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const main = await attach((t) => t.type === "page" && /^(app:|file:|http:)/.test(t.url) && !t.url.includes("#settings"), "the main window");
  await main.cdp("Emulation.setDeviceMetricsOverride", { width: 1240, height: 820, deviceScaleFactor: 0, mobile: false });
  for (let i = 0; i < 100 && !(await main.run(`!!document.querySelector('.cmp-in')`)); i++) {
    await main.run(`[...document.querySelectorAll("button")].find(b => /稍后|later|skip/i.test(b.textContent))?.click()`);
    await sleep(200);
  }
  // A new conversation takes its mode from the composer's draft, which starts at manual.
  await main.run(`localStorage.setItem("main-view", JSON.stringify({ draft: { permission: "bypass-permissions" } })); location.reload()`);
  await sleep(500);
  for (let i = 0; i < 100 && !(await main.run(`!!document.querySelector('.cmp-in')`).catch(() => false)); i++) await sleep(200);
  const status = await main.run(`window.finx.desktopControlStatus()`);
  check(status.accessibility === "granted", `FinxWork here has no Accessibility permission (${status.accessibility}): grant it and run again`);

  // 1. Start it, learn it is opaque, click Bob and the field, type, send.
  const started = Date.now();
  await task(main, "给 OpaqueChat 里的 Bob 发一句你好 OPAQUE_SEND", "OPAQUE_SEND_DONE");
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const [launched, snapshot, screenshot, ...acts] = transcripts.OPAQUE_SEND;
  check(launched.includes("is running"), `launch: ${launched}`);
  check(snapshot.includes("does not expose its contents"), `the snapshot does not send the model to screenshots: ${snapshot}`);
  check(/Screenshot p\d+ of .*, \d+×\d+ px/.test(screenshot), `screenshot: ${screenshot}`);
  check(acts.every((r) => /Screenshot p\d+ after it/.test(r)), `an action came back without a screenshot: ${acts.join(" | ")}`);
  for (const r of transcripts.OPAQUE_SEND) check(!/--[a-z]|agent-desktop /.test(r), `a CLI flag reached the model: ${r}`);
  for (let i = 0; i < 20 && !fs.existsSync(path.join(chatDir, "messages.txt")); i++) await sleep(100);
  const sent = fs.existsSync(path.join(chatDir, "messages.txt")) ? fs.readFileSync(path.join(chatDir, "messages.txt"), "utf8") : "";
  check(sent === "Bob\t你好，这是 finx\n", `the message did not reach Bob: ${JSON.stringify(sent)}; ${acts.join(" | ")}`);
  check(execFileSync("pbpaste", { encoding: "utf8" }) === marker, "the clipboard was not put back");
  console.log(`sent in 7 tool calls, ${seconds}s`);
  await main.shot("1-sent");

  // 2. The window moves between the screenshot and the click: refused, nothing clicked.
  await task(main, "再点一下 OPAQUE_MOVED", "OPAQUE_MOVED_DONE");
  const moved = transcripts.OPAQUE_MOVED.at(-1);
  check(/window moved/.test(moved), `a click on a moved window was not refused: ${moved}`);
  console.log("desktop opaque: ok");
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await quit();
  provider.close();
  quitChat();
  execFileSync("pbcopy", { input: clipboard });
  try {
    execFileSync(lsregister, ["-u", fixture]);
  } catch {}
  if (!failed) fs.rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
