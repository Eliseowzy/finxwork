#!/usr/bin/env node
// System notifications (notification-design §5.7). A system notification cannot be read back and an
// unsigned build shows none, so what would happen is recorded (FINXWORK_E2E_NOTIFIED) and a click is
// asked for through the file beside it; with that, the app counts as not in front. Showing, clicking
// and taking down real ones is for a signed build, by hand. A model server on the Mac stands in for
// the provider.
//
// Runs the development build against the repository's target/debug/finx, in a HOME, FINX_HOME and
// profile of its own. Takes about a minute once built.
//
//   node apps/desktop/e2e/notifications.mjs
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

// The provider: what a message says decides what comes back.
const sse = (delta, finish) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\ndata: [DONE]\n\n`;
const call = (name, args) => ({ role: "assistant", tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (!req.url?.endsWith("/chat/completions")) return res.writeHead(404).end();
    const { messages, tools } = JSON.parse(body);
    const isBot = tools?.some((t) => t.function?.name === "send_to_user");
    const last = messages.at(-1);
    const answer = (text) => res.end(isBot ? sse(call("send_to_user", { text, end_turn: true }), "tool_calls") : sse({ role: "assistant", content: text }, "stop"));
    const said = typeof last.content === "string" ? last.content : (last.content ?? []).map((c) => c.text ?? "").join("");
    if (last.role !== "tool" && said.includes("请失败")) return res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "mock: refused" } }));
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (last.role === "tool") return answer("好了");
    if (said.includes("请确认")) return res.end(sse(call("bash", { command: "touch asked.txt" }), "tool_calls"));
    answer(`## ${said.match(/回一句 (\S+)/)?.[1] ?? "嗯"}\n后面的正文不进通知`);
  });
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));

// Short: the kernel's socket lives under it, and a socket path has at most 103 bytes.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxn-"));
const home = path.join(work, "finx");
const profile = path.join(work, "profile");
const notified = path.join(work, "notified.jsonl");
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(
  path.join(home, "models.toml"),
  `[providers.mock]\nname = "Mock"\napi = "openai-chat"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nauth = "none"\n\n[[providers.mock.models]]\nid = "mock-1"\nname = "Mock One"\ncontext_window = 128000\nmax_output_tokens = 2000\n`,
);
fs.writeFileSync(path.join(home, "config.toml"), `model = "mock/mock-1"\npermission_mode = "manual"\n[models]\nnetwork = false\n`);

// ── what was recorded ──
const records = () => (fs.existsSync(notified) ? fs.readFileSync(notified, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const shown = () => records().filter((r) => r.id);
const badge = () => records().filter((r) => "badge" in r).at(-1)?.badge ?? 0;
async function untilRecord(what, test, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const hit = records().find(test);
    if (hit) return hit;
    if (Date.now() > end) fail(`timed out waiting for ${what}; recorded: ${JSON.stringify(records())}`);
    await sleep(100);
  }
}
async function untilBadge(n, ms = 10000) {
  const end = Date.now() + ms;
  while (badge() !== n) {
    if (Date.now() > end) fail(`the icon's number stayed ${badge()}, not ${n}`);
    await sleep(100);
  }
}
let clicks = 0;
/** A click on a notification of this group. */
const click = (group) => fs.writeFileSync(`${notified}.click`, `${group}\n${++clicks}\n`);

/** Requests to finx on one connection of its own, one after another; the last one's answer. */
function finxCalls(...calls) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(path.join(home, "run/finx.sock"));
    let buf = "";
    const send = (id, m, p) => s.write(JSON.stringify({ jsonrpc: "2.0", id, method: m, params: p }) + "\n");
    s.on("connect", () => send(0, "initialize", { protocol_version: 2, client_info: { name: "e2e" } }));
    s.on("data", (c) => {
      buf += c;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (msg.id === undefined) continue;
        if (msg.error) return reject(new Error(msg.error.message));
        if (msg.id < calls.length) send(msg.id + 1, calls[msg.id][0], calls[msg.id][1] ?? {});
        else {
          s.end();
          resolve(msg.result);
        }
      }
    });
    s.on("error", reject);
  });
}

// ── the app, driven over the DevTools protocol ──
let app = null;
const port = 9400 + Math.floor(Math.random() * 400);
function launch() {
  app = spawn(electron, [desktop, `--remote-debugging-port=${port}`], {
    env: { ...process.env, HOME: work, FINX_HOME: home, FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINX_CREDENTIAL_STORE: "file", FINXWORK_E2E_NOTIFIED: notified, FINXWORK_NO_BROWSER: "1" },
    stdio: ["ignore", "ignore", "inherit"],
  });
}

