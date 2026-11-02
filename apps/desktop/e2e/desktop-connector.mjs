#!/usr/bin/env node
// Verify desktop control as a system connector (connectors-entry-design §6.2, §8): Settings ›
// Desktop control leads to its page among the connectors; not connected, the page offers
// Connect, whose sheet says agent-desktop is missing and how to install it, next to the
// permissions FinxWork asks of the system (macOS); once its switch is in the user's config,
// the page has the switch, which writes `desktop.enabled`, and says what is still missing; the
// composer's + › Connectors has the same switch. Everything stays in a private HOME. Needs
// `pnpm build`, `cargo build -p finx-cli`; the installed step needs agent-desktop in
// ~/.finx/desktop/bin or AGENT_DESKTOP.
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
// No model key either, so the first-run page always opens, once, and can be left.
for (const k of Object.keys(env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete env[k];
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
/** A row of the open menus by its text in either language. */
const menuRow = (selector, ...texts) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find(r => ${JSON.stringify(texts)}.some(t => r.textContent.includes(t)))`;
const toggle = `document.querySelector('.cz-dacts [role=switch]')`;
const sheet = `document.querySelector('.cn-sheet')`;
const mac = process.platform === "darwin";

let failed = false;
try {
  app = spawn(electron, [desktop, `--remote-debugging-port=${port}`], {
    env: { ...env, FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINXWORK_NO_BROWSER: "1" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const main = await attach((t) => t.type === "page" && /^(app:|file:|http:)/.test(t.url) && !t.url.includes("#settings"), "the main window");
  await main.until("app loaded", `!!document.querySelector("button")`);
  await main.until("the first-run page", `!!${button("稍后再说，先看看", "Not now, just look around")}`);
  await main.run(`(${button("稍后再说，先看看", "Not now, just look around")}).click()`);
  await main.until("the home page", `!!document.querySelector(".cmp-plus")`);

  // Settings › Desktop control: one row, to its page among the connectors.
  await main.run(`window.finx.openSettings("desktop")`);
  const set = await attach((t) => t.type === "page" && t.url.includes("#settings"), "the settings window");
  await set.until("the desktop page", `!!document.querySelector('.desktop-set') && !!${button("打开", "Open")}`);
  await set.shot("1-settings");
  await set.run(`(${button("打开", "Open")}).click()`);
  await main.cdp("Emulation.setDeviceMetricsOverride", { width: 1100, height: 760, deviceScaleFactor: 0, mobile: false });
  await main.until("its page", `${JSON.stringify(["桌面控制", "Desktop Control"])}.includes(document.querySelector('.cz-dpage h1')?.textContent)`);

  // Not connected: the page offers Connect, and has no switch.
  check(await main.run(`!${toggle} && !!${button("连接", "Connect")}`), "the page does not offer Connect");
  check(await main.run(shows("未连接", "Not connected")), "the page does not say it is not connected");
  await main.shot("2-not-connected");

  // Connect: the sheet says what is missing; Done waits for it.
  await main.run(`(${button("连接", "Connect")}).click()`);
  await main.until("the connect sheet", `!!${sheet}`);
  if (mac) {
    await main.until("agent-desktop said to be missing", `${sheet}.innerText.includes("npm install -g agent-desktop")`);
    check(await main.run(`["辅助功能", "Accessibility"].some(t => ${sheet}.innerText.includes(t)) && ["屏幕录制", "Screen Recording"].some(t => ${sheet}.innerText.includes(t))`), "no permission rows");
    check(await main.run(`${sheet}.querySelector('.btn.primary').disabled`), "Done is not waiting for agent-desktop");
  }
  await main.shot("3-connect-sheet");
  await main.run(`(${button("取消", "Cancel")}).click()`);
  await main.until("the sheet closed", `!${sheet}`);

  // Connected once (its switch in the user's config, as Done writes it): the switch, and what is missing.
  fs.appendFileSync(path.join(home, "config.toml"), `\n[desktop]\nenabled = true\n`);
  await main.until("the switch", `${toggle}?.getAttribute('aria-checked') === 'true'`, 20000);
  if (mac) {
    await main.until("the note", `document.querySelector('.cz-note')?.innerText.includes("npm install -g agent-desktop")`);
    check(await main.run(shows("未安装", "Not installed")), "the state does not say agent-desktop is missing");
  }
  await main.shot("4-on-missing");

  // Installed in finx's own folder: Check Again finds it, and the note is about the permission at most.
  if (mac && fs.existsSync(realProgram)) {
    const bin = path.join(userHome, ".finx/desktop/bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.copyFileSync(realProgram, path.join(bin, "agent-desktop"));
    fs.chmodSync(path.join(bin, "agent-desktop"), 0o755);
    const helper = path.join(path.dirname(realProgram), "agent-desktop-macos-helper");
    if (fs.existsSync(helper)) fs.copyFileSync(helper, path.join(bin, "agent-desktop-macos-helper"));
    await main.run(`(${button("重新检查", "Check Again")}).click()`);
    await main.until("found", `!document.querySelector('.cz-note')?.innerText.includes("npm install")`, 15000);
    await main.shot("5-installed");
  } else {
    console.log(`no agent-desktop at ${realProgram}; skipping the installed step`);
  }

  // Off with the page's switch.
  await main.run(`${toggle}.click()`);
  await main.until("turned off", `${toggle}.getAttribute('aria-checked') === 'false'`);
  check(/\[desktop\][^[]*enabled = false/.test(config()), `not turned off: ${config()}`);
  check(await main.run(shows("已停用", "Off")), "the page does not say it is off");
  await main.shot("6-off");

  // On again from the composer's + › Connectors (on the home page): the same switch.
  await main.run(`document.querySelector('.side-nav .nav-i').click()`);
  await main.until("the home page", `!!document.querySelector(".cmp-plus")`);
  await main.run(`document.querySelector('.cmp-plus').click()`);
  await main.until("the + menu", `!!${menuRow(".vmenu [role=menuitem]", "连接器", "Connectors")}`);
  await main.run(`${menuRow(".vmenu [role=menuitem]", "连接器", "Connectors")}.click()`);
  const row = menuRow(".cn-sub .cn-row", "桌面控制", "Desktop Control");
  await main.until("its row", `${row}?.getAttribute('aria-checked') === 'false'`);
  await main.run(`${row}.click()`);
  await main.until("on in the menu", `${row}?.getAttribute('aria-checked') === 'true'`);
  check(/\[desktop\][^[]*enabled = true/.test(config()), `not turned on from the menu: ${config()}`);
  await main.shot("7-menu");
  console.log("desktop connector: ok");
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await quit();
  if (!failed) fs.rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
