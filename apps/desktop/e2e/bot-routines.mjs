#!/usr/bin/env node
// A bot's routines in the real app (bot-mode-design §6.21, routine-design §9): made in the chat,
// a line there that opens the panel; the list, a routine and one run; on and off, run now, stop,
// delete; a sentence in the composer to change one; a real run at its time, whose bubble knows it.
// A model server on the Mac stands in for the provider.
//
//   node apps/desktop/e2e/bot-routines.mjs
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
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`;
const call = (name, args) => ({ role: "assistant", tool_calls: [{ index: 0, id: `call_${Date.now()}_${Math.random()}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const send = (text) => call("send_to_user", { text, end_turn: true });
const say = (text) => ({ role: "assistant", content: text });
const textOf = (m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((c) => c.text ?? "").join(""));

// What it answers: the owner's "建任务 名字|时间|说明" makes a routine; a routine's brief does what its
// instructions say ("说：" a report, "静：" nothing to report, "慢" takes a while); a report is passed on.
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    if (!req.url?.endsWith("/chat/completions")) return res.writeHead(404).end();
    const { messages } = JSON.parse(body);
    // Not what the kernel adds: the model is kept up to date, and each of the owner's messages is followed by a word.
    const added = (m) => /^<(environment_update|reminder)>/.test(textOf(m));
    const users = messages.filter((m) => m.role === "user" && !added(m));
    const last = users.at(-1);
    const said = last ? textOf(last) : "";
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (said.startsWith("You are carrying out a routine")) {
      const asked = /<instructions>\n([\s\S]*?)\n<\/instructions>/.exec(said)?.[1] ?? "";
      if (asked.startsWith("慢")) {
        await sleep(20000);
        return res.end(sse(say("慢慢做完了。"), "stop"));
      }
      // A step to show, before it says what it has to say.
      if (asked.startsWith("说：") && messages.at(-1).role === "user") return res.end(sse(call("bash", { command: "echo checked" }), "tool_calls"));
      const answer = asked.startsWith("静：") ? `NOTHING_TO_REPORT ${asked.slice(2)}` : asked.replace(/^说：/, "");
      return res.end(sse(say(answer), "stop"));
    }
    // The list of routines the kernel adds may come after the tool's result.
    const latest = messages.filter((m) => !added(m)).at(-1);
    if (latest.role === "tool") return res.end(sse(send("记好了。"), "tool_calls"));
    const report = /<routine_report[^>]*>\n([\s\S]*?)\n<\/routine_report>/.exec(said)?.[1];
    if (report) return res.end(sse(send(`转告：${report}`), "tool_calls"));
    const made = /^建任务 (.+?)\|(.+?)\|(.+)$/.exec(said.trim());
    if (made) {
      const [, name, schedule, prompt] = made;
      return res.end(sse(call("manage_routine", { action: "create", name, schedule, prompt, when: schedule.startsWith("in ") ? "一会儿" : "每天早上 8 点" }), "tool_calls"));
    }
    res.end(sse(send(`收到：${said.slice(0, 40)}`), "tool_calls"));
  });
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));

const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxr-"));
const home = path.join(work, "finx");
const userHome = path.join(work, "home");
fs.mkdirSync(userHome);
const profile = path.join(work, "profile");
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(
  path.join(home, "models.toml"),
  `[providers.mock]\nname = "Mock"\napi = "openai-chat"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nauth = "none"\ncompat = { thinking_format = "openai" }\n\n[[providers.mock.models]]\nid = "mock-1"\nname = "Mock One"\ncontext_window = 128000\nmax_output_tokens = 2000\n`,
);
fs.writeFileSync(path.join(home, "config.toml"), `model = "mock/mock-1"\n[models]\nnetwork = false\n`);

function finxCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(path.join(home, "run/finx.sock"));
    let buf = "";
    const write = (id, m, p) => s.write(JSON.stringify({ jsonrpc: "2.0", id, method: m, params: p }) + "\n");
    s.on("connect", () => write(1, "initialize", { protocol_version: 2, client_info: { name: "e2e" } }));
    s.on("data", (c) => {
      buf += c;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (msg.id === 1) write(2, method, params);
        if (msg.id === 2) {
          s.end();
          resolve(msg);
        }
      }
    });
    s.on("error", reject);
  });
}

let app = null;
const port = 9400 + Math.floor(Math.random() * 400);

/** Drives a page of the app over the DevTools protocol. */
async function attach(target) {
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
  return { cdp, run, until, shot, close: () => ws.close() };
}

/** The app's page whose address `want` accepts, once it is there. */
async function pageOf(want, what) {
  let target;
  for (let i = 0; i < 150 && !target; i++) {
    await sleep(200);
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => []);
    target = list.find((t) => t.type === "page" && want(t.url));
  }
  check(target, `${what} never showed up`);
  return attach(target);
}

async function launch() {
  app = spawn(electron, [desktop, `--remote-debugging-port=${port}`], {
    env: { ...process.env, FINX_HOME: home, HOME: userHome, FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINX_CREDENTIAL_STORE: "file" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const page = await pageOf((u) => !u.includes("#settings") && !u.startsWith("devtools"), "the main window");
  await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 0, mobile: false });
  return page;
}

async function quit() {
  if (!app || app.exitCode !== null) return;
  const exited = new Promise((r) => app.once("exit", r));
  app.kill("SIGTERM");
  await exited;
}

/** A click with the mouse, where the element is on screen: what is over it gets it. */
async function press(page, selector) {
  await page.run(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "center" })`);
  const at = await page.run(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
  await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", clickCount: 1 });
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", clickCount: 1 });
}

async function tell(page, text) {
  await page.run(`document.querySelector(".cmp-in").focus()`);
  await sleep(100);
  await page.cdp("Input.insertText", { text });
  await page.until("Send enabled", `!document.querySelector("button.send")?.disabled`);
  await page.run(`document.querySelector("button.send").click()`);
}

const bubbles = `[...document.querySelectorAll(".tr.bots .bm:not(.working) .bbub")]`;
const panel = `document.querySelector(".bgp.rtn")`;
const title = `${panel}?.querySelector(".rtn-tt")?.textContent`;
const button = (text) => `[...${panel}.querySelectorAll("button")].find((b) => b.textContent.includes(${JSON.stringify(text)}))`;
const clickIn = (text) => `${button(text)}.click()`;
const openRoutine = (name) => `[...document.querySelectorAll(".rtn-row")].find((r) => r.textContent.includes(${JSON.stringify(name)})).click()`;

let failed = false;
try {
  if (!process.env.FINXWORK_E2E_NO_BUILD) {
    step("building finx and the app");
    sh("cargo", ["build", "-p", "finx-cli"], { cwd: root });
    sh("pnpm", ["--dir", desktop, "build"]);
  }
  const page = await launch();
  await page.until("the window", `!!document.querySelector(".seg.mode")`, 60000);
  await page.run(`document.querySelector('.seg.mode [data-mode=bots]').click()`);
  await page.until("FinxBot's page", `document.querySelector(".bhead-n")?.textContent === "FinxBot" && !!document.querySelector(".cmp-in")`, 60000);

  step("the clock opens the panel, empty for now, and closes it");
  check(await page.run(`!document.querySelector(".rtn-dot")`), "no dot without routines");
  check(!fs.existsSync(path.join(home, "finx.db")), "no database before the first routine");
  await press(page, ".rtn-btn");
  await page.until("the panel", `!!${panel}`);
  check((await page.run(`${panel}.querySelector(".rtn-empty").textContent`)).includes("FinxBot"), "the empty panel names the bot");
  await page.shot("r1-empty");
  await press(page, ".rtn-btn");
  await page.until("the panel to close", `!${panel}`);

  step("a routine said in the chat: a line, which opens it");
  await tell(page, "建任务 喝水提醒|0 8 * * *|说：该喝水了。");
  await page.until("the line in the chat", `document.querySelector(".tr.bots .rtn-line")?.textContent.includes("已创建定时任务「喝水提醒」")`);
  await page.until("the bot's answer", `${bubbles}.at(-1)?.innerText.includes("记好了")`);
  check(fs.existsSync(path.join(home, "finx.db")), "the first routine makes the database");
  await page.shot("r2-line");
  await press(page, ".tr.bots .rtn-line");
  await page.until("the routine in the panel", `${title} === "喝水提醒"`);
  await page.until("its saved text", `${panel}.querySelector(".rtn-prompt")?.textContent === "说：该喝水了。"`);
  const upcoming = await page.until("its next runs", `[...${panel}.querySelectorAll(".frow")].find((r) => r.textContent.startsWith("接下来"))?.textContent`);
  check(upcoming.includes("08:00"), `next runs: ${upcoming}`);
  await page.shot("r3-routine");

  step("run now: it runs, the bot passes it on, and the bubble and the record know each other");
  await page.run(clickIn("立即运行"));
  await page.until("the bot's message", `${bubbles}.at(-1)?.innerText.includes("转告：该喝水了。")`);
  await page.until("the record", `[...${panel}.querySelectorAll(".rtn-runrow")].some((r) => r.textContent.includes("发给你了"))`);
  check(await page.run(`!document.querySelector(".tr.bots .wbub")`), "no busy bubble is left");
  await page.shot("r4-delivered");
  const fromBubble = `document.querySelector(".tr.bots .bm[data-run] .tb[aria-label*='喝水提醒']")`;
  check(await page.run(`!!${fromBubble}`), "the message has the clock");

  step("one run: result and steps; back to the message");
  await page.run(`${panel}.querySelector(".rtn-runrow").click()`);
  await page.until("the run", `${title} === "一次运行"`);
  await page.until("its report", `[...${panel}.querySelectorAll(".fhead")].some((h) => h.textContent === "汇报") && ${panel}.querySelector(".rtn-prompt.md")?.textContent.includes("该喝水了")`);
  await page.until("its steps", `[...${panel}.querySelectorAll(".fhead")].some((h) => h.textContent === "过程")`);
  await page.shot("r5-run");
  check(!(await page.run(`${panel}.textContent.includes("You are carrying out")`)), "the brief is not shown");
  await page.run(clickIn("在对话里看"));
  await page.until("the message standing out", `!!document.querySelector(".tr.bots .bm.rtn-flash")`);
  // Into the panel from the message's clock too.
  await press(page, `.bgp.rtn .rtn-top .tb[aria-label="返回"]`);
  await page.until("back at the routine", `${title} === "喝水提醒"`);
  await press(page, `.bgp.rtn .rtn-top .tb[aria-label="关闭"]`);
  await page.until("the panel to close", `!${panel}`);
  await page.run(`${fromBubble}.click()`);
  await page.until("the run from its message", `${title} === "一次运行"`);
  await press(page, `.bgp.rtn .rtn-top .tb[aria-label="返回"]`);
  await page.until("back at the routine", `${title} === "喝水提醒"`);
  await press(page, `.bgp.rtn .rtn-top .tb[aria-label="返回"]`);
  await page.until("the list", `${title} === "定时任务"`);

  step("a run under way shows on the clock and the row; it can be stopped, and says nothing");
  const chatBefore = await page.run(`${bubbles}.length`);
  await tell(page, "建任务 慢任务|0 9 * * *|慢");
  await page.until("the bot's answer", `${bubbles}.length > ${chatBefore}`);
  await page.run(openRoutine("慢任务"));
  await page.until("that routine", `${title} === "慢任务"`);
  const said = await page.run(`${bubbles}.length`);
  await page.run(clickIn("立即运行"));
  await page.until("the clock's blue dot", `!!document.querySelector(".rtn-btn .rtn-dot.run")`);
  await page.until("Stop in place of Run now", `!!${button("停止")}`);
  check(await page.run(`!document.querySelector(".tr.bots .wbub")`), "a run is no work of the bot's: no busy bubble");
  await page.shot("r6-running");
  await page.run(clickIn("停止"));
  await page.until("the record", `[...${panel}.querySelectorAll(".rtn-runrow")].some((r) => r.textContent.includes("已停止"))`);
  check(await page.run(`!document.querySelector(".rtn-btn .rtn-dot")`), "the dot goes with it");
  check((await page.run(`${bubbles}.length`)) === said, "a stopped run says nothing");

  step("nothing to report: the chat stays as it was, and the record says what it checked");
  await press(page, `.bgp.rtn .rtn-top .tb[aria-label="返回"]`);
  await page.until("the list", `${title} === "定时任务"`);
  const before = await page.run(`${bubbles}.length`);
  await tell(page, "建任务 查价格|0 10 * * *|静：还是 412。");
  await page.until("the bot's answer", `${bubbles}.length > ${before}`);
  await page.run(openRoutine("查价格"));
  await page.until("that routine", `${title} === "查价格"`);
  const quietBefore = await page.run(`${bubbles}.length`);
  await page.run(clickIn("立即运行"));
  await page.until("the quiet record", `[...${panel}.querySelectorAll(".rtn-runrow")].some((r) => r.textContent.includes("没有要说的") && r.textContent.includes("还是 412。"))`);
  await sleep(500);
  check((await page.run(`${bubbles}.length`)) === quietBefore, "no message");
  await page.shot("r7-quiet");

  step("off and on, right there; the list groups them");
  await press(page, `.bgp.rtn .rtn-top .tb[aria-label="返回"]`);
  await page.until("the list", `${title} === "定时任务"`);
  await page.run(`[...document.querySelectorAll(".rtn-row")].find((r) => r.textContent.includes("喝水提醒")).querySelector(".sw").click()`);
  await page.until("paused", `[...${panel}.querySelectorAll("section")].some((s) => s.textContent.startsWith("已暂停") && s.textContent.includes("喝水提醒"))`);
  await page.shot("r8-list");
  await page.run(`[...document.querySelectorAll(".rtn-row")].find((r) => r.textContent.includes("喝水提醒")).querySelector(".sw").click()`);
  await page.until("back on", `![...${panel}.querySelectorAll("section")].some((s) => s.textContent.startsWith("已暂停"))`);

  step("changing one goes through the chat: the sentence is ready to finish");
  await page.run(openRoutine("喝水提醒"));
  await page.until("that routine", `${title} === "喝水提醒"`);
  await page.run(clickIn("在对话里修改"));
  await page.until("the panel to close", `!${panel}`);
  await page.until("the sentence", `document.querySelector(".cmp-in").textContent.includes("把定时任务「喝水提醒」改成：")`);
  check(await page.run(`document.activeElement === document.querySelector(".cmp-in")`), "ready to type");
  await page.cdp("Input.insertText", { text: "每天 9 点" });
  await page.until("what was typed goes at the end", `document.querySelector(".cmp-in").textContent.endsWith("改成：每天 9 点")`);
  await page.run(`document.querySelector("button.send").click()`);
  await page.until("the bot's answer", `${bubbles}.at(-1)?.innerText.includes("收到：把定时任务")`);

  step("one place beside the conversation: the file panel puts the routines away");
  await press(page, ".rtn-btn");
  await page.until("the panel", `!!${panel}`);
  const filesButton = await page.run(`!!document.querySelector(".ctool .tb[aria-label='文件']")`);
  if (filesButton) {
    await press(page, ".ctool .tb[aria-label='文件']");
    await page.until("the routines to go", `!${panel}`);
  }

  step("deleted from the panel: gone from the list and from what the model knows");
  if (filesButton) await page.run(`document.querySelector(".ctool .tb[aria-label='文件']")?.click()`);
  if (!(await page.run(`!!${panel}`))) await press(page, ".rtn-btn");
  await page.until("the list", `${title} === "定时任务"`);
  await page.run(openRoutine("查价格"));
  await page.until("that routine", `${title} === "查价格"`);
  await page.run(clickIn("删除"));
  await page.until("the question", `!!document.querySelector(".sheet, [role=dialog], [role=alertdialog]")`);
  await page.shot("r9-delete");
  await page.run(`[...document.querySelectorAll(".sheet button, [role=dialog] button, [role=alertdialog] button")].find((b) => b.textContent.trim() === "删除").click()`);
  await page.until("the list without it", `${title} === "定时任务" && ![...${panel}.querySelectorAll(".rtn-row")].some((r) => r.textContent.includes("查价格"))`);

  step("at its time, with nobody asking: a one-off runs, the bot says so, and it is over");
  const asked = await page.run(`${bubbles}.length`);
  await tell(page, "建任务 一会儿|in 3s|说：时间到了。");
  await page.until("the message at its time", `${bubbles}.at(-1)?.innerText.includes("转告：时间到了。")`, 60000);
  check((await page.run(`${bubbles}.length`)) >= asked + 2, "its answer, then the run's message");
  await page.until("finished in the list", `[...${panel}.querySelectorAll("section")].some((s) => s.textContent.startsWith("已结束") && s.textContent.includes("一会儿"))`);
  await page.shot("r10-finished");

  step("the settings: at login, and keeping the Mac awake");
  await page.run(`window.finx.openSettings()`);
  const settings = await pageOf((u) => u.includes("#settings"), "the settings window");
  const row = (text) => `[...document.querySelectorAll(".frow")].find((r) => r.textContent.includes(${JSON.stringify(text)}))`;
  await settings.until("the rows", `!!${row("保持唤醒")} && !!${row("登录时启动")}`);
  check(await settings.run(`${row("登录时启动")}.querySelector(".sw").getAttribute("aria-checked") === "true"`), "at login is on until the person says no");
  check(await settings.run(`${row("保持唤醒")}.querySelector(".sw").getAttribute("aria-checked") === "false"`), "keeping awake is off until asked");
  await settings.run(`${row("保持唤醒")}.querySelector(".sw").click()`);
  await settings.until("it on", `${row("保持唤醒")}.querySelector(".sw").getAttribute("aria-checked") === "true"`);
  await settings.run(`${row("登录时启动")}.querySelector(".sw").click()`);
  await settings.until("it off", `${row("登录时启动")}.querySelector(".sw").getAttribute("aria-checked") === "false"`);
  await settings.shot("r11-settings");
  const kept = JSON.parse(fs.readFileSync(path.join(profile, "preferences.json"), "utf8"));
  check(kept.routinesKeepAwake === true && kept.routinesAtLogin === false, `what was kept: ${JSON.stringify(kept)}`);
  settings.close();

  step("what the service keeps");
  const listed = await finxCall("bots/subscribe");
  const bot = listed.result.bots.find((b) => b.name === "FinxBot");
  const names = bot.routines.map((r) => `${r.name}:${r.state}`);
  console.log(`  · ${names.join(", ")}`);
  check(names.includes("喝水提醒:active") && names.includes("一会儿:finished") && names.includes("慢任务:active"), `routines: ${names}`);
  check(!names.some((n) => n.startsWith("查价格")), "the deleted one is gone");
  const mode = (fs.statSync(path.join(home, "finx.db")).mode & 0o777).toString(8);
  check(mode === "600", `finx.db's mode: ${mode}`);

  page.close();
  console.log("\n✔ a bot's routines work end to end");
} catch (e) {
  failed = true;
  console.error(`\n✘ ${e.message}`);
} finally {
  await quit();
  await finxCall("server/shutdown").catch(() => {});
  provider.close();
  if (!failed) fs.rmSync(work, { recursive: true, force: true });
  else console.error(`  kept ${work}`);
}
process.exit(failed ? 1 : 0);
