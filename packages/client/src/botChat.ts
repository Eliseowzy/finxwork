import type { ErrorInfo } from "@finx/protocol";
import { runningAgents, type SessionView } from "./session.ts";
import { conversation, userText, type Step, type WorkItem } from "./steps.ts";

// A bot's conversation as Bot mode shows it (docs/kernel/bot-design.md §3.4):
// the owner's messages, each message the bot sent with send_to_user and
// failures, in the order they were sent. What the bot did and wrote for itself
// is the "process" of the message that followed it. An approval is no part of
// it: it pops up above the composer, as on a session's page.

export const SEND_TO_USER = "send_to_user";

export type BotItem =
  /** queued: sent while the bot was busy, not in its conversation yet. */
  | { kind: "user"; key: string; text: string; images: { mime_type: string; data: string }[]; files: string[]; skills: string[]; ts: number; queued: boolean }
  /** A message from the bot; process: what it did since its last message (or since the task began), took: how long that was. */
  | { kind: "bot"; key: string; text: string; ts: number; process: Step[]; took: number }
  /** last: no task ran since, so it can be retried. */
  | { kind: "failure"; key: string; error: ErrorInfo; ts: number; last: boolean };

/** When each message the bot sent was sent: the end of the reply that called send_to_user. */
function sendTimes(v: SessionView): Map<string, number> {
  const at = new Map<string, number>();
  for (const e of v.entries) {
    if (e.type !== "message" || e.message.role !== "assistant") continue;
    const done = e.message.ts + (e.message.duration_ms ?? 0);
    for (const c of e.message.content) if (c.type === "tool_call" && c.name === SEND_TO_USER) at.set(c.id, done);
  }
  return at;
}

/** A send_to_user call that reached the owner: it ran or is about to; failed, refused and cancelled ones did not. */
function delivered(item: WorkItem): string | null {
  if (item.kind !== "tool" || item.tool.name !== SEND_TO_USER) return null;
  if (item.tool.state === "failed" || item.tool.state === "denied" || item.tool.state === "cancelled" || item.tool.state === "streaming") return null;
  const text = item.tool.args.text;
  return typeof text === "string" && text.trim() !== "" ? text : null;
}

/** The conversation as bubbles and failure cards, oldest first. */
export function botChat(v: SessionView): BotItem[] {
  const times = sendTimes(v);
  const out: BotItem[] = [];
  let process: Step[] = [];
  let since: number | undefined;
  const keep = (s: Step) => process.push(s);
  for (const s of conversation(v)) {
    switch (s.kind) {
      case "user":
        out.push({ kind: "user", key: s.key, text: s.text, images: s.images, files: s.files, skills: s.skills, ts: s.ts, queued: false });
        since ??= s.ts;
        break;
      case "work": {
        // A work step splits where the bot sent a message: what came before is that message's process.
        let items: WorkItem[] = [];
        const flush = () => {
          if (items.length) keep({ kind: "work", key: items[0].key, items, live: items.some((i) => i.kind === "tool" && i.tool.state !== "done") });
          items = [];
        };
        for (const item of s.items) {
          const text = delivered(item);
          if (text === null) {
            if (!(item.kind === "tool" && item.tool.name === SEND_TO_USER)) items.push(item);
            continue;
          }
          flush();
          const ts = times.get(item.key) ?? since ?? Date.now();
          out.push({ kind: "bot", key: item.key, text, ts, process, took: since === undefined ? 0 : Math.max(0, ts - since) });
          process = [];
          since = ts;
        }
        flush();
        break;
      }
      case "text":
      case "agents":
      case "report":
        keep(s);
        break;
      case "end":
        if (s.end.outcome === "failed" && s.end.error) out.push({ kind: "failure", key: s.key, error: s.end.error, ts: s.end.ts, last: false });
        process = [];
        since = undefined;
        break;
      case "note":
        break;
    }
  }
  const lastFailure = out.findLastIndex((i) => i.kind === "failure");
  if (lastFailure >= 0 && !v.live && v.failure) out[lastFailure] = { ...(out[lastFailure] as Extract<BotItem, { kind: "failure" }>), last: true };
  for (const q of v.queued) {
    const { text, files } = userText(q.message.content);
    const images = q.message.content.flatMap((c) => (c.type === "image" ? [{ mime_type: c.mime_type, data: c.data }] : []));
    out.push({ kind: "user", key: q.id, text, images, files, skills: [], ts: q.message.ts, queued: true });
  }
  // In the order things were sent; the same time keeps the history's order.
  return out.map((item, i) => ({ item, i })).sort((a, b) => a.item.ts - b.item.ts || a.i - b.i).map((x) => x.item);
}

/** A sub-agent at work, as the busy bubble shows it. */
export interface WorkingAgent {
  id: string;
  /** What the bot called the work. */
  label: string;
}

/** What the busy bubble shows, or null when the bot is not busy: waiting for an approval alone is not busy. */
export function busyBubble(v: SessionView): { typing: boolean; agents: WorkingAgent[] } | null {
  const agents = runningAgents(v).map((a) => ({ id: a.id, label: a.description || a.name }));
  const typing = !!v.live && v.live.approvals.length === 0;
  return typing || agents.length > 0 ? { typing, agents } : null;
}

/** The steps of a bot message's process, counted as the process line shows them ("6 步"). */
export function processSteps(process: Step[]): number {
  return process.reduce((n, s) => n + (s.kind === "work" ? s.items.filter((i) => i.kind === "tool").length : s.kind === "agents" ? s.launches.length : s.kind === "report" ? 1 : 0), 0);
}
