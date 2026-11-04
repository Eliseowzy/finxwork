import type {
  ActiveTask, AgentStatus, ContextReport, Methods, ApprovalDecision, MailInfo, PermissionMode, AssistantContent, ErrorInfo, EventMsg, Op, PromptMode, RpcErrorObject,
  SessionInfo, SessionSnapshot, SessionState, SessionSummary, ThinkingLevel, TranscriptItem, Usage, UserContent, UserMessage,
} from "@finx/protocol";
import { applyEvent, fromSnapshot, runningAgents, statusOf, type SessionView } from "../session.ts";
import { describe, userText } from "../steps.ts";
import { agentTask, agentsScenario, wantsAgents, type AgentsScenario } from "./agents.ts";
import { demoModels, demoSessions, demoSkills, demoSkillUses, replyScript, siteScript, steerScript, wantsSite, type DemoSession, type DemoTask } from "./data.ts";
import { CustomizeMock, Failure as CustomizeFailure } from "./customize.ts";
import { asks, type TaskScript, type ToolScript, type TurnScript } from "./script.ts";
import { snake } from "./snake.ts";

// A stand-in for `finx serve` (desktop-design §6.4): the native protocol's
// server side, with the proposed methods (§7), over NDJSON text. Tasks are
// scripted and played event by event as finx would send them; each session
// keeps its state with the client's own reducer, so a snapshot followed by
// the later events always rebuilds what a client that saw every event has.

/** Where a connection's text goes. */
export interface Peer {
  write(text: string): void;
}

export interface Connection {
  /** Text from the client: whole NDJSON lines. */
  receive(text: string): void;
  close(): void;
}

export interface MockOptions {
  /** Multiplies the pace of streaming and tools (default 1). */
  speed?: number;
  /** Plays nothing live (tests). */
  still?: boolean;
}

interface Conn {
  peer: Peer;
  attached: Set<string>;
  listening: boolean;
}

interface Run {
  cancelled: boolean;
  /** `steer_now`: the turn under way ends, and the task goes on. */
  cut?: boolean;
  approvals: Map<string, (d: ApprovalDecision) => void>;
  /** The assistant message being written, if one is (for an interrupt to complete it). */
  writing?: { message_id: string; content: AssistantContent[] };
  /** The turn's tool calls that have no result yet (for `steer_now` to end them). */
  pending?: { call_id: string; tool: ToolScript; started: boolean }[];
}

/** Input that waits for the running task, as finx keeps it. */
interface Waiting {
  id: string;
  mode: PromptMode;
  input: UserContent[];
  ts: number;
}

interface Session {
  id: string;
  view: SessionView;
  summary: SessionSummary;
  seq: number;
  run?: Run;
  /** Input waiting for the running task, in the order it came. */
  queue: Waiting[];
  tasks: number;
  /** A sub-agent's session: whose agent it is. Its events reach the main session as agent_event. */
  parent?: { root: Session; name: string };
  /** A main session's sub-agents. */
  children: Session[];
  /** Reports not yet in the conversation, oldest first. */
  mails: { text: string; mail: MailInfo; wake: boolean }[];
  /** The last task was stopped: reports wait for new input instead of starting a task. */
  held?: boolean;
  /** The sub-agent request this main session plays, until its answer starts. */
  scenario?: AgentsScenario;
  /** When a sub-agent's round of work started. */
  roundStart?: number;
  /** When the main session got busy, for lists while only its sub-agents work. */
  busySince?: number;
}

/** What a client following a sub-agent gets of its events, as finx sends them. */
const followed = new Set<string>([
  "task_started", "turn_started", "message_completed", "stream_retry", "tool_started", "tool_running", "tool_completed",
  "compaction_started", "compaction_completed", "compaction_failed", "turn_completed", "task_completed", "task_failed", "task_interrupted", "warning",
]);

/** A list's state: a session whose sub-agents work runs. */
function listState(v: SessionView): SessionState {
  const s = statusOf(v);
  return s === "idle" && runningAgents(v).length > 0 ? "running" : s;
}

class Failure extends Error {
  readonly error: RpcErrorObject;
  constructor(code: number, kind: string, message: string) {
    super(message);
    this.error = { code, message, data: { kind } };
  }
}

/** The rate limit a retried task waits out before it goes on. */
const rateLimited: ErrorInfo = { kind: "rate_limited", message: "429 Too Many Requests: Rate limit reached for deepseek-flash on tokens per min (TPM). Please try again in 4s.", status: 429, retryable: true };
const providerOf = (model: string) => model.split("/")[0] ?? model;
const iso = (ms: number) => new Date(ms).toISOString();
let counter = 0;
const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;
/** Waiting input in the order it joins: steering input first, each kind in the order it came. */
const ordered = (queue: Waiting[]) => [...queue.filter((x) => x.mode === "steer"), ...queue.filter((x) => x.mode === "follow_up")];

export class MockServer {
  private readonly sessions = new Map<string, Session>();
  private readonly conns = new Set<Conn>();
  private readonly speed: number;
  private readonly still: boolean;
  /** The clock events are stamped with; in the past while the demo's history is written. */
  private clock: number | null = null;
  /** Providers whose key was saved with auth/set. */
  private readonly stored = new Set<string>();
  /** Models shown or hidden with models/show. */
  private readonly selection = new Map<string, boolean>();
  /** When the demo's model lists were last asked (models/refresh). */
  private listedAt = "2026-10-30T08:00:00Z";
  /** The 自定义 page's skills, servers and configuration; its changes reach every connection. */
  private readonly customize = new CustomizeMock((method, params) => {
    const line = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    for (const c of this.conns) c.peer.write(line);
  });

  constructor(o: MockOptions = {}) {
    this.speed = o.speed ?? 1;
    this.still = o.still ?? false;
    this.addSnake();
    for (const d of demoSessions()) this.addDemo(d);
    this.addAgentsDemo();
  }

  connect(peer: Peer): Connection {
    const c: Conn = { peer, attached: new Set(), listening: false };
    this.conns.add(c);
    return {
      receive: (text) => {
        for (const line of text.split("\n")) if (line.trim() !== "") this.handle(c, line);
      },
      close: () => this.conns.delete(c),
    };
  }

  // ---- the demo's sessions ----

  private now(): number {
    return this.clock ?? Date.now();
  }

