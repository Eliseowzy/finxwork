import assert from "node:assert/strict";
import { test } from "node:test";
import type { GroupSummary } from "@finx/protocol";
import { groupLine, groupTime, mergeGroups, sortGroups, threadMessages } from "./groups.ts";

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
