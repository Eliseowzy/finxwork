#!/usr/bin/env node
// How a bot's turn goes with long work (bot-turn-design §3, §5.3): its first message comes at once,
// the work goes to the background and its page says so, messages sent meanwhile get their answers
// while it goes on, its report comes back as a message. Asked how it is going, the bot finds the
// deferred tool and says what it shows; told to drop it, it stops the work before saying so, and
// nothing comes of it afterwards.
//
// Runs the development build against the repository's target/debug/finx in a temporary FINX_HOME
// and profile, with finx-mock as the model, scripted by the prompt. Takes under a minute once built.
//
//   node apps/desktop/e2e/bot-turn.mjs
//   FINXWORK_E2E_SHOTS=<folder> …   also screenshots each step
//   FINXWORK_E2E_NO_BUILD=1 …       uses the builds there are
//   FINXWORK_E2E_APP=dist/FinxWork.app/Contents/MacOS/FinxWork …   the packaged app, with its own finx
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "../..");
const finx = path.join(root, "target/debug/finx");
const mockModel = path.join(root, "target/debug/finx-mock");
const electron = path.join(desktop, "node_modules/.bin/electron");
const shots = process.env.FINXWORK_E2E_SHOTS;
const packaged = process.env.FINXWORK_E2E_APP ? path.resolve(process.env.FINXWORK_E2E_APP) : null;
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const step = (s) => console.log(`\n▶ ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => {
  throw new Error(message);
};
const check = (ok, message) => ok || fail(message);

// Short: the kernel's socket lives under it, and a socket path has at most 103 bytes.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxt-"));
const home = path.join(work, "finx");
const profile = path.join(work, "profile");
const socket = path.join(home, "run/finx.sock");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(path.join(work, "home"), { recursive: true });

/** One request to finx over its socket. */
function finxCall(method, params = {}) {
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
let model = null;
async function launch() {
  const port = 9400 + Math.floor(Math.random() * 400);
  app = spawn(packaged ?? electron, packaged ? [`--remote-debugging-port=${port}`] : [desktop, `--remote-debugging-port=${port}`], {
    env: { ...process.env, FINX_HOME: home, HOME: path.join(work, "home"), FINXWORK_DEFAULT_MODE: "sessions", FINXWORK_USER_DATA: profile, ...(packaged ? {} : { FINXWORK_FINX: finx }), FINX_CREDENTIAL_STORE: "file" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  let target;
  for (let i = 0; i < 150 && !target; i++) {
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
  const until = async (what, expr, ms = 30000) => {
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
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 0, mobile: false });
  return { cdp, run, until, shot, close: page.close };
}

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

const bubbles = `[...document.querySelectorAll(".tr.bots .bm:not(.working) .bbub")].map((b) => b.innerText)`;
const has = (text) => `${bubbles}.some((t) => t.includes(${JSON.stringify(text)}))`;
const working = `!!document.querySelector(".tr.bots .bm.working")`;
const workingText = `document.querySelector(".tr.bots .bm.working")?.innerText ?? ""`;
const rowSays = `document.querySelector(".brow")?.innerText ?? ""`;

let failed = false;
let page = null;
try {
  if (!process.env.FINXWORK_E2E_NO_BUILD && !packaged) {
    step("building finx, its test servers and the app");
    sh("cargo", ["build", "-p", "finx-cli", "-p", "finx-mock"], { cwd: root });
    sh("pnpm", ["--dir", desktop, "build"]);
  }

  step("the model: finx-mock, scripted by the prompt");
  model = spawn(mockModel, [], { stdio: ["ignore", "pipe", "inherit"] });
  // It prints its base URL, then a models.toml that ends with the model's cost.
  const toml = await new Promise((resolve) => {
    let out = "";
    model.stdout.on("data", (c) => {
      out += c;
      if (/^cost = .*$/m.test(out)) resolve(out);
    });
  });
  fs.writeFileSync(path.join(home, "models.toml"), toml.replace(/^# .*\n/m, ""));
  fs.writeFileSync(path.join(home, "config.toml"), `model = "mock/mock-1"\n[models]\nnetwork = false\n`);

  page = await launch();
  const write = async (text) => {
    await page.run(`document.querySelector(".cmp-in").focus()`);
    await page.cdp("Input.insertText", { text });
    await page.until("send enabled", `!document.querySelector("button.send")?.disabled`);
    await page.run(`document.querySelector("button.send").click()`);
  };

  await page.until("the new session page", `!!document.querySelector(".seg.mode [data-mode=bots]")`, 60000);
  await page.run(`document.querySelector('.seg.mode [data-mode=bots]').click()`);
  await page.until("the bot's page", `!!document.querySelector(".bhead") && !!document.querySelector(".cmp-in")`, 30000);

  step("a long job: the first message at once, the work in the background");
  const t0 = Date.now();
  await write("[[mock:relay_slow:6]] 写一篇一万字的小作文");
  await page.until("the first message", has("好，这个要一会儿，写好发你。"), 5000);
  console.log(`  · first message after ${Date.now() - t0} ms`);
  await page.until("its page says it works", working, 5000);
  check((await page.run(workingText)).includes("写长文"), `what it says it does: ${await page.run(workingText)}`);
  await page.until("its row says so", `(${rowSays}).includes("正在处理一件事")`, 5000);
  await page.shot("1-working");

  step("the owner goes on talking: answered at once, while the work goes on");
  const t1 = Date.now();
  await write("刚才给你发啥了你知道么");
  await page.until("the answer", has("回复：刚才给你发啥了你知道么"), 4000);
  console.log(`  · answered after ${Date.now() - t1} ms`);
  check(await page.run(working), "the work goes on");
  await write("为什么你在写的时候我还能给你发消息");
  await page.until("the next answer", has("回复：为什么你在写的时候我还能给你发消息"), 4000);
  check(await page.run(working), "the work still goes on");
  await page.shot("2-talking-on");

  step("its report comes back as a message");
  await page.until("the result", has("agent_report"), 15000);
  await page.until("the work over", `!${working}`, 5000);
  const order = await page.run(bubbles);
  const at = (text) => order.findIndex((t) => t.includes(text));
  check(at("好，这个要一会儿") < at("刚才给你发啥") && at("刚才给你发啥") < at("为什么你在写") && at("为什么你在写") < at("agent_report"), `in order: ${JSON.stringify(order)}`);
  await page.shot("3-delivered");

  step("how is it going: it looks before it says");
  await write("[[mock:relay_slow:120]] 再写一篇");
  await page.until("the work again", working, 5000);
  await write("[[mock:check]] 写到哪了");
  await page.until("what it sees", has("running for"), 10000);
  const seen = (await page.run(bubbles)).find((t) => t.includes("running for"));
  check(/\(写长文\): running for .*recent steps: sleep 120/s.test(seen), `what it saw: ${seen}`);
  await page.shot("4-checked");

  step("drop it: the work stops, then the bot says so, and nothing comes of it");
  await write("[[mock:stop_all]] 算了不用了");
  await page.until("what it stopped", has("Stopped: "), 15000);
  await page.until("the work over", `!${working}`, 5000);
  await page.until("its row, quiet", `!(${rowSays}).includes("正在处理")`, 5000);
  const before = (await page.run(bubbles)).length;
  await sleep(1500);
  check((await page.run(bubbles)).length === before, "a stopped agent's report wakes no one");
  await page.shot("5-stopped");

  page.close();
  console.log("\n✔ a bot's long work runs in the background, and the owner can talk, ask and stop");
} catch (e) {
  failed = true;
  console.error(`\n✖ ${e.message}`);
  await page?.shot("failed").catch(() => {});
} finally {
  await finxCall("server/shutdown", {}).catch(() => {});
  if (app && app.exitCode === null) {
    const exited = new Promise((r) => app.once("exit", r));
    app.kill("SIGTERM");
    await exited;
  }
  model?.kill();
  fs.rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
