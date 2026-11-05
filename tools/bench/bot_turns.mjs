#!/usr/bin/env node
// How a real model keeps a bot's turn rules (docs/kernel/bot-design.md §8): each scenario runs
// N times in a fresh bot over `finx serve`, and counts
//   - first:   the first call after the owner's message is send_to_user;
//   - missed:  a task ended without sending anything;
//   - failed:  a task failed, so the model never answered: the run says nothing about its turns;
//   - late:    a task sent only after the kernel's reminder (bot-design §3.11): its first
//              reply had no call at all;
//   - leaked:  a message names a tool or carries an id;
//   - delegated: long work went to a sub-agent (spawn_agent);
//   - ordered: the four poems came back in the order asked;
//   - attached: a file went out as an attachment message; linked: only as a link in words;
//   - asked: a choice went out as a question with options; prose: only as words ending in a question;
//   - rejected: a send the kernel refused (printed with why): it costs a round trip, the owner sees nothing.
//
//   DEEPSEEK_API_KEY=… node tools/bench/bot_turns.mjs [runs] [scenario…]
//   FINX_BOT_PROMPT=<file>   tries another bot.md (bot_prompt_file)
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
const home = fs.mkdtempSync(path.join(os.tmpdir(), "fxb-"));
const config = [`model = "${process.env.FINX_MODEL ?? "deepseek/deepseek-flash"}"`, `permission_mode = "accept-edits"`];
if (process.env.FINX_BOT_PROMPT) config.push(`bot_prompt_file = "${path.resolve(process.env.FINX_BOT_PROMPT)}"`);
fs.writeFileSync(path.join(home, "config.toml"), config.join("\n") + "\n");

const server = spawn(finx, ["serve", "--stdio"], { env: { ...process.env, FINX_HOME: home, HOME: path.join(home, "user") }, stdio: ["pipe", "pipe", "inherit"] });
fs.mkdirSync(path.join(home, "user"), { recursive: true });
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

