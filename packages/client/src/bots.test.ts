import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantContent, BotSummary, Event, EventMsg, SessionInfo, Usage } from "@finx/protocol";
import { applyEvents, fromSnapshot, type SessionView } from "./session.ts";
import { attention, botLine, initialOf, lastText, mergeBots, plain, searchBots, sortBots } from "./bots.ts";
import { botChat, busyBubble, processSteps } from "./botChat.ts";

const bot = (id: string, o: Partial<BotSummary> = {}): BotSummary => ({ id, name: id, avatar: { kind: "mono", hue: "slate" }, created_at: "2026-11-01T00:00:00Z", ...o });
const at = (minute: number) => `2026-11-04T10:${String(minute).padStart(2, "0")}:00Z`;

test("pinned bots first, then the latest message; busy ones keep their place", () => {
  const list = [
    bot("a", { last: { from: "bot", text: "x", ts: at(1) } }),
    bot("b", { last: { from: "user", text: "y", ts: at(5) }, typing: true }),
    bot("c", { pinned: true, last: { from: "bot", text: "z", ts: at(0) } }),
    bot("d"),
  ];
  assert.deepEqual(sortBots(list).map((b) => b.id), ["c", "b", "a", "d"]);
  const merged = mergeBots(list, [bot("a", { last: { from: "bot", text: "new", ts: at(9) } }), bot("e")], ["d"]);
  assert.deepEqual(sortBots(merged).map((b) => b.id), ["c", "a", "b", "e"]);
  assert.deepEqual(attention(merged), { unread: false, waiting: false });
  assert.deepEqual(attention([bot("x", { unread: 2 }), bot("y", { waiting: "rm -rf build" })]), { unread: true, waiting: true });
});

test("a row's second line: an approval, then helpers, then answering, then the last message", () => {
  const last = { from: "user" as const, text: "看看这个\nAttached files:\n/Users/me/报告.pdf\n/Users/me/data.xlsx", ts: at(1) };
  assert.deepEqual(botLine(bot("a", { waiting: "重启 nginx", helpers: 2, typing: true, last })), { kind: "waiting", text: "重启 nginx" });
  assert.deepEqual(botLine(bot("a", { helpers: 2, typing: true, last })), { kind: "helpers", count: 2 });
  assert.deepEqual(botLine(bot("a", { typing: true, last })), { kind: "typing" });
  assert.deepEqual(botLine(bot("a", { last })), { kind: "last", from: "user", text: "看看这个", images: 0, files: ["报告.pdf", "data.xlsx"] });
  assert.deepEqual(botLine(bot("a")), { kind: "empty" });
  assert.deepEqual(lastText({ from: "bot", text: "\n## **对比好了**\n- 三种", ts: at(2) }), { text: "对比好了", files: [] });
  assert.equal(plain("[文档](https://x.y) 和 `code` ~~旧~~"), "文档 和 code 旧");
  assert.equal(initialOf("  研究员"), "研");
  assert.equal(initialOf("👩‍🔬 Lab"), "👩‍🔬".slice(0, 2));
});

// ---- the conversation ----

const info: SessionInfo = { session_id: "s", cwd: "/home/.finx/bots/b/files", session_file: "/f.jsonl", model: "p/m", thinking: "off", permission_mode: "manual", context_window: 1000, archived: false };
const usage: Usage = { input: 1, output: 1, cache_read: 0, cache_write: 0, cost: { currency: "USD", input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 } };

function play(msgs: EventMsg[]): SessionView {
  const events = msgs.map((m, i) => ({ seq: i + 1, ts: 1000 + i, ...m }) as Event);
  return applyEvents(fromSnapshot({ session: info, last_seq: 0, transcript: { items: [] }, usage: { per_model: {} } }), events);
}

