#!/usr/bin/env node
// How a real model keeps a bot's turn rules (docs/kernel/bot-design.md §8, bot-turn-design §11):
// each scenario runs N times in a fresh bot over `finx serve`, and counts
//   - first:      the first call after the owner's message is send_to_user (not the aim in `stop`:
//                 there the stop comes first);
//   - missed:     a task the owner started ended without sending anything;
//   - late:       a task sent only after the kernel's reminder: its first reply had no call at all;
//   - unanswered, undelivered: the kernel's reminders, from the session's log;
//   - leaked:     a message names a tool or carries an id;
//   - asides:     a whole message in brackets, the bot talking to itself;
//   - internal:   a message speaks of sub-agents (it should only when asked how it works);
//   - delegated:  long work went to a sub-agent;
//   - delivered:  of the runs with a report, those with a message sent after the last one;
//   - firstMs:    from the owner's first message to the first bubble, median and worst;
//   - nextMs:     from each later message to the next bubble, median and worst;
//   - during:     later messages answered while a sub-agent still worked, of those asked then;
//   - ordered:    `poems`, the four poems came back in the order asked;
//   - stopFirst, stopped, told, restarted: `stop` and `session`, the agents stopped before the bot
//                 said so, stopped at all, it said so, it started the work again;
//   - checked:    `progress` and `session`, check_agents ran after the question;
//   - lastAutumn, spring: `change`, the last message is the poem asked for last; the first one
//                 went out too, which is acceptable.
// Messages are printed, to read for the rest: does an acknowledgement name its first step, does
// what it says of the progress match.
//
//   DEEPSEEK_API_KEY=… node tools/bench/bot_turns.mjs [runs] [scenario…]
//   FINX_BOT_PROMPT=<file>     tries another bot.md (bot_prompt_file)
//   FINX_BENCH_THINKING=<lvl>  the bots' thinking level
//   FINX_BENCH_PARALLEL=<n>    runs at a time, 3 by default
//   FINX_BENCH_MODELS=<file>   a models.toml, with FINX_MODEL: another provider, or finx-mock to try
//                              the script itself
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
const parallel = Number(process.env.FINX_BENCH_PARALLEL ?? 3);
const home = fs.mkdtempSync(path.join(os.tmpdir(), "fxb-"));
const config = [`model = "${process.env.FINX_MODEL ?? "deepseek/deepseek-flash"}"`, `permission_mode = "accept-edits"`];
if (process.env.FINX_BENCH_THINKING) config.push(`thinking = "${process.env.FINX_BENCH_THINKING}"`);
if (process.env.FINX_BOT_PROMPT) config.push(`bot_prompt_file = "${path.resolve(process.env.FINX_BOT_PROMPT)}"`);
fs.writeFileSync(path.join(home, "config.toml"), config.join("\n") + "\n");
if (process.env.FINX_BENCH_MODELS) fs.copyFileSync(process.env.FINX_BENCH_MODELS, path.join(home, "models.toml"));

fs.mkdirSync(path.join(home, "user"), { recursive: true });
const server = spawn(finx, ["serve", "--stdio"], { env: { ...process.env, FINX_HOME: home, HOME: path.join(home, "user") }, stdio: ["pipe", "pipe", "inherit"] });
let next = 1;
const waiting = new Map();
const listeners = new Set();
readline.createInterface({ input: server.stdout }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && waiting.has(msg.id)) {
    const w = waiting.get(msg.id);
    waiting.delete(msg.id);
    msg.error ? w.reject(new Error(`${msg.error.message}`)) : w.resolve(msg.result);
  } else if (msg.method) for (const f of listeners) f(msg);
});
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = next++;
    waiting.set(id, { resolve, reject });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1] : null);

const allow = () => ({ type: "approve" });
const deny = () => ({ type: "deny", feedback: "这个文件名不行，先别建" });

/** Everything `session` says, stamped on arrival; what it asks is answered with `decide`. */
function watch(session, decide = allow) {
  const w = { events: [], lastEvent: Date.now(), lastIdle: 0 };
  const answer = (op) => void call("session/op", { session_id: session, op });
  const on = (msg) => {
    if (msg.method !== "session/event" || msg.params.session_id !== session) return;
    const e = { ...msg.params.event, at: Date.now() };
    w.events.push(e);
    w.lastEvent = e.at;
    if (e.type === "idle") w.lastIdle = e.at;
    if (e.type === "approval_requested") {
      console.log(`   (asked: ${e.summary})`);
      answer({ type: "approval", call_id: e.call_id, decision: decide(e) });
    }
    if (e.type === "agent_event" && e.event.type === "approval_requested") {
      console.log(`   (a sub-agent asked: ${e.event.summary})`);
      answer({ type: "agent_approval", agent: e.agent_id, call_id: e.event.call_id, decision: decide(e.event) });
    }
  };
  listeners.add(on);
  w.close = () => listeners.delete(on);
  return w;
}

