import assert from "node:assert/strict";
import { test } from "node:test";
import type { Event, SessionSnapshot, SessionSummary } from "@finx/protocol";
import { RpcClient } from "../rpc.ts";
import { applyEvent, fromSnapshot, statusOf, type SessionView } from "../session.ts";
import { conversation } from "../steps.ts";
import { mockTransport } from "./index.ts";
import { MockServer } from "./server.ts";

function client(server = new MockServer({ speed: 200 })) {
  return new RpcClient(mockTransport(server));
}

/** The parts of a state a client shows (ids of new objects aside). */
function shown(v: SessionView) {
  return { status: statusOf(v), steps: conversation(v).map((s) => ({ ...s, ts: undefined })), usage: v.usage, info: v.info, lastSeq: v.lastSeq };
}

test("the demo lists sessions in every state, newest first", async () => {
  const rpc = client(new MockServer({ still: true }));
  await rpc.request("initialize", { protocol_version: 1 });
  const { sessions } = await rpc.request("sessions/subscribe", {});
  const states = new Set(sessions.map((s: SessionSummary) => s.state));
  for (const st of ["idle", "running", "failed"] as const) assert.ok(states.has(st), `no ${st} session`);
  assert.ok(sessions.some((s) => s.archived));
  const times = sessions.map((s) => Date.parse(s.updated_at));
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
});

test("a snapshot taken at any point, with the events after it, rebuilds what a client that saw every event has", async () => {
  const server = new MockServer({ speed: 400 });
  const watcher = client(server);
  // Full auto: the demo's reply asks before its edit in the other modes.
  const { session_id, snapshot } = await watcher.request("session/new", { cwd: "/tmp/demo", permission_mode: "bypass-permissions" });
  let full = fromSnapshot(snapshot);
  const done = new Promise<void>((resolve) => {
    watcher.on("session/event", ({ event }) => {
      full = applyEvent(full, event as Event);
      if (event.type === "task_completed") resolve();
    });
  });
  await watcher.request("session/op", { session_id, op: { type: "prompt", input: [{ type: "text", text: "看看这个项目" }] } });
  // Others attach at different moments, each from its own snapshot and then its own events.
  const late: { view?: SessionView }[] = [];
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 15));
    const other = client(server);
    const l: { view?: SessionView } = {};
    other.on("session/event", ({ event }) => void (l.view &&= applyEvent(l.view, event as Event)));
    const { snapshot: s } = await other.request("session/attach", { session_id });
    l.view = fromSnapshot(s as SessionSnapshot);
    late.push(l);
  }
  await done;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(late.length, 6);
  for (const l of late) assert.deepEqual(shown(l.view!), shown(full));
  assert.equal(statusOf(full), "idle");
});

test("an approval waits, and the task goes on once approved", async () => {
  const server = new MockServer({ speed: 300 });
  const rpc = client(server);
  const { sessions } = await rpc.request("sessions/subscribe", {});
  const asking = sessions.find((s) => s.title === "清理会话的临时输出")!;
  const { snapshot } = await rpc.request("session/attach", { session_id: asking.session_id });
  let v = fromSnapshot(snapshot);
  const ended = new Promise<void>((resolve) =>
    rpc.on("session/event", ({ event }) => {
      v = applyEvent(v, event as Event);
      if (event.type === "approval_requested") void rpc.request("session/op", { session_id: asking.session_id, op: { type: "approval", call_id: event.call_id, decision: { type: "approve" } } });
      if (event.type === "task_completed") resolve();
    }),
  );
  await ended;
  const tools = conversation(v).flatMap((s) => (s.kind === "work" ? s.items : [])).filter((i) => i.kind === "tool");
  assert.ok(tools.every((t) => t.kind === "tool" && t.tool.state === "done"));
  assert.equal(statusOf(v), "idle");
});

test("an interrupt ends the task, keeping what was written", async () => {
  const server = new MockServer({ speed: 50 });
  const rpc = client(server);
  const { session_id, snapshot } = await rpc.request("session/new", { cwd: "/tmp/demo" });
  let v = fromSnapshot(snapshot);
  rpc.on("session/event", ({ event }) => void (v = applyEvent(v, event as Event)));
  await rpc.request("session/op", { session_id, op: { type: "prompt", input: [{ type: "text", text: "hi" }] } });
  await new Promise((r) => setTimeout(r, 40));
  await rpc.request("session/op", { session_id, op: { type: "interrupt" } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(statusOf(v), "idle");
  assert.equal(v.entries.at(-1)?.type, "task_end");
  const end = v.entries.at(-1);
  assert.ok(end?.type === "task_end" && end.outcome === "interrupted");
});