  private create(id: string, cwd: string, model: string, thinking: ThinkingLevel, permission_mode: PermissionMode, at: number, no_project = false): Session {
    const info: SessionInfo = {
      session_id: id,
      cwd,
      session_file: `~/.finx/sessions/${new Date(at).toISOString().slice(0, 10)}/${id}.jsonl`,
      model,
      thinking,
      permission_mode,
      context_window: contextWindow(model),
      archived: false,
    };
    const view = fromSnapshot({ session: info, last_seq: 0, transcript: { items: [] }, usage: { per_model: {} } });
    const summary: SessionSummary = {
      session_id: id, cwd, no_project, created_at: iso(at), updated_at: iso(at), loaded: true, busy: false, attached_clients: 0, state: "idle", model, archived: false,
    };
    const s: Session = { id, view, summary, seq: 0, queue: [], tasks: 0, children: [], mails: [] };
    this.sessions.set(id, s);
    return s;
  }

  /** A session that asks for sub-agents, playing from the start (not in tests). */
  private addAgentsDemo() {
    const s = this.create("0193f7c1-4d2e-7a90-8b1c-2e3f4a5b6c7d", "~/CodeSpace/calc-lib", "deepseek/deepseek-flash", "off", "bypass-permissions", Date.now() - 2 * 60_000);
    s.summary = { ...s.summary, title: "给 calc 的三个模块补测试" };
    if (!this.still) this.prompt(s, [{ type: "text", text: "calc 包里有 mathutil、textutil、listutil 三个互不相关的模块。请用子智能体并行地分别给它们补单元测试（unittest，每个模块至少 20 个用例），保证全部通过，最后汇总告诉我结果。" }]);
  }

  private addSnake() {
    const s = this.create(snake.session_id, snake.cwd, snake.model, snake.thinking, snake.permission_mode, snake.first_ts);
    const items: TranscriptItem[] = [
      ...snake.items,
      { type: "task_end", task_id: "t1", outcome: "completed", reason: "done", usage: snake.usage, ts: snake.last_ts },
    ];
    s.view = fromSnapshot({ session: s.view.info, last_seq: 0, transcript: { items: items as TranscriptItem[] }, usage: snake.usage });
    const first = snake.items[0];
    const preview = first?.type === "message" && first.message.role === "user" ? textOf(first.message.content) : "";
    s.summary = { ...s.summary, title: "贪吃蛇小游戏", preview: preview.slice(0, 120), updated_at: iso(snake.last_ts) };
  }

  private addDemo(d: DemoSession) {
    const start = Date.now() - d.ago;
    const s = this.create(d.id, d.cwd, d.model, d.thinking, d.permission_mode, start, d.no_project);
    this.clock = start;
    for (const t of d.history) this.playNow(s, t, t.script.turns.length);
    if (d.live) {
      this.playNow(s, d.live, d.live.played, true);
      if (!this.still) void this.play(s, d.live.script, d.live.played);
    }
    this.clock = null;
    s.summary = { ...s.summary, title: d.title, archived: d.archived ?? false };
  }

  /** Writes a task's first turns at once, as history (the clock moves on a little per event). */
  private playNow(s: Session, t: DemoTask, turns: number, keepGoing = false) {
    const run: Run = { cancelled: false, approvals: new Map() };
    s.run = run;
    this.startTask(s, [{ type: "text", text: t.prompt }]);
    t.script.turns.slice(0, turns).forEach((turn, i) => this.turnNow(s, turn, i + 1));
    if (keepGoing) return;
    if (t.interrupted) this.interrupt(s);
    else this.endTask(s, t.script.fail);
  }

  private turnNow(s: Session, turn: TurnScript, n: number) {
    const task_id = s.view.live!.task_id;
    this.emit(s, { type: "turn_started", task_id, turn: n });
    const message_id = newId("m");
    const content = this.contentOf(turn);
    this.emit(s, { type: "message_started", message_id, role: "assistant" });
    this.complete(s, message_id, content, turn.tools?.length ? "tool_use" : "stop");
    const calls = content.filter((c) => c.type === "tool_call");
    for (const [k, tool] of (turn.tools ?? []).entries()) {
      const call_id = calls[k].id;
      this.toolStarted(s, call_id, tool);
      this.emit(s, { type: "tool_running", call_id });
      this.toolCompleted(s, call_id, tool);
    }
    this.emit(s, { type: "turn_completed", task_id, turn: n, usage: usageFor(s.view.info.model, turn) });
  }

  // ---- events ----

  private emit(s: Session, msg: EventMsg) {
    if (s.parent) return this.emitAgent(s, msg);
    if (this.clock !== null) this.clock += 700 + Math.round(Math.random() * 1600);
    const event = { seq: ++s.seq, ts: this.now(), ...msg };
    const before = listState(s.view);
    s.view = applyEvent(s.view, event);
    const line = JSON.stringify({ jsonrpc: "2.0", method: "session/event", params: { session_id: s.id, event } }) + "\n";
    for (const c of this.conns) if (c.attached.has(s.id)) c.peer.write(line);
    // The list hears of what a row shows: its state, title, model, time. The time is the last
    // task's start or end, as finx keeps it: opening or changing settings is not activity.
    const after = listState(s.view);
    const changed = before !== after || msg.type === "message_completed" || msg.type === "settings_changed" || msg.type === "task_started";
    const active = msg.type === "task_started" || msg.type === "task_completed" || msg.type === "task_failed" || msg.type === "task_interrupted";
    // As finx's lists: running while sub-agents work, timed from when the work began.
    const busy = after !== "idle" && after !== "failed";
    s.busySince = busy ? (s.busySince ?? s.view.live?.started ?? event.ts) : undefined;
    s.summary = {
      ...s.summary,
      updated_at: active ? iso(event.ts) : s.summary.updated_at,
      busy: s.view.live !== null || runningAgents(s.view).length > 0,
      state: after,
      model: s.view.info.model,
      task_started_at: busy && s.busySince !== undefined ? iso(s.busySince) : undefined,
    };
    if (changed) this.listChanged(s);
  }

  /** A sub-agent's event: its own state, and the main session hears what changes its conversation. */
  private emitAgent(s: Session, msg: EventMsg) {
    if (this.clock !== null) this.clock += 700 + Math.round(Math.random() * 1600);
    const event = { seq: ++s.seq, ts: this.now(), ...msg };
    s.view = applyEvent(s.view, event);
    if (followed.has(msg.type)) this.emit(s.parent!.root, { type: "agent_event", agent_id: s.id, event });
  }

