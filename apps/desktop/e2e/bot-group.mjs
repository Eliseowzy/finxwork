#!/usr/bin/env node
// Group chat on the desktop (bot-group-chat-dev-brief §5, M5): making a group of this computer's
// bots, saying something, an @ that opens a thread, a quote that finds its message, who is
// thinking. The app runs against the repository's
// target/debug/finx in a temporary FINX_HOME and profile, with a scripted model on a local port;
// the person's own finx, settings and home are not touched.
//
//   node apps/desktop/e2e/bot-group.mjs
//   FINXWORK_E2E_SHOTS=<folder> …   also screenshots each step
//   FINXWORK_E2E_NO_BUILD=1 …       uses the builds there are
import { cdpPort } from "./lib/port.mjs";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "../..");
const finx = path.join(root, "target/debug/finx");
const electron = path.join(desktop, "node_modules/.bin/electron");
const shots = process.env.FINXWORK_E2E_SHOTS;
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const step = (s) => console.log(`\n▶ ${s}`);
const note = (s) => console.log(`  · ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => {
  throw new Error(message);
};
const check = (ok, message) => ok || fail(message);

// ── the model, scripted by what the owner just said ──
const sse = (delta, finish) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\ndata: [DONE]\n\n`;
const send = (text) => ({ role: "assistant", tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name: "send_to_user", arguments: JSON.stringify({ text, end_turn: true }) } }] });
const lastWords = (asked) => {
  const messages = asked.messages ?? [];
  const last = [...messages].reverse().find((m) => m.role === "user");
  if (!last) return "";
  return typeof last.content === "string" ? last.content : JSON.stringify(last.content);
};
let requests = 0;
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url?.endsWith("/models")) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [] }));
    if (!req.url?.endsWith("/chat/completions")) return res.writeHead(404).end();
    const asked = JSON.parse(body);
    // Checking a key is no conversation.
    if (!asked.tools?.length) return res.writeHead(200, { "content-type": "text/event-stream" }).end(sse({ role: "assistant", content: "ok" }, "stop"));
    requests += 1;
    const slow = lastWords(asked).includes("慢慢想");
    res.writeHead(200, { "content-type": "text/event-stream" });
    setTimeout(() => {
      res.end(sse(send(slow ? "想好了，慢慢来。" : "好的，收到。"), "tool_calls"));
    }, slow ? 3000 : 150);
  });
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));

const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxg-"));
// A private HOME: the app registers the extension's host in the browsers under it.
const userHome = path.join(work, "home");
fs.mkdirSync(userHome);
const home = path.join(work, "finx");
// A row's menu is native: finx's test seam records it and answers from a file.
const menus = path.join(work, "menus");
fs.mkdirSync(menus);
const profile = path.join(work, "profile");
fs.mkdirSync(home, { recursive: true });
const place = () => {
  fs.writeFileSync(
    path.join(home, "models.toml"),
    `[providers.mock]\nname = "Mock"\napi = "openai-chat"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nauth = "none"\ncompat = { thinking_format = "openai" }\n\n[[providers.mock.models]]\nid = "mock-1"\nname = "Mock One"\ncontext_window = 128000\nmax_output_tokens = 2000\n`,
  );
  fs.writeFileSync(path.join(home, "config.toml"), `model = "mock/mock-1"\npermission_mode = "manual"\n[models]\nnetwork = false\n[bots]\nexternal = false\n[groups]\nquiet_secs = 1\nmax_wait_secs = 2\n`);
};

// ── the app, driven over the DevTools protocol ──
let app = null;
async function launch() {
  const port = cdpPort();
  const env = { ...process.env, FINX_HOME: home, HOME: userHome, FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINX_CREDENTIAL_STORE: "file", FINXWORK_E2E_MENU: menus };
  delete env.DEEPSEEK_API_KEY;
  // A terminal that runs Node through Electron would keep Electron from opening a window.
  delete env.ELECTRON_RUN_AS_NODE;
  app = spawn(electron, [desktop, `--remote-debugging-port=${port}`], { env, stdio: ["ignore", "ignore", "inherit"] });
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
      await sleep(200);
    }
  };
  const shot = async (name) => {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, "base64"));
  };
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 0, mobile: false });
  // A menu closes when the window loses the focus, and this window may run behind whatever else is in front.
  await cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
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
  if (app && app.exitCode === null) {
    const exited = new Promise((r) => app.once("exit", r));
    app.kill("SIGTERM");
    await exited;
  }
  // finx serves on after the app is gone (until it has been idle a while), and two bots answering
  // each other never leave it idle: stop this home's finx too.
  const sock = path.join(home, "run", "finx.sock");
  try {
    execFileSync("pkill", ["-f", sock]);
  } catch {
    return; // none was running
  }
  for (let i = 0; i < 50; i++) {
    try {
      execFileSync("pgrep", ["-f", sock]);
    } catch {
      return;
    }
    await sleep(100);
  }
}