/** Quiet since an idle that came after `since`. An idle sent before a message can cross it on the
 * wire, so it has to stay the last thing said for a moment. */
async function settled(w, since, ms, done) {
  const end = Date.now() + ms;
  for (;;) {
    if (done?.(w)) return true;
    if (w.lastIdle > since && w.lastIdle === w.lastEvent && Date.now() - w.lastIdle > 1500) return true;
    if (Date.now() > end) return false;
    await sleep(200);
  }
}

/** The tool a call really runs, deferred or not. */
const toolOf = (e) => (e.name === "call_tool" ? e.args?.name : e.name);
const isSend = (e) => e.type === "tool_started" && e.name === "send_to_user";
const isCall = (e, name) => e.type === "tool_started" && toolOf(e) === name;
const firstAfter = (w, at, test) => w.events.find((e) => e.at >= at && test(e));
const long = "写一篇一万字的小作文，主题随便，写好整理成文件告诉我。";
const atWork = (w) => w.events.some((e) => e.type === "agent_started");

/** `say`: [ms after the one before, text], or [ms, text, when]: `when` is awaited first.
 * `oneByOne`: each after the one before is answered.
 * `until`: ends the run early, the work still going. `check`: counts of its own. */
const scenarios = {
  poems: { say: () => ["写一首春天的诗", "写一首夏天的诗", "写一首秋天的诗", "写一首冬天的诗"].map((t) => [400, t]) },
  // One at a time, each answered before the next: a short answer is where a bot forgets to send.
  quick: { oneByOne: true, say: () => ["用一句话介绍你自己。", "今天星期几？", "1 加 1 等于几？"].map((t) => [0, t]) },
  hello: { oneByOne: true, say: () => ["你好，你是谁？用一句话回答。", "你能帮我做什么？简单说。", "谢谢！"].map((t) => [0, t]) },
  // One short question per bot: runs do not lean on each other, which suits comparing prompts.
  one: { say: (run) => [[0, ["用一句话介绍你自己。", "今天星期几？", "1 加 1 等于几？", "你好，你是谁？用一句话回答。", "你能帮我做什么？简单说。", "谢谢！"][run % 6]]] },
  mixed: {
    say: () =>
      [
        "帮我写个 Python 脚本，统计你文件夹里新建的 data.csv 每列的平均值：先造一份 200 行、5 列的随机数据，跑完把结果告诉我",
        "1 公里等于多少英里？",
        "再列一下 macOS 上常见的三种自动更新方案，各一句话",
      ].map((t) => [400, t]),
  },
  // How soon the first bubble comes when the work is long; no need to wait for the essay.
  // A moment past the handing over, to see what else it says.
  ack: { ms: 60_000, say: () => [[0, long]], until: (w) => w.events.some((e) => e.type === "agent_started" && Date.now() - e.at > 8000) },
  // The timeline of bot-turn-design §3.
  // Two thousand characters: the timeline is the same as for ten thousand, at a fraction of the cost.
  long: { ms: 600_000, say: () => [[0, long.replace("一万字", "两千字")], [2000, "刚才给你发啥了你知道么", atWork], [3000, "为什么你在写的时候我还能给你发消息"]] },
  stop: {
    ms: 180_000,
    say: (run) => [[0, long], [5000, ["算了不用了", "这个先别弄了", "Never mind, drop it."][run % 3], atWork]],
    check(t, w, at) {
      const told = firstAfter(w, at[1], isSend);
      const stop = firstAfter(w, at[1], (e) => isCall(e, "stop_agents"));
      const interrupted = firstAfter(w, at[1], (e) => e.type === "agent_status" && e.status === "interrupted");
      t.stopFirst += stop && (!told || stop.at <= told.at) ? 1 : 0;
      t.stopped += interrupted ? 1 : 0;
      t.told += told ? 1 : 0;
      t.restarted += firstAfter(w, at[1], (e) => e.type === "tool_started" && (e.name === "spawn_agent" || (e.name === "send_message" && !e.args?.interrupt))) ? 1 : 0;
    },
  },
  progress: {
    ms: 180_000,
    say: () => [[0, long], [10_000, "写到哪了", atWork]],
    // Answered: there is no need to wait for the essay.
    until: (w, at) => at.length === 2 && !!firstAfter(w, at[1] + 1, (e) => isSend(e) && !isAck(e)),
    check(t, w, at) {
      t.checked += firstAfter(w, at[1], (e) => isCall(e, "check_agents")) ? 1 : 0;
    },
  },
  change: {
    say: () => [[0, "写一首春天的诗"], [1000, "算了写秋天的"]],
    check(t, w) {
      const sent = w.events.filter(isSend).map((e) => String(e.args?.text ?? ""));
      t.lastAutumn += /秋/.test(sent.at(-1) ?? "") ? 1 : 0;
      t.spring += sent.some((s) => /春/.test(s) && s.length > 20) ? 1 : 0;
    },
  },
  // What a sub-agent asks, in Ask Permissions (subagent-design §10): the result must not get lost.
  allow: { manual: true, say: () => [[0, "请交给子智能体去做：在你的文件夹里运行命令 touch real.txt，做完告诉我结果。"]] },
  deny: { manual: true, decide: deny, say: () => [[0, "请交给子智能体去做：在你的文件夹里运行命令 touch real.txt，做完告诉我结果。"]] },
  // The tools for checking and stopping are the sessions' too.
  session: {
    plain: true,
    ms: 240_000,
    say: () => [[0, `请交给子智能体去做：${long}`], [15_000, "进展如何？", atWork], [20_000, "算了，停下吧。"]],
    check(t, w, at) {
      t.checked += firstAfter(w, at[1], (e) => isCall(e, "check_agents")) ? 1 : 0;
      t.stopped += firstAfter(w, at[2], (e) => e.type === "agent_status" && e.status === "interrupted") ? 1 : 0;
      t.stopFirst += firstAfter(w, at[2], (e) => isCall(e, "stop_agents")) ? 1 : 0;
    },
  },
};
const isAck = (e) => /我看|我查|我去|稍等|看一下|查一下|let me|checking/i.test(String(e.args?.text ?? "")) && String(e.args?.text ?? "").length < 30;
const tools = /\b(send_to_user|spawn_agent|send_message|end_turn|check_agents|stop_agents|tool_search|call_tool|bash|read|write|edit|tool_call|call_[a-z0-9]+)\b/i;
const internal = /子智能体|sub-?agent|agent_report|汇报/i;
const aside = /^\s*[（(][^（()）]*[）)]\s*$/;