  private listChanged(s: Session, deleted: string[] = []) {
    if (this.clock !== null) return;
    const line = JSON.stringify({ jsonrpc: "2.0", method: "sessions/changed", params: { sessions: deleted.length ? [] : [s.summary], deleted } }) + "\n";
    for (const c of this.conns) if (c.listening) c.peer.write(line);
  }

  /** Tells every connection the models changed, as finx does after a key, a refresh or a menu change. */
  private notifyModels() {
    const line = JSON.stringify({ jsonrpc: "2.0", method: "models/changed", params: {} }) + "\n";
    for (const c of this.conns) c.peer.write(line);
  }

  private startTask(s: Session, input: UserContent[], id = newId("u")) {
    s.tasks++;
    const task_id = `t${s.tasks}`;
    this.emit(s, { type: "task_started", task_id });
    // Reports that waited come before the owner's message, as in finx.
    s.held = false;
    this.deliver(s);
    // The preview first, so the list hears of it with the message.
    if (!s.summary.preview) s.summary = { ...s.summary, preview: userText(input).text.slice(0, 120) };
    this.emit(s, { type: "message_completed", message_id: id, message: { role: "user", content: input, ts: this.now() }, skills: demoSkillUses(userText(input).text) });
  }

  /** The queue as finx announces it: steering input first, each kind in the order it came. */
  private queueChanged(s: Session) {
    const queued = ordered(s.queue).map((x) => ({ id: x.id, mode: x.mode, message: { content: x.input, ts: x.ts } }));
    this.emit(s, { type: "queue_changed", queued });
  }

  /** Takes waiting input of one kind out of the queue: all of it, or the first. */
  private take(s: Session, mode: PromptMode, all: boolean): Waiting[] {
    const taken = s.queue.filter((x) => x.mode === mode).slice(0, all ? undefined : 1);
    if (taken.length === 0) return taken;
    s.queue = s.queue.filter((x) => !taken.includes(x));
    this.queueChanged(s);
    return taken;
  }

  /** Waiting input joins the history, under its id. */
  private join(s: Session, x: Waiting) {
    this.emit(s, { type: "message_completed", message_id: x.id, message: { role: "user", content: x.input, ts: x.ts }, skills: demoSkillUses(userText(x.input).text) });
  }

  /** A task that ends early hands what still waits back, in the order it would have joined. */
  private handBack(s: Session): UserMessage[] {
    if (s.queue.length === 0) return [];
    const back = ordered(s.queue).map((x) => ({ content: x.input, ts: x.ts }));
    s.queue = [];
    this.queueChanged(s);
    return back;
  }

  private endTask(s: Session, fail?: ErrorInfo) {
    const live = s.view.live;
    if (!live) return;
    if (fail) this.emit(s, { type: "task_failed", task_id: live.task_id, error: fail, usage: live.usage, returned_input: this.handBack(s) });
    else {
      const last = [...s.view.entries].reverse().find((e) => e.type === "message" && e.message.role === "assistant");
      const last_message = last?.type === "message" ? textOf(last.message.content) : undefined;
      this.emit(s, { type: "task_completed", task_id: live.task_id, usage: live.usage, last_message, reason: "done" });
    }
    s.run = undefined;
    if (s.parent) return this.agentDone(s, fail ? "failed" : "completed");
    // P3: a title once the first task is done.
    if (!s.summary.title && s.summary.preview) {
      s.summary = { ...s.summary, title: shortTitle(s.summary.preview) };
      this.listChanged(s);
    }
  }

  private interrupt(s: Session) {
    // Stopping the main session stops every sub-agent; their reports wait for new input.
    if (!s.parent) for (const c of s.children) this.interrupt(c);
    const live = s.view.live;
    const run = s.run;
    if (!live || !run) return void this.settle(s);
    run.cancelled = true;
    for (const resolve of run.approvals.values()) resolve({ type: "abort" });
    if (run.writing) {
      this.complete(s, run.writing.message_id, run.writing.content, "aborted");
      run.writing = undefined;
    }
    this.emit(s, { type: "task_interrupted", task_id: live.task_id, returned_input: this.handBack(s), usage: live.usage });
    s.run = undefined;
    if (s.parent) return this.agentDone(s, "interrupted");
    s.held = true;
    this.settle(s);
  }

  // ---- sub-agents ----

  /** spawn_agent's call completed: the agent starts, in the background. Its result's details. */
  private spawnAgent(root: Session, call_id: string, t: ToolScript): Record<string, unknown> {
    const name = typeof t.args.name === "string" ? t.args.name : "agent";
    const description = typeof t.args.description === "string" ? t.args.description : "";
    const task = typeof t.args.task === "string" ? t.args.task : "";
    const script = root.scenario?.agents.find((a) => a.name === name)?.script ?? { turns: [{ say: "完成了。" }] };
    const id = crypto.randomUUID();
    const session_file = root.view.info.session_file.replace(/[^/]*\.jsonl$/, `${id}.jsonl`);
    const info: SessionInfo = { ...root.view.info, session_id: id, session_file, title: description || name, archived: false };
    const view = fromSnapshot({ session: info, last_seq: 0, transcript: { items: [] }, usage: { per_model: {} } });
    const child: Session = { id, view, summary: root.summary, seq: 0, queue: [], tasks: 0, children: [], mails: [], parent: { root, name }, roundStart: this.now() };
    root.children.push(child);
    this.emit(root, { type: "agent_started", agent_id: id, name, description, session_file, call_id });
    child.run = { cancelled: false, approvals: new Map() };
    this.startTask(child, [{ type: "text", text: agentTask(name, task) }]);
    void this.play(child, script);
    return { agent_id: id, name, session_file, status: "running", background: true, reported: false };
  }

