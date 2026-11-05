#!/usr/bin/env node
// How a real model handles routines (docs/kernel/routine-design.md §12). Each scenario runs N times
// in a fresh bot over `finx serve` and counts:
//   explicit, watch:  a routine was made when asked for one, with a time the owner was told;
//   implied:          it offered and did not make one when it only seemed useful;
//   system:           it reached for crontab, launchctl or a long sleep instead (should be 0);
//   quiet:            a run with nothing to say replied NOTHING_TO_REPORT;
//   relay:            a run with something to say reached the owner, without talking about runs.
// It prints each saved schedule and prompt, to read by hand, and what each kind of run cost.
//
//   DEEPSEEK_API_KEY=… node tools/bench/routine_turns.mjs [runs] [scenario…]
//   FINX_MODEL=<provider/model>   another model
//   FINX_MODELS_TOML=<file>       a models.toml for it, when it is not a built-in one
//
// It uses a home of its own, so the person's ~/.finx is not touched.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const root = path.resolve(import.meta.dirname, "../..");
const finx = process.env.FINX_BIN ?? path.join(root, "target/debug/finx");
const runs = Number(process.argv[2] ?? 12);
const only = process.argv.slice(3);
const home = fs.mkdtempSync(path.join(os.tmpdir(), "fxr-"));
fs.mkdirSync(path.join(home, "user"), { recursive: true });
fs.writeFileSync(path.join(home, "config.toml"), `model = "${process.env.FINX_MODEL ?? "deepseek/deepseek-flash"}"\npermission_mode = "bypass-permissions"\n`);
if (process.env.FINX_MODELS_TOML) fs.copyFileSync(process.env.FINX_MODELS_TOML, path.join(home, "models.toml"));

const server = spawn(finx, ["serve", "--stdio"], { env: { ...process.env, FINX_HOME: home, HOME: path.join(home, "user") }, stdio: ["pipe", "pipe", "inherit"] });
let next = 1;
const waiting = new Map();
const listeners = new Set();
readline.createInterface({ input: server.stdout }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && waiting.has(msg.id)) {
    const w = waiting.get(msg.id);
    waiting.delete(msg.id);
    msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result);
  } else if (msg.method) for (const f of listeners) f(msg);
});
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = next++;
    waiting.set(id, { resolve, reject });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Events of `session` until it is idle, or `ms` pass. */
function collect(session, ms) {
  const events = [];
  return {
    events,
    idle: new Promise((resolve) => {
      const timer = setTimeout(() => (listeners.delete(on), resolve(false)), ms);
      const on = (msg) => {
        if (msg.method !== "session/event" || msg.params.session_id !== session) return;
        events.push(msg.params.event);
        if (msg.params.event.type === "idle") {
          clearTimeout(timer);
          listeners.delete(on);
          resolve(true);
        }
      };
      listeners.add(on);
    }),
  };
}

async function freshBot(run) {
  const { bot } = await call("bots/create", { name: `测试${run + 1}`, avatar: { kind: "mono", hue: "slate" } });
  const opened = await call("bots/open", { bot_id: bot.id, events: { exclude: ["text_delta", "thinking_delta", "tool_call_delta", "tool_progress"] } });
  return { id: bot.id, session: opened.session_id, folder: path.join(home, "bots", bot.id, "files") };
}

/** Says something and waits until it is done with it. */
async function ask(bot, text) {
  const c = collect(bot.session, 240_000);
  await call("session/op", { session_id: bot.session, op: { type: "prompt", input: [{ type: "text", text }] } });
  const quiet = await c.idle;
  return { events: c.events, quiet };
}