function logOf(session) {
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((f) => (f.isDirectory() ? walk(path.join(dir, f.name)) : f.name.endsWith(".jsonl") ? [path.join(dir, f.name)] : []));
  const file = walk(path.join(home, "sessions")).find((f) => f.includes(session));
  return file ? fs.readFileSync(file, "utf8") : "";
}

async function oneRun(name, s, run, t) {
  let bot = null;
  let session;
  if (s.plain) {
    const cwd = path.join(home, "work", `${name}-${run}`);
    fs.mkdirSync(cwd, { recursive: true });
    session = (await call("session/new", { cwd })).session_id;
  } else {
    bot = (await call("bots/create", { name: `测试${run + 1}`, avatar: { kind: "mono", hue: "slate" } })).bot;
    const opened = await call("bots/open", { bot_id: bot.id, events: { exclude: ["text_delta", "thinking_delta", "tool_call_delta", "tool_progress"] } });
    session = opened.session_id;
    if (s.manual) await call("session/op", { session_id: session, op: { type: "set_permission_mode", mode: "manual" } });
  }
  const w = watch(session, s.decide);
  const limit = s.ms ?? 240_000;
  const at = [];
  let quiet = true;
  for (const [gap, text, when] of s.say(run)) {
    if (s.oneByOne && at.length) quiet &&= await settled(w, at.at(-1), limit);
    // Not if it finished without: a bot may do short work itself.
    const finished = () => w.lastIdle > at.at(-1) && Date.now() - w.lastIdle > 1500;
    for (const end = Date.now() + limit; when && !when(w) && !finished() && Date.now() < end; ) await sleep(100);
    if (gap) await sleep(gap);
    at.push(Date.now());
    await call("session/op", { session_id: session, op: { type: "prompt", input: [{ type: "text", text }] } });
  }
  quiet &&= await settled(w, at.at(-1), limit, s.until && ((w) => s.until(w, at)));
  const log = logOf(session);
  w.close();
  const { events } = w;

  t.runs++;
  t.idle += quiet ? 1 : 0;
  const sent = events.filter(isSend).map((e) => String(e.args?.text ?? ""));
  t.sends += sent.length;
  t.leaked += sent.filter((x) => tools.test(x)).length;
  t.asides += sent.filter((x) => aside.test(x)).length;
  t.internal += sent.filter((x) => internal.test(x)).length;
  t.unanswered += (log.match(/"type":"unanswered"/g) ?? []).length;
  t.undelivered += (log.match(/"type":"undelivered"/g) ?? []).length;

  // Each task the owner started (a sub-agent's report needs no reply first): did its first reply
  // start with a send, and did it send at all?
  let inTask = false, first = null, sentInTask = false, replies = [];
  for (const e of s.plain ? [] : events) {
    if (e.type === "task_started") (inTask = e.trigger !== "mail"), (first = null), (sentInTask = false), (replies = []);
    if (inTask && e.type === "message_completed" && e.message.role === "assistant") {
      replies.push(e.message.content.map((x) => (x.type === "tool_call" ? `[${x.name}]` : x.type === "text" ? x.text : "")).join(" "));
      if (first === null) {
        first = e.message.content.find((x) => x.type === "tool_call")?.name ?? "(none)";
        t.tasks++;
        if (first === "send_to_user") t.first++;
      }
    }
    if (inTask && isSend(e)) sentInTask = true;
    if (inTask && (e.type === "task_completed" || e.type === "task_failed")) {
      inTask = false;
      if (!sentInTask) {
        t.missed++;
        // What it wrote instead, reply by reply.
        for (const r of replies) console.log(`   (missed: ${r.replace(/\s+/g, " ").slice(0, 120)})`);
      } else if (first === "(none)") t.late++;
    }
  }

  const delegated = events.some((e) => e.type === "agent_started");
  t.delegated += delegated ? 1 : 0;
  // Reports: did anything reach the owner after the last one?
  const reports = events.filter((e) => e.type === "message_completed" && e.mail);
  if (reports.length && !s.plain) {
    t.reported++;
    if (firstAfter(w, reports.at(-1).at, isSend)) t.delivered++;
    else console.log("   (nothing sent after the last report)");
  }

  // How long the owner waits for a bubble, and whether the work went on meanwhile.
  at.forEach((time, i) => {
    const bubble = firstAfter(w, time, isSend);
    if (!bubble) return;
    (i === 0 ? t.firstMs : t.nextMs).push(bubble.at - time);
    if (i === 0) return;
    const started = events.find((e) => e.type === "agent_started");
    const working = (moment) =>
      started && started.at < moment && !events.some((e) => e.type === "agent_status" && e.at < moment && ["completed", "failed", "interrupted"].includes(e.status));
    if (working(time)) {
      t.askedDuring++;
      if (working(bubble.at)) t.during++;
    }
  });

  if (name === "poems") {
    // The season a poem is about is the first one it names (its title); others may come up in its lines.
    const firsts = sent.map((x) => x.match(/[春夏秋冬]/)?.[0]).filter(Boolean).join("");
    if (firsts.startsWith("春夏秋冬")) t.ordered++;
    else console.log(`   (order: ${firsts})`);
  }
  s.check?.(t, w, at);
  console.log(`${name} #${run + 1}: ${sent.length} messages${quiet ? "" : " (timed out)"}${delegated ? ", delegated" : ""}`);
  for (const x of sent) console.log("   ·", x.replace(/\s+/g, " ").slice(0, 90));
  if (bot) await call("bots/delete", { bot_id: bot.id });
}

