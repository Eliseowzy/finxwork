import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { RpcClient, RpcError, type Transport } from "@finx/client";
import { PROTOCOL_VERSION, type BotSummary, type InitializeResult, type ServerCapabilities, type SessionState, type SessionSummary } from "@finx/protocol";
import type { KernelStatusView } from "../../shared/bridge";
import type { LoginEnvironment } from "./env.ts";
import { readRecord, stopRecorded, type ServiceRecord } from "./record.ts";

// Keeps a finx service that matches the app running, and says how it is
// (desktop-kernel-integration §5–§6): connect to the one already there, or
// start the app's own; check its version, capabilities and file; when it goes
// away, start it again; replace one that differs once no task runs. It talks to
// the service on a control connection of its own and never touches what the
// windows' connections carry.

/** The supervisor's view of the service; the windows get it with FINX_HOME added. */
export type KernelStatus = Omit<KernelStatusView, "home">;

export type SupervisorOptions = {
  /** The service's Unix socket. */
  endpoint: string;
  /** FINX_HOME for a service the app starts. */
  home: string;
  /** The finx to start; null when there is none (only an existing service can be used). */
  binary: string | null;
  /** The version that binary reports; a service with another one is replaced. */
  expected: string | null;
  environment: () => Promise<LoginEnvironment>;
  log: string;
  idleExitSecs: number;
  client: { name: string; version?: string };
  /** What the app cannot work without. */
  required: (keyof ServerCapabilities)[];
  /**
   * Where the supervisor notes which file each service it started runs. An
   * update puts a new finx at the same path while the old one keeps running,
   * and the version alone need not change from one build to the next
   * (desktop-release DD-25).
   */
  starts?: string;
  /** Waits before each reconnect attempt, the last repeating. */
  backoff?: number[];
  /** How long a started service has to answer. */
  startTimeoutMs?: number;
  trace?: (message: string) => void;
  /** Follows the lists this connection already follows: the app's system notifications. */
  lists?: ListFollower;
};

/** The service's lists: what they are on each new connection, then how they change. */
export type ListFollower = {
  reconnected(): void;
  botList(list: BotSummary[]): void;
  botsChanged(changed: BotSummary[], deleted: string[]): void;
  sessionList(list: SessionSummary[]): void;
  sessionsChanged(changed: SessionSummary[], deleted: string[]): void;
};

/** The longest Unix socket path (sockaddr_un's 104 bytes, with the terminator). */
const MAX_SOCKET_PATH = 103;
const COMPARE_CHUNK = 1 << 20;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A Unix socket as an RpcClient transport. */
export function socketTransport(socket: net.Socket): Transport {
  socket.setEncoding("utf8");
  return {
    send: (text) => void socket.write(text),
    onText: (cb) => {
      socket.on("data", cb);
      return () => void socket.off("data", cb);
    },
    onClose: (cb) => {
      socket.on("close", cb);
      return () => void socket.off("close", cb);
    },
  };
}

type Connected = { ok: true; socket: net.Socket } | { ok: false; code: string; message: string };

/** One attempt to connect, within `timeoutMs`. */
export function tryConnect(endpoint: string, timeoutMs = 300): Promise<Connected> {
  return new Promise((resolve) => {
    const socket = net.createConnection(endpoint);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, code: "ETIMEDOUT", message: `no answer on ${endpoint}` });
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve({ ok: true, socket });
    });
    socket.once("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ ok: false, code: e.code ?? "EIO", message: e.message });
    });
  });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

type Handshake = "ok" | "incompatible" | "silent";

export class Supervisor {
  private status: KernelStatus;
  private readonly listeners = new Set<(s: KernelStatus) => void>();
  private readonly backoff: number[];
  private env: Promise<LoginEnvironment> | null = null;
  private cycle: Promise<void> | null = null;
  private control: { rpc: RpcClient; socket: net.Socket } | null = null;
  /** Sessions with a task running, and bots at work, as the control connection hears of them. */
  private readonly busy = new Map<string, SessionState>();
  private expectClose = false;
  /** The last service was stopped to be replaced. */
  private replaced = false;
  private stopped = false;
  private readonly exits: number[] = [];
  private attempt = 0;

  private readonly o: SupervisorOptions;

  constructor(o: SupervisorOptions) {
    this.o = o;
    this.backoff = o.backoff ?? [0, 200, 500, 1000, 2000, 5000];
    this.status = { state: "starting", endpoint: o.endpoint, binary: o.binary, log: o.log };
  }

  get current(): KernelStatus {
    return this.status;
  }