  /** A sub-agent's task ended: its status, and its report as mail for the main session. */
  private agentDone(child: Session, status: AgentStatus) {
    const root = child.parent!.root;
    const name = child.parent!.name;
    const last = [...child.view.entries].reverse().find((e) => e.type === "message" && e.message.role === "assistant" && textOf(e.message.content).trim() !== "");
    // Like the kernel: with no reply, the report only tells the model so, and the mail says it had none.
    const replied = last?.type === "message";
    const body = replied ? textOf(last.message.content) : status === "interrupted" ? "(It had not replied yet.)" : "(It finished without a reply.)";
    const elapsed_ms = this.now() - (child.roundStart ?? this.now());
    this.emit(root, { type: "agent_status", agent_id: child.id, name, status, summary: replied ? body.slice(0, 200) : null, usage: child.view.usage, elapsed_ms });
    const note = status === "interrupted" ? "\nIt keeps its work and context: send_message lets it continue where it stopped." : "";
    root.mails.push({
      text: `<agent_report agent="${name}" status="${status}">\n${body}\n</agent_report>${note}`,
      mail: { id: newId("mail"), from: { id: child.id, name }, kind: "report", status, ...(replied ? {} : { no_reply: true }) },
      wake: status === "completed" || status === "failed",
    });
    if (!root.view.live) this.settle(root);
  }

  /** The reports waiting, into the conversation; who sent them. */
  private deliver(s: Session): string[] {
    const mails = s.mails.splice(0);
    for (const m of mails) {
      this.emit(s, { type: "message_completed", message_id: m.mail.id, message: { role: "user", content: [{ type: "text", text: m.text }], ts: this.now() }, mail: m.mail });
    }
    return mails.map((m) => m.mail.from.name);
  }

  /** The main session has nothing running: a report that wakes it starts a task; else, once its agents rest, it is idle. */
  private settle(s: Session) {
    if (s.parent || s.view.live || s.queue.length > 0) return;
    if (!s.held && s.mails.some((m) => m.wake)) return this.wake(s);
    if (runningAgents(s.view).length === 0) this.emit(s, { type: "idle" });
  }

  /** Reports start a task: what the model says on them, or its answer once all are in. */
  private wake(s: Session) {
    s.run = { cancelled: false, approvals: new Map() };
    s.tasks++;
    this.emit(s, { type: "task_started", task_id: `t${s.tasks}`, trigger: "mail" });
    const names = this.deliver(s);
    const sc = s.scenario;
    const done = s.view.agents.length > 0 && s.view.agents.every((a) => a.status === "completed");
    let script: TaskScript;
    if (sc && done) {
      script = sc.final;
      s.scenario = undefined;
    } else {
      script = { turns: [{ say: names.map((n) => sc?.reactions[n] ?? `${n} 汇报了。`).join("\n\n") }] };
    }
    void this.play(s, script);
  }

  private contentOf(turn: TurnScript): AssistantContent[] {
    const out: AssistantContent[] = [];
    if (turn.think) out.push({ type: "thinking", text: turn.think });
    if (turn.say) out.push({ type: "text", text: turn.say });
    for (const t of turn.tools ?? []) out.push({ type: "tool_call", id: newId("call_"), name: t.name, arguments: t.args });
    return out;
  }

  private complete(s: Session, message_id: string, content: AssistantContent[], stop: "stop" | "tool_use" | "aborted") {
    const model = s.view.info.model;
    const i = model.indexOf("/");
    this.emit(s, {
      type: "message_completed",
      message_id,
      message: {
        role: "assistant", content, provider: providerOf(model), api: "openai-chat", model: i < 0 ? model : model.slice(i + 1),
        usage: usageFor(model, { say: content.map((c) => (c.type === "tool_call" ? "" : c.text)).join("") }), stop_reason: stop, ts: this.now(),
      },
    });
  }

  private toolStarted(s: Session, call_id: string, t: ToolScript) {
    const d = describe(t.name, t.args, s.view.info.cwd);
    this.emit(s, { type: "tool_started", call_id, name: t.name, args: t.args, category: d.category, title: d.title });
  }

  private toolCompleted(s: Session, call_id: string, t: ToolScript, denied?: string) {
    const text = denied ?? t.output;
    // As in finx, a sub-agent starts when its spawn_agent call completes.
    const details = t.name === "spawn_agent" && denied === undefined && !s.parent ? this.spawnAgent(s, call_id, t) : undefined;
    this.emit(s, {
      type: "tool_completed",
      call_id,
      result: { call_id, tool_name: t.name, content: [{ type: "text", text }], is_error: denied !== undefined || t.error === true, ts: this.now(), duration_ms: t.ms, details },
    });
  }

