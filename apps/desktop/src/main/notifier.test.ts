import assert from "node:assert/strict";
import { test } from "node:test";
import type { AlertSession } from "@finx/client";
import type { BotSummary } from "@finx/protocol";
import { Notifier } from "./notifier.ts";

const bot = (over: Partial<BotSummary> = {}): BotSummary => ({ id: "b", name: "小研", avatar: { kind: "mono", hue: "slate" }, created_at: "2026-11-04T00:00:00Z", ...over });
const said = (text: string, ts = "2026-11-04T01:00:00.000Z") => ({ from: "bot" as const, text, ts });
const session = (state: AlertSession["state"]): AlertSession => ({ session_id: "s", state, archived: false, cwd: "/w", no_project: false });

function setup(over: { front?: boolean; enabled?: boolean; sound?: boolean; sessionEnded?: boolean } = {}) {
  const state = { front: false, enabled: true, sound: true, sessionEnded: true, ...over };
  const log = { shown: [] as { kind: string; sound: boolean }[], clear: [] as string[], groups: [] as string[], badges: [] as number[] };
  const n = new Notifier({
    show: (alert, sound) => log.shown.push({ kind: alert.kind, sound }),
    clear: (ids) => log.clear.push(...ids),
    clearGroups: (g) => log.groups.push(...g),
    setBadge: (c) => log.badges.push(c),
    inFront: () => state.front,
    settings: () => state,
  });
  return { n, log, state };
}

test("the list's first arrival is what already was: nothing shows, the icon counts it", () => {
  const { n, log } = setup();
  n.botList([bot({ last: said("一"), unread: 2, waiting: "运行 ls" })]);
  n.sessionList([session("awaiting_approval")]);
  assert.deepEqual(log.shown, []);
  assert.deepEqual(log.badges, [2, 3]);
});

test("away from the app, a bot's message shows", () => {
  const { n, log } = setup();
  n.botList([bot()]);
  n.botsChanged([bot({ last: said("一"), unread: 1 })]);
  assert.deepEqual(log.shown, [{ kind: "bot_message", sound: true }]);
  assert.deepEqual(log.badges, [1]);
});

test("looking at the app, nothing shows but the number still moves", () => {
  const { n, log } = setup({ front: true });
  n.botList([bot()]);
  n.botsChanged([bot({ last: said("一"), unread: 1 })]);
  assert.deepEqual(log.shown, []);
  assert.deepEqual(log.badges, [1]);
});

test("what was read goes, whether or not the app is in front", () => {
  const { n, log } = setup({ front: true });
  n.botList([bot({ last: said("一"), unread: 1 })]);
  n.botsChanged([bot({ last: said("一") })]);
  assert.deepEqual(log.groups, ["bot:b"]);
});

test("switched off: nothing shows and the icon has no number; on again it counts", () => {
  const { n, log, state } = setup({ enabled: false });
  n.botList([bot()]);
  n.botsChanged([bot({ last: said("一"), unread: 1 })]);
  assert.deepEqual(log.shown, []);
  assert.deepEqual(log.badges, []);
  state.enabled = true;
  n.refresh();
  assert.deepEqual(log.badges, [1]);
  state.enabled = false;
  n.refresh();
  assert.deepEqual(log.badges, [1, 0]);
});

test("without sound the alert says so", () => {
  const { n, log } = setup({ sound: false });
  n.botList([bot()]);
  n.botsChanged([bot({ waiting: "运行 ls", unread: 1 })]);
  assert.deepEqual(log.shown, [{ kind: "bot_approval", sound: false }]);
});

test("a session's ending has its own switch; waiting and failing do not", () => {
  const { n, log } = setup({ sessionEnded: false });
  n.sessionList([session("running")]);
  n.sessionsChanged([session("idle")]);
  assert.equal(log.shown.length, 0);
  n.sessionsChanged([session("running")]);
  n.sessionsChanged([session("awaiting_approval")]);
  n.sessionsChanged([session("running")]);
  n.sessionsChanged([session("failed")]);
  assert.deepEqual(log.shown.map((s) => s.kind), ["session_approval", "session_failed"]);
});

test("a change before its list is ignored, as the list holds it", () => {
  const { n, log } = setup();
  n.botsChanged([bot({ last: said("一"), unread: 1 })]);
  n.sessionsChanged([session("awaiting_approval")]);
  assert.deepEqual(log.shown, []);
  assert.deepEqual(log.badges, []);
});

test("reconnecting: what came meanwhile is not repeated, later news still shows", () => {
  const { n, log } = setup();
  n.botList([bot()]);
  n.reconnected();
  n.botsChanged([bot({ last: said("路上"), unread: 1 })]);
  n.botList([bot({ last: said("路上"), unread: 1 })]);
  assert.equal(log.shown.length, 0);
  n.botsChanged([bot({ last: said("新的", "2026-11-04T02:00:00.000Z"), unread: 2 })]);
  assert.deepEqual(log.shown.map((s) => s.kind), ["bot_message"]);
});

test("a deleted bot or session takes what it had showing, and its share of the number", () => {
  const { n, log } = setup();
  n.botList([bot({ unread: 2 })]);
  n.sessionList([session("awaiting_approval")]);
  n.botsChanged([], ["b"]);
  n.sessionsChanged([], ["s"]);
  assert.deepEqual(log.groups, ["bot:b", "session:s"]);
  assert.deepEqual(log.badges, [2, 3, 1, 0]);
});