const sends = (events) => events.filter((e) => e.type === "tool_started" && e.name === "send_to_user").map((e) => String(e.args.text ?? ""));
const makes = (events) => events.filter((e) => e.type === "tool_started" && e.name === "manage_routine" && e.args.action === "create");
const system = (events) => events.filter((e) => e.type === "tool_started" && e.name === "bash" && /crontab|launchctl|launchd|\bsleep\s+\d{2,}/.test(String(e.args.command ?? ""))).length;
/** Whether a message tells a time. */
const tellsTime = (texts) => texts.some((t) => /\d{1,2}[:：点]|\d{1,2}\s*(am|pm)|明天|明早|今晚|下次|第一次|首次/i.test(t));
/** Words that give away how it works, in a message to the owner. */
const leaks = /运行记录|这次运行|定时运行|运行结果|汇报|routine_report|run\b|NOTHING_TO_REPORT/i;

async function routinesOf(bot) {
  const listed = await call("bots/subscribe", {});
  return listed.bots.find((b) => b.id === bot.id)?.routines ?? [];
}

async function detail(bot, id) {
  const { routine } = await call("bots/routine", { bot_id: bot.id, routine_id: id });
  return routine;
}

const asks = {
  explicit: { text: "每天早上 8 点提醒我喝水", schedule: /^0 8 \* \* \*$/ },
  evening: { text: "每个工作日晚上 9 点半提醒我写日报", schedule: /^30 21 \* \* 1-5$/ },
  once: { text: "20 分钟后提醒我关火", schedule: /T.*[+-]\d\d:\d\d$/ },
  watch: { text: "特斯拉股价跌破 300 美元的话告诉我", schedule: /CRON_TZ=America\/New_York|\S/ },
};

const totals = {};
const costs = { quiet: [], reported: [], relay: [], chat: [] };
const tokens = (usage) => Object.values(usage?.per_model ?? {}).reduce((n, m) => n + (m.input ?? 0) + (m.output ?? 0) + (m.cache_read ?? 0) + (m.cache_write ?? 0), 0);

await call("initialize", { protocol_version: 2, client_info: { name: "routine-turns" } });
await call("bots/subscribe", {});

for (const [name, want] of Object.entries(asks)) {
  if (only.length && !only.includes(name)) continue;
  const t = (totals[name] = { runs: 0, made: 0, right: 0, told: 0, system: 0, timedOut: 0 });
  for (let run = 0; run < runs; run++) {
    const bot = await freshBot(run);
    const { events, quiet } = await ask(bot, want.text);
    t.runs++;
    t.timedOut += quiet ? 0 : 1;
    t.system += system(events);
    const made = makes(events).length > 0;
    t.made += made ? 1 : 0;
    const said = sends(events);
    if (tellsTime(said)) t.told++;
    const routines = await routinesOf(bot);
    if (routines[0]) {
      const d = await detail(bot, routines[0].id);
      if (want.schedule.test(d.schedule)) t.right++;
      console.log(`${name} #${run + 1}: [${d.schedule}] when="${routines[0].when}"\n   prompt: ${d.prompt.replace(/\s+/g, " ").slice(0, 300)}`);
    } else console.log(`${name} #${run + 1}: no routine`);
    for (const s of said) console.log("   ·", s.replace(/\s+/g, " ").slice(0, 120));
    await call("bots/delete", { bot_id: bot.id });
  }
}

// Only useful, not asked for: it should offer and wait.
if (!only.length || only.includes("implied")) {
  const t = (totals.implied = { runs: 0, made: 0, offered: 0, system: 0 });
  for (let run = 0; run < runs; run++) {
    const bot = await freshBot(run);
    const { events } = await ask(bot, "我每周一都要看一遍这张销售表，这周的数字是 A 100、B 200、C 150，帮我算一下总数。");
    t.runs++;
    t.system += system(events);
    if (makes(events).length) t.made++;
    const said = sends(events);
    if (said.some((s) => /定时|每周一|每周|提醒|自动/.test(s) && /[?？吗]|要不要|需要的话/.test(s))) t.offered++;
    console.log(`implied #${run + 1}: ${makes(events).length ? "made one" : "did not make one"}`);
    for (const s of said) console.log("   ·", s.replace(/\s+/g, " ").slice(0, 120));
    await call("bots/delete", { bot_id: bot.id });
  }
}

