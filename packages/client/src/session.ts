import type {
  AgentSnapshot, AgentStatus, Delta, ErrorInfo, Event, Location, PartialBlock, PartialMessage, PendingApproval, PermissionMode, SessionInfo,
  SessionSnapshot, TaskEndItem, ThinkingLevel, ToolCategory, TranscriptItem, UsageTotals, UserMessage, WarningCode,
} from "@finx/protocol";
import { addTotals, usageTokens } from "./text.ts";

// A session as the window knows it: the snapshot it attached with, and every
// event after it (protocol-design §3.5). Each event makes a new state; what
// it did not change stays the same object, so the page redraws only what
// changed.

/** Lines the client adds to the conversation that the protocol's history has no item for. */
export type NoteEntry =
  | { type: "note"; note: "compaction"; tokens_before: number; tokens_after: number; ts: number }
  | { type: "note"; note: "warning"; message: string; ts: number };

export type Entry = TranscriptItem | NoteEntry;

/**
 * A warning the kernel marks with a code: the page words it itself and keeps
 * it apart from the conversation, until the owner closes it or what it warns
 * about ends. One per code, the latest.
 */
export interface Notice {
  code: WarningCode;
  message: string;
  ts: number;
}

/** A tool call as tool_started describes it (or the client's own reading of its arguments). */
export interface ToolDescription {
  category: ToolCategory;
  title: string;
  locations?: Location[];
}

/** A tool call of the task in progress that has not completed. */
export interface LiveTool {
  call_id: string;
  name: string;
  category: ToolCategory;
  title: string;
  args: Record<string, unknown>;
  locations?: Location[];
  /** pending: before tool_running (preflight, or waiting its turn); denied: refused, no result yet. */
  phase: "pending" | "awaiting_approval" | "running" | "denied";
  /** The latest progress output. */
  progress: string;
}

export interface LiveTask {
  task_id: string;
  turn: number;
  /** When it started (ms); from the snapshot, the last user message's time. */
  started: number;
  streaming?: PartialMessage;
  tools: LiveTool[];
  /** In the order they were asked. */
  approvals: PendingApproval[];
  retry?: { attempt: number; delay_ms: number; error: ErrorInfo; at: number };
  compacting?: string;
  /** This task's usage so far, from its finished turns. */
  usage: UsageTotals;
}

export type SessionStatus = "idle" | "running" | "awaiting_approval" | "failed";

/**
 * A sub-agent of the session: what agent_started and agent_status said, and
 * its own session as its agent_events tell it (the same reducer builds both).
 */
export interface AgentView {
  id: string;
  name: string;
  /** The spawn_agent call that started it. */
  call_id: string;
  status: AgentStatus;
  /** When the status was last set (ms): a running agent's round of work started then. */
  since: number;
  /** The start of its last report. */
  summary?: string;
  usage?: UsageTotals;
  error?: ErrorInfo;
  /** How long its last finished round of work took. */
  elapsed_ms?: number;
  view: SessionView;
}

export interface SessionView {
  info: SessionInfo;
  lastSeq: number;
  entries: Entry[];
  /** Cursor to earlier history (session/history); absent at the beginning. */
  before?: string;
  live: LiveTask | null;
  /** The session's totals. */
  usage: UsageTotals;
  /** Tokens in the context after the last response. */
  context: number;
  /** The last task failed, and none ran since. */
  failure?: ErrorInfo;
  /** Tool calls as tool_started describes them, by call id. */
  descriptions: Record<string, ToolDescription>;
  /** What an interrupt handed back, for the composer. */
  returned?: UserMessage[];
  /** Warnings with a code, oldest first. */
  notices: Notice[];
  /** Sub-agents started since the session was loaded, in the order they started. */
  agents: AgentView[];
  closed: boolean;
}

const progressTail = 16 * 1024;

export function statusOf(v: SessionView): SessionStatus {
  if (v.live) return v.live.approvals.length > 0 ? "awaiting_approval" : "running";
  return v.failure ? "failed" : "idle";
}

