#!/usr/bin/env node
// Build first: cargo build -p finx-cli; pnpm --filter @finx/desktop build
// Exercises the real Electron UI and kernel with the local OAuth/Responses fixture.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fixture, finx, until, sleep } from "../../../crates/finx-connections/tests/chatgpt-fixture.mjs";
const f = await fixture();
const desktop = path.resolve(import.meta.dirname, "..");
const port = 9800 + Math.floor(Math.random() * 400);
const socket = path.join(f.home, "run/finx.sock");
const locales = ["en", "zh-CN"].map(l => JSON.parse(fs.readFileSync(path.join(desktop, `src/locales/${l}/settings.json`))));
const labels = key => locales.map(l => key.split(".").reduce((v, k) => v[k], l));
const row = 'document.querySelector("[data-testid=chatgpt-connection]")';
const button = key => `[...(${row})?.querySelectorAll("button") ?? []].find(b => ${JSON.stringify(labels(key))}.includes(b.textContent))`;
let app;
const pages = [];
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(socket); let buffer = "";
    const timer = setTimeout(() => { s.destroy(); reject(new Error(`RPC timeout ${method}`)); }, 20000);
    const send = (id, name, p) => s.write(JSON.stringify({ jsonrpc: "2.0", id, method: name, params: p }) + "\n");
    s.on("connect", () => send(1, "initialize", { protocol_version: 2, client_info: { name: "desktop-e2e" } }));
    s.on("error", e => { clearTimeout(timer); reject(e); });
    s.on("data", data => {
      buffer += data;
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const m = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
        if (m.id === 1) send(2, method, params);
        if (m.id === 2) { clearTimeout(timer); s.end(); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
      }
    });
  });
}
async function page(settings) {
  const target = await until(async () => {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json(), () => []);
    return list.find(t => t.type === "page" && t.url.includes("#settings") === settings && !t.url.startsWith("devtools"));
  }, settings ? "settings window" : "main window");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const waiting = new Map(); let seq = 0;
  ws.onmessage = e => { const m = JSON.parse(e.data); const w = waiting.get(m.id); if (w) { waiting.delete(m.id); clearTimeout(w.timer); m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result); } };
  ws.onclose = () => { for (const w of waiting.values()) { clearTimeout(w.timer); w.reject(new Error("DevTools page closed during a command")); } waiting.clear(); };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`DevTools timeout: ${method}`)); }, 15000);
    waiting.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  const run = async expression => {
    const r = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const closeWindow = async () => {
    const closed = new Promise(resolve => ws.addEventListener("close", resolve, { once: true }));
    await run("setTimeout(() => window.close(), 100); undefined");
    await closed;
  };
  const p = { cdp, run, closeWindow, close: () => ws.close(), wait: (expr, label) => until(() => run(expr), label) }; pages.push(p); return p;
}
try {
  console.log("Launching isolated kernel and Electron");
  f.processFor(["serve", "--listen", "unix://"]);
  await until(() => fs.existsSync(socket), "kernel socket");
  f.state.mode = "pending";
  app = spawn(path.join(desktop, "node_modules/.bin/electron"), [desktop, `--remote-debugging-port=${port}`], {
    env: { ...f.env, FINXWORK_USER_DATA: path.join(f.work, "profile"), FINXWORK_FINX: finx }, stdio: ["ignore", "ignore", "pipe"],
  });
  app.stderr.on("data", () => {});
  const main = await page(false);
  await main.wait('!!window.finx', "desktop bridge");
  await until(() => main.run('!!document.querySelector(".onb .onb-local [data-testid=chatgpt-connection]")'), "onboarding subscriptions", 45000);
  const onboardingHeadings = await main.run('[...document.querySelectorAll(".onb .connections-section-heading h3")].map(n => n.textContent)');
  assert.equal(onboardingHeadings.length, 2);
  assert.ok(labels("models.subscription").includes(onboardingHeadings[0]));
  assert.ok(labels("models.api").includes(onboardingHeadings[1]));
  if (process.env.FINXWORK_E2E_SHOTS) {
    fs.mkdirSync(process.env.FINXWORK_E2E_SHOTS, { recursive: true });
    const { data } = await main.cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(process.env.FINXWORK_E2E_SHOTS, "onboarding.png"), Buffer.from(data, "base64"));
  }
  await main.run('window.finx.openSettings("models")');
  let settings = await page(true);
  await settings.wait(`!!(${button("models.connect")}) && !(${button("models.connect")}).disabled`, "ChatGPT sign-in entry");
  console.log("Subscriptions share one group");
  assert.deepEqual(await settings.run(`[...(${row}).closest('.fgroup').querySelectorAll('.mrow')].map(n => n.dataset.testid)`), ["chatgpt-connection", "qwenwork-connection", "qoder-connection"]);
  const headings = await settings.run('[...document.querySelectorAll(".models > section > h3")].map(n => n.textContent)');
  assert.equal(headings.length, 2);
  assert.ok(labels("models.subscription").includes(headings[0]));
  assert.ok(labels("models.api").includes(headings[1]));
  if (process.env.FINXWORK_E2E_SHOTS) {
    fs.mkdirSync(process.env.FINXWORK_E2E_SHOTS, { recursive: true });
    const { data } = await settings.cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(process.env.FINXWORK_E2E_SHOTS, "subscriptions.png"), Buffer.from(data, "base64"));
  }
  console.log("Sign-in, pending state, cancellation");
  await settings.run(`(${button("models.connect")}).click()`);
  await settings.wait(`!!(${button("models.cancel")})`, "pending authorization controls");
  await settings.run(`(${button("models.cancel")}).click()`);
  await settings.wait(`!!(${button("models.connect")})`, "cancelled sign-in");
  assert.equal((await call("chatgpt/status")).state, "cancelled");
  console.log("Login survives closing settings, publishes model catalog, and manages models");
  await settings.run(`(${button("models.connect")}).click()`);
  await settings.wait(`!!(${button("models.cancel")})`, "second pending sign-in");
  const pending = await call("chatgpt/status");
  await settings.closeWindow();
  await main.run('window.finx.openSettings("models")'); settings = await page(true);
  await settings.wait(`!!(${button("models.cancel")})`, "restored pending sign-in");
  f.state.mode = "ok"; await f.authorize(pending.authorize_url);
  await settings.wait(`!!(${button("models.manage.open")})`, "connected subscription row");
  assert.match(await settings.run(`${row}.innerText`), /tester@example.invalid/);
  await settings.run(`(${button("models.manage.open")}).click()`);
  await settings.wait('document.querySelector(".mm-list")?.innerText.includes("ChatGPT Fixture")', "account models");
  await settings.run('document.querySelector(".mm-bar button").click()');
  await settings.wait('!document.querySelector(".mm-bar button")?.disabled', "model refresh complete");
  await settings.run('document.querySelector(".provider-dialog-top button").click()');
  if (process.env.FINXWORK_E2E_SHOTS) {
    fs.mkdirSync(process.env.FINXWORK_E2E_SHOTS, { recursive: true });
    const { data } = await settings.cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(process.env.FINXWORK_E2E_SHOTS, "chatgpt-connected.png"), Buffer.from(data, "base64"));
  }
  console.log("Select subscription model and run a task in the desktop");
  await settings.closeWindow();
  // First-time users explicitly leave the ready page after connecting their first model.
  await main.wait('!!document.querySelector(".onb-start")', "first model ready");
  await main.run('document.querySelector(".onb-start").click()');
  const picker = '[...document.querySelectorAll("button.mb")].find(b => ["Model", "模型"].includes(b.title))';
  await main.wait(`!!(${picker})`, "model picker");
  await main.run(`(${picker}).click()`);
  await main.wait('[...document.querySelectorAll("button.mi")].some(b => b.textContent.startsWith("ChatGPT Fixture"))', "subscription model in picker");
  await main.run('[...document.querySelectorAll("button.mi")].find(b => b.textContent.startsWith("ChatGPT Fixture")).click()');
  await main.run('document.querySelector(".cmp-in").focus()');
  await main.cdp("Input.insertText", { text: "ping from subscription" });
  await main.wait('!document.querySelector("button.send")?.disabled', "send enabled");
  await main.run('document.querySelector("button.send").click()');
  await main.wait('document.body.innerText.includes("subscription-pong")', "subscription reply");
  assert.equal(f.state.responses.length, 1);
  console.log("Disconnect removes subscription models and revokes the grant");
  await main.run('window.finx.openSettings("models")'); settings = await page(true);
  await settings.wait(`!!(${button("models.disconnect")})`, "disconnect control");
  await settings.run(`(${button("models.disconnect")}).click()`);
  await settings.wait(`!!(${button("models.connect")})`, "disconnected row");
  assert.equal((await call("chatgpt/status")).connection, null); assert.equal(f.state.revocations, 1);
  await settings.wait(`!!(${button("models.chatgpt.forget")})`, "retained account registration");
  await settings.run(`(${button("models.chatgpt.forget")}).click()`);
  await settings.wait(`!(${button("models.chatgpt.forget")})`, "forgotten account");
  assert.equal((await call("chatgpt/status")).account, null);
  assert.deepEqual(f.state.errors.map(e => e.message), []);
  console.log("PASS: Electron settings login/cancel/reopen, model management, model selection, task reply, logout");
} catch (error) {
  console.error(`Desktop E2E failed: ${error.message}`);
  console.error(`Fixture errors: ${f.state.errors.map(e => e.message).join("; ")}; model requests: ${f.state.responses.length}`);
  throw error;
} finally {
  for (const p of pages) p.close();
  if (app?.exitCode === null) {
    const exited = new Promise(r => app.once("exit", r)); app.kill();
    await Promise.race([exited, sleep(3000)]);
    if (app.exitCode === null) app.kill("SIGKILL");
  }
  await f.close();
}