  // ---- playing a task live ----

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms / this.speed));
  }

  /** Plays a script's turns from `from`, in the task that is running (started by the caller). */
  private async play(s: Session, script: TaskScript, from = 0) {
    const run = s.run;
    if (!run) return;
    const task_id = s.view.live!.task_id;
    for (let attempt = 1; from === 0 && attempt <= (script.retries?.count ?? 0); attempt++) {
      const delay_ms = 3000 + attempt * 1000;
      this.emit(s, { type: "stream_retry", attempt, delay_ms, error: script.retries!.error });
      await this.sleep(delay_ms);
      if (run.cancelled) return;
    }
    for (let i = from; ; i++) {
      if (i >= script.turns.length) {
        // The task would end here: a follow-up goes in, and the same task goes on.
        const [next] = this.take(s, "follow_up", false);
        if (!next) break;
        this.join(s, next);
        script = { ...script, turns: [...script.turns, ...replyScript(userText(next.input).text).turns] };
      }
      await this.sleep(500 + Math.random() * 500);
      if (run.cancelled) return;
      // Steering input joins at the turn boundary, all of it, and is answered first.
      const steers = this.take(s, "steer", true);
      if (steers.length > 0) {
        for (const x of steers) this.join(s, x);
        const answer = steerScript(steers.map((x) => userText(x.input).text).join("；")).turns;
        script = { ...script, turns: [...script.turns.slice(0, i), ...answer, ...script.turns.slice(i)] };
      }
      const turn = script.turns[i];
      this.emit(s, { type: "turn_started", task_id, turn: i + 1 });
      const ok = await this.playTurn(s, run, turn, i + 1);
      if (run.cancelled) return;
      if (!ok) {
        if (!run.cut) return;
        this.endCut(s, run, turn, i + 1);
      }
    }
    await this.sleep(300);
    if (run.cancelled) return;
    this.endTask(s, script.fail);
    // Input that came after the last boundary starts the next task, steering input first.
    const next = this.take(s, "steer", false)[0] ?? this.take(s, "follow_up", false)[0];
    if (next) this.prompt(s, next.input, undefined, next.id);
    else this.settle(s);
  }

  /** `steer_now` ended the turn under way: what was written stays, the calls without a result end, and the task goes on. */
  private endCut(s: Session, run: Run, turn: TurnScript, n: number) {
    run.cut = false;
    if (run.writing) {
      // As finx keeps a reply cut short: its words, not calls that may be incomplete.
      this.complete(s, run.writing.message_id, run.writing.content.filter((c) => c.type !== "tool_call"), "aborted");
      run.writing = undefined;
    }
    for (const p of run.pending ?? []) {
      if (!p.started) this.toolStarted(s, p.call_id, p.tool);
      this.toolCompleted(s, p.call_id, p.tool, p.started ? "Cancelled by user." : "Tool call was not executed (interrupted).");
    }
    run.pending = undefined;
    this.emit(s, { type: "turn_completed", task_id: s.view.live!.task_id, turn: n, usage: usageFor(s.view.info.model, turn) });
  }

  private async playTurn(s: Session, run: Run, turn: TurnScript, n: number): Promise<boolean> {
    const message_id = newId("m");
    const content = this.contentOf(turn);
    const writing: Run["writing"] = { message_id, content: [] };
    run.writing = writing;
    const stopped = () => run.cancelled || run.cut === true;
    this.emit(s, { type: "message_started", message_id, role: "assistant" });
    await this.sleep(350);
    for (const [index, c] of content.entries()) {
      if (stopped()) return false;
      if (c.type === "tool_call") {
        this.emit(s, { type: "message_delta", message_id, delta: { type: "tool_call_start", index, call_id: c.id, name: c.name } });
        const json = JSON.stringify(c.arguments);
        for (let k = 0; k < json.length; k += 48) {
          await this.sleep(25);
          if (stopped()) return false;
          this.emit(s, { type: "message_delta", message_id, delta: { type: "tool_call_args", index, json: json.slice(k, k + 48) } });
        }
        writing.content.push(c);
        continue;
      }
      writing.content.push({ ...c, text: "" });
      for (const piece of chunks(c.text)) {
        await this.sleep(c.type === "thinking" ? 14 + Math.random() * 20 : 22 + Math.random() * 30);
        if (stopped()) return false;
        (writing.content.at(-1) as { text: string }).text += piece;
        this.emit(s, { type: "message_delta", message_id, delta: { type: c.type, index, text: piece } });
      }
    }
    run.writing = undefined;
    this.complete(s, message_id, content, turn.tools?.length ? "tool_use" : "stop");
    const calls = content.filter((c) => c.type === "tool_call");
    const pending: NonNullable<Run["pending"]> = (turn.tools ?? []).map((tool, k) => ({ call_id: calls[k].id, tool, started: false }));
    run.pending = pending;
    const done = (k: number) => (run.pending = run.pending?.filter((p) => p !== pending[k]));
    for (const [k, t] of (turn.tools ?? []).entries()) {
      const call_id = calls[k].id;
      this.toolStarted(s, call_id, t);
      pending[k].started = true;
      if (t.approval && (t.approval.own_browser || asks(s.view.info.permission_mode, describe(t.name, t.args, s.view.info.cwd).category))) {
        const d = describe(t.name, t.args, s.view.info.cwd);
        this.emit(s, { type: "approval_requested", call_id, name: t.name, args: t.args, summary: t.approval.summary || d.title, reason: t.approval.reason, proposed_grants: t.approval.grants, ...(t.approval.own_browser ? { own_browser: true } : {}) });
        const decision = await new Promise<ApprovalDecision>((resolve) => run.approvals.set(call_id, resolve));
        run.approvals.delete(call_id);
        if (stopped()) return false;
        this.emit(s, { type: "approval_resolved", call_id, decision });
        if (decision.type === "abort") {
          this.interrupt(s);
          return false;
        }
        if (decision.type === "deny") {
          this.toolCompleted(s, call_id, t, `Denied by user${decision.feedback ? `: ${decision.feedback}` : "."}`);
          done(k);
          continue;
        }
      }
      await this.sleep(120);
      if (stopped()) return false;
      this.emit(s, { type: "tool_running", call_id });
      const lines = t.progress ?? [];
      const ms = t.ms ?? 400;
      for (const line of lines) {
        await this.sleep(ms / Math.max(1, lines.length));
        if (stopped()) return false;
        this.emit(s, { type: "tool_progress", call_id, text: line });
      }
      if (!lines.length) await this.sleep(ms);
      if (stopped()) return false;
      this.toolCompleted(s, call_id, t);
      done(k);
    }
    run.pending = undefined;
    this.emit(s, { type: "turn_completed", task_id: s.view.live!.task_id, turn: n, usage: usageFor(s.view.info.model, turn) });
    return true;
  }

  private prompt(s: Session, input: UserContent[], script?: TaskScript, id?: string) {
    const text = userText(input).text;
    // `/context`: a task of its own that only reports, as finx runs it.
    if (/^\s*\/context(\s|$)/.test(text)) {
      s.tasks++;
      const task_id = `t${s.tasks}`;
      this.emit(s, { type: "task_started", task_id });
      this.emit(s, { type: "context_reported", report: contextReport(s.view) });
      this.emit(s, { type: "task_completed", task_id, usage: { per_model: {} }, reason: "done" });
      return;
    }
    if (!script && wantsAgents(text)) {
      const sc = agentsScenario();
      s.scenario = sc;
      // Asked with 额度 (quota): the account runs out once they work, and only the main agent stops.
      script = /额度|quota/i.test(text)
        ? { turns: sc.lead, fail: { kind: "quota_exceeded", message: "Insufficient balance: please top up your account.", status: 402, retryable: false } }
        : { turns: [...sc.lead, { say: sc.started }] };
    }
    if (!script && wantsSite(text)) script = siteScript();
    script = this.unkeyed(s) ?? script ?? replyScript(text);
    s.run = { cancelled: false, approvals: new Map() };
    this.startTask(s, input, id);
    void this.play(s, script);
  }

  // ---- requests ----

  private handle(c: Conn, line: string) {
    let msg: { id?: number | string; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(line);
    } catch {
      return this.reply(c, null, undefined, { code: -32700, message: "parse error", data: { kind: "parse_error" } });
    }
    if (msg.method === undefined) return;
    const id = msg.id;
    if (id === undefined) return; // A notification: $/cancel_request has nothing to cancel here.
    // Answered at once: a response must reach the client before any event that follows it (protocol-design §6.5).
    const failed = (e: unknown): RpcErrorObject =>
      e instanceof Failure
        ? e.error
        : e instanceof CustomizeFailure
          ? { code: e.code, message: e.message, data: { kind: e.kind, ...e.extra } }
          : { code: -32603, message: String(e), data: { kind: "internal_error" } };
    try {
      const result: unknown = this.call(c, msg.method as keyof Methods, (msg.params ?? {}) as never);
      // A check takes its time; everything else answers at once.
      if (result instanceof Promise) result.then((r) => this.reply(c, id, r), (e) => this.reply(c, id, undefined, failed(e)));
      else this.reply(c, id, result);
    } catch (e) {
      this.reply(c, id, undefined, failed(e));
    }
  }

  private reply(c: Conn, id: number | string | null, result?: unknown, error?: RpcErrorObject) {
    c.peer.write(JSON.stringify(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result: result ?? {} }) + "\n");
  }

  private session(id: unknown): Session {
    const s = typeof id === "string" ? this.sessions.get(id) : undefined;
    if (!s) throw new Failure(-32002, "session_not_found", `no session ${String(id)}`);
    return s;
  }

  private call<M extends keyof Methods>(c: Conn, method: M, p: Methods[M][0]): Methods[M][1] {
    type P<K extends keyof Methods> = Methods[K][0];
    type R<K extends keyof Methods> = Methods[K][1];
    switch (method) {
      case "initialize": {
        const capabilities = { max_frame_bytes: 33_554_432, session_delete: true, resource_read: false, event_filter: false, sessions_subscribe: true, session_metadata: true, transcript_task_end: true, auth: true, agents: true, model_connections: false, model_discovery: true, customize: true, embedded_browser: false, input_queue: true, workbooks: true };
        return { protocol_version: 2, server_info: { name: "finx", version: "0.1.0-mock" }, capabilities } satisfies R<"initialize">;
      }
      case "sessions/subscribe":
        c.listening = true;
        return { sessions: this.summaries() } satisfies R<"sessions/subscribe">;
      case "sessions/unsubscribe":
        c.listening = false;
        return {};
      case "session/list":
        return { sessions: this.summaries() } satisfies R<"session/list">;
      case "models/list":
        return demoModels(this.stored, this.selection, this.listedAt) satisfies R<"models/list">;
      case "models/refresh":
        this.listedAt = new Date().toISOString();
        this.notifyModels();
        return { providers: demoModels(this.stored, this.selection, this.listedAt).providers } satisfies R<"models/refresh">;
      case "models/show": {
        const q = p as P<"models/show">;
        if (!demoModels(new Set([...this.stored, "anthropic", "kimi"])).models.some((m) => m.id === q.model)) throw new Failure(-32602, "invalid_params", `unknown model '${q.model}'`);
        this.selection.set(q.model, q.shown);
        this.notifyModels();
        return {} satisfies R<"models/show">;
      }
      // A session's skills are the demo's; a folder's, those of the 自定义 page.
      case "skills/list":
        return ((p as P<"skills/list">).session_id ? demoSkills() : this.customize.skillsList()) satisfies R<"skills/list">;
      case "skills/install":
        return this.customize.skillsInstall(p as P<"skills/install">) satisfies R<"skills/install">;
      case "skills/remove":
        return this.customize.skillsRemove((p as P<"skills/remove">).path) satisfies R<"skills/remove">;
      case "skills/set_enabled": {
        const q = p as P<"skills/set_enabled">;
        return this.customize.skillsSetEnabled(q.path, q.enabled) satisfies R<"skills/set_enabled">;
      }
      case "skills/files":
        return this.customize.skillsFiles((p as P<"skills/files">).path) satisfies R<"skills/files">;
      case "skills/read": {
        const q = p as P<"skills/read">;
        return this.customize.skillsRead(q.path, q.file) satisfies R<"skills/read">;
      }
      case "config/read":
        return this.customize.configRead(!!(p as P<"config/read">).layers) satisfies R<"config/read">;
      case "browser/status":
        return this.customize.browserStatus() satisfies R<"browser/status">;
      case "browser/site_icon":
        return {} satisfies R<"browser/site_icon">;
      case "config/write": {
        const q = p as P<"config/write">;
        return this.customize.configWrite(q.layer, q.edits, q.expected_version) satisfies R<"config/write">;
      }
      case "credentials/set":
        return this.customize.credentialsSet((p as P<"credentials/set">).name) satisfies R<"credentials/set">;
      case "credentials/delete":
        return this.customize.credentialsDelete((p as P<"credentials/delete">).name) satisfies R<"credentials/delete">;
      case "mcp/list":
        return this.customize.mcpList() satisfies R<"mcp/list">;
      case "mcp/tools":
        return this.customize.mcpTools((p as P<"mcp/tools">).name) satisfies R<"mcp/tools">;
      case "mcp/check":
        return this.customize.mcpCheck((p as P<"mcp/check">).name) satisfies R<"mcp/check">;
      case "mcp/probe":
        return this.customize.mcpProbe(p as P<"mcp/probe">) as unknown as R<"mcp/probe">;
      case "mcp/probe_cancel":
        return {} satisfies R<"mcp/probe_cancel">;
      case "mcp/login":
        return this.customize.mcpLogin(p as P<"mcp/login">) satisfies R<"mcp/login">;
      case "mcp/logout":
        return this.customize.mcpLogout((p as P<"mcp/logout">).name) satisfies R<"mcp/logout">;
      // Local applications: one on this Mac and signed in, one not installed; none connected.
      case "chatgpt/status":
        return { state: "idle" } satisfies R<"chatgpt/status">;
      case "connections/list":
        return { connections: [], revision: 0 } satisfies R<"connections/list">;
      case "connections/discover":
        return {
          discoveries: [
            { adapter_id: "qwenwork", discovery_id: "mock-qwenwork", installed: true, login: "present", version: "1.4.0" },
            { adapter_id: "qoder", discovery_id: "mock-qoder", installed: false, login: "unavailable" },
          ],
        } satisfies R<"connections/discover">;
      case "auth/set":
      case "auth/delete": {
        const q = p as P<"auth/set">;
        const provider = demoModels().providers.find((x) => x.id === q.provider);
        if (provider?.auth !== "api_key") throw new Failure(-32602, "invalid_params", `provider '${q.provider}' does not use an API key`);
        // A key the demo provider refuses, to show what a wrong key looks like.
        if (method === "auth/set" && q.api_key === "sk-rejected") throw new Failure(-32021, "key_rejected", "Authentication Fails, Your api key is invalid");
        if (method === "auth/set") this.stored.add(q.provider);
        else this.stored.delete(q.provider);
        this.notifyModels();
        if (method === "auth/delete") return {};
        const count = demoModels(this.stored).models.filter((m) => m.provider === q.provider).length;
        return provider.plan && !provider.plan.dynamic_models ? { verified: false } : { verified: true, models: count } satisfies R<"auth/set">;
      }
      case "session/new": {
        const q = p as P<"session/new">;
        const model = q.model ?? demoModels().defaults!.model;
        // As finx: a model whose provider is gone (a connection removed) is not there to start on.
        if (!demoModels().providers.some((d) => d.id === providerOf(model))) {
          throw new Failure(-32022, "model_unavailable", `unknown provider '${providerOf(model)}'`);
        }
        // Without a project, a folder of its own, as finx makes one.
        const id = crypto.randomUUID();
        const cwd = q.cwd ?? `~/.finx/chats/${id}`;
        const s = this.create(id, cwd, model, q.thinking ?? "medium", q.permission_mode ?? "manual", Date.now(), !q.cwd);
        c.attached.add(s.id);
        this.emit(s, { type: "session_started", session_id: s.id, protocol_version: 2, model, cwd, resumed: false, session_file: s.view.info.session_file, thinking: s.view.info.thinking, permission_mode: s.view.info.permission_mode, context_window: s.view.info.context_window, usage: { per_model: {} } });
        this.listChanged(s);
        return { session_id: s.id, snapshot: snapshotOf(s.view, q.history_limit ?? undefined) };
      }
      case "session/resume":
      case "session/attach": {
        const q = p as P<"session/attach">;
        const s = this.session(q.session_id);
        c.attached.add(s.id);
        return { snapshot: snapshotOf(s.view, q.history_limit ?? undefined) };
      }
      case "session/detach":
        c.attached.delete((p as P<"session/detach">).session_id);
        return {};
      case "session/history": {
        const q = p as P<"session/history">;
        const s = this.session(q.session_id);
        const end = Number(q.before);
        const items = history(s.view);
        const start = Math.max(0, end - (q.limit ?? 100));
        // The mock serves the proposed history (P5's task ends among the items).
        return { items: items.slice(start, end) as TranscriptItem[], before: start > 0 ? String(start) : undefined };
      }
      case "session/context":
        return contextReport(this.session((p as P<"session/context">).session_id).view) satisfies R<"session/context">;
      case "session/op": {
        const q = p as P<"session/op">;
        const s = this.session(q.session_id);
        if (!c.attached.has(s.id)) throw new Failure(-32013, "not_attached", "attach before sending ops");
        this.op(s, q.op);
        return {};
      }
      case "session/rename": {
        const q = p as P<"session/rename">;
        const s = this.session(q.session_id);
        const title = q.title.split(/\s+/).filter(Boolean).join(" ").slice(0, 200);
        if (!title) throw new Failure(-32602, "invalid_params", "the title is empty");
        // As finx does: the kernel records it and says so to whoever is attached.
        s.summary = { ...s.summary, title };
        this.emit(s, { type: "title_changed", title });
        this.listChanged(s);
        return {};
      }
      case "session/archive":
      case "session/unarchive": {
        const s = this.session((p as P<"session/archive">).session_id);
        const archived = method === "session/archive";
        if (s.summary.archived !== archived) {
          s.summary = { ...s.summary, archived };
          this.emit(s, { type: "archived_changed", archived });
          this.listChanged(s);
        }
        return {};
      }
      case "session/close":
        return {};
      case "session/delete": {
        const s = this.session((p as P<"session/delete">).session_id);
        if (s.run) this.interrupt(s);
        this.sessions.delete(s.id);
        for (const x of this.conns) x.attached.delete(s.id);
        this.listChanged(s, [s.id]);
        return {};
      }
      default:
        throw new Failure(-32601, "method_not_found", `unknown method ${method}`);
    }
  }

  private op(s: Session, op: Op) {
    switch (op.type) {
      case "prompt": {
        if (!s.view.live) return this.prompt(s, op.input);
        s.queue.push({ id: newId("u"), mode: op.mode ?? "steer", input: op.input, ts: this.now() });
        return this.queueChanged(s);
      }
      case "withdraw": {
        const x = s.queue.find((y) => y.id === op.id);
        if (!x) return;
        s.queue = s.queue.filter((y) => y !== x);
        this.emit(s, { type: "input_withdrawn", id: op.id });
        return this.queueChanged(s);
      }
      case "requeue": {
        const x = s.queue.find((y) => y.id === op.id);
        if (!x || x.mode === op.mode) return;
        // To the end of the other kind.
        s.queue = [...s.queue.filter((y) => y !== x), { ...x, mode: op.mode }];
        return this.queueChanged(s);
      }
      case "steer_now":
        if (s.run && s.run.approvals.size === 0 && s.queue.some((x) => x.mode === "steer")) s.run.cut = true;
        return;
      case "continue":
        if (s.view.live) throw new Failure(-32014, "prompt_in_progress", "a task is running");
        const limited = s.view.failure?.kind === "rate_limited";
        s.run = { cancelled: false, approvals: new Map() };
        s.tasks++;
        this.emit(s, { type: "task_started", task_id: `t${s.tasks}` });
        // The demo's rate-limited review goes on after finx waits out the limit twice; anything else just goes on.
        if (!limited) return void this.play(s, this.unkeyed(s) ?? { turns: [{ say: "好的，接着刚才的请求继续。" }] });
        void this.play(s, { retries: { count: 2, error: rateLimited }, turns: [{ think: "接着上次中断的地方继续。", say: "重试成功。上次因为限流中断，现在接着评审：\n\n- **阈值**：在窗口的 80% 触发，留出一轮完整回复的余量，合理。\n- **保留最近消息**：约 20k token 的预算足够保留最近几条用户消息。\n- **失败处理**：摘要请求失败时保留原历史、只发 warning，这一点很好；建议再限制连续压缩的次数，避免来回压缩。" }] });
        return;
      case "interrupt":
        return this.interrupt(s);
      case "agent_interrupt": {
        const c = s.children.find((x) => (x.id === op.agent || x.parent?.name === op.agent) && x.view.live);
        if (c) return this.interrupt(c);
        return this.emit(s, { type: "warning", message: `no sub-agent "${op.agent}" is running` });
      }
      case "approval": {
        const resolve = s.run?.approvals.get(op.call_id);
        if (!resolve) throw new Failure(-32015, "approval_not_pending", "no such approval");
        return resolve(op.decision);
      }
      case "set_model": {
        // As finx does (model-catalog-design §18): a level asked for is kept when the model offers it;
        // on a switch the session's level is kept when the new model offers it; else "default".
        const offered = demoModels(new Set([...this.stored, "anthropic", "kimi"])).models.find((m) => m.id === op.model)?.thinking_levels ?? [];
        const wanted = op.thinking ?? s.view.info.thinking;
        const thinking = wanted !== "default" && offered.includes(wanted) ? wanted : "default";
        return this.emit(s, { type: "settings_changed", model: op.model, thinking, permission_mode: s.view.info.permission_mode, context_window: contextWindow(op.model) });
      }
      case "set_permission_mode": {
        const before = s.view.info.permission_mode;
        this.emit(s, { type: "settings_changed", model: s.view.info.model, thinking: s.view.info.thinking, permission_mode: op.mode, context_window: s.view.info.context_window });
        // As finx does on switching into bypass-permissions.
        if (op.mode === "bypass-permissions" && before !== op.mode) this.emit(s, { type: "warning", code: "bypass_permissions", message: "Permission mode bypass-permissions: tools run without asking." });
        return;
      }
      case "compact":
      case "shutdown":
        return;
    }
  }

  /** As finx fails a request to a provider it has no key for. */
  private unkeyed(s: Session): TaskScript | undefined {
    const model = demoModels(this.stored).models.find((m) => m.id === s.view.info.model);
    if (!model || model.available) return undefined;
    return { turns: [], fail: { kind: "auth", message: `no API key for provider '${model.provider}': set one with auth/set or the ${model.provider.toUpperCase()}_API_KEY environment variable`, retryable: false } };
  }

  private summaries(): SessionSummary[] {
    return [...this.sessions.values()].map((s) => s.summary).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  }
}