/** The state a snapshot describes. */
export function fromSnapshot(s: SessionSnapshot): SessionView {
  const entries: Entry[] = s.transcript.items;
  const descriptions: Record<string, ToolDescription> = {};
  let context = 0;
  let lastUser = 0;
  for (const e of entries) {
    if (e.type !== "message") continue;
    if (e.message.role === "assistant") context = usageTokens(e.message.usage);
    if (e.message.role === "user") lastUser = e.message.ts;
  }
  const a = s.active_task;
  let live: LiveTask | null = null;
  if (a) {
    const approvals = a.approvals ?? [];
    const tools = a.tools ?? [];
    const asked = new Set(approvals.map((x) => x.call_id));
    for (const t of tools) descriptions[t.call_id] = { category: t.category, title: t.title };
    live = {
      task_id: a.task_id,
      turn: a.turn,
      started: lastUser || Date.now(),
      streaming: a.streaming ?? undefined,
      tools: tools.map((t) => ({
        call_id: t.call_id, name: t.name, category: t.category, title: t.title, args: argsOf(t.args),
        phase: asked.has(t.call_id) ? "awaiting_approval" : t.running ? "running" : "pending",
        progress: t.progress_tail ?? "",
      })),
      approvals,
      usage: { per_model: {} },
    };
  }
  const last = entries.at(-1);
  return {
    info: s.session,
    lastSeq: s.last_seq,
    entries,
    before: s.transcript.before ?? undefined,
    live,
    usage: s.usage,
    context,
    failure: !live && last?.type === "task_end" && last.outcome === "failed" ? (last.error ?? undefined) : undefined,
    descriptions,
    notices: [],
    agents: (s.agents ?? []).map((a) => agentFrom(s.session, a)),
    closed: false,
  };
}

/** A sub-agent from a snapshot: its own session shares the main one's settings. */
function agentFrom(info: SessionInfo, a: AgentSnapshot): AgentView {
  const own: SessionSnapshot = {
    session: { ...info, session_id: a.agent_id, session_file: a.session_file, title: a.name, archived: false },
    last_seq: 0,
    transcript: a.transcript,
    active_task: a.active_task,
    usage: a.usage ?? { per_model: {} },
  };
  return {
    id: a.agent_id,
    name: a.name,
    call_id: a.call_id,
    status: a.status,
    since: a.since,
    summary: a.summary ?? undefined,
    usage: a.usage ?? undefined,
    error: a.error ?? undefined,
    elapsed_ms: a.elapsed_ms ?? undefined,
    view: fromSnapshot(own),
  };
}

/** The sub-agents still working. */
export function runningAgents(v: SessionView): AgentView[] {
  return v.agents.filter((a) => a.status === "running");
}

/** The state after an event; the same state for one it already has (seq at or below what it holds). */
export function applyEvent(v: SessionView, e: Event): SessionView {
  if (e.seq <= v.lastSeq) return v;
  const next = step(v, e);
  return next === v ? { ...v, lastSeq: e.seq } : { ...next, lastSeq: e.seq };
}

/** Several events at once (a frame's worth). */
export function applyEvents(v: SessionView, events: Event[]): SessionView {
  return events.reduce(applyEvent, v);
}

function withLive(v: SessionView, f: (live: LiveTask) => LiveTask): SessionView {
  return v.live ? { ...v, live: f(v.live) } : v;
}

function withTool(v: SessionView, callId: string, f: (t: LiveTool) => LiveTool): SessionView {
  return withLive(v, (live) => ({ ...live, tools: live.tools.map((t) => (t.call_id === callId ? f(t) : t)) }));
}

function settings(info: SessionInfo, model: string, thinking: ThinkingLevel, permission_mode: PermissionMode, context_window: number): SessionInfo {
  return { ...info, model, thinking, permission_mode, context_window: context_window || info.context_window };
}

