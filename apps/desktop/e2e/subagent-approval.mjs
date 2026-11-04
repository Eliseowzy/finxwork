#!/usr/bin/env node
// What a sub-agent asks goes to the owner (subagent-design §10): the session page and a bot's page
// pop up the same approval above the composer, saying which sub-agent asks, whether or not the
// main agent is at work. Allowing lets it go on, denying refuses that call alone, one question
// shows at a time, "for this session" holds for the whole tree and settles what waits in line, a
// reloaded window finds the question again, and stopping the sub-agent ends it.
//
// Runs the development build against the repository's target/debug/finx in a temporary FINX_HOME
// and profile, with finx-mock as the model, scripted by the prompt. Takes under a minute once built.
//
//   node apps/desktop/e2e/subagent-approval.mjs
//   FINXWORK_E2E_SHOTS=<folder> …   also screenshots each step
//   FINXWORK_E2E_NO_BUILD=1 …       uses the builds there are
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
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const step = (s) => console.log(`\n▶ ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => {
  throw new Error(message);
};
const check = (ok, message) => ok || fail(message);

// Short: the kernel's socket lives under it, and a socket path has at most 103 bytes.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxs-"));
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
  app = spawn(electron, [desktop, `--remote-debugging-port=${port}`], {
    env: { ...process.env, FINX_HOME: home, HOME: path.join(work, "home"), FINXWORK_DEFAULT_MODE: "sessions", FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINX_CREDENTIAL_STORE: "file" },
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

const asking = `!!document.querySelector(".appr")`;
const who = `document.querySelector(".appr .appr-who")?.textContent ?? ""`;
const what = `document.querySelector(".appr .appr-pre")?.textContent ?? ""`;
const howMany = `document.querySelectorAll(".appr").length`;
const allow = `document.querySelector(".appr .btn.primary").click()`;
const bubbles = `[...document.querySelectorAll(".tr.bots .bm:not(.working) .bbub")].map((b) => b.innerText)`;

let failed = false;
let page = null;
try {
  if (!process.env.FINXWORK_E2E_NO_BUILD) {
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
  fs.writeFileSync(path.join(home, "config.toml"), `model = "mock/mock-1"\npermission_mode = "manual"\n[models]\nnetwork = false\n`);

  page = await launch();
  const write = async (text) => {
    await page.run(`document.querySelector(".cmp-in").focus()`);
    await page.cdp("Input.insertText", { text });
    await page.until("send enabled", `!document.querySelector("button.send")?.disabled`);
    await page.run(`document.querySelector("button.send").click()`);
  };
  /** The session's row: `session/list` has it first. */
  const row = async () => (await finxCall("session/list")).result.sessions[0];
  const settled = async () => {
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      const r = await row();
      if (!r.busy) return r;
      await sleep(150);
    }
    fail("the session stayed busy");
  };
  const cwd = async () => (await row()).cwd;

  step("a sub-agent asks: the window says who, the session waits for the owner");
  await page.until("the new session page", `!!document.querySelector(".cmp-in")`, 60000);
  await write("[[mock:delegate:touch a.txt]] 运行一下");
  await page.until("the approval", asking);
  check((await page.run(who)) === "子智能体 · 运行 touch a.txt", `who asks: ${await page.run(who)}`);
  check((await page.run(what)).includes("touch a.txt"), "what it asks");
  // The main agent's turn ends as it would: the question does not hang on it.
  await page.until("the main agent's own reply", `document.body.innerText.includes("交给子智能体了。")`);
  check((await row()).state === "awaiting_approval", "the list says it waits");
  const dir = await cwd();
  check(!fs.existsSync(path.join(dir, "a.txt")), "not run before it is allowed");
  await page.shot("1-asks");

  step("allowing lets it go on");
  await page.run(allow);
  await page.until("the approval gone", `!${asking}`);
  await settled();
  check(fs.existsSync(path.join(dir, "a.txt")), "the command ran");

  step("denying refuses that call, with why, and it reports as usual");
  await write("[[mock:delegate:touch b.txt]] 再运行一个");
  await page.until("the approval", asking);
  await page.run(`document.querySelector(".appr .appr-f .btn").click()`);
  await page.until("the line for why", `!!document.querySelector(".appr .field")`);
  await page.run(`document.querySelector(".appr .field").focus()`);
  await page.cdp("Input.insertText", { text: "不要这个文件" });
  await page.run(`document.querySelector(".appr .btn.danger").click()`);
  await page.until("the approval gone", `!${asking}`);
  const denied = await settled();
  check(!fs.existsSync(path.join(dir, "b.txt")), "denied, not run");
  const attached = (await finxCall("session/attach", { session_id: denied.session_id })).result.snapshot;
  const last = attached.agents.at(-1);
  check(last.status === "completed", `it went on: ${last.status}`);
  check(JSON.stringify(last.transcript).includes("The user denied this tool call. Feedback: 不要这个文件"), "the sub-agent was told why");

  step("two at once: one question, then the other");
  await write("[[mock:delegate:touch c.txt|touch d.txt]] 两个一起");
  await page.until("the first", asking);
  const first = await page.run(who);
  await sleep(600);
  check((await page.run(howMany)) === 1, "one window");
  check((await page.run(who)) === first, "the same question: nothing swaps under the cursor");
  await page.shot("2-first-of-two");
  await page.run(allow);
  await page.until("the other", `${asking} && (${who}) !== ${JSON.stringify(first)}`);
  await page.shot("2-second-of-two");
  await page.run(allow);
  await settled();
  check(fs.existsSync(path.join(dir, "c.txt")) && fs.existsSync(path.join(dir, "d.txt")), "both ran");

  step("for this session: the tree follows, and what waits in line no longer asks");
  await write("[[mock:delegate:touch e.txt|touch e.txt]] 同一条命令");
  await page.until("the first", asking);
  await sleep(600);
  const session = await page.run(`[...document.querySelectorAll(".appr .btn")].find((b) => b.textContent.includes("本会话都允许"))?.textContent ?? ""`);
  check(session, "it offers the session");
  await page.run(`[...document.querySelectorAll(".appr .btn")].find((b) => b.textContent.includes("本会话都允许")).click()`);
  await page.until("the approval gone", `!${asking}`);
  let again = false;
  const end = Date.now() + 8000;
  while (Date.now() < end && !again) {
    again = await page.run(asking);
    if (!(await row()).busy) break;
    await sleep(100);
  }
  check(!again, "the other was not asked again");
  await settled();
  check(fs.existsSync(path.join(dir, "e.txt")), "it ran");

  step("a window that comes back finds the question");
  await write("[[mock:delegate:touch f.txt]] 再来一个");
  await page.until("the approval", asking);
  await page.cdp("Page.reload");
  await page.until("the question again", `${asking} && (${who}).includes("touch f.txt")`, 60000);
  await page.shot("3-after-reload");
  await page.run(allow);
  await settled();
  check(fs.existsSync(path.join(dir, "f.txt")), "answered after the reload");

  step("the background card says it waits, and stopping it ends the question");
  await write("[[mock:delegate:touch g.txt]] 这个要停掉");
  await page.until("the approval", asking);
  await page.run(`document.querySelector(".bgind")?.click()`);
  const row2 = `[...document.querySelectorAll(".bgc-list .srow")].find((r) => r.innerText.includes("touch g.txt"))`;
  await page.until("its row", `!!${row2}`);
  await page.until("the row says so", `${row2}.querySelector(".smeta").innerText.includes("等你批准")`);
  await page.shot("4-background-card");
  await page.run(`${row2}.querySelector(".rowact.stop").click()`);
  await page.until("the approval gone", `!${asking}`);
  await settled();
  check(!fs.existsSync(path.join(dir, "g.txt")), "stopped, not run");
  await page.run(`document.querySelector(".bgind")?.click()`);

  step("in a bot: the same window, the row waits, and the bot keeps talking");
  await page.run(`document.querySelector('.seg.mode [data-mode=bots]').click()`);
  await page.until("the permission mode under the composer", `document.querySelector(".cmp-zone.bot .cmp-meta .lbl")?.textContent === "完全访问"`, 30000);
  await page.run(`document.querySelector(".cmp-zone.bot .cmp-meta .mb").click()`);
  await page.until("the menu", `[...document.querySelectorAll(".mi")].some((e) => e.textContent.includes("询问权限"))`);
  await page.run(`[...document.querySelectorAll(".mi")].find((e) => e.textContent.includes("询问权限")).click()`);
  await page.until("Ask Permissions", `document.querySelector(".cmp-zone.bot .cmp-meta .lbl")?.textContent === "询问权限"`);
  await write("[[mock:relay_run:touch h.txt]] 建个文件");
  await page.until("the approval", `!!document.querySelector(".cmp-zone.bot .appr")`);
  check((await page.run(who)) === "子智能体 · 运行 touch h.txt", `who asks: ${await page.run(who)}`);
  await page.until("the bot's message", `${bubbles}.includes("交给子智能体了。")`);
  await page.until("its row waits", `[...document.querySelectorAll(".brow")].some((r) => r.innerText.includes("[待确认]"))`);
  await page.shot("5-bot-asks");
  await write("还在吗");
  await page.until("an answer while it waits", `${bubbles}.includes("做完了：还在吗")`);
  check(await page.run(asking), "the question still waits");
  await page.shot("6-bot-talks-on");
  const bots = fs.readdirSync(path.join(home, "bots")).map((id) => path.join(home, "bots", id, "files", "h.txt"));
  check(!bots.some((f) => fs.existsSync(f)), "not run before it is allowed");
  await page.run(allow);
  await page.until("the approval gone", `!${asking}`);
  for (let i = 0; i < 60 && !bots.some((f) => fs.existsSync(f)); i++) await sleep(250);
  check(bots.some((f) => fs.existsSync(f)), "the command ran in the bot's folder");
  await page.until("its report relayed", `${bubbles}.some((t) => t.includes("agent_report"))`);
  await page.shot("7-bot-done");

  page.close();
  console.log("\n✔ what sub-agents ask reaches the owner, in both modes");
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