const totals = {};
await call("initialize", { protocol_version: 2, client_info: { name: "bot-turns" } });
await call("bots/subscribe", {});
for (const [name, s] of Object.entries(scenarios)) {
  if (only.length && !only.includes(name)) continue;
  const t = (totals[name] = {
    runs: 0, idle: 0, tasks: 0, first: 0, missed: 0, late: 0, unanswered: 0, undelivered: 0, sends: 0, leaked: 0, asides: 0, internal: 0,
    delegated: 0, reported: 0, delivered: 0, firstMs: [], nextMs: [], askedDuring: 0, during: 0,
    ordered: 0, stopFirst: 0, stopped: 0, told: 0, restarted: 0, checked: 0, lastAutumn: 0, spring: 0,
  });
  for (let run = 0; run < runs; run += parallel) {
    const batch = Array.from({ length: Math.min(parallel, runs - run) }, (_, k) => oneRun(name, s, run + k, t).catch((e) => console.log(`${name} #${run + k + 1}: ${e.message}`)));
    await Promise.all(batch);
  }
  for (const key of ["firstMs", "nextMs"]) t[key] = { median: median(t[key]), worst: t[key].length ? Math.max(...t[key]) : null };
}
console.log("\n" + JSON.stringify(totals, null, 1));
server.kill();
fs.rmSync(home, { recursive: true, force: true });
process.exit(0);