/** A tool call's arguments as an object (they always are one; the schema calls them any JSON). */
export function argsOf(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

function step(v: SessionView, e: Event): SessionView {
  switch (e.type) {
    case "session_started":
      return { ...v, info: { ...settings(v.info, e.model, e.thinking, e.permission_mode, e.context_window), cwd: e.cwd, session_file: e.session_file } };
    case "title_changed":
      return { ...v, info: { ...v.info, title: e.title } };
    case "archived_changed":
      return { ...v, info: { ...v.info, archived: e.archived } };
    case "task_started":
      return {
        ...v,
        failure: undefined,
        returned: undefined,
        live: { task_id: e.task_id, turn: 0, started: e.ts, tools: [], approvals: [], usage: { per_model: {} } },
      };
    case "turn_started":
      return withLive(v, (live) => ({ ...live, turn: e.turn, retry: undefined }));
    case "message_started":
      return e.role === "assistant" ? withLive(v, (live) => ({ ...live, streaming: { message_id: e.message_id, blocks: [] } })) : v;
    case "message_delta":
      return withLive(v, (live) => {
        const s = live.streaming?.message_id === e.message_id ? live.streaming : { message_id: e.message_id, blocks: [] };
        return { ...live, retry: undefined, streaming: { message_id: s.message_id, blocks: applyDelta(s.blocks, e.delta) } };
      });
    case "message_completed": {
      const m = e.message;
      const entries = [...v.entries, { type: "message" as const, message_id: e.message_id, message: m, mail: e.mail ?? undefined, skills: e.skills }];
      const context = m.role === "assistant" ? usageTokens(m.usage) : v.context;
      const live = v.live && v.live.streaming?.message_id === e.message_id ? { ...v.live, streaming: undefined } : v.live;
      return { ...v, entries, context, live };
    }
    case "stream_retry":
      return withLive(v, (live) => ({ ...live, retry: { attempt: e.attempt, delay_ms: e.delay_ms, error: e.error, at: e.ts } }));
    case "tool_started": {
      const d: ToolDescription = { category: e.category, title: e.title, locations: e.locations };
      const tool: LiveTool = { call_id: e.call_id, name: e.name, category: e.category, title: e.title, args: argsOf(e.args), locations: e.locations, phase: "pending", progress: "" };
      const next = { ...v, descriptions: { ...v.descriptions, [e.call_id]: d } };
      return withLive(next, (live) => ({ ...live, tools: [...live.tools.filter((t) => t.call_id !== e.call_id), tool] }));
    }
    case "approval_requested": {
      const { type: _, ...asked } = e;
      const next = withLive(v, (live) => ({ ...live, approvals: [...live.approvals.filter((a) => a.call_id !== e.call_id), withoutEventFields(asked)] }));
      return withTool(next, e.call_id, (t) => ({ ...t, phase: "awaiting_approval" }));
    }
    case "approval_resolved": {
      const refused = e.decision.type === "deny" || e.decision.type === "abort";
      const next = withLive(v, (live) => ({ ...live, approvals: live.approvals.filter((a) => a.call_id !== e.call_id) }));
      return withTool(next, e.call_id, (t) => ({ ...t, phase: refused ? "denied" : "pending" }));
    }
    case "tool_running":
      return withTool(v, e.call_id, (t) => ({ ...t, phase: "running" }));
    case "tool_progress":
      return withTool(v, e.call_id, (t) => ({ ...t, progress: (t.progress + e.text).slice(-progressTail) }));
    case "tool_completed": {
      const entries = [...v.entries, { type: "tool_result" as const, call_id: e.call_id, result: e.result }];
      return withLive({ ...v, entries }, (live) => ({ ...live, tools: live.tools.filter((t) => t.call_id !== e.call_id) }));
    }
    case "compaction_started":
      return withLive(v, (live) => ({ ...live, compacting: e.reason }));
    case "compaction_completed": {
      const note: NoteEntry = { type: "note", note: "compaction", tokens_before: e.tokens_before, tokens_after: e.tokens_after, ts: e.ts };
      return withLive({ ...v, entries: [...v.entries, note], context: e.tokens_after }, (live) => ({ ...live, compacting: undefined }));
    }
    case "turn_completed":
      return withLive(v, (live) => ({ ...live, usage: addTotals(live.usage, { per_model: { [v.info.model]: e.usage } }) }));
    case "task_completed":
      return endTask(v, { type: "task_end", task_id: e.task_id, outcome: "completed", reason: e.reason, usage: e.usage, ts: e.ts });
    case "task_failed":
      return { ...endTask(v, { type: "task_end", task_id: e.task_id, outcome: "failed", error: e.error, usage: e.usage, ts: e.ts }), failure: e.error };
    case "task_interrupted":
      return { ...endTask(v, { type: "task_end", task_id: e.task_id, outcome: "interrupted", usage: e.usage, ts: e.ts }), returned: e.returned_input };
    case "settings_changed": {
      const info = settings(v.info, e.model, e.thinking, e.permission_mode, e.context_window);
      // Out of bypass-permissions, its warning no longer holds.
      const notices = info.permission_mode === "bypass-permissions" ? v.notices : v.notices.filter((n) => n.code !== "bypass_permissions");
      return { ...v, info, notices: notices.length === v.notices.length ? v.notices : notices };
    }
    case "warning":
      if (e.code) {
        const notice = { code: e.code, message: e.message, ts: e.ts };
        return { ...v, notices: [...v.notices.filter((n) => n.code !== e.code), notice] };
      }
      return { ...v, entries: [...v.entries, { type: "note", note: "warning", message: e.message, ts: e.ts }] };
    case "agent_started": {
      const own: SessionSnapshot = {
        session: { ...v.info, session_id: e.agent_id, session_file: e.session_file, title: e.name, archived: false },
        last_seq: 0,
        transcript: { items: [] },
        usage: { per_model: {} },
      };
      const agent: AgentView = { id: e.agent_id, name: e.name, call_id: e.call_id, status: "running", since: e.ts, view: fromSnapshot(own) };
      return { ...v, agents: [...v.agents.filter((a) => a.id !== e.agent_id), agent] };
    }
    case "agent_status":
      return withAgent(v, e.agent_id, (a) =>
        // A new round keeps what the last one reported until it reports itself.
        e.status === "running"
          ? { ...a, status: e.status, since: e.ts }
          : { ...a, status: e.status, since: e.ts, summary: e.summary ?? undefined, usage: e.usage ?? undefined, error: e.error ?? undefined, elapsed_ms: e.elapsed_ms ?? undefined },
      );
    case "agent_event":
      return withAgent(v, e.agent_id, (a) => {
        const view = applyEvent(a.view, e.event);
        return view === a.view ? a : { ...a, view };
      });
    case "session_closed":
      return { ...v, live: null, closed: true };
    default:
      return v; // A newer kernel's event: ignored (technical-design §8.4).
  }
}

/** approval_requested without seq and ts: the fields a pending approval has. */
function withoutEventFields(e: PendingApproval & { seq?: number; ts?: number }): PendingApproval {
  const { seq: _s, ts: _t, ...rest } = e;
  return rest;
}

function withAgent(v: SessionView, id: string, f: (a: AgentView) => AgentView): SessionView {
  let changed = false;
  const agents = v.agents.map((a) => {
    if (a.id !== id) return a;
    const next = f(a);
    changed ||= next !== a;
    return next;
  });
  return changed ? { ...v, agents } : v;
}

function endTask(v: SessionView, end: TaskEndItem): SessionView {
  return { ...v, live: null, entries: [...v.entries, end], usage: end.usage ? addTotals(v.usage, end.usage) : v.usage };
}

/** A partial message's blocks with a delta added; blocks stay in index order. */
export function applyDelta(blocks: PartialBlock[], d: Delta): PartialBlock[] {
  const i = blocks.findIndex((b) => b.index === d.index);
  const b = i < 0 ? undefined : blocks[i];
  let out: PartialBlock;
  switch (d.type) {
    case "text":
    case "thinking":
      out = b && b.type === d.type ? { ...b, text: b.text + d.text } : { type: d.type, index: d.index, text: d.text };
      break;
    case "tool_call_start":
      out = { type: "tool_call", index: d.index, call_id: d.call_id, name: d.name, args_json: "" };
      break;
    case "tool_call_args":
      if (!b || b.type !== "tool_call") return blocks;
      out = { ...b, args_json: b.args_json + d.json };
      break;
  }
  if (i >= 0) return blocks.map((x, j) => (j === i ? out : x));
  return [...blocks, out].sort((x, y) => x.index - y.index);
}