// ---- helpers ----

/** The history as the protocol has it: the client's own notes left out. */
function history(v: SessionView): TranscriptItem[] {
  return v.entries.filter((e): e is TranscriptItem => e.type !== "note");
}

function snapshotOf(v: SessionView, limit = 100): SessionSnapshot {
  const items = history(v);
  const start = Math.max(0, items.length - limit);
  const live = v.live;
  const active_task: ActiveTask | undefined = live
    ? {
        task_id: live.task_id,
        turn: live.turn,
        streaming: live.streaming,
        tools: live.tools.map((t) => ({ call_id: t.call_id, name: t.name, category: t.category, title: t.title, args: t.args, running: t.phase === "running", progress_tail: t.progress })),
        approvals: live.approvals,
      }
    : undefined;
  return {
    session: v.info,
    last_seq: v.lastSeq,
    transcript: { items: items.slice(start), before: start > 0 ? String(start) : undefined } as SessionSnapshot["transcript"],
    active_task,
    usage: v.usage,
    queued: v.queued,
    agents: v.agents.map((a) => {
      const own = snapshotOf(a.view, limit);
      return {
        agent_id: a.id, name: a.name, description: a.description, call_id: a.call_id, session_file: a.view.info.session_file, status: a.status, since: a.since,
        summary: a.summary, usage: a.usage, error: a.error, elapsed_ms: a.elapsed_ms, transcript: own.transcript, active_task: own.active_task,
      };
    }),
  };
}