const user = (id: string, text: string, ts: number): EventMsg => ({ type: "message_completed", message_id: id, message: { role: "user", content: [{ type: "text", text }], ts } });
const assistant = (id: string, content: AssistantContent[], ts: number, duration_ms = 0): EventMsg => ({
  type: "message_completed",
  message_id: id,
  message: { role: "assistant", content, provider: "p", api: "a", model: "m", usage, stop_reason: "tool_use", ts, duration_ms },
});
const send = (id: string, text: string, end = false): AssistantContent => ({ type: "tool_call", id, name: "send_to_user", arguments: end ? { text, end_turn: true } : { text } });
const started = (id: string, name = "send_to_user", args: Record<string, unknown> = {}): EventMsg => ({ type: "tool_started", call_id: id, name, args, category: "other", title: name });
const done = (id: string, name = "send_to_user", text = "Sent.", is_error = false): EventMsg => ({
  type: "tool_completed",
  call_id: id,
  result: { call_id: id, tool_name: name, content: [{ type: "text", text }], is_error, ts: 0 },
});

test("each send_to_user is a bubble; what the bot did and wrote for itself is the next bubble's process", () => {
  const v = play([
    { type: "task_started", task_id: "t1" },
    user("u1", "常见的方案有哪些？", 10_000),
    assistant("a1", [send("c1", "在查了。")], 11_000, 500),
    started("c1"),
    done("c1"),
    assistant("a2", [{ type: "thinking", text: "查一下" }, { type: "text", text: "私下的想法" }, { type: "tool_call", id: "c2", name: "bash", arguments: { command: "ls" } }], 12_000, 1000),
    started("c2", "bash"),
    done("c2", "bash", "a b"),
    assistant("a3", [send("c3", "三种：甲、乙、丙。"), send("c4", "要细说哪一种？", true)], 20_000, 2000),
    started("c3"),
    started("c4"),
    done("c4"),
    done("c3"),
    { type: "task_completed", task_id: "t1", usage: { per_model: {} }, reason: "done" },
  ]);
  const items = botChat(v);
  assert.deepEqual(items.map((i) => (i.kind === "bot" ? `bot:${i.text}` : i.kind === "user" ? `user:${i.text}` : i.kind)), [
    "user:常见的方案有哪些？",
    "bot:在查了。",
    "bot:三种：甲、乙、丙。",
    "bot:要细说哪一种？",
  ]);
  const [, first, second, third] = items;
  assert.ok(first.kind === "bot" && second.kind === "bot" && third.kind === "bot");
  assert.equal(first.ts, 11_500, "sent when its reply ended");
  assert.equal(first.took, 1_500, "since the owner's message");
  assert.equal(first.process.length, 0);
  // The private words and the command went before the answer.
  assert.deepEqual(second.process.map((s) => s.kind), ["work", "text", "work"]);
  assert.equal(processSteps(second.process), 1);
  assert.equal(second.took, 22_000 - 11_500);
  assert.equal(third.process.length, 0);
  assert.equal(busyBubble(v), null);
});

test("a message sent while the bot answered keeps its place, whether queued or in the history", () => {
  const live = play([
    { type: "task_started", task_id: "t1" },
    user("u1", "写一首春天的诗", 10_000),
    { type: "queue_changed", queued: [{ id: "u2", mode: "steer", message: { content: [{ type: "text", text: "再写一首夏天的" }], ts: 10_500 } }] },
  ]);
  assert.deepEqual(botChat(live).map((i) => i.kind === "user" && `${i.text}${i.queued ? " (queued)" : ""}`), ["写一首春天的诗", "再写一首夏天的 (queued)"]);
  assert.deepEqual(busyBubble(live), { typing: true, helpers: [] });
  const later = applyEvents(live, [
    { seq: 10, ts: 0, ...assistant("a1", [send("c1", "春天的诗。", true)], 11_000, 2000) } as Event,
    { seq: 11, ts: 0, ...started("c1") } as Event,
    { seq: 12, ts: 0, ...done("c1") } as Event,
    { seq: 13, ts: 0, type: "queue_changed", queued: [] } as Event,
    // It joins the history after the bot's answer, but was sent before it.
    { seq: 14, ts: 0, ...user("u2", "再写一首夏天的", 10_500) } as Event,
  ]);
  assert.deepEqual(
    botChat(later).map((i) => (i.kind === "bot" ? `bot:${i.text}` : i.kind === "user" ? `user:${i.text}` : i.kind)),
    ["user:写一首春天的诗", "user:再写一首夏天的", "bot:春天的诗。"],
  );
});

