import assert from "node:assert/strict";
import { test } from "node:test";
import type { GroupSummary } from "@finx/protocol";
import { collageMembers, groupLine, groupTime, insertMention, mentionChoices, mergeGroups, sortGroups, threadMessages, typingMention } from "./groups.ts";

const member = (bot_id: string, name: string) => ({ bot_id, name, avatar: { kind: "mono" as const, hue: "slate" as const }, mode: "normal" as const });
const group = (patch: Partial<GroupSummary> = {}): GroupSummary => ({
  id: "g1",
  name: "装修群",
  created_at: "2026-11-14T08:00:00Z",
  members: [member("a", "Alice"), member("b", "Bob")],
  ...patch,
});
const last = (text: string, ts: string): GroupSummary["last"] => ({ from: { kind: "owner" }, text, ts });

test("pinned groups first, then the latest message", () => {
  const older = group({ id: "old", last: last("早", "2026-11-14T09:00:00Z") });
  const newer = group({ id: "new", last: last("晚", "2026-11-14T10:00:00Z") });
  const pinned = group({ id: "pin", pinned: true, last: last("旧", "2026-11-13T09:00:00Z") });
  assert.deepEqual(sortGroups([older, newer, pinned]).map((g) => g.id), ["pin", "new", "old"]);
  assert.equal(groupTime(older), Date.parse("2026-11-14T09:00:00Z"));
});

test("merges changed rows and drops deleted ones", () => {
  const a = group({ id: "a" });
  const b = group({ id: "b" });
  assert.deepEqual(mergeGroups([a, b], [b], ["a"]).map((g) => g.id), ["b"]);
});

test("a row shows a stopped group before anything else", () => {
  const g = group({ stopped: { reason: "daily_tokens", detail: "今天的额度用完了" } });
  assert.deepEqual(groupLine(g), { kind: "stopped", text: "今天的额度用完了" });
});

test("a row names the bots answering", () => {
  const g = group({ typing: ["b"] });
  assert.deepEqual(groupLine(g), { kind: "typing", names: ["Bob"] });
});

test("a row takes one line of the last message, and its file", () => {
  const g = group({ last: { from: { kind: "bot", bot_id: "a", name: "Alice" }, text: "**看好了**\n第二条", ts: "2026-11-14T09:00:00Z", file: "报价.pdf" } });
  assert.deepEqual(groupLine(g), { kind: "last", from: { kind: "bot", bot_id: "a", name: "Alice" }, text: "看好了", images: 0, files: ["报价.pdf"] });
});

test("a row without a message is empty", () => {
  assert.deepEqual(groupLine(group()), { kind: "empty" });
});

test("thread replies come in order", () => {
  const messages = [
    { id: "r", seq: 0 },
    { id: "2", seq: 2, thread: "r" },
    { id: "1", seq: 1, thread: "r" },
    { id: "x", seq: 3 },
  ];
  assert.deepEqual(threadMessages(messages, "r").map((m) => m.id), ["1", "2"]);
});

test("a collage takes at most four members, in the group's order", () => {
  const members = ["a", "b", "c", "d", "e"].map((id) => member(id, id.toUpperCase()));
  assert.deepEqual(collageMembers(members).map((m) => m.bot_id), ["a", "b", "c", "d"]);
  assert.deepEqual(collageMembers(members, 2).map((m) => m.bot_id), ["a", "b"]);
});

test("an @ at the end of the text is a mention being typed, and is replaced", () => {
  assert.deepEqual(typingMention("请 @Al"), { start: 2, end: 5, query: "Al" });
  assert.deepEqual(typingMention("@"), { start: 0, end: 1, query: "" });
  assert.equal(typingMention("邮件 a@b"), null);
  assert.equal(typingMention("请 @Alice 看看"), null);
  assert.deepEqual(insertMention("请 @Al", { start: 2, end: 5, query: "Al" }, "Alice"), "请 @Alice ");
});

test("the @ menu puts names that start with the query first", () => {
  const members = [member("a", "张三"), member("b", "阿里"), member("c", "小阿")];
  assert.deepEqual(mentionChoices(members, "阿").map((m) => m.bot_id), ["b", "c"]);
  assert.deepEqual(mentionChoices(members, "").map((m) => m.bot_id), ["a", "b", "c"]);
});