function textOf(content: { type: string; text?: string }[]): string {
  return content.flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join("\n");
}

/** A first message as a list title: its first clause, short. */
function shortTitle(text: string): string {
  const first = text.split(/[\n。！？!?]/)[0].trim();
  return first.length > 24 ? first.slice(0, 24) + "…" : first;
}

/** Text in the small pieces a model streams: a few characters at a time. */
function chunks(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; ) {
    const n = 1 + Math.floor(Math.random() * 4);
    out.push(text.slice(i, i + n));
    i += n;
  }
  return out;
}

function contextWindow(model: string): number {
  return demoModels().models.find((m) => m.id === model)?.context_window ?? 131_072;
}

/** Plausible usage for a turn: a growing prompt, mostly cached, and what it wrote. */
function usageFor(model: string, turn: TurnScript): Usage {
  const written = (turn.think?.length ?? 0) + (turn.say?.length ?? 0);
  const output = Math.round(written * 1.6) + 40 * (turn.tools?.length ?? 0) + 20;
  const input = 600 + Math.round(Math.random() * 900);
  const cache_read = 18_000 + Math.round(Math.random() * 12_000);
  const cny = model.startsWith("deepseek/");
  const rate = cny ? { input: 2e-6, output: 8e-6, cache: 0.2e-6 } : { input: 3e-6, output: 15e-6, cache: 0.3e-6 };
  const cost = { input: input * rate.input, output: output * rate.output, cache_read: cache_read * rate.cache, cache_write: 0 };
  return { input, output, cache_read, cache_write: 0, cost: { currency: cny ? "CNY" : "USD", ...cost, total: cost.input + cost.output + cost.cache_read } };
}

/**
 * What finx's `session/context` answers for a session: the size its last reply reported (or
 * the fixed parts alone before one), the parts before the messages as a session of the demo
 * would have them, and the rest of the window as finx's limits leave it.
 */
function contextReport(v: SessionView): ContextReport {
  const window = v.info.context_window || 131_072;
  const hard = Math.max(window - 32_000, window / 2);
  const soft = Math.round(hard * 0.9);
  const fixed = { system_prompt: 3_400, tools: 2_900, skills: 1_100 };
  const before = fixed.system_prompt + fixed.tools + fixed.skills;
  const tokens = Math.max(v.context, before);
  return {
    model: v.info.model,
    usage: { tokens, estimated: 0, soft_limit: soft, hard_limit: hard, window },
    parts: [
      { kind: "messages", tokens: tokens - before },
      { kind: "system_prompt", tokens: fixed.system_prompt },
      { kind: "tools", tokens: fixed.tools },
      { kind: "skills", tokens: fixed.skills },
    ],
    free: Math.max(0, soft - tokens),
    reserved: window - Math.max(tokens, soft),
  };
}