/** Events of `session` until it is idle (nothing runs, no sub-agent works), or `ms` pass. */
function collect(session, ms) {
  const events = [];
  return {
    events,
    idle: new Promise((resolve) => {
      const timer = setTimeout(() => (listeners.delete(on), resolve(false)), ms);
      const on = (msg) => {
        if (msg.method !== "session/event" || msg.params.session_id !== session) return;
        events.push(msg.params.event);
        // The owner allows what the bot asks for: the counts are about its turns, not its approvals.
        const e = msg.params.event;
        if (e.type === "approval_requested") {
          console.log(`   (allowed: ${e.summary})`);
          void call("session/op", { session_id: session, op: { type: "approval", call_id: e.call_id, decision: { type: "approve" } } });
        }
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

const scenarios = {
  poems: ["写一首春天的诗", "写一首夏天的诗", "写一首秋天的诗", "写一首冬天的诗"],
  // One at a time, each answered before the next: a short answer is where a bot forgets to send.
  quick: ["用一句话介绍你自己。", "今天星期几？", "1 加 1 等于几？"],
  hello: ["你好，你是谁？用一句话回答。", "你能帮我做什么？简单说。", "谢谢！"],
  // The message types (bot-design §3.12): is a file sent as one, and a choice asked as one?
  files: ["写一份 100 字的周报，存成 report.md，再用 Python 把 1 到 5 的平方写进 squares.csv，都发给我。"],
  // The answers can be listed: a question with options fits.
  choice: ["我有两份周报草稿：A 版详细，B 版简洁。你不知道我要哪版，先问我一下，我选了你再往下写。"],
  // The answers cannot all be listed (a name, a date): words may fit better.
  open: ["帮我写一封请假邮件。收件人和请几天你都不知道，也猜不到，要问我的话一次只问一个。"],
  mixed: [
    "帮我写个 Python 脚本，统计你文件夹里新建的 data.csv 每列的平均值：先造一份 200 行、5 列的随机数据，跑完把结果告诉我",
    "1 公里等于多少英里？",
    "再列一下 macOS 上常见的三种自动更新方案，各一句话",
  ],
};
const tools = /\b(send_to_user|spawn_agent|send_message|end_turn|bash|read|write|edit|tool_call|call_[a-z0-9]+)\b/i;

const totals = {};
await call("initialize", { protocol_version: 2, client_info: { name: "bot-turns" } });
await call("bots/subscribe", {});
for (const [name, prompts] of Object.entries(scenarios)) {
  if (only.length && !only.includes(name)) continue;
  const t = (totals[name] = { runs: 0, first: 0, tasks: 0, missed: 0, late: 0, leaked: 0, delegated: 0, ordered: 0, attached: 0, linked: 0, asked: 0, prose: 0, rejected: 0, failed: 0, sends: 0, idle: 0 });
  for (let run = 0; run < runs; run++) {
    const { bot } = await call("bots/create", { name: `测试${run + 1}`, avatar: { kind: "mono", hue: "slate" } });
    const opened = await call("bots/open", { bot_id: bot.id, events: { exclude: ["text_delta", "thinking_delta", "tool_call_delta", "tool_progress"] } });
    const session = opened.session_id;
    let c = collect(session, 240_000);
    let quiet = true;
    const all = [];
    for (const p of prompts) {
      await call("session/op", { session_id: session, op: { type: "prompt", input: [{ type: "text", text: p }] } });
      if (name !== "quick" && name !== "hello") {
        await sleep(400);
        continue;
      }
      quiet &&= await c.idle;
      all.push(...c.events);
      c = collect(session, 240_000);
    }
    if (name === "quick" || name === "hello") c = { events: all, idle: Promise.resolve(quiet) };
    else quiet = await c.idle;
    t.runs++;
    t.idle += quiet ? 1 : 0;
    // What the kernel refused never reached the owner: only the rest count.
    const refused = new Map(c.events.filter((e) => e.type === "tool_completed" && e.result.tool_name === "send_to_user" && e.result.is_error).map((e) => [e.call_id, e.result.content.map((x) => x.text ?? "").join("")]));
    const started = c.events.filter((e) => e.type === "tool_started" && e.name === "send_to_user");
    for (const e of started) {
      if (!refused.has(e.call_id)) continue;
      t.rejected++;
      console.log(`   (rejected: ${refused.get(e.call_id).slice(0, 110)} | args: ${JSON.stringify(e.args).slice(0, 170)})`);
    }
    const calls = started.filter((e) => !refused.has(e.call_id));
    const hasFiles = (e) => e.args.type === "attachment" || (!e.args.type && e.args.files?.length > 0);
    const isQuestion = (e) => e.args.type === "question" || (!e.args.type && e.args.options?.length > 0);
    const sent = calls.map((e) => (hasFiles(e) ? `[files${e.args.type ? "" : ", no type"}] ${(e.args.files ?? []).map((f) => f.path.split("/").at(-1)).join(", ")}${e.args.text ? ` | ${e.args.text}` : ""}` : isQuestion(e) ? `[question] ${e.args.text} / ${(e.args.options ?? []).map((o) => o.label).join(" / ")}` : String(e.args.text ?? "")));
    if (calls.some(hasFiles)) t.attached++;
    else if (calls.some((e) => /\]\([^)h][^)]*\)|\.(md|csv|png|pdf)\b/.test(String(e.args.text ?? "")))) t.linked++;
    if (calls.some(isQuestion)) t.asked++;
    else if (calls.some((e) => /[?？]\s*$/.test(String(e.args.text ?? "")))) t.prose++;
    t.sends += sent.length;
    t.leaked += sent.filter((s) => tools.test(s)).length;
    // Each task the owner started (a sub-agent's report needs no reply first): did its first reply
    // start with a send, and did it send at all?
    let inTask = false, first = null, sentInTask = false, replies = [];
    for (const e of c.events) {
      if (e.type === "task_started") (inTask = e.trigger !== "mail"), (first = null), (sentInTask = false), (replies = []);
      if (inTask && e.type === "message_completed" && e.message.role === "assistant") {
        replies.push(e.message.content.map((x) => (x.type === "tool_call" ? `[${x.name}]` : x.type === "text" ? x.text : "")).join(" "));
        if (first === null) {
          first = e.message.content.find((x) => x.type === "tool_call")?.name ?? "(none)";
          t.tasks++;
          if (first === "send_to_user") t.first++;
        }
      }
      if (inTask && e.type === "tool_started" && e.name === "send_to_user") sentInTask = true;
      if (inTask && (e.type === "task_completed" || e.type === "task_failed")) {
        inTask = false;
        if (e.type === "task_failed") {
          t.failed++;
          console.log(`   (failed: ${e.error?.kind}: ${String(e.error?.message).slice(0, 120)})`);
        } else if (!sentInTask) {
          t.missed++;
          // What it wrote instead, reply by reply.
          for (const r of replies) console.log(`   (missed: ${r.replace(/\s+/g, " ").slice(0, 120)})`);
        } else if (first === "(none)") t.late++;
      }
    }
    if (c.events.some((e) => e.type === "agent_started")) t.delegated++;
    if (name === "poems") {
      // The season a poem is about is the first one it names (its title); others may come up in its lines.
      const firsts = sent.map((x) => x.match(/[春夏秋冬]/)?.[0]).filter(Boolean).join("");
      if (firsts.startsWith("春夏秋冬")) t.ordered++;
      else console.log(`   (order: ${firsts})`);
    }
    console.log(`${name} #${run + 1}: ${sent.length} messages${quiet ? "" : " (timed out)"}${c.events.some((e) => e.type === "agent_started") ? ", delegated" : ""}`);
    for (const s of sent) console.log("   ·", s.replace(/\s+/g, " ").slice(0, 90));
    await call("bots/delete", { bot_id: bot.id });
  }
}
console.log("\n" + JSON.stringify(totals, null, 1));
server.kill();
fs.rmSync(home, { recursive: true, force: true });