test("a failed, refused or cancelled send shows nothing; an approval card waits at the end", () => {
  const v = play([
    { type: "task_started", task_id: "t1" },
    user("u1", "nginx 挂了", 10_000),
    assistant("a1", [send("c1", "  "), send("c2", "要重启 nginx，确认一下。"), { type: "tool_call", id: "c3", name: "bash", arguments: { command: "systemctl restart nginx" } }], 11_000),
    started("c1"),
    started("c2"),
    started("c3", "bash", { command: "systemctl restart nginx" }),
    { type: "approval_requested", call_id: "c3", name: "bash", args: { command: "systemctl restart nginx" }, summary: "systemctl restart nginx" },
  ]);
  const items = botChat(v);
  // The send that waits for the approval with the rest of its batch shows already.
  assert.deepEqual(items.map((i) => i.kind), ["user", "bot", "approval"]);
  assert.equal(busyBubble(v), null, "waiting for the owner is not being busy");
  const failed = applyEvents(v, [
    { seq: 20, ts: 0, ...done("c1", "send_to_user", "invalid arguments: text must not be empty", true) } as Event,
    { seq: 21, ts: 0, type: "approval_resolved", call_id: "c3", decision: { type: "deny" } } as Event,
    { seq: 22, ts: 0, ...done("c2") } as Event,
    { seq: 23, ts: 0, ...done("c3", "bash", "The user denied this tool call.", true) } as Event,
    { seq: 24, ts: 30_000, type: "task_failed", task_id: "t1", error: { kind: "rate_limited", message: "slow down", retryable: true }, usage: { per_model: {} } } as Event,
  ]);
  const after = botChat(failed);
  assert.deepEqual(after.map((i) => i.kind), ["user", "bot", "failure"]);
  const failure = after[2];
  assert.ok(failure.kind === "failure" && failure.last && failure.error.kind === "rate_limited");
});

test("helpers at work make the bot busy, each with what it was asked to do", () => {
  const v = play([
    { type: "task_started", task_id: "t1" },
    user("u1", "调研一下", 10_000),
    assistant("a1", [{ type: "tool_call", id: "c1", name: "spawn_agent", arguments: { description: "调研更新方案", task: "…" } }, send("c2", "在查了。", true)], 11_000),
    started("c1", "spawn_agent"),
    started("c2"),
    { type: "agent_started", agent_id: "g1", name: "agent", description: "调研更新方案", session_file: "/g.jsonl", call_id: "c1" },
    done("c1", "spawn_agent", "started"),
    done("c2"),
    { type: "task_completed", task_id: "t1", usage: { per_model: {} }, reason: "done" },
    { type: "agent_event", agent_id: "g1", event: { seq: 1, ts: 1, type: "task_started", task_id: "t1" } },
    { type: "agent_event", agent_id: "g1", event: { seq: 2, ts: 2, type: "tool_started", call_id: "x", name: "bash", args: {}, category: "execute", title: "curl releases" } },
  ]);
  const busy = busyBubble(v);
  assert.equal(busy?.typing, false);
  assert.deepEqual(busy?.helpers.map((h) => [h.label, h.step]), [["调研更新方案", "curl releases"]]);
  // The launch is part of the first message's process.
  const bubble = botChat(v).find((i) => i.kind === "bot");
  assert.ok(bubble?.kind === "bot" && bubble.process.some((s) => s.kind === "agents"));
});

test("a search finds bots by name or by what was last said", () => {
  const list = [bot("研究员", { last: { from: "bot", text: "**对比好了**", ts: at(3) } }), bot("运维", { pinned: true }), bot("Writer", { last: { from: "user", text: "润色一下", ts: at(1) } })];
  assert.deepEqual(searchBots(list, "").map((b) => b.id), ["运维", "研究员", "Writer"]);
  assert.deepEqual(searchBots(list, "对比").map((b) => b.id), ["研究员"]);
  assert.deepEqual(searchBots(list, "writ").map((b) => b.id), ["Writer"]);
  assert.deepEqual(searchBots(list, "nothing"), []);
});