/** A routine that looks at a file in the bot's folder, so that the test decides what it finds. */
async function watching(bot) {
  await ask(bot, "每小时看一下你文件夹里的 status.txt：里面有 ALERT 就告诉我写了什么，否则不用说。");
  const routines = await routinesOf(bot);
  return routines[0];
}

async function runNow(bot, routine, ms = 240_000) {
  const c = collect(bot.session, ms);
  await call("bots/routine_run_now", { bot_id: bot.id, routine_id: routine.id });
  // Wait for its record: a quiet run leaves the session alone.
  const end = Date.now() + ms;
  let record;
  for (;;) {
    await sleep(500);
    const { runs: all } = await call("bots/routine_runs", { bot_id: bot.id, routine_id: routine.id, limit: 1 });
    record = all[0];
    if (record?.outcome || Date.now() > end) break;
  }
  return { c, record };
}

if (!only.length || only.includes("quiet")) {
  const t = (totals.quiet = { runs: 0, quiet: 0, reported: 0, failed: 0, woke: 0 });
  for (let run = 0; run < runs; run++) {
    const bot = await freshBot(run);
    const routine = await watching(bot);
    if (!routine) {
      console.log(`quiet #${run + 1}: no routine was made`);
      continue;
    }
    fs.writeFileSync(path.join(bot.folder, "status.txt"), "一切正常\n");
    const { c, record } = await runNow(bot, routine);
    t.runs++;
    t[record?.outcome === "quiet" ? "quiet" : record?.outcome === "failed" ? "failed" : "reported"]++;
    await sleep(1000);
    if (c.events.some((e) => e.type === "task_started")) t.woke++;
    if (record?.usage) costs.quiet.push(tokens(record.usage));
    console.log(`quiet #${run + 1}: ${record?.outcome}: ${(record?.note ?? record?.report ?? "").replace(/\s+/g, " ").slice(0, 120)}`);
    await call("bots/delete", { bot_id: bot.id });
  }
}

if (!only.length || only.includes("relay")) {
  const t = (totals.relay = { runs: 0, reported: 0, reached: 0, reminded: 0, failed: 0, leaked: 0, delivered: 0 });
  for (let run = 0; run < runs; run++) {
    const bot = await freshBot(run);
    const routine = await watching(bot);
    if (!routine) {
      console.log(`relay #${run + 1}: no routine was made`);
      continue;
    }
    fs.writeFileSync(path.join(bot.folder, "status.txt"), "ALERT 服务器磁盘只剩 3%\n");
    const { c, record } = await runNow(bot, routine);
    t.runs++;
    if (record?.outcome === "reported") t.reported++;
    await c.idle;
    const said = sends(c.events);
    if (said.length) t.reached++;
    if (c.events.some((e) => e.type === "task_failed")) t.failed++;
    const turns = c.events.filter((e) => e.type === "turn_started").length;
    if (said.length && turns > 2) t.reminded++;
    if (said.some((s) => leaks.test(s))) t.leaked++;
    const { runs: after } = await call("bots/routine_runs", { bot_id: bot.id, routine_id: routine.id, limit: 1 });
    if (after[0]?.delivered) t.delivered++;
    if (record?.usage) costs.reported.push(tokens(record.usage));
    const task = c.events.find((e) => e.type === "task_completed");
    if (task?.usage) costs.relay.push(tokens(task.usage));
    console.log(`relay #${run + 1}: ${record?.outcome}: ${said.length} messages`);
    for (const s of said) console.log("   ·", s.replace(/\s+/g, " ").slice(0, 160));
    await call("bots/delete", { bot_id: bot.id });
  }
}

const mean = (list) => (list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : 0);
console.log("\n" + JSON.stringify(totals, null, 1));
console.log(`\ntokens per run, mean: quiet ${mean(costs.quiet)}, with something to say ${mean(costs.reported)}, the bot passing it on ${mean(costs.relay)}`);
server.kill();
fs.rmSync(home, { recursive: true, force: true });
// A quiet run's wait for the bot's session has nothing to end it.
process.exit(0);
