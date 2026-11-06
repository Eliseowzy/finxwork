#!/usr/bin/env node
// The first run with nothing set up (standalone-cli-design §7.2): no model is assumed. The app
// names none, asks for one on the first-run page and the new session page, and a bot's page says
// the same. The first provider connected becomes the default: the page shows its model, and the
// first message goes to it.
//
// Runs the development build (electron-vite build) against the repository's target/debug/finx in
// temporary FINX_HOMEs and profiles, with a model server on this Mac standing in for the provider,
// so the person's own finxwork, its settings and their finx are not touched. The window shows up
// while it runs. Takes under a minute once built.
//
//   node apps/desktop/e2e/first-run.mjs
//   FINXWORK_E2E_SHOTS=<folder> node apps/desktop/e2e/first-run.mjs   also screenshots
import { cdpPort } from "./lib/port.mjs";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "../..");
const finx = path.join(root, "target/debug/finx");
const electron = path.join(desktop, "node_modules/.bin/electron");
const shots = process.env.FINXWORK_E2E_SHOTS;
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const step = (s) => console.log(`\n▶ ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => {
  throw new Error(message);
};
const check = (ok, message) => ok || fail(message);

const locale = (l, ns) => JSON.parse(fs.readFileSync(path.join(desktop, "src/locales", l, `${ns}.json`), "utf8"));
const session = ["en", "zh-CN"].map((l) => locale(l, "session"));
const words = (pick) => JSON.stringify(session.map(pick));

// The provider: an OpenAI-style server that lists its models and answers every request with one line.
const asked = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: [{ id: "kimi-k3.1-pro" }, { id: "kimi-k3" }] }));
    }
    if (!req.url?.endsWith("/chat/completions")) return res.writeHead(404).end();
    asked.push(JSON.parse(body).model);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = { choices: [{ index: 0, delta: { role: "assistant", content: "pong" }, finish_reason: null }] };
    const end = { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } };
    res.end(`data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/v1`;

/** A home nobody has set up. Kimi's address leads to the server above; a local Ollama stays out of it. */
function freshHome() {
  // Short: the kernel's socket lives under it, and a socket path has at most 103 bytes.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxf-"));
  const home = path.join(work, "finx");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(work, "home"), { recursive: true });
  fs.writeFileSync(path.join(home, "models.toml"), `[providers.kimi]\nbase_url = "${base}"\n\n[providers.ollama]\nbase_url = "http://127.0.0.1:9/v1"\n`);
  fs.writeFileSync(path.join(home, "config.toml"), `[models]\nnetwork = false\n`);
  return { work, home, socket: path.join(home, "run/finx.sock") };
}

// ── finx over its socket, as kernel-call.mjs talks to it ──
function finxCall({ socket }, method, params = {}) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(socket);
    let buf = "";
    const send = (id, m, p) => s.write(JSON.stringify({ jsonrpc: "2.0", id, method: m, params: p }) + "\n");
    s.on("connect", () => send(1, "initialize", { protocol_version: 2, client_info: { name: "e2e" } }));
    s.on("data", (c) => {
      buf += c;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (msg.id === 1) send(2, method, params);
        if (msg.id === 2) {
          s.end();
          resolve(msg);
        }
      }
    });
    s.on("error", reject);
  });
}

// ── the app, driven over the DevTools protocol ──
let app = null;
async function launch({ work, home }, mode) {
  const port = cdpPort();
  // Everything that would make a provider connected is left out: this is the first run.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.endsWith("_API_KEY") && k !== "FINX_MODEL"));
  app = spawn(electron, [desktop, `--remote-debugging-port=${port}`], {
    env: { ...env, FINX_HOME: home, HOME: path.join(work, "home"), FINXWORK_DEFAULT_MODE: mode, FINXWORK_USER_DATA: path.join(work, "profile"), FINXWORK_FINX: finx, FINX_CREDENTIAL_STORE: "file" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(200);
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => []);
    target = list.find((t) => t.type === "page" && !t.url.includes("#settings") && !t.url.startsWith("devtools"));
  }
  check(target, "the main window never showed up");
  const page = await devtools(target.webSocketDebuggerUrl);
  const cdp = page.call;
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
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, "base64"));
  };
  return { cdp, run, until, shot, close: page.close };
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
  await exited;
}

// The model picker is the composer's button titled "Model" in the app's language.
const picker = `[...document.querySelectorAll("button.mb")].find((b) => ${words((s) => s.composer.model)}.includes(b.title))`;
const pickerLabel = `(${picker})?.querySelector(".lbl")?.textContent ?? ""`;
const later = `[...document.querySelectorAll(".onb-foot button")].find((b) => ${words((s) => s.onboarding.later)}.includes(b.textContent.trim()))`;
const heroTitle = `document.querySelector(".new-hero h1")?.textContent ?? ""`;
const noModelWords = words((s) => s.new.noModel);

const homes = [];
let failed = false;
try {
  if (!process.env.FINXWORK_E2E_NO_BUILD) {
    step("building finx and the app");
    sh("cargo", ["build", "-p", "finx-cli"], { cwd: root });
    sh("pnpm", ["--dir", desktop, "build"]);
  }

  step("nothing set up: the first-run page opens, and no model is named");
  const first = freshHome();
  homes.push(first);
  let page = await launch(first, "sessions");
  await page.until("the first-run page", `!!(${later})`);
  await page.shot("1-first-run");
  const listed = await finxCall(first, "models/list");
  check(listed.result.models.length === 0, `models offered before any is connected: ${JSON.stringify(listed.result.models.map((m) => m.id))}`);
  check(listed.result.defaults.model === undefined, `a default model is assumed: ${listed.result.defaults.model}`);

  step("left for later: the new session page says so, and the menu leads back");
  await page.run(`(${later}).click()`);
  await page.until("the new session page", `${noModelWords}.includes(${heroTitle})`);
  const label = await page.run(pickerLabel);
  check(session.some((s) => s.composer.model === label), `the model button shows ${label}`);
  check(!(await page.run(`document.body.innerText.includes("DeepSeek")`)), "DeepSeek is named on the page");
  check(await page.run(`document.querySelector("button.send")?.disabled ?? true`), "a message can be sent without a model");
  await page.run(`(${picker}).click()`);
  await page.until("the menu says no model is connected", `${noModelWords}.includes(document.querySelector(".mmodels .mempty")?.textContent ?? "")`);
  // The menu fades in.
  await sleep(300);
  await page.shot("2-no-model");
  const connect = `[...document.querySelectorAll(".mmodels button.mi")].find((b) => ${words((s) => s.new.connect)}.includes(b.textContent.trim()))`;
  await page.until("the way to connect one", `!!(${connect})`);
  await page.run(`(${connect}).click()`);
  await page.until("the first-run page again", `!!(${later})`);

  step("a provider's key: its model is the default, shown and used");
  await page.run(`document.querySelector(".provider-choice.choice-kimi").click()`);
  await page.until("the key form", `!!document.querySelector(".key-entry input")`);
  await page.run(`document.querySelector(".key-entry input").focus()`);
  await page.cdp("Input.insertText", { text: "sk-e2e-key" });
  await page.run(`document.querySelector(".key-entry").requestSubmit()`);
  await page.until("ready", `!!document.querySelector(".onb-start")`);
  const defaultRow = await page.until("the default marked", `document.querySelector(".connection-default.chosen")?.closest(".connection-model")?.querySelector("strong")?.textContent`);
  const models = await finxCall(first, "models/list");
  check(models.result.defaults.model === "kimi/kimi-k3.1-pro", `the default is ${models.result.defaults.model}`);
  const name = models.result.models.find((m) => m.id === "kimi/kimi-k3.1-pro").name;
  check(defaultRow === name, `the page marks ${defaultRow} as the default, finx says ${name}`);
  await page.shot("3-ready");
  await page.run(`document.querySelector(".onb-start").click()`);
  await page.until("the model in the picker", `(${pickerLabel}) === ${JSON.stringify(name)}`);
  await page.until("the greeting", `!${noModelWords}.includes(${heroTitle})`);
  await page.run(`document.querySelector(".cmp-in").focus()`);
  await page.cdp("Input.insertText", { text: "ping" });
  await page.until("send enabled", `!document.querySelector("button.send")?.disabled`);
  await page.run(`document.querySelector("button.send").click()`);
  await page.until("the reply", `document.body.innerText.includes("pong")`);
  check(asked.length === 1 && asked[0] === "kimi-k3.1-pro", `the provider was asked for ${JSON.stringify(asked)}`);
  check(!(await page.run(`!!document.querySelector(".toast.bad")`)), "an error toast showed");
  await page.shot("4-sent");
  page.close();
  await quit();
  await finxCall(first, "server/shutdown").catch(() => {});

  step("Bot mode: its page says the same, without an error, and starts once a model is connected");
  const second = freshHome();
  homes.push(second);
  page = await launch(second, "");
  await page.until("the first-run page", `!!(${later})`);
  await page.run(`(${later}).click()`);
  await page.until("the bot's page says no model is connected", `!!document.querySelector(".bot") && ${noModelWords}.includes(${heroTitle})`);
  // Long enough for a failed bots/open to have shown its error.
  await sleep(800);
  check(!(await page.run(`!!document.querySelector(".toast.bad")`)), "an error toast showed");
  check(!(await page.run(`!!document.querySelector(".bot .mini-spin")`)), "the page is still spinning");
  await page.shot("5-bot-no-model");
  // As from the settings window: the model arrives without this page doing anything.
  const set = await finxCall(second, "auth/set", { provider: "kimi", api_key: "sk-e2e-key" });
  check(!set.error, `auth/set: ${set.error?.message}`);
  await page.until("the bot's conversation", `!document.querySelector(".new-hero") && !!document.querySelector(".bot .cmp-in")`);
  await page.shot("6-bot-started");
  page.close();
  console.log("\n✔ no model is assumed: the app asks for one, and the first provider connected is the default");
} catch (e) {
  failed = true;
  console.error(`\n✘ ${e.message}`);
} finally {
  await quit();
  for (const home of homes) await finxCall(home, "server/shutdown").catch(() => {});
  server.close();
  for (const { work } of homes) {
    if (!failed) fs.rmSync(work, { recursive: true, force: true });
    else console.error(`  kept ${work} (finx's log is in finx/logs)`);
  }
  process.exitCode = failed ? 1 : 0;
}
