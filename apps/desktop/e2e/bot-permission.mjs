#!/usr/bin/env node
// What bots may do (bot-mode-design §6.13): Full Access by default, a conversation already there
// included, with a note above the composer until it is closed or the settings are opened. No
// dialog. The mode is changed in the bot's settings, none is under its composer, and what is picked
// there stays. A model server on the Mac stands in for the provider: it runs one `touch`, then says so.
//
// Runs the development build against the repository's target/debug/finx, in a FINX_HOME and
// profile of its own. Takes under a minute once built.
//
//   node apps/desktop/e2e/bot-permission.mjs
//   FINXWORK_E2E_SHOTS=<folder> …   also screenshots each step
//   FINXWORK_E2E_NO_BUILD=1 …       uses the builds there are
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

const sse = (delta, finish) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\ndata: [DONE]\n\n`;
const call = (name, args) => ({ role: "assistant", tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (!req.url?.endsWith("/chat/completions")) return res.writeHead(404).end();
    const { messages } = JSON.parse(body);
    // Past the word that follows each of the owner's messages (bot-design §3.13).
    const last = messages.filter((m) => !JSON.stringify(m.content ?? "").includes("<reminder>")).at(-1);
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (last.role === "tool") return res.end(sse(call("send_to_user", { text: "好了", end_turn: true }), "tool_calls"));
    const said = typeof last.content === "string" ? last.content : last.content.map((c) => c.text ?? "").join("");
    res.end(sse(call("bash", { command: `touch ${said.match(/\S+\.txt/)?.[0] ?? "x.txt"}` }), "tool_calls"));
  });
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));

/** A FINX_HOME, HOME and profile of their own: the app registers the extension's host in the
 * browsers under that HOME. Short: the kernel's socket lives under them. */
function place() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxq-"));
  const home = path.join(work, "finx");
  const userHome = path.join(work, "home");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(userHome);
  fs.writeFileSync(
    path.join(home, "models.toml"),
    `[providers.mock]\nname = "Mock"\napi = "openai-chat"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nauth = "none"\n\n[[providers.mock.models]]\nid = "mock-1"\nname = "Mock One"\ncontext_window = 128000\nmax_output_tokens = 2000\n`,
  );
  fs.writeFileSync(path.join(home, "config.toml"), `model = "mock/mock-1"\npermission_mode = "manual"\n[models]\nnetwork = false\n`);
  return { work, home, userHome, profile: path.join(work, "profile") };
}

/** One request to finx over its socket. */
function finxCall(home, method, params = {}) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(path.join(home, "run/finx.sock"));
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
async function launch({ home, userHome, profile }) {
  const port = 9400 + Math.floor(Math.random() * 400);
  app = spawn(electron, [desktop, `--remote-debugging-port=${port}`], {
    env: { ...process.env, FINX_HOME: home, HOME: userHome, FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINX_CREDENTIAL_STORE: "file" },
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
      await sleep(250);
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

async function quit() {
  if (!app || app.exitCode !== null) return;
  const exited = new Promise((r) => app.once("exit", r));
  app.kill("SIGTERM");
  await exited;
}

const asking = `!!document.querySelector(".cmp-zone.bot .appr")`;
const tip = `document.querySelector(".cmp-zone.bot .knote")?.textContent ?? ""`;
const dialog = `!!document.querySelector("dialog.sheet[open]")`;
const mode = `document.querySelector(".bpn-perm .lbl")?.textContent`;
const noneUnder = `!document.querySelector(".cmp-zone.bot .cmp-meta")`;
const bubbles = `[...document.querySelectorAll(".tr.bots .bm:not(.working) .bbub")].length`;
const made = (home, name) => fs.readdirSync(path.join(home, "bots")).some((id) => fs.existsSync(path.join(home, "bots", id, "files", name)));

/** Writes and sends; `meanwhile` runs with the text written, not yet sent. */
async function say(page, text, meanwhile) {
  await page.run(`document.querySelector(".cmp-in").focus()`);
  await page.cdp("Input.insertText", { text });
  await page.until("Send enabled", `!document.querySelector("button.send")?.disabled`);
  await meanwhile?.();
  await page.run(`document.querySelector("button.send").click()`);
}

/** The bot's settings out, from its name at the top. */
async function settings(page) {
  await page.run(`document.querySelector(".bpn") || document.querySelector(".bhead").click()`);
  await page.until("the settings", `!!document.querySelector(".bpn-perm")`);
}

async function intoBots(page) {
  await page.until("the window", `!!document.querySelector(".seg.mode")`, 60000);
  await page.run(`document.querySelector('.seg.mode [data-mode=bots]').click()`);
}

let failed = false;
const places = [];
try {
  if (!process.env.FINXWORK_E2E_NO_BUILD) {
    step("building finx and the app");
    sh("cargo", ["build", "-p", "finx-cli"], { cwd: root });
    sh("pnpm", ["--dir", desktop, "build"]);
  }

  step("by default: Full Access, a conversation already there included, a note and no dialog");
  const one = place();
  places.push(one);
  let page = await launch(one);
  await page.until("the window", `!!document.querySelector(".seg.mode")`, 60000);
  // A bot whose conversation is already there, in the config's manual mode.
  const old = (await finxCall(one.home, "bots/create", { name: "老对话", avatar: { kind: "mono", hue: "slate" } })).result.bot;
  await finxCall(one.home, "bots/open", { bot_id: old.id });
  await intoBots(page);
  const said = await page.until("the note", tip, 30000);
  check(!(await page.run(dialog)), "no dialog");
  check(await page.run(noneUnder), "no permission mode under a bot's composer");
  check(said.includes("完全访问") && said.includes("智能体和任务") && said.includes("每个 Bot") && said.includes("顶部"), `the note says what holds, how far and where to change it: ${said}`);
  await sleep(500);
  await page.shot("p1-note");
  await say(page, "建 b.txt", async () => {
    check(await page.run(`!!document.querySelector(".cmp-zone.bot .knote")`), "writing leaves the note: it covers nothing");
    await page.shot("p1-writing");
    await page.run(`[...document.querySelectorAll(".knote .btn")].find((b) => b.textContent === "知道了").click()`);
    await page.until("the note gone", `(${tip}) === ""`);
  });
  await page.until("the answer", `${bubbles} > 0`, 30000);
  check(made(one.home, "b.txt"), "b.txt without asking");
  check(!(await page.run(asking)), "no approval");
  await settings(page);
  await page.until("Full Access", `${mode} === "完全访问"`);
  const scope = await page.run(`document.querySelector(".bpn-perm .set-note").textContent`);
  check(scope.includes("只对这个 Bot") && scope.includes("智能体和任务"), `the settings say how far the mode reaches: ${scope}`);
  await sleep(500);
  await page.shot("p2-settings");

  step("the conversation that was already there gets it too");
  await page.run(`[...document.querySelectorAll(".brow")].find((r) => r.querySelector(".bname").textContent === "老对话").click()`);
  await page.until("老对话, Full Access", `document.querySelector(".bhead-n")?.textContent === "老对话" && ${mode} === "完全访问"`, 30000);
  await page.run(`[...document.querySelectorAll(".brow")].find((r) => r.querySelector(".bname").textContent === "FinxBot").click()`);
  await page.until("FinxBot", `document.querySelector(".bhead-n")?.textContent === "FinxBot"`);

  step("知道了 closed the note for good");
  await page.cdp("Page.reload");
  await sleep(1500);
  await page.until("the page again", `!!document.querySelector(".cmp-zone.bot")`, 30000);
  await sleep(500);
  check((await page.run(tip)) === "", "the note stays closed");

  step("a new bot starts with Full Access; what is picked in its settings stays");
  await page.run(`[...document.querySelectorAll(".side-nav .nav-i")][0].click()`);
  await page.until("the form", `!!document.querySelector("dialog.bsheet[open] input.field")`);
  await page.cdp("Input.insertText", { text: "研究员" });
  await page.run(`document.querySelector("dialog.bsheet form").requestSubmit()`);
  await page.until("研究员", `document.querySelector(".bhead-n")?.textContent === "研究员"`, 30000);
  await settings(page);
  await page.until("研究员, Full Access", `${mode} === "完全访问"`, 30000);
  check((await page.run(tip)) === "", "no note for the new bot");
  await page.run(`document.querySelector(".bpn-perm .mb").click()`);
  await page.until("the menu", `[...document.querySelectorAll(".mi")].some((e) => e.textContent.includes("询问权限"))`);
  await sleep(500);
  await page.shot("p3-picker");
  await page.run(`[...document.querySelectorAll(".mi")].find((e) => e.textContent.includes("询问权限")).click()`);
  await page.until("Ask Permissions", `${mode} === "询问权限"`);
  await page.cdp("Page.reload");
  await sleep(1500);
  await page.until("the page again", `!!document.querySelector(".bhead")`, 30000);
  await settings(page);
  await page.until("the picked mode stays", `${mode} === "询问权限"`, 30000);
  await say(page, "建 c.txt");
  await page.until("the approval", asking, 30000);
  check(!made(one.home, "c.txt"), "this bot asks now");
  await page.run(`document.querySelector(".appr .btn.primary").click()`);
  await page.until("the answer", `${bubbles} > 0`, 30000);

  step("back to Full Access asks first, as on a session's page");
  await page.run(`document.querySelector(".bpn-perm .mb").click()`);
  await page.until("the menu", `[...document.querySelectorAll(".mi")].some((e) => e.textContent.includes("完全访问"))`);
  await page.run(`[...document.querySelectorAll(".mi")].find((e) => e.textContent.includes("完全访问")).click()`);
  await page.until("the question", dialog);
  const question = await page.run(`document.querySelector("dialog.sheet[open]").textContent`);
  check(question.includes("智能体和任务"), `the question says it reaches what the bot creates: ${question}`);
  await sleep(300);
  await page.shot("p5-question");
  check((await page.run(mode)) === "询问权限", "nothing changes until agreed");
  await page.run(`[...document.querySelectorAll("dialog.sheet[open] .btn")].find((b) => b.textContent === "同意").click()`);
  await page.until("Full Access again", `${mode} === "完全访问"`);

  await page.run(`[...document.querySelectorAll(".brow")].find((r) => r.querySelector(".bname").textContent === "FinxBot").click()`);
  await page.until("the other bot keeps Full Access", `document.querySelector(".bhead-n")?.textContent === "FinxBot" && ${mode} === "完全访问"`, 30000);
  page.close();
  await quit();
  await finxCall(one.home, "server/shutdown").catch(() => {});

  step("the note's Open Settings opens them, says where the mode is, and closes the note for good");
  const two = place();
  places.push(two);
  page = await launch(two);
  await intoBots(page);
  await page.until("the note", tip, 30000);
  await page.run(`[...document.querySelectorAll(".knote .btn")].find((b) => b.textContent === "打开设置").click()`);
  await page.until("the settings, Full Access", `${mode} === "完全访问"`);
  await page.until("the note gone", `(${tip}) === ""`);
  await sleep(500);
  await page.shot("p4-from-note");
  await page.cdp("Page.reload");
  await sleep(1500);
  await page.until("the page again", `!!document.querySelector(".cmp-zone.bot")`, 30000);
  await sleep(500);
  check((await page.run(tip)) === "", "the note stays closed");
  page.close();
  await quit();
  await finxCall(two.home, "server/shutdown").catch(() => {});

  step("opening the settings from the name at the top closes the note too");
  const three = place();
  places.push(three);
  page = await launch(three);
  await intoBots(page);
  await page.until("the note", tip, 30000);
  await settings(page);
  await page.until("the note gone", `(${tip}) === ""`);
  page.close();
  await quit();
  await finxCall(three.home, "server/shutdown").catch(() => {});
  console.log("\n✔ a bot's permission mode works end to end");
} catch (e) {
  failed = true;
  console.error(`\n✘ ${e.message}`);
} finally {
  await quit();
  for (const p of places) await finxCall(p.home, "server/shutdown").catch(() => {});
  provider.close();
  if (!failed) for (const p of places) fs.rmSync(p.work, { recursive: true, force: true });
  else console.error(`  kept ${places.map((p) => p.work).join(", ")}`);
}
process.exit(failed ? 1 : 0);