async function attach(want, what) {
  let target;
  for (let i = 0; i < 150 && !target; i++) {
    await sleep(200);
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => []);
    target = list.find((t) => t.type === "page" && want(t.url));
  }
  check(target, `${what} never showed up`);
  const page = await devtools(target.webSocketDebuggerUrl);
  const cdp = page.call;
  const run = async (expr) => {
    const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) fail(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const until = async (w, expr, ms = 30000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await run(expr);
      if (v) return v;
      if (Date.now() > end) fail(`timed out waiting for ${w}`);
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
const mainPage = () => attach((u) => !u.includes("#settings") && !u.startsWith("devtools"), "the main window");

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

const away = (page) => page.run(`document.hasFocus = () => false`);
const back = (page) => page.run(`document.hasFocus = () => true; window.dispatchEvent(new Event("focus"))`);
const botShows = (name) => `document.querySelector(".bhead-n")?.textContent === ${JSON.stringify(name)}`;
const bubbleWith = (text) => `[...document.querySelectorAll(".tr.bots .bm:not(.working) .bbub")].some((b) => b.innerText.includes(${JSON.stringify(text)}))`;
const notBusy = `!document.querySelector(".tr.bots .bm.working")`;

async function say(page, text) {
  await page.until("the composer", `!!document.querySelector(".cmp-in")`);
  await page.run(`document.querySelector(".cmp-in").focus()`);
  await page.cdp("Input.insertText", { text });
  await page.until("Send enabled", `!document.querySelector("button.send")?.disabled`);
  await page.run(`document.querySelector("button.send").click()`);
}

let failed = false;
try {
  if (!process.env.FINXWORK_E2E_NO_BUILD) {
    step("building finx and the app");
    sh("cargo", ["build", "-p", "finx-cli"], { cwd: root });
    sh("pnpm", ["--dir", desktop, "build"]);
  }

  step("starting: what is there already says nothing");
  launch();
  let page = await mainPage();
  await page.until("the window", `!!document.querySelector(".seg.mode")`, 60000);
  await page.run(`document.querySelector('.seg.mode [data-mode=bots]').click()`);
  await page.until("FinxBot", botShows("FinxBot"), 30000);
  await away(page);
  const bot = (await finxCalls(["bots/subscribe"])).bots[0];
  const group = `bot:${bot.id}`;
  check(shown().length === 0, "no notification at the start");

  step("7/§4. a bot's message while away: its first plain line, grouped by bot, and a number on the icon");
  await say(page, "回一句 你好");
  const hello = await untilRecord("the message", (r) => r.group === group && r.body === "你好");
  check(hello.title === "FinxBot", `the title is the bot's name: ${hello.title}`);
  check(hello.sound === true, "with sound by default");
  await untilBadge(1);
  await page.shot("n1-unread");

  step("1. a click from the other mode: back to the bot; reading takes the notification down and the number off");
  await page.run(`document.querySelector('.seg.mode [data-mode=sessions]').click()`);
  await page.until("session mode", `!document.querySelector(".bhead-n")`);
  await back(page);
  click(group);
  await page.until("the bot opened", botShows("FinxBot"));
  await untilRecord("taken down", (r) => r.clearGroups?.includes(group));
  await untilBadge(0);
  await away(page);

  step("2. every window closed: the main process still says so, and a click opens a window on the bot");
  await page.run(`window.close()`).catch(() => {});
  page.close();
  await sleep(500);
  const session = (await finxCalls(["bots/subscribe"])).bots[0].session_id;
  await finxCalls(["bots/open", { bot_id: bot.id }], ["session/op", { session_id: session, op: { type: "prompt", input: [{ type: "text", text: "回一句 窗口关着" }] } }]);
  await untilRecord("the message with no window", (r) => r.group === group && r.body === "窗口关着");
  await untilBadge(1);
  click(group);
  page = await mainPage();
  await page.until("the bot, in the new window", botShows("FinxBot"), 30000);
  await page.until("the message there", bubbleWith("窗口关着"));
  await back(page);
  await untilBadge(0);
  await away(page);
  await page.shot("n2-reopened");

  step("4. an approval says what it waits for; answered, it comes down");
  await page.run(`document.querySelector(".cmp-zone.bot .cmp-meta .mb").click()`);
  await page.until("the menu", `[...document.querySelectorAll(".mi")].some((e) => e.textContent.includes("询问权限"))`);
  await page.run(`[...document.querySelectorAll(".mi")].find((e) => e.textContent.includes("询问权限")).click()`);
  await say(page, "请确认");
  const asked = await untilRecord("the approval", (r) => r.id === `${group}:approval`);
  check(asked.body.startsWith("等你确认："), `it says so: ${asked.body}`);
  await page.until("the window asks", `!!document.querySelector(".cmp-zone.bot .appr")`);
  await page.run(`document.querySelector(".appr .btn.primary").click()`);
  await untilRecord("the approval down", (r) => r.clear?.includes(`${group}:approval`));
  await page.until("the answer", bubbleWith("好了"));
  await page.until("not busy", notBusy);

  step("5. a failure, when no message is coming; working again takes it down");
  await say(page, "请失败");
  const broke = await untilRecord("the failure", (r) => r.id === `${group}:failed`);
  check(broke.body === "这次没能回复", `it says so: ${broke.body}`);
  await page.until("the failure card", `!!document.querySelector(".tr.bots .fcard")`);
  await say(page, "回一句 恢复了");
  await untilRecord("the failure down", (r) => r.clear?.includes(`${group}:failed`));
  await untilRecord("the next message", (r) => r.body === "恢复了");
  await page.until("not busy", notBusy);
  await back(page);
  await untilBadge(0);
  await away(page);

  step("6. a muted bot: no notification and no share of the number, the list still counts");
  await page.run(`document.querySelector(".bhead").click()`);
  await page.until("its settings", `!!document.querySelector(".bpn .sw")`);
  await page.shot("n3-mute");
  await page.run(`document.querySelector(".bpn .sw").click()`);
  await page.until("muted", `document.querySelector(".bpn .sw").getAttribute("aria-checked") === "true"`);
  check((await finxCalls(["bots/subscribe"])).bots[0].muted === true, "finx keeps it");
  let before = shown().length;
  await say(page, "回一句 安静");
  await page.until("the message", bubbleWith("安静"));
  await page.until("not busy", notBusy);
  await sleep(300);
  check(shown().length === before, "nothing shown for a muted bot");
  check(badge() === 0, "no number for a muted bot");
  check((await finxCalls(["bots/subscribe"])).bots[0].unread === 1, "the list still counts it");
  await page.run(`document.querySelector(".bpn .sw").click()`);
  await page.until("not muted", `document.querySelector(".bpn .sw").getAttribute("aria-checked") === "false"`);
  await untilBadge(1);
  await back(page);
  await untilBadge(0);
  await away(page);

  step("7. the service restarting repeats nothing; later news still comes");
  before = shown().length;
  await finxCalls(["bots/open", { bot_id: bot.id }], ["bots/unread", { bot_id: bot.id }]);
  await untilBadge(1);
  await finxCalls(["server/shutdown"]);
  await sleep(1500);
  await page.until("the service back", `!document.querySelector(".kernel-banner")`, 30000);
  for (let i = 0; i < 100; i++) {
    const again = await finxCalls(["bots/subscribe"]).catch(() => null);
    if (again) break;
    await sleep(200);
  }
  await sleep(1000);
  check(shown().length === before, `nothing repeated: ${JSON.stringify(shown().slice(before))}`);
  check(badge() === 1, "the number comes back from the list");
  await page.cdp("Page.reload");
  await sleep(1500);
  await page.until("the bot", botShows("FinxBot"), 30000);
  await away(page);
  await say(page, "回一句 重启之后");
  await untilRecord("news after the restart", (r) => r.body === "重启之后");
  await page.until("not busy", notBusy);
  await back(page);
  await untilBadge(0);
  await away(page);

  step("8. a session: ending, waiting and failing");
  await page.run(`document.querySelector('.seg.mode [data-mode=sessions]').click()`);
  await page.until("the composer", `!!document.querySelector(".cmp-in")`);
  await say(page, "回一句 会话");
  const ended = await untilRecord("the ending", (r) => r.group?.startsWith("session:") && r.id.endsWith(":ended"));
  check(ended.body === "任务已结束", `it says so: ${ended.body}`);
  check(ended.title.includes("回一句"), `the title is the session's: ${ended.title}`);
  await page.until("a turn finished", `!document.querySelector("button.stop")`);
  await say(page, "请确认");
  const waits = await untilRecord("the waiting", (r) => r.id === `${ended.group}:approval`);
  check(waits.body === "任务在等你", `it says so: ${waits.body}`);
  await untilBadge(1);
  await page.until("the window asks", `!!document.querySelector(".appr .btn.primary")`);
  await page.run(`document.querySelector(".appr .btn.primary").click()`);
  await untilRecord("the waiting down", (r) => r.clear?.includes(`${ended.group}:approval`));
  await untilBadge(0);
  await page.until("a turn finished", `!document.querySelector("button.stop")`);
  await sleep(300);
  await say(page, "请失败");
  await untilRecord("the failing", (r) => r.group === ended.group && r.body === "任务失败了");

  step("§5.5. the settings: without the session's ending, without sound, then off altogether");
  const setSettings = (s) => page.run(`window.finx.setPreferences({ notifications: ${JSON.stringify(s)} })`);
  await setSettings({ enabled: true, sound: false, sessionEnded: false });
  await page.until("a turn finished", `!document.querySelector("button.stop")`);
  before = shown().length;
  await say(page, "回一句 不说结束");
  await sleep(1500);
  check(shown().length === before, `the ending stays quiet: ${JSON.stringify(shown().slice(before))}`);
  await page.run(`document.querySelector('.seg.mode [data-mode=bots]').click()`);
  await page.until("FinxBot", botShows("FinxBot"), 30000);
  await away(page);
  await say(page, "回一句 没有声音");
  const silent = await untilRecord("the message", (r) => r.body === "没有声音");
  check(silent.sound === false, "no sound");
  await untilBadge(1);
  await page.until("not busy", notBusy);
  await setSettings({ enabled: false, sound: false, sessionEnded: false });
  await untilBadge(0);
  before = shown().length;
  await say(page, "回一句 全部关掉");
  await page.until("the message", bubbleWith("全部关掉"));
  await page.until("not busy", notBusy);
  await sleep(300);
  check(shown().length === before, "off: nothing shows");
  check(badge() === 0, "off: no number");
  await setSettings({ enabled: true, sound: true, sessionEnded: true });
  await untilBadge(2);
  await back(page);
  await untilBadge(0);

  step("the settings page");
  await page.run(`window.finx.openSettings("notifications")`);
  const settings = await attach((u) => u.includes("#settings"), "the settings window");
  await settings.cdp("Emulation.setDeviceMetricsOverride", { width: 820, height: 620, deviceScaleFactor: 0, mobile: false });
  await settings.until("its switches", `document.querySelectorAll(".sw.on").length === 3`);
  await settings.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await sleep(400);
  await settings.shot("n4-settings-light");
  await settings.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await sleep(400);
  await settings.shot("n5-settings-dark");
  await settings.cdp("Emulation.setEmulatedMedia", { features: [] });
  check(await settings.run(`[...document.querySelectorAll(".sw")].every((s) => s.getAttribute("aria-checked") === "true")`), "all on");
  await settings.run(`document.querySelectorAll(".sw")[1].click()`);
  await settings.until("sound off", `document.querySelectorAll(".sw")[1].getAttribute("aria-checked") === "false"`);
  check(JSON.parse(fs.readFileSync(path.join(profile, "preferences.json"), "utf8")).notifications.sound === false, "saved");
  await settings.run(`document.querySelectorAll(".sw")[0].click()`);
  await settings.until("the others follow", `document.querySelectorAll(".sw")[1].disabled && document.querySelectorAll(".sw")[2].disabled`);
  await settings.run(`document.querySelectorAll(".sw")[0].click()`);
  await settings.until("on again", `!document.querySelectorAll(".sw")[1].disabled`);
  await settings.run(`document.querySelector(".fgroup + .fgroup .btn").click()`);
  await untilRecord("the test notification", (r) => r.id === "test");
  settings.close();

  page.close();
  await quit();
  await finxCalls(["server/shutdown"]).catch(() => {});
  console.log("\n✔ notifications work end to end");
} catch (e) {
  failed = true;
  console.error(`\n✘ ${e.message}`);
} finally {
  await quit().catch(() => {});
  await finxCalls(["server/shutdown"]).catch(() => {});
  provider.close();
  provider.closeAllConnections?.();
  if (failed) console.error(`kept for looking at: ${work}`);
  else fs.rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
