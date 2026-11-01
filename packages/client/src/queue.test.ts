import assert from "node:assert/strict";
import { test } from "node:test";
import type { Event, EventMsg, SessionInfo, UserMessage } from "@finx/protocol";
import { applyEvents, fromSnapshot } from "./session.ts";

// Prompts sent while a task runs: they wait in view until the kernel takes
// them in, and go when the task fails or is stopped.

const info: SessionInfo = { session_id: "s", cwd: "/w", session_file: "/f.jsonl", model: "p/m", thinking: "off", permission_mode: "manual", context_window: 1000, archived: false };
const start = () => fromSnapshot({ session: info, last_seq: 0, transcript: { items: [] }, usage: { per_model: {} } });
const msg = (text: string, ts: number): UserMessage => ({ content: [{ type: "text", text }], ts });
let seq = 0;
const play = (msgs: EventMsg[], from = start()) => applyEvents(from, msgs.map((m) => ({ seq: ++seq, ts: seq, ...m }) as Event));

test("a queued prompt waits until it joins the history", () => {
  let v = play([
    { type: "task_started", task_id: "t" },
    { type: "input_queued", message: msg("now", 10), mode: "steer" },
    { type: "input_queued", message: msg("later", 11), mode: "follow_up" },
  ]);
  assert.deepEqual(v.queued.map((q) => q.mode), ["steer", "follow_up"]);
  v = play([{ type: "message_completed", message_id: "u", message: { role: "user", ...msg("now", 10) } }], v);
  assert.deepEqual(v.queued.map((q) => q.message.ts), [11]);
  // A task that completes keeps the rest: the next task takes them.
  v = play([{ type: "task_completed", task_id: "t", usage: { per_model: {} }, reason: "done" }], v);
  assert.equal(v.queued.length, 1);
  v = play([{ type: "task_started", task_id: "t2" }, { type: "task_interrupted", task_id: "t2", returned_input: [msg("later", 11)], usage: { per_model: {} } }], v);
  assert.equal(v.queued.length, 0);
});

test("a snapshot carries the queue", () => {
  const v = fromSnapshot({ session: info, last_seq: 3, transcript: { items: [] }, usage: { per_model: {} }, queued: [{ message: msg("x", 1), mode: "follow_up" }] });
  assert.equal(v.queued[0].mode, "follow_up");
});
