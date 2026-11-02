#!/usr/bin/env node
// Verify computer use (docs/desktop/computer-use-design.md): it is not among the connectors, in
// the composer's + › Connectors or on 自定义; Settings › 电脑操控 has its switch, on with nothing
// written, which writes `desktop.enabled`. The permissions are not on the page: without
// Accessibility the switch is grey, says so, and opens them in a dialog. There is no agent-desktop
// to install: it comes with FinxWork, and missing, the line says to reinstall (macOS). Everything stays in a private HOME. Needs `pnpm build` (which puts agent-desktop
// beside the debug finx) and `cargo build -p finx-cli`.
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
// Only the agent-desktop beside finx counts: no PATH entry could hold another.
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
const NAMES = ["电脑操控", "桌面控制", "Computer Use", "Desktop Control"];
const toggle = `document.querySelector('.desktop-set [role=switch]')`;
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

  // Not a connector: the composer's + menu has its switch, beside the browser's, and grey with
  // what it needs until it can work; the connectors menu lists neither.
  const status = await main.run(`window.finx.desktopControlStatus()`);
  await main.run(`document.querySelector('.cmp-plus').click()`);
  if (status.accessibility !== "unsupported") {
    const quick = menuRow(".vmenu .cn-row.quick", ...NAMES);
    await main.until("the + menu", `!!${quick}`);
    const ready = !!(status.accessibility === "granted" && status.program);
    // Once the app has read what computer use has.
    await main.until("the switch's state", ready ? `${quick}.getAttribute('aria-checked') === 'true'` : `${quick}.getAttribute('aria-checked') === 'false' && !!${quick}.querySelector('.cn-st')`);
    await main.shot("1-plus-menu");
  }
  await main.run(`${menuRow(".vmenu [role=menuitem]", "连接器", "Connectors")}.click()`);
  await main.until("the connectors menu", `!!document.querySelector('.cn-none-row, .cn-sub .cn-row')`);
  check(!(await main.run(`!!${menuRow(".cn-row:not(.quick)", ...NAMES, "你的浏览器", "Your Browser")}`)), "a system connector is in the connectors menu");
  await main.run(`document.querySelector('.cmp-plus').click()`);
  // Nor on 自定义 › 连接器 › 我的.
  await main.run(`${menuRow(".side-nav .nav-i", "自定义", "Customize")}.click()`);
  await main.until("自定义", `!!${button("连接器", "Connectors")}`);
  await main.run(`(${button("连接器", "Connectors")}).click()`);
  await main.until("连接器", `!!${button("我的", "Mine")}`);
  await main.run(`(${button("我的", "Mine")}).click()`);
  await main.until("我的", `!!document.querySelector('.cz-row, .cz-empty')`);
  await main.shot("2-mine");
  check(!(await main.run(`!!${menuRow(".cz-row", ...NAMES, "你的浏览器", "Your Browser")}`)), "a system connector is among the connectors");

  // Settings › 电脑操控: on with nothing written; grey until FinxWork has Accessibility.
  await main.run(`window.finx.openSettings("desktop")`);
  const set = await attach((t) => t.type === "page" && t.url.includes("#settings"), "the settings window");
  await set.cdp("Emulation.setDeviceMetricsOverride", { width: 820, height: 720, deviceScaleFactor: 0, mobile: false });
  await set.until("the page", `!!${toggle} && !${toggle}.disabled`);
  check(!config().includes("[desktop]"), `on by default without writing anything: ${config()}`);
  const granted = (await set.run(`window.finx.desktopControlStatus()`)).accessibility === "granted";
  // The permissions are not on the page: only asked for when missing, in a dialog.
  check(!(await set.run(shows("npm install", "agent-desktop", "授权准备"))), "the page shows what it needs all the time");
  if (mac && !granted) {
    await set.until("the grey switch", `${toggle}.getAttribute('aria-checked') === 'false' && ${shows("需要先完成授权", "Grant permission first")}`);
    await set.shot("3-needs-grant");
    // The switch opens the permissions: Accessibility required, Screen Recording optional.
    await set.run(`${toggle}.click()`);
    await set.until("the dialog", `!!document.querySelector('.cu-grant')`);
    const text = await set.run(`document.querySelector('.cu-grant').innerText`);
    check(["辅助功能", "Accessibility"].some((w) => text.includes(w)) && ["屏幕录制", "Screen Recording"].some((w) => text.includes(w)), `the dialog lacks a permission: ${text}`);
    await set.shot("4-grant");
    await set.run(`(${button("完成", "Done")}).click()`);
    await set.until("the dialog closed", `!document.querySelector('.cu-grant')`);
    check(!config().includes("[desktop]"), `closing it writes nothing: ${config()}`);
  } else {
    check((await set.run(`${toggle}.getAttribute('aria-checked')`)) === "true", "computer use is off by default");
  }

  // Were the program missing, the line says to reinstall: here, by pointing finx elsewhere.
  if (mac) {
    fs.appendFileSync(path.join(home, "config.toml"), `\n[desktop]\nexecutable = "/nonexistent/agent-desktop"\n`);
    await set.until("reinstall", shows("请重新安装 FinxWork", "reinstall FinxWork"));
    check(!(await set.run(shows("npm install"))), "an install command is shown");
    await set.shot("5-missing");
    fs.writeFileSync(path.join(home, "config.toml"), config().replace(`\n[desktop]\nexecutable = "/nonexistent/agent-desktop"\n`, ""));
    await set.until("found again", `!${shows("请重新安装 FinxWork", "reinstall FinxWork")}`);
  }

  // With the permission: off, written, and the app list below cannot be changed; on again.
  if (granted || !mac) {
    await set.run(`${toggle}.click()`);
    await set.until("turned off", `${toggle}.getAttribute('aria-checked') === 'false'`);
    check(/\[desktop\][^[]*enabled = false/.test(config()), `not turned off: ${config()}`);
    check(await set.run(`document.querySelector('.desktop-sub').disabled === true`), "the apps can be changed while it is off");
    await set.run(`${toggle}.click()`);
    await set.until("turned on", `${toggle}.getAttribute('aria-checked') === 'true'`);
    check(/\[desktop\][^[]*enabled = true/.test(config()), `not turned on: ${config()}`);
  } else {
    console.log("FinxWork (Electron here) has no Accessibility: switching on and off not tried");
  }
  console.log("computer use: ok");
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await quit();
  if (!failed) fs.rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