  onChange(cb: (s: KernelStatus) => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  /** Starts working out the login environment (it is needed only if a service has to be started) and connects. */
  start() {
    this.env ??= this.o.environment();
    void this.run();
  }

  /** Resolves once a matching service answers (now, or after it is started again). */
  async ready(): Promise<void> {
    while (this.status.state !== "ready") {
      if (this.status.state === "failed") throw new Error(this.status.reason ?? "finx is not available");
      await new Promise<void>((resolve) => {
        const off = this.onChange(() => (off(), resolve()));
      });
    }
  }

  /** After a failure: try again from the start. */
  retry() {
    this.exits.length = 0;
    this.attempt = 0;
    void this.run();
  }

  /**
   * Starts the service again with a freshly read login environment: at once
   * when `now` (running tasks are interrupted and saved), otherwise when no
   * task runs.
   */
  async restart(now: boolean) {
    this.env = this.o.environment();
    if (this.status.state !== "ready") return this.retry();
    this.set({ replacing: true });
    if (now) await this.shutdownService();
    else await this.replaceWhenIdle();
  }

  /** The app quits: its connections close; the service and its tasks go on. */
  stop() {
    this.stopped = true;
    this.control?.socket.destroy();
  }

  private set(patch: Partial<KernelStatus>) {
    this.status = { ...this.status, ...patch };
    this.o.trace?.(`kernel ${this.status.state}${this.status.reason ? `: ${this.status.reason}` : ""}`);
    for (const cb of this.listeners) cb(this.status);
  }

  private run(): Promise<void> {
    // Whatever goes wrong on the way ends in the failed state, never in a promise nobody awaits.
    this.cycle ??= this.connectOrStart()
      .catch((e: unknown) => this.fail(e instanceof Error ? e.message : String(e)))
      .finally(() => (this.cycle = null));
    return this.cycle;
  }

  private fail(reason: string, output?: string) {
    this.set({ state: "failed", reason, output, version: undefined, replacing: undefined });
  }

  private async connectOrStart() {
    if (this.stopped) return;
    if (this.status.state !== "reconnecting") this.set({ state: "starting", reason: undefined, output: undefined });
    if (Buffer.byteLength(this.o.endpoint) > MAX_SOCKET_PATH) {
      return this.fail(`the socket path ${this.o.endpoint} is longer than ${MAX_SOCKET_PATH} bytes; set a shorter FINX_HOME`);
    }
    const found = await tryConnect(this.o.endpoint);
    if (found.ok) {
      const shake = await this.handshake(found.socket);
      if (shake === "ok") return;
      // A service the app cannot talk to: stop it through its record, then start ours.
      await stopRecorded(this.o.endpoint);
    } else if (found.code !== "ENOENT" && found.code !== "ECONNREFUSED") {
      return this.fail(found.message);
    }
    await this.startService();
  }

  /** Starts the app's finx as a service of its own and waits until it answers. */
  private async startService() {
    const { binary, endpoint } = this.o;
    if (!binary) return this.fail("finx is not installed in this app");
    const env = await (this.env ??= this.o.environment());
    // A first run: neither FINX_HOME nor its logs folder exists yet.
    fs.mkdirSync(this.o.home, { recursive: true });
    fs.mkdirSync(path.dirname(this.o.log), { recursive: true });
    const from = fs.existsSync(this.o.log) ? fs.statSync(this.o.log).size : 0;
    const out = fs.openSync(this.o.log, "a");
    const file = fileId(binary);
    let pid: number | undefined;
    let exited: number | null = null;
    let spawnError: string | null = null;
    try {
      // Its own session and process group: quitting the app leaves it and its tasks running.
      // Its output goes to a file; a pipe nobody reads would block it once full.
      const child = spawn(binary, ["serve", "--listen", `unix://${endpoint}`, "--idle-exit", String(this.o.idleExitSecs)], {
        detached: true,
        stdio: ["ignore", out, out],
        cwd: os.homedir(),
        env: { ...env.env, FINX_HOME: this.o.home, FINXWORK_PARENT: "1" },
      });
      pid = child.pid;
      child.once("exit", (code, signal) => (exited = code ?? (signal ? 128 : -1)));
      child.once("error", (e) => (spawnError = e.message));
      child.unref();
    } finally {
      fs.closeSync(out);
    }
    this.set({ env: env.source });
    const deadline = Date.now() + (this.o.startTimeoutMs ?? 10_000);
    for (let wait = 10; Date.now() < deadline; wait = Math.min(wait * 2, 200)) {
      const found = await tryConnect(endpoint);
      if (found.ok) {
        const shake = await this.handshake(found.socket);
        if (shake === "ok") return this.noteStart(pid, file);
        return this.fail(shake === "silent" ? "finx did not answer" : "finx speaks another protocol version");
      }
      if (spawnError) return this.fail(`cannot start finx: ${spawnError}`);
      if (exited !== null) {
        const output = tail(this.o.log, from);
        // Another process started one first; ours stepped aside. Keep connecting.
        if (/already listening/.test(output)) {
          exited = null;
          continue;
        }
        return this.fail(`finx exited during start-up (status ${exited})`, output);
      }
      await sleep(wait);
    }
    this.fail("finx did not start within 10 seconds", tail(this.o.log, from));
  }

  /** initialize on a fresh control connection; on success the service is ready. */
  private async handshake(socket: net.Socket): Promise<Handshake> {
    const rpc = new RpcClient(socketTransport(socket));
    // finx writes its record before it listens: this is the service that answers.
    const record = readRecord(this.o.endpoint);
    const ours = !!record?.exe && !!this.o.binary && sameFile(record.exe, this.o.binary);
    // Only as the app opens. On a reconnect, a service that isn't ours was started by whoever
    // got there first, another app still open or a terminal, and replacing it would have the
    // two replace each other for as long as both run.
    const another = !ours && this.status.state === "starting" && (await this.anotherBuild(record));
    let init: InitializeResult;
    try {
      init = await withTimeout(
        rpc.request("initialize", { protocol_version: PROTOCOL_VERSION, client_info: { name: this.o.client.name, version: this.o.client.version } }),
        5_000,
      );
    } catch (e) {
      socket.destroy();
      return e instanceof RpcError && e.kind === "invalid_params" ? "incompatible" : "silent";
    }
    // Replaced: a service of another version than the app ships (an older app's, or one
    // started from a terminal; after an update in place the app's own path runs the old
    // version), one that lacks what the app needs, the app's own when its binary was
    // rebuilt since (development), or one found as the app opens that runs another build:
    // the version need not change from one build to the next (desktop-release DD-25), and
    // a terminal's counts like an older app's. Only once in a row: if the service the app
    // just started still differs, starting it again would not help.
    const versionOff = this.o.expected !== null && init.server_info.version !== this.o.expected;
    const lacking = this.o.required.some((c) => !init.capabilities[c]);
    const rebuilt = ours && fs.statSync(this.o.binary!).mtimeMs > Date.parse(record!.started_at) + 1000;
    const swapped = ours && this.swapped(record!);
    const stale = (versionOff || lacking || rebuilt || swapped || another) && !(ours && this.replaced);
    if (!stale) this.replaced = false;
    if (ours && this.replaced && (versionOff || lacking)) this.o.trace?.("the app's own finx differs from what the app expects; keeping it");
    if (another) this.o.trace?.(`the service runs another build (${record!.exe}); replacing it once no task runs`);
    // The app's life does not hang on this connection (a test's either).
    socket.unref();
    this.control = { rpc, socket };
    this.busy.clear();
    socket.once("close", () => this.lost(socket));
    this.o.lists?.reconnected();
    if (init.capabilities.sessions_subscribe) {
      rpc.on("sessions/changed", (c) => {
        for (const s of c.sessions) this.track(s.session_id, s.state);
        for (const id of c.deleted ?? []) this.busy.delete(id);
        this.o.lists?.sessionsChanged(c.sessions, c.deleted ?? []);
        if (this.status.replacing) void this.replaceWhenIdle();
      });
      try {
        const list = await rpc.request("sessions/subscribe", { limit: 500 });
        for (const s of list.sessions) this.track(s.session_id, s.state);
        this.o.lists?.sessionList(list.sessions);
      } catch {
        // Without the list the service is replaced only when asked.
      }
    }
    // A bot's conversation is not in the session list: its row says when it works (bot-design §5.2).
    if (init.capabilities.bots) {
      rpc.on("bots/changed", (c) => {
        for (const b of c.bots) this.trackBot(b);
        for (const id of c.deleted ?? []) this.busy.delete(`bot:${id}`);
        this.o.lists?.botsChanged(c.bots, c.deleted ?? []);
        if (this.status.replacing) void this.replaceWhenIdle();
      });
      try {
        const list = await rpc.request("bots/subscribe", {});
        for (const b of list.bots) this.trackBot(b);
        this.o.lists?.botList(list.bots);
      } catch {
        // Without the list a bot's work does not hold a replacement back.
      }
    }
    this.attempt = 0;
    this.set({ state: "ready", version: init.server_info.version ?? undefined, replacing: stale, ours, reason: undefined, output: undefined, attempt: undefined });
    if (stale) void this.replaceWhenIdle();
    return "ok";
  }

  /** The service this supervisor started, and the file it runs (only when it is the one that answers). */
  private noteStart(pid: number | undefined, file: FileId | null) {
    if (!this.o.starts || !pid || !file || readRecord(this.o.endpoint)?.pid !== pid) return;
    try {
      const notes = readStarts(this.o.starts);
      notes[this.o.endpoint] = { pid, ...file };
      fs.mkdirSync(path.dirname(this.o.starts), { recursive: true });
      fs.writeFileSync(this.o.starts, JSON.stringify(notes));
    } catch (e) {
      this.o.trace?.(`could not note the service's file: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** A service this supervisor (or the app before an update) started runs a file no longer at its path. */
  private swapped(record: ServiceRecord): boolean {
    if (!this.o.starts) return false;
    const noted = readStarts(this.o.starts)[this.o.endpoint];
    if (!noted || noted.pid !== record.pid) return false;
    const now = fileId(record.exe!);
    return !!now && (now.dev !== noted.dev || now.ino !== noted.ino);
  }

  /**
   * A service not running the app's file: whether it runs another build, as far as the
   * files tell. A record naming no file tells nothing, and without a file of its own the
   * app has nothing to start in the service's place; a file that is gone is another build.
   */
  private async anotherBuild(record: ServiceRecord | null): Promise<boolean> {
    const binary = this.o.binary;
    if (!record?.exe || !binary || !fileId(binary)) return false;
    // A file replaced since the service started says nothing about what it runs.
    return this.swapped(record) || !(await sameBytes(record.exe, binary));
  }

  private track(id: string, state: SessionState) {
    if (state === "running" || state === "awaiting_approval") this.busy.set(id, state);
    else this.busy.delete(id);
  }

  /** A bot works while it answers, waits for an approval or has sub-agents at work. */
  private trackBot(b: BotSummary) {
    const key = `bot:${b.id}`;
    if (b.waiting) this.busy.set(key, "awaiting_approval");
    // A routine's run shows nowhere in the row's work, and the service's replacement waits for it (routine-design §7.3).
    else if (b.typing || (b.agents_working ?? 0) > 0 || b.routines?.some((r) => r.running)) this.busy.set(key, "running");
    else this.busy.delete(key);
  }

  /** Replaces the service now if no task runs; otherwise the list's next change tries again. */
  private async replaceWhenIdle() {
    if (this.busy.size > 0 || !this.control) return;
    this.replaced = true;
    await this.shutdownService();
  }

  private async shutdownService() {
    const control = this.control;
    if (!control) return;
    this.expectClose = true;
    try {
      await control.rpc.request("server/shutdown", {});
    } catch {
      control.socket.destroy();
    }
  }

  /** The control connection ended: the service stopped, was replaced, or crashed. */
  private lost(socket: net.Socket) {
    if (this.control?.socket !== socket) return;
    this.control = null;
    if (this.stopped) return;
    if (!this.expectClose) {
      const now = Date.now();
      this.exits.push(now);
      while (this.exits.length && now - this.exits[0] > 60_000) this.exits.shift();
      if (this.exits.length >= 3) return this.fail("finx stopped three times within a minute");
    }
    this.expectClose = false;
    this.attempt += 1;
    this.set({ state: "reconnecting", attempt: this.attempt, version: undefined });
    const wait = this.backoff[Math.min(this.attempt - 1, this.backoff.length - 1)];
    setTimeout(() => void this.run(), wait).unref();
  }
}

/** A file as the file system knows it: a replaced file is another, whatever it holds. */
type FileId = { dev: number; ino: number };

function fileId(p: string): FileId | null {
  try {
    const st = fs.statSync(p);
    return { dev: st.dev, ino: st.ino };
  } catch {
    return null;
  }
}

function readStarts(file: string): Record<string, { pid: number } & FileId> {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function sameFile(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return a === b;
  }
}

/** Whether two files hold the same bytes, read only as far as the first difference; one that cannot be read does not. */
export async function sameBytes(a: string, b: string): Promise<boolean> {
  let x: fs.promises.FileHandle | undefined;
  let y: fs.promises.FileHandle | undefined;
  try {
    x = await fs.promises.open(a, "r");
    y = await fs.promises.open(b, "r");
    const size = (await x.stat()).size;
    if ((await y.stat()).size !== size) return false;
    const [p, q] = [Buffer.allocUnsafe(COMPARE_CHUNK), Buffer.allocUnsafe(COMPARE_CHUNK)];
    for (let at = 0; at < size; at += COMPARE_CHUNK) {
      const [r, s] = await Promise.all([x.read(p, 0, COMPARE_CHUNK, at), y.read(q, 0, COMPARE_CHUNK, at)]);
      if (r.bytesRead !== s.bytesRead || !p.subarray(0, r.bytesRead).equals(q.subarray(0, s.bytesRead))) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    await x?.close();
    await y?.close();
  }
}

/** What finx wrote to its output file since `from`, the last lines of it. */
function tail(file: string, from: number): string {
  try {
    const text = fs.readFileSync(file, "utf8").slice(from);
    return text.trim().split("\n").slice(-12).join("\n");
  } catch {
    return "";
  }
}
