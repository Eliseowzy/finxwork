import type { GroupLast, GroupSummary } from "@finx/protocol";
import { plain } from "./bots.ts";

// What the group list shows (docs/kernel/bot-group-chat-dev-brief.md §5): rows worked out
// from the groups alone, so they can be checked without a window.

/** Each row's time, parsed once: sorting runs on every change of any group. */
const parsed = new WeakMap<GroupSummary, number>();

/** When the group last had a message, else when it was made: what the list sorts by. */
export function groupTime(g: GroupSummary): number {
  let t = parsed.get(g);
  if (t === undefined) parsed.set(g, (t = Date.parse(g.last?.ts ?? g.created_at) || 0));
  return t;
}

/** Pinned groups first, then the latest message first. Being busy moves nothing. */
export function sortGroups(list: GroupSummary[]): GroupSummary[] {
  return [...list].sort((a, b) => +!!b.pinned - +!!a.pinned || groupTime(b) - groupTime(a) || a.id.localeCompare(b.id));
}

/** The list with `groups/changed` applied: each group replaces its row or joins; deleted ones leave. */
export function mergeGroups(list: GroupSummary[], changed: GroupSummary[], deleted: string[] = []): GroupSummary[] {
  const out = list.filter((g) => !deleted.includes(g.id) && !changed.some((c) => c.id === g.id));
  return [...out, ...changed.filter((c) => !deleted.includes(c.id))];
}

/** A bot answering in the group: what the row and the title bar say. */
export function groupWorking(g: GroupSummary): boolean {
  return (g.typing?.length ?? 0) > 0;
}

/** The name of a member, for lines that name a bot. */
export function memberName(g: GroupSummary, botId: string): string {
  return g.members.find((m) => m.bot_id === botId)?.name ?? botId;
}

/** The row's second line, the first that applies: a fuse, who is answering, its last message. */
export type GroupLine =
  | { kind: "stopped"; text: string }
  | { kind: "typing"; names: string[] }
  | { kind: "last"; from: GroupLast["from"]; text: string; images: number; files: string[] }
  | { kind: "empty" };

export function groupLine(g: GroupSummary): GroupLine {
  if (g.stopped) return { kind: "stopped", text: g.stopped.detail };
  if (g.typing?.length) return { kind: "typing", names: g.typing.map((id) => memberName(g, id)) };
  if (!g.last) return { kind: "empty" };
  const { text, files } = lastLine(g.last);
  return { kind: "last", from: g.last.from, text, images: g.last.images ?? 0, files };
}

/** A last message's line: plain text, and the files it names. */
export function lastLine(last: GroupLast): { text: string; files: string[] } {
  const line = last.text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "") ?? "";
  return { text: last.from.kind === "bot" ? plain(line) : line, files: last.file ? [last.file] : [] };
}

/** The messages under a thread's first message, oldest first. */
export function threadMessages<T extends { id: string; seq: number; thread?: string | null }>(messages: T[], root: string): T[] {
  return messages.filter((m) => m.thread === root).sort((a, b) => a.seq - b.seq);
}