/** A click with the mouse, where the element is on screen: what is over it gets it. */
async function press(page, expr) {
  const at = await page.run(`(() => { const r = (${expr}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
  await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", clickCount: 1 });
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", clickCount: 1 });
}
const $ = (s) => `document.querySelector(${JSON.stringify(s)})`;
const rows = `[...document.querySelectorAll(".brow")].map((r) => r.textContent)`;
const sent = `[...document.querySelectorAll(".gmsg.own .bub, .gmsg.own .bbub")].map((b) => b.innerText)`;
const answers = `[...document.querySelectorAll(".gmsg.other .bbub")].map((b) => b.innerText)`;
const mentionMenu = `document.querySelector(".gmenu")`;
const menuItem = (name) => `[...document.querySelectorAll(".gmenu .gmenu-i")].find((b) => b.textContent.includes(${JSON.stringify(name)}))`;

async function intoBots(page) {
  await page.until("the window", `!!document.querySelector(".seg.mode")`, 60000);
  await page.run(`document.querySelector('.seg.mode [data-mode=bots]').click()`);
  await page.until("Bot mode's list", `!!document.querySelector(".side-list.bots") && !document.querySelector("[aria-label='Bots and groups'] .loadrow")`);
}
async function addBot(page, name) {
  await page.run(`[...document.querySelectorAll(".nav-i")].find((b) => b.textContent.includes("添加 Bot")).click()`);
  await page.until("the bot form", `!!document.querySelector("dialog.bsheet[open] input.field")`);
  await page.run(`document.querySelector("dialog.bsheet input.field").focus()`);
  await page.cdp("Input.insertText", { text: name });
  await page.until("the bot's name", `document.querySelector("dialog.bsheet input.field").value === ${JSON.stringify(name)}`);
  await press(page, `document.querySelector("dialog.bsheet .sheet-foot .btn.primary")`);
  await page.until(`${name} in the list`, `${rows}.some((r) => r.includes(${JSON.stringify(name)}))`);
}
async function openGroupSheet(page) {
  await page.run(`[...document.querySelectorAll(".nav-i")].find((b) => b.textContent.includes("新建群")).click()`);
  await page.until("the group form", `!!document.querySelector("dialog.gsheet[open]")`);
}
async function chooseMembers(page, names) {
  for (const name of names) {
    await page.run(`[...document.querySelectorAll("dialog.gsheet .gmember")].find((r) => r.textContent.includes(${JSON.stringify(name)})).click()`);
  }
}
const createGroup = `document.querySelector("dialog.gsheet .sheet-foot .btn.primary")`;
const inGroup = (name) => `document.querySelector(".gpage .ghead-n")?.textContent.includes(${JSON.stringify(name)}) && !!document.querySelector(".gpage .cmp-in")`;
async function say(page, text) {
  await page.run(`document.querySelector(".gpage .cmp-in").focus()`);
  await page.cdp("Input.insertText", { text });
  await page.until("Send enabled", `!document.querySelector(".gpage button.send")?.disabled`);
  await page.run(`document.querySelector(".gpage button.send").click()`);
}
let failed = false;
let page = null;
try {
  if (!process.env.FINXWORK_E2E_NO_BUILD) {
    step("building finx and the app");
    sh("cargo", ["build", "-p", "finx-cli"], { cwd: root });
    sh("pnpm", ["--dir", desktop, "build"]);
  }
  place();
  page = await launch();
  await intoBots(page);

  step("two bots, then a group of them");
  await addBot(page, "Alice");
  await addBot(page, "Bob");
  // The note about a bot's Full Access has done its work for the shot, and the form is what the step is about.
  if (await page.run(`!!document.querySelector(".knote .btn.primary")`)) await page.run(`document.querySelector(".knote .btn.primary").click()`);
  await openGroupSheet(page);
  await page.run(`document.querySelector("dialog.gsheet input.field").focus()`);
  await page.cdp("Input.insertText", { text: "装修群" });
  await chooseMembers(page, ["Alice", "Bob"]);
  check(await page.run(`!!document.querySelector("dialog.gsheet .gmember.on")`), "the form shows a chosen member");
  await page.shot("create");
  await press(page, createGroup);
  await page.until("the group's page", inGroup("装修群"));
  check(await page.run(`${rows}.some((r) => r.includes("装修群"))`), "the group is in the list beside the bots");

  step("an answer in the group");
  await say(page, "大家好");
  await page.until("Alice's or Bob's answer", `${answers}.some((b) => b.includes("好的，收到"))`);
  const messages = await page.run(`document.querySelectorAll(".gmsg").length`);
  check(messages >= 2, `the flow has the owner's message and an answer: ${messages}`);
  await page.shot("chat");

  step("an @ picks a member, and its answer opens a thread");
  await page.run(`document.querySelector(".gpage .cmp-in").focus()`);
  await page.cdp("Input.insertText", { text: "@" });
  await page.until("the @ menu", `!!${mentionMenu}`);
  await page.shot("mention");
  await press(page, menuItem("Alice"));
  await page.until("the mention in the composer", `document.querySelector(".gpage .cmp-in").innerText.includes("@Alice")`);
  await page.cdp("Input.insertText", { text: "这个报价你再看下" });
  await page.run(`document.querySelector(".gpage button.send").click()`);
  await page.until("the answer in a thread", `!!document.querySelector(".gthread-link") && ${answers}.length >= 2`);
  check(await page.run(`document.querySelector(".gthread-link").innerText.includes("1 条回复")`), "the first message says how many replies it has");
  await press(page, `document.querySelector(".gthread-link")`);
  await page.until("the thread panel", `!!document.querySelector(".gthread")`);
  check(await page.run(`document.querySelectorAll(".gthread .gmsg").length >= 2`), "the thread shows its first message and the reply");
  await page.shot("thread");

  step("a reply in the thread panel sends into the thread");
  await page.run(`document.querySelector(".gthread .cmp-in").focus()`);
  await page.cdp("Input.insertText", { text: "那就按这个价" });
  await page.run(`document.querySelector(".gthread button.send").click()`);
  await page.until("the thread's second answer", `document.querySelectorAll(".gthread .gmsg.other").length >= 2`);
  await page.run(`document.querySelector(".gthread-top .tb").click()`);
  await page.until("the thread closed", `!document.querySelector(".gthread")`);

  step("an older thread keeps its replies after the group is opened again");
  // `groups/open` carries only the main flow: the panel asks for the thread's own replies.
  const row = (name) => `[...document.querySelectorAll(".brow:not(.grow)")].find((r) => r.textContent.includes(${JSON.stringify(name)}))`;
  await press(page, `document.querySelector(".gthread-link")`);
  await page.until("the thread open before leaving", `!!document.querySelector(".gthread")`);
  await page.run(`${row("Alice")}.click()`);
  await page.until("away from the group", `!document.querySelector(".gpage")`);
  await page.run(`document.querySelector(".brow.grow").click()`);
  await page.until("the group again", `${inGroup("装修群")} && !!document.querySelector(".gthread-link")`);
  check(await page.run(`!document.querySelector(".gthread")`), "a thread left open does not follow into another page");
  await press(page, `document.querySelector(".gthread-link")`);
  await page.until("the thread's replies, loaded", `document.querySelectorAll(".gthread .gmsg.other").length >= 2 && !document.querySelector(".gthread .mini-spin")`);
  await page.shot("thread-again");
  await page.run(`document.querySelector(".gthread-top .tb").click()`);
  await page.until("the thread closed again", `!document.querySelector(".gthread")`);

  step("a quote shows the words it quotes, and its click finds them");
  const quoteButton = `[...document.querySelectorAll(".gmsg.other")].at(-1).querySelectorAll(".gact")[1]`;
  await press(page, quoteButton);
  await page.until("the quote over the composer", `!!document.querySelector(".gquote-draft")`);
  const quoted = await page.run(`document.querySelector(".gquote-draft .gquote-words").innerText`);
  check(quoted.length > 0, "the quote card carries the words");
  await say(page, "收到");
  await page.until("the sent quote card", `!!document.querySelector(".gmsg.own .gquote")`);
  check(await page.run(`document.querySelector(".gmsg.own .gquote").innerText.includes(${JSON.stringify(quoted)})`), "the sent message shows what it quotes");
  await press(page, `document.querySelector(".gmsg.own .gquote")`);
  await page.until("the quote's light", `!!document.querySelector(".gmsg.qflash")`);
  await page.shot("quote");
  await press(page, quoteButton);
  await page.until("a quote again, for its picture", `!!document.querySelector(".gquote-draft")`);
  await page.shot("quote-draft");
  await page.run(`document.querySelector(".gquote-x").click()`);
  await page.until("the quote put away", `!document.querySelector(".gquote-draft")`);

  step("who is thinking, before the answer comes");
  await say(page, "@Alice 慢慢想");
  await page.until("the thinking line", `!!document.querySelector(".gtyping") && document.querySelector(".gtyping").innerText.includes("Alice")`);
  await page.shot("typing");
  check(requests > 0, "the scripted model was asked");

  step("the group goes back to its list");
  await page.run(`document.querySelector('.ghead')?.click()`);
  await page.until("the group's settings", `!!document.querySelector(".gpanel")`);
  check(await page.run(`document.querySelector(".gpanel").innerText.includes("Alice")`), "the settings list the members");
  await page.shot("settings");

  step("a member who leaves: a line in the flow, and its old words marked");
  await page.run(`[...document.querySelectorAll(".gpanel-member")].find((r) => r.innerText.includes("Bob")).querySelector(".gpanel-remove").click()`);
  await page.until("the leaving line", `[...document.querySelectorAll(".gpage .gsys")].some((e) => e.innerText.includes("Bob 离开了群"))`);
  await page.until("Bob's old words marked", `[...document.querySelectorAll(".gpage .gmsg.gone")].some((e) => e.innerText.includes("Bob") && !!e.querySelector(".ggone"))`);
  check(!(await page.run(`[...document.querySelectorAll(".gpage .gmsg.gone")].some((e) => e.innerText.includes("Alice"))`)), "a member still here is not marked");
  await page.until("the one who left is not thinking", `!document.querySelector(".gtyping") || !document.querySelector(".gtyping").innerText.includes("-")`);
  await page.shot("left");

  step("a group's row: right-click to pin and rename, double-click to rename");
  const groupRow = `[...document.querySelectorAll(".brow.grow")].find((x) => x.querySelector(".bname")?.textContent === name || x.querySelector(".srename"))`;
  const rowMenu = async (name, pick) => {
    fs.writeFileSync(path.join(menus, "pick"), pick);
    await page.run(`((name) => ${groupRow})(${JSON.stringify(name)}).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
    await sleep(300);
    return JSON.parse(fs.readFileSync(path.join(menus, "shown.jsonl"), "utf8").trim().split("\n").at(-1));
  };
  const typeName = async (text) => {
    await page.run(`document.activeElement.select()`);
    await page.cdp("Input.insertText", { text });
    await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  };
  const shown = await rowMenu("装修群", "pin");
  const labels = JSON.stringify(shown);
  check(["置顶", "重命名", "删除群"].every((l) => labels.includes(l)), `the group's menu: ${labels}`);
  await page.until("the group pinned", `!!document.querySelector(".brow.grow .bpin")`);
  await rowMenu("装修群", "rename");
  await page.until("the name as a field", `document.activeElement?.matches(".brow.grow .srename")`);
  await typeName("新装修群");
  await page.until("renamed in the list and the title", `[...document.querySelectorAll(".brow.grow .bname")].some((e) => e.textContent === "新装修群") && document.querySelector(".ghead").innerText.includes("新装修群")`);
  await page.shot("group-menu");
  await page.run(`[...document.querySelectorAll(".brow.grow")].find((x) => x.querySelector(".bname")?.textContent === "新装修群").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
  await page.until("the name as a field, double-clicked", `document.activeElement?.matches(".brow.grow .srename")`);
  await typeName("装修群");
  await page.until("renamed back", `[...document.querySelectorAll(".brow.grow .bname")].some((e) => e.textContent === "装修群")`);

  step("a long group pages back, in the main flow and in a thread");
  // Written straight into the group's files while the app is closed: 130 messages in the main flow and a thread of 70.
  await page.close();
  await quit();
  const groupsDir = path.join(home, "groups");
  const gid = fs.readdirSync(groupsDir).find((d) => fs.existsSync(path.join(groupsDir, d, "group.json")));
  const gfile = path.join(groupsDir, gid, "group.json");
  const data = JSON.parse(fs.readFileSync(gfile, "utf8"));
  let seq = data.next_seq;
  const ts = new Date().toISOString();
  const lines = [];
  const line = (id, text, thread) => lines.push(JSON.stringify({ id, seq: seq++, ts, from: { kind: "owner" }, text, ...(thread ? { thread } : {}) }));
  for (let i = 1; i <= 130; i++) line(`seed-main-${i}`, `第 ${i} 条`);
  line("seed-root", "长话题");
  for (let i = 1; i <= 70; i++) line(`seed-reply-${i}`, `话题第 ${i} 条`, "seed-root");
  fs.appendFileSync(path.join(groupsDir, gid, "messages.jsonl"), `${lines.join("\n")}\n`);
  fs.writeFileSync(gfile, JSON.stringify({ ...data, next_seq: seq }, null, 2));
  page = await launch();
  await intoBots(page);
  await page.run(`document.querySelector(".brow.grow").click()`);
  await page.until("the long group", `${inGroup("装修群")} && !!document.querySelector(".gpage .tdiv.earlier")`);
  const mainCount = `document.querySelectorAll(".gpage .gtr > .gmsg").length`;
  const before = await page.run(mainCount);
  // The last 100 of the main flow: seed-main-32 to 130 and the thread's root (a bot may have said one more since).
  check(before >= 100, `the first page holds 100 messages: ${before}`);
  check(await page.run(`!document.querySelector('.gpage [data-mid="seed-main-31"]')`), "older messages wait for their page");
  // Scrolling to the top asks for the page before; what was in sight stays where it was.
  const seen = `document.querySelector('.gpage [data-mid="seed-main-40"]').getBoundingClientRect().top`;
  await page.run(`document.querySelector(".gpage .cscroll").style.scrollBehavior = "auto"`);
  await page.run(`document.querySelector(".gpage .cscroll").scrollTop = 1`);
  const was = await page.run(seen);
  await page.run(`document.querySelector(".gpage .cscroll").scrollTop = 0`);
  await page.until("the page before", `!!document.querySelector('.gpage [data-mid="seed-main-31"]') && !document.querySelector(".gpage .tdiv.earlier")`);
  const kept = await page.run(seen);
  // Within the height of the line that offered the page, which goes once there is nothing older.
  check(Math.abs(kept - was) < 60, `the view stays on what was in sight: ${was} → ${kept}`);
  check(await page.run(`${mainCount} > 100`), "the main flow grew by the earlier page");
  await page.shot("earlier");

  await page.run(`document.querySelector('.gpage [data-mid="seed-root"]').scrollIntoView()`);
  await press(page, `document.querySelector('.gpage [data-mid="seed-root"] .gthread-link')`);
  await page.until("the long thread", `!!document.querySelector(".gthread .gthread-earlier") && document.querySelectorAll(".gthread .gthread-scroll > .gmsg").length === 49`);
  check(await page.run(`document.querySelector(".gthread-sub").innerText.includes("70")`), "the thread's header counts every reply, loaded or not");
  await page.run(`document.querySelector(".gthread-scroll").scrollTop = 0`);
  await page.until("the thread's earlier replies", `!!document.querySelector('.gthread [data-mid="seed-reply-1"]') && !document.querySelector(".gthread .gthread-earlier")`);
  check(await page.run(`document.querySelectorAll(".gthread .gthread-scroll > .gmsg").length === 70`), "every reply is there once");
  await page.shot("thread-earlier");
  console.log("\nok");
} catch (e) {
  failed = true;
  console.error(e);
  if (page) console.error((await page.run("document.body.innerText").catch(() => "")).slice(0, 4000));
} finally {
  await quit();
  provider.close();
  if (!failed) fs.rmSync(work, { recursive: true, force: true });
  else console.error(`left in ${work}`);
}
process.exit(failed ? 1 : 0);