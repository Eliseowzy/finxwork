// Real Electron preferences: default palette, both windows, light/system mode and restart.
// Uses an isolated profile and kernel home; no model or account is needed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cdpPort } from "./lib/port.mjs";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxa-"));
const profile = path.join(work, "profile");
const home = path.join(work, "finx");
fs.mkdirSync(home, { recursive: true });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let app;
let port;
let connections = [];

async function until(read, label) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const result = await read();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}

async function page(settings = false) {
  const target = await until(async () => {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => []);
    return list.find((t) => t.type === "page" && t.url.startsWith("app://finxwork/") && t.url.includes("#settings") === settings);
  }, settings ? "settings window" : "main window");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  connections.push(ws);
  let id = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const reply = JSON.parse(data);
    const request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id);
    if (reply.error) request.reject(new Error(reply.error.message));
    else request.resolve(reply.result);
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const run = async (expression) => {
    const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  await until(() => run("!!document.querySelector('#root > *')"), "rendered app");
  return { call, run };
}

async function launch() {
  port = cdpPort();
  app = spawn(path.join(desktop, "node_modules/.bin/electron"), [desktop, `--remote-debugging-port=${port}`], {
    env: {
      ...process.env, FINX_HOME: home, FINX_CREDENTIAL_STORE: "file", FINX_NO_BROWSER: "1",
      FINXWORK_USER_DATA: profile, FINXWORK_FINX: path.join(root, "target/debug/finx"),
      FINXWORK_NO_BROWSER: "1", FINXWORK_DEFAULT_MODE: "sessions",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  return page();
}

async function quit() {
  for (const ws of connections) ws.close();
  connections = [];
  if (app && app.exitCode === null) {
    const exited = once(app, "exit");
    app.kill("SIGTERM");
    await exited;
  }
}

const background = (p, rgb) => until(() => p.run(`getComputedStyle(document.body).backgroundColor === ${JSON.stringify(rgb)}`), `background ${rgb}`);
const prefs = (p) => p.run("window.finx.getPreferences()");
const set = (p, value) => p.run(`window.finx.setPreferences(${JSON.stringify(value)})`);
async function shot(p, name) {
  if (!process.env.FINXWORK_E2E_SHOTS) return;
  await delay(250);
  const { data } = await p.call("Page.captureScreenshot", { format: "png" });
  fs.mkdirSync(process.env.FINXWORK_E2E_SHOTS, { recursive: true });
  fs.writeFileSync(path.join(process.env.FINXWORK_E2E_SHOTS, `${name}.png`), Buffer.from(data, "base64"));
}

try {
  let main = await launch();
  assert.equal((await prefs(main)).appearance, "system");
  await set(main, { appearance: "gray" });
  await background(main, "rgb(36, 36, 36)");
  await until(() => main.run("!!document.querySelector('.onb-foot button')"), "onboarding");
  await main.run("document.querySelector('.onb-foot button').click()");
  await until(() => main.run("!!document.querySelector('.mainwrap .side')"), "main interface");
  assert.equal(await main.run("getComputedStyle(document.querySelector('.mainwrap .side')).backgroundColor"), "rgb(30, 30, 30)");
  await shot(main, "home-soft-gray");
  await main.run("window.finx.openSettings('general')");
  const settings = await page(true);
  await background(settings, "rgb(36, 36, 36)");
  const lang = await settings.run("window.finx.language");
  const t = JSON.parse(fs.readFileSync(path.join(desktop, "src/locales", lang, "settings.json"), "utf8"));
  assert.equal(await settings.run("document.querySelectorAll('input[name=appearance]').length"), 4);
  const choose = async (value) => {
    const selector = `input[name=appearance][value=${value}]`;
    const clicked = await settings.run(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      if (!input || input.matches(':disabled') || !input.labels[0].textContent.includes(${JSON.stringify(t.appearance[value])})) return false;
      input.click(); return true;
    })()`);
    assert.ok(clicked, `${value} is labeled and enabled`);
    await until(() => settings.run(`document.querySelector(${JSON.stringify(selector)})?.checked`), "selected option");
    await until(async () => (await prefs(settings)).appearance === value, "saved appearance");
  };
  await shot(settings, "appearance-soft-gray");
  await choose("black");
  await background(main, "rgb(7, 7, 9)");
  await background(settings, "rgb(7, 7, 9)");
  await shot(settings, "appearance-deep-black");
  await choose("light");
  await background(main, "rgb(244, 245, 247)");
  await background(settings, "rgb(244, 245, 247)");
  await shot(settings, "appearance-light");
  // Native radio keyboard navigation selects the next palette and updates the other window.
  await settings.run("document.querySelector('input[name=appearance][value=light]').focus()");
  await settings.call("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
  await settings.call("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
  await until(async () => (await prefs(settings)).appearance === "gray", "keyboard selection");
  await background(main, "rgb(36, 36, 36)");
  await choose("black");
  const rejected = await set(main, { appearance: "not-a-style" });
  assert.equal(rejected.appearance, "black", "invalid values do not overwrite the preference");
  await choose("system");
  for (const [value, rgb] of [["light", "rgb(244, 245, 247)"], ["dark", "rgb(36, 36, 36)"]]) {
    await main.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
    await background(main, rgb);
  }
  await main.call("Emulation.setEmulatedMedia", { features: [] });
  await choose("black");
  await quit();
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile, "preferences.json"), "utf8")).appearance, "black");
  main = await launch();
  await background(main, "rgb(7, 7, 9)");
  assert.equal((await prefs(main)).appearance, "black");
  await set(main, { appearance: "gray" });
  await background(main, "rgb(36, 36, 36)");
  await main.call("Page.reload");
  await until(() => main.run("!!document.querySelector('#root > *')"), "reload");
  await background(main, "rgb(36, 36, 36)");
  console.log("PASS: four choices, keyboard navigation, both windows, light/system, invalid input, restart and reload");
} finally {
  await quit();
  fs.rmSync(work, { recursive: true, force: true });
}
