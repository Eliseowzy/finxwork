#!/usr/bin/env node
// Verify Settings › Desktop control: with no agent-desktop, the page says how to install it;
// once the program is in finx's own folder it shows its version; the switch writes
// `desktop.enabled` to the user's config and back; the permission rows show the app's own
// state (macOS). Everything stays in a private HOME. Needs `pnpm build`, `cargo build -p
// finx-cli`; the version step needs agent-desktop in ~/.finx/desktop/bin or AGENT_DESKTOP.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "../..");
const finx = path.join(root, "target/debug/finx");
const electron = createRequire(import.meta.url)("electron");
const shots = process.env.FINXWORK_E2E_SHOTS;
const realProgram = process.env.AGENT_DESKTOP ?? path.join(os.homedir(), ".finx/desktop/bin/agent-desktop");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => {
  throw new Error(message);
};
const check = (ok, message) => ok || fail(message);

// Short: the kernel's socket lives under it, and a socket path has at most 103 bytes.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxd-"));
const home = path.join(work, "finx");
const profile = path.join(work, "profile");
const userHome = path.join(work, "home");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(userHome, { recursive: true });
// No PATH entry that could hold a real agent-desktop.
const env = { ...process.env, PATH: "/usr/bin:/bin", FINX_HOME: home, HOME: userHome, FINX_CREDENTIAL_STORE: "file", FINX_NO_BROWSER: "1" };
fs.writeFileSync(path.join(home, "config.toml"), `permission_mode = "manual"\n[models]\nnetwork = false\n`);

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

const config = () => fs.readFileSync(path.join(home, "config.toml"), "utf8");
const shows = (...texts) => `${JSON.stringify(texts)}.some(t => document.body.innerText.includes(t))`;
const button = (...labels) => `[...document.querySelectorAll('button')].find(b => ${JSON.stringify(labels)}.includes(b.textContent.trim()))`;
const toggle = `document.querySelector('.desktop-set [role=switch]')`;

let failed = false;
try {
  app = spawn(electron, [desktop, `--remote-debugging-port=${port}`], {
    env: { ...env, FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINXWORK_NO_BROWSER: "1" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const main = await attach((t) => t.type === "page" && /^(app:|file:|http:)/.test(t.url) && !t.url.includes("#settings"), "the main window");
  await main.until("app loaded", `!!document.querySelector("button")`);
  await main.run(`window.finx.openSettings("desktop")`);
  const set = await attach((t) => t.type === "page" && t.url.includes("#settings"), "the settings window");
  await set.cdp("Emulation.setDeviceMetricsOverride", { width: 820, height: 640, deviceScaleFactor: 0, mobile: false });

  // Not installed: the page says how to install it; the switch is off.
  await set.until("the desktop page", `!!${toggle} && !${toggle}.disabled && ${shows("npm install -g agent-desktop")}`);
  check((await set.run(`${toggle}.getAttribute('aria-checked')`)) === "false", "the switch is on by default");
  check(await set.run(shows("未安装", "Not installed")), "the program is not said to be missing");
  if (process.platform === "darwin") {
    check(await set.run(shows("辅助功能", "Accessibility")) && (await set.run(shows("屏幕录制", "Screen Recording"))), "no permission rows");
  }
  await set.shot("1-not-installed");

  // On: the user's config says so, and the page says what is missing.
  await set.run(`${toggle}.click()`);
  await set.until("turned on", `${toggle}.getAttribute('aria-checked') === 'true'`);
  check(/\[desktop\][\s\S]*enabled = true/.test(config()), `not turned on: ${config()}`);
  check(await set.run(shows("还没有安装 agent-desktop", "agent-desktop is not installed")), "the switch does not say the program is missing");
  await set.shot("2-on-missing");

  // Installed in finx's own folder: after the window comes back to the front, its version.
  if (fs.existsSync(realProgram)) {
    const bin = path.join(userHome, ".finx/desktop/bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.copyFileSync(realProgram, path.join(bin, "agent-desktop"));
    fs.chmodSync(path.join(bin, "agent-desktop"), 0o755);
    const helper = path.join(path.dirname(realProgram), "agent-desktop-macos-helper");
    if (fs.existsSync(helper)) fs.copyFileSync(helper, path.join(bin, "agent-desktop-macos-helper"));
    await set.run(`(${button("重新检查", "Check again")}).click()`);
    await set.until("the version", shows("版本 ", "Version "), 15000);
    check(await set.run(shows("已安装", "Installed")), "the program is not said to be installed");
    check(await set.run(shows(path.join(bin, "agent-desktop"))), "the program's path is not shown");
    await set.shot("3-installed");
  } else {
    console.log(`no agent-desktop at ${realProgram}; skipping the version step`);
  }

  // Off again.
  await set.run(`${toggle}.click()`);
  await set.until("turned off", `${toggle}.getAttribute('aria-checked') === 'false'`);
  check(/\[desktop\][\s\S]*enabled = false/.test(config()), `not turned off: ${config()}`);
  await set.shot("4-off");
  console.log("desktop settings: ok");
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await quit();
  if (!failed) fs.rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
