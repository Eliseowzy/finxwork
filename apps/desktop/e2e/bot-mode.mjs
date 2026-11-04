#!/usr/bin/env node
// Bot mode end to end, the way people use it (docs/desktop/bot-mode-design.md §11), with a real
// model: the development build (electron-vite build) against the repository's target/debug/finx in
// a temporary FINX_HOME and profile, so the person's own finxwork, settings and finx are not
// touched. Needs DEEPSEEK_API_KEY. The window shows up while it runs; a few minutes. Item 12 (a
// failed request, then 重试) is bot-failure.mjs: a real model cannot be made to fail on cue.
//
//   DEEPSEEK_API_KEY=… node apps/desktop/e2e/bot-mode.mjs
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
if (!process.env.DEEPSEEK_API_KEY) fail("set DEEPSEEK_API_KEY: this runs a real model");

// Short: the kernel's socket lives under it, and a socket path has at most 103 bytes.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxb-"));
const home = path.join(work, "finx");
const profile = path.join(work, "profile");
const socket = path.join(home, "run/finx.sock");
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(home, "config.toml"), `model = "deepseek/deepseek-flash"\npermission_mode = "manual"\n[models]\nnetwork = false\n`);

/** One request to finx over its socket, as kernel-call.mjs talks to it. */
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
async function launch() {
  const port = 9400 + Math.floor(Math.random() * 400);
  app = spawn(electron, [desktop, `--remote-debugging-port=${port}`], {
    env: { ...process.env, FINX_HOME: home, FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINX_CREDENTIAL_STORE: "file" },
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

// ── what the page shows ──
const bubbles = `[...document.querySelectorAll(".tr.bots .bm:not(.working) .bbub")].map((b) => b.innerText.trim())`;
const mine = `[...document.querySelectorAll(".tr.bots .um .bub")].map((b) => b.innerText.trim())`;
const rows = `[...document.querySelectorAll(".brow")].map((r) => ({ name: r.querySelector(".bname").textContent, line: r.querySelector(".bprev")?.textContent ?? "", unread: r.querySelector(".bbadge")?.textContent ?? "", sel: r.classList.contains("sel"), pinned: !!r.querySelector(".bpin") }))`;
const busy = `!!document.querySelector(".tr.bots .bm.working")`;
const asking = `!!document.querySelector(".cmp-zone.bot .appr")`;

/** Answers every approval the bot asks for (allow or not) until it is idle, has replied after the
 * last answer, and `done()` holds. */
async function answerAll(page, allow, done, from, ms = 180000) {
  const end = Date.now() + ms;
  let last = from;
  for (;;) {
    if (await page.run(asking)) {
      note(`${allow ? "allowed" : "not allowed"}: ${await page.run(`document.querySelector(".appr .appr-pre")?.textContent`)}`);
      last = (await page.run(bubbles)).length;
      if (allow) await page.run(`document.querySelector(".appr .btn.primary").click()`);
      else {
        // Deny opens a line for why: leave it empty.
        await page.run(`document.querySelector(".appr-f .btn").click()`);
        await page.until("the line for why", `!!document.querySelector(".appr .btn.danger")`);
        await page.run(`document.querySelector(".appr .btn.danger").click()`);
      }
      await sleep(500);
    }
    if (done() && !(await page.run(busy)) && !(await page.run(asking)) && (await page.run(bubbles)).length > last) return;
    if (Date.now() > end) fail("timed out waiting for the bot to finish after its approvals");
    await sleep(500);
  }
}

/** Types into the composer and sends, as a person does. */
async function say(page, text) {
  await page.run(`document.querySelector(".cmp-in").focus()`);
  await page.cdp("Input.insertText", { text });
  await page.until("Send enabled", `!document.querySelector("button.send")?.disabled`);
  await page.run(`document.querySelector("button.send").click()`);
}

/** Waits for the bot to have sent `count` messages in all, and to be quiet; checks no message ever changed once shown. */
async function replies(page, count, ms = 180000) {
  const seen = new Map();
  const end = Date.now() + ms;
  for (;;) {
    const now = await page.run(bubbles);
    now.forEach((text, i) => {
      // Bubbles are whole when they appear: never a growing text (no streaming).
      if (seen.has(i) && seen.get(i) !== text) fail(`a message changed while shown: ${JSON.stringify(seen.get(i))} → ${JSON.stringify(text)}`);
      seen.set(i, text);
    });
    if (now.length >= count && !(await page.run(busy))) return now;
    if (Date.now() > end) fail(`timed out waiting for ${count} messages (have ${now.length}: ${JSON.stringify(now)})`);
    await sleep(400);
  }
}

const select = (name) => `[...document.querySelectorAll(".brow")].find((r) => r.querySelector(".bname").textContent === ${JSON.stringify(name)})?.click()`;

let failed = false;
try {
  if (!process.env.FINXWORK_E2E_NO_BUILD) {
    step("building finx and the app");
    sh("cargo", ["build", "-p", "finx-cli"], { cwd: root });
    sh("pnpm", ["--dir", desktop, "build"]);
  }

  step("1. the switch: Bot mode has the default bot, FinxBot");
  let page = await launch();
  await page.until("the window", `!!document.querySelector(".seg.mode")`, 60000);
  await page.run(`document.querySelector('.seg.mode button[role=tab]:last-child').click()`);
  await page.until("FinxBot in the list", `${rows}.some((r) => r.name === "FinxBot")`, 30000);
  await page.until("its empty page", `!!document.querySelector(".bempty") || document.querySelectorAll(".tr.bots > *").length > 0`);
  check(await page.run(`document.querySelector(".bav.mark") !== null`), "FinxBot has the mark");
  // Full Access by default (e2e/bot-permission.mjs); this walk has approvals to answer.
  await page.until("the permission mode under the composer", `document.querySelector(".cmp-zone.bot .cmp-meta .lbl")?.textContent === "完全访问"`, 30000);
  await page.run(`document.querySelector(".cmp-zone.bot .cmp-meta .mb").click()`);
  await page.until("the menu", `[...document.querySelectorAll(".mi")].some((e) => e.textContent.includes("询问权限"))`);
  await page.run(`[...document.querySelectorAll(".mi")].find((e) => e.textContent.includes("询问权限")).click()`);
  await page.until("Ask Permissions", `document.querySelector(".cmp-zone.bot .cmp-meta .lbl")?.textContent === "询问权限"`);
  check((await page.run(`document.querySelectorAll(".cmp-zone.bot .cmp-meta .mb").length`)) === 1, "of a session's settings, a bot's composer has the permission mode only");
  await page.shot("01-bot-mode");

  step("4/6/7. a question: one message back, whole, nothing internal in it");
  await say(page, "你好，你是谁？用一句话回答。");
  await page.until("the busy bubble or a reply", `${busy} || ${bubbles}.length > 0`, 30000);
  await page.shot("02-busy");
  const first = await replies(page, 1);
  note(`FinxBot: ${first.at(-1).replace(/\s+/g, " ").slice(0, 80)}`);
  for (const t of first) check(!/send_to_user|end_turn|spawn_agent|call_[a-z0-9]{6}/.test(t), `a message names a tool: ${t}`);
  await page.shot("03-answer");

  step("5. four poems in a row: four messages, in order");
  const before = (await page.run(bubbles)).length;
  for (const s of ["春", "夏", "秋", "冬"]) await say(page, `写一首${s}天的四行小诗`);
  await page.until("the four messages sent", `${mine}.filter((t) => t.includes("小诗")).length === 4`, 15000);
  const poems = (await replies(page, before + 4, 240000)).slice(before);
  const order = ["春", "夏", "秋", "冬"].map((s) => poems.findIndex((p) => p.includes(s)));
  note(`${poems.length} messages; seasons at ${JSON.stringify(order)}`);
  check(poems.length >= 4, "four poems, each its own message");
  if (!order.every((v, i) => v >= 0 && (i === 0 || v >= order[i - 1]))) note("(the model answered out of order)");
  await page.shot("04-poems");

  step("15. reopened, the conversation keeps its order");
  const shownOrder = await page.run(`[...document.querySelectorAll(".tr.bots > .um, .tr.bots > .bm:not(.working)")].map((e) => e.innerText.trim().slice(0, 12))`);
  await page.cdp("Page.reload");
  await sleep(1500);
  await page.until("the page again", `document.querySelectorAll(".tr.bots > .bm").length > 0`, 30000);
  const reopenedOrder = await page.run(`[...document.querySelectorAll(".tr.bots > .um, .tr.bots > .bm:not(.working)")].map((e) => e.innerText.trim().slice(0, 12))`);
  check(JSON.stringify(shownOrder) === JSON.stringify(reopenedOrder), `the order changed on reopening:\n${JSON.stringify(shownOrder)}\n${JSON.stringify(reopenedOrder)}`);

  step("14. a message's process: hover → 过程");
  const hasProcess = await page.run(`!!document.querySelector('.bm .msg-act button[aria-label="过程"]')`);
  if (hasProcess) {
    await page.run(`document.querySelector('.bm .msg-act button[aria-label="过程"]').click()`);
    await page.until("the steps under it", `!!document.querySelector(".bproc .bproc-h")`);
    note(await page.run(`document.querySelector(".bproc .bproc-h").textContent`));
    await page.shot("05-process");
    await page.run(`document.querySelector('.bm .msg-act button[aria-label="过程"]').click()`);
  } else note("(no message with steps yet)");

  step("8/9. two things for helpers, a quick question meanwhile");
  // Work a helper can finish by itself: in manual mode a helper's commands are refused, not asked
  // (subagent-design D-43); the approval the bot itself asks for is step 11.
  const n0 = (await page.run(bubbles)).length;
  await say(page, "请交给两个后台帮手分别去做，做完分别告诉我：一个写一首关于秋天的十四行诗；一个把《静夜思》翻译成英文。");
  await sleep(2500);
  await say(page, "顺便问一下，1 公里是多少英里？");
  const isQuick = (t) => /0\.62/.test(t);
  const isSonnet = (t) => /秋|autumn/i.test(t) && t.length > 120;
  const isTranslation = (t) => /moon/i.test(t);
  let sawHelper = false, sawTwo = false, quiet = 0;
  const end = Date.now() + 300000;
  for (;;) {
    if (await page.run(asking)) {
      note(`allowed: ${await page.run(`document.querySelector(".appr .appr-pre")?.textContent`)}`);
      await page.run(`document.querySelector(".appr .btn.primary").click()`);
    }
    const label = await page.run(`document.querySelector(".tr.bots .bm.working .wb-t")?.textContent ?? ""`);
    if (label && (!sawHelper || (!sawTwo && label.includes("两件事")))) {
      sawHelper = true;
      sawTwo ||= label.includes("两件事");
      note(`busy bubble: ${label}`);
      await page.run(`document.querySelector(".tr.bots .bm.working button.wb-h")?.click()`);
      await sleep(800);
      await page.shot(sawTwo ? "06-helpers" : "06-helper");
      note(`its row says: ${await page.run(`${rows}.find((r) => r.sel)?.line`)}`);
    }
    // Until all three came: between a helper's end and the bot's relay, nothing shows as busy.
    const sofar = (await page.run(bubbles)).slice(n0);
    const done = sofar.some(isQuick) && sofar.some(isSonnet) && sofar.some(isTranslation) && !(await page.run(busy)) && !(await page.run(asking));
    quiet = done ? quiet + 1 : 0;
    if (quiet >= 6) break;
    if (Date.now() > end) fail(`timed out waiting for the helpers' work and the quick answer: ${JSON.stringify(sofar.map((t) => t.slice(0, 40)))}`);
    await sleep(500);
  }
  const mixed = (await page.run(bubbles)).slice(n0);
  for (const t of mixed) note(`→ ${t.replace(/\s+/g, " ").slice(0, 90)}`);
  check(sawHelper, "the work went to helpers");
  if (!sawTwo) note("(never two helpers at once)");
  await page.shot("07-mixed");

  step("10. 'no need any more': the helper stops, the bot says so");
  await say(page, "请交给后台帮手去做：写一篇 3000 字左右的短篇小说，主题是秋天的银杏，写完告诉我。");
  // It may ask first (say, to look at its folder): allowed.
  for (const until10 = Date.now() + 120000; !(await page.run(`(document.querySelector(".tr.bots .bm.working .wb-t")?.textContent ?? "") !== ""`)); await sleep(300)) {
    if (await page.run(asking)) await page.run(`document.querySelector(".appr .btn.primary").click()`);
    if (Date.now() > until10) fail("timed out waiting for a helper at work");
  }
  note(`busy bubble: ${await page.run(`document.querySelector(".tr.bots .bm.working .wb-t")?.textContent`)}`);
  await sleep(1500);
  const asked10 = (await page.run(bubbles)).length;
  await say(page, "那篇小说不用写了，停下吧。");
  // It may look at its folder first, which asks: allowed.
  await answerAll(page, true, () => true, asked10);
  const after10 = (await page.run(bubbles)).slice(asked10);
  for (const t of after10) note(`→ ${t.replace(/\s+/g, " ").slice(0, 90)}`);
  check(after10.every((t) => t.length < 1500), "no story came after it was called off");
  await page.shot("07b-stopped");

  step("11. an approval: the prompt above the composer, none in the conversation; allowed, the work goes on");
  const hello = () => fs.readdirSync(path.join(home, "bots")).map((id) => path.join(home, "bots", id, "files", "hello.txt")).find((f) => fs.existsSync(f));
  const n1 = (await page.run(bubbles)).length;
  await say(page, "在你的文件夹里新建 hello.txt，内容写 hi。");
  await page.until("the approval", asking, 120000);
  check(!(await page.run(`!!document.querySelector(".tr.bots .appr")`)), "the conversation has no approval in it");
  const rowWaiting = await page.until("the row's [待确认]", `${rows}.find((r) => r.sel)?.line.includes("[待确认]") && ${rows}.find((r) => r.sel)?.line`);
  note(`row: ${rowWaiting}`);
  await page.shot("08-approval");
  // It may ask more than once (look first, then write): allow each, until it is done.
  await answerAll(page, true, () => !!hello(), n1);
  check(fs.readFileSync(hello(), "utf8").trim() === "hi", "hello.txt says hi");
  check(!(await page.run(`${rows}.find((r) => r.sel)?.line.includes("[待确认]")`)), "the row's [待确认] is gone");
  await page.shot("09-allowed");

  step("11. not allowed: the bot says so, nothing happens");
  const n1b = (await page.run(bubbles)).length;
  await say(page, "把你文件夹里的 hello.txt 删掉。");
  await page.until("the approval", asking, 120000);
  await answerAll(page, false, () => true, n1b);
  note(`it says: ${(await page.run(bubbles)).at(-1).replace(/\s+/g, " ").slice(0, 80)}`);
  check(!!hello(), "hello.txt is still there");
  check(!(await page.run(`${rows}.find((r) => r.sel)?.line.includes("[待确认]")`)), "the row's [待确认] is gone");
  await page.shot("09b-denied");

  step("3. a new bot: a name and ↩");
  await page.run(`[...document.querySelectorAll(".side-nav .nav-i")][0].click()`);
  await page.until("the form", `!!document.querySelector("dialog.bsheet[open] input.field")`);
  await page.cdp("Input.insertText", { text: "研究员" });
  await page.run(`document.querySelector("dialog.bsheet form").requestSubmit()`);
  await page.until("研究员 selected", `${rows}.find((r) => r.sel)?.name === "研究员"`);
  check(await page.run(`!!document.querySelector(".bempty")`), "a new bot opens on its empty page");
  await page.shot("10-new-bot");

  step("2/13. unread: a reply while looking at another bot");
  await say(page, "用一句话介绍你自己。");
  await page.run(select("FinxBot"));
  // One reply or a few: the count is what came.
  await page.until("研究员 unread", `Number(${rows}.find((r) => r.name === "研究员")?.unread || 0) >= 1`, 120000);
  check((await page.run(rows))[0].name === "研究员", "the row with the new reply moved to the top");
  await page.shot("11-unread");
  await page.run(select("研究员"));
  await page.until("read once opened", `${rows}.find((r) => r.name === "研究员")?.unread === ""`);

  step("16. a new name: the bot goes by it from its next reply");
  await page.run(`[...document.querySelectorAll(".brow")].find((x) => x.querySelector(".bname").textContent === "研究员").querySelector(".rowact").click()`);
  await page.until("the row's menu", `!!document.querySelector(".vmenu")`);
  await page.run(`[...document.querySelectorAll(".vmenu .mi")].find((b) => b.textContent === "重命名").click()`);
  await page.until("the name as a field", `document.activeElement?.matches(".brow .srename")`);
  await page.cdp("Input.insertText", { text: "小研" });
  await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.until("renamed in the list and the title", `${rows}.some((r) => r.name === "小研") && document.querySelector(".bhead h2").textContent === "小研"`);
  const n2 = (await page.run(bubbles)).length;
  await say(page, "你现在叫什么名字？只回答名字。");
  const named = (await replies(page, n2 + 1, 120000)).at(-1);
  note(`it says: ${named}`);
  check(named.includes("小研"), "the bot goes by its new name");

  step("16. a picture as its avatar: the list and the page show it");
  // What the form sends once the picker cropped one: a square PNG (the native dialog itself is not driven).
  const xiaoyan = (await finxCall("bots/subscribe")).result.bots.find((b) => b.name === "小研");
  const png = fs.readFileSync(path.join(root, "assets/brand/app/finxwork-mark-on-light-256.png")).toString("base64");
  const updated = await finxCall("bots/update", { bot_id: xiaoyan.id, avatar: { kind: "image", png } });
  check(!updated.error, `bots/update: ${updated.error?.message}`);
  await page.until(
    "the picture in its row and its page",
    `(() => { const r = [...document.querySelectorAll(".brow")].find((x) => x.querySelector(".bname").textContent === "小研"); return !!r?.querySelector(".bav.pic img[src^='data:image/png']") && !!document.querySelector(".bhead .bav.pic img[src^='data:image/png']"); })()`,
  );
  await page.shot("11b-picture");

  step("pin, delete");
  await page.run(`(() => { const r = [...document.querySelectorAll(".brow")].find((x) => x.querySelector(".bname").textContent === "小研"); r.querySelector(".rowact").click(); })()`);
  await page.until("the menu", `!!document.querySelector(".vmenu")`);
  await page.run(`[...document.querySelectorAll(".vmenu .mi")].find((b) => b.textContent === "置顶").click()`);
  await page.until("pinned first", `${rows}[0].name === "小研" && ${rows}[0].pinned`);
  await page.run(`document.querySelector(".ctool .tb[aria-haspopup=menu]").click()`);
  await page.until("the page's menu", `!!document.querySelector(".vmenu")`);
  await page.run(`[...document.querySelectorAll(".vmenu .mi")].find((b) => b.textContent.startsWith("删除 Bot")).click()`);
  await page.until("the confirmation", `!!document.querySelector("dialog.sheet[open] .btn.danger")`);
  await page.run(`document.querySelector("dialog.sheet[open] .btn.danger").click()`);
  await page.until("gone from the list", `!${rows}.some((r) => r.name === "小研")`, 30000);
  await page.run(`[...document.querySelectorAll(".brow")].find((x) => x.querySelector(".bname").textContent === "FinxBot").querySelector(".rowact").click()`);
  await page.until("FinxBot's menu", `!!document.querySelector(".vmenu")`);
  const deleteDefault = await page.run(`[...document.querySelectorAll(".vmenu .mi")].find((b) => b.textContent.startsWith("删除 Bot"))?.disabled`);
  check(deleteDefault === true, "the default bot cannot be deleted");
  await page.run(`document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))`);

  step("13. the app quits while the bot works: the answer is there when it comes back");
  await page.run(select("FinxBot"));
  await sleep(500);
  // Text alone: in manual mode a file or a command would wait for an approval nobody can give while the app is closed.
  await say(page, "直接在对话里写一段 200 字左右的短文，讲讲秋天的银杏，不用存文件。");
  await page.until("it has the message", `${mine}.some((t) => t.includes("银杏"))`);
  page.close();
  await quit();
  note("the app is closed; finx goes on");
  let seen = null;
  for (let i = 0; i < 120; i++) {
    const r = await finxCall("bots/subscribe").catch(() => null);
    seen = r?.result?.bots?.find((b) => b.name === "FinxBot") ?? seen;
    if (seen && !seen.typing && seen.last?.from === "bot" && seen.last.text.includes("银杏")) break;
    await sleep(1000);
  }
  check((seen?.unread ?? 0) >= 1, "what came while the app was closed is unread");
  page = await launch();
  await page.until("the window", `!!document.querySelector(".seg.mode")`, 60000);
  await page.until("Bot mode, FinxBot", `${rows}.some((r) => r.name === "FinxBot")`, 30000);
  // Should it have asked after all, the prompt is there: allowed, the work goes on.
  await answerAll(page, true, () => true, 0, 120000);
  check((await page.run(bubbles)).some((t) => t.includes("银杏") && t.length > 100), "the answer is in the conversation");
  note(`it wrote: ${(await page.run(bubbles)).at(-1).replace(/\s+/g, " ").slice(0, 60)}…`);
  await page.shot("13-after-restart");

  step("17. both themes");
  await page.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await sleep(500);
  await page.shot("14-light");
  await page.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await sleep(500);
  await page.shot("15-dark");

  step("17. reduced motion: the busy dots, avatar and row stand still");
  await page.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }, { name: "prefers-reduced-motion", value: "reduce" }] });
  const n17 = (await page.run(bubbles)).length;
  await say(page, "用一句话说说秋天适合做什么。");
  await page.until("the busy bubble", busy, 30000);
  const moving = await page.run(
    `[...document.querySelectorAll(".tr.bots .bm.working .dots i, .bav.busy .eyes, .bav.busy.mark > img, .bav.busy .ch, .brow .shimmer")].map((e) => getComputedStyle(e).animationName).filter((n) => n !== "none")`,
  );
  check(moving.length === 0, `something moves with reduced motion: ${moving.join(", ")}`);
  await page.shot("16-reduced-motion");
  await replies(page, n17 + 1, 120000);
  await page.cdp("Emulation.setEmulatedMedia", { features: [] });

  step("2. back in session mode: the switch remembers both sides, and the draft");
  await page.run(`document.querySelector(".cmp-in").focus()`);
  await page.cdp("Input.insertText", { text: "还没发的草稿" });
  await page.run(`document.querySelector('.seg.mode button[role=tab]').click()`);
  await page.until("session mode", `!!document.querySelector(".side-nav .nav-i") && document.querySelector(".side-nav .nav-i span").textContent === "新会话"`);
  await page.run(`document.querySelector('.seg.mode button[role=tab]:last-child').click()`);
  await page.until("back to FinxBot", `${rows}.find((r) => r.sel)?.name === "FinxBot"`);
  await page.until("the draft still there", `document.querySelector(".cmp-in")?.innerText.includes("还没发的草稿")`);
  page.close();
  console.log("\n✔ Bot mode works end to end with a real model");
} catch (e) {
  failed = true;
  console.error(`\n✘ ${e.message}`);
} finally {
  await quit();
  await finxCall("server/shutdown", {}).catch(() => {});
  if (!failed) fs.rmSync(work, { recursive: true, force: true });
  else console.error(`  kept ${work} (finx's log is in finx/logs)`);
}
process.exit(failed ? 1 : 0);
