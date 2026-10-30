import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { parseEnv, withLocale } from "./env.ts";
import { alive, readRecord } from "./record.ts";
import { Supervisor, tryConnect, type KernelStatus } from "./supervisor.ts";

// The supervisor against the real finx (the repository's debug build), in a
// FINX_HOME of its own: start, reuse, crash, replace, quit.

const finx = path.resolve(import.meta.dirname, "../../../../../target/debug/finx");
const built = fs.existsSync(finx);

test("the login environment is read between the marks, NUL-separated, without the shell's own variables", () => {
  const mark = "__M__";
  const out = `Welcome back!\n${mark}PATH=/opt/homebrew/bin:/usr/bin\0NOTE=two\nlines\0SHLVL=2\0_=/usr/bin/env\0PWD=/tmp\0${mark}bye`;
  assert.deepEqual(parseEnv(out, mark), { PATH: "/opt/homebrew/bin:/usr/bin", NOTE: "two\nlines" });
  assert.equal(parseEnv("no marks here", mark), null);
  assert.equal(withLocale({ PATH: "/bin" }).LANG, "en_US.UTF-8");
  assert.equal(withLocale({ PATH: "/bin", LC_ALL: "zh_CN.UTF-8" }).LANG, undefined);
});

const made: Supervisor[] = [];

/** Whatever a test left behind: the supervisors' connections and the services they started. */
function cleanup() {
  for (const s of made.splice(0)) {
    s.stop();
    const record = readRecord(s.current.endpoint);
    if (record && alive(record.pid)) process.kill(record.pid, "SIGTERM");
  }
}
after(cleanup);

function supervisor(home: string, o: { expected?: string | null; binary?: string; starts?: string } = {}) {
  const states: KernelStatus["state"][] = [];
  const s = new Supervisor({
    endpoint: path.join(home, "run", "finx.sock"),
    home,
    binary: o.binary ?? finx,
    expected: o.expected ?? null,
    starts: o.starts,
    environment: async () => ({ env: { ...process.env, FINX_CREDENTIAL_STORE: "file" }, source: "login", ms: 0 }),
    // As on a first run: the logs folder does not exist yet.
    log: path.join(home, "logs", "serve.out.log"),
    idleExitSecs: 30,
    client: { name: "supervisor-test" },
    required: ["sessions_subscribe", "session_metadata", "transcript_task_end", "auth"],
    backoff: [0, 50],
  });
  s.onChange((st) => states.push(st.state));
  made.push(s);
  return { s, states };
}

async function until(f: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("starts finx when none runs, uses one that does, and starts it again after it dies", { skip: !built && "run `cargo build` first" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fxw-"));
  try {
    // Cold: nothing listens, so the supervisor starts finx and waits for it.
    const first = supervisor(home);
    first.s.start();
    await first.s.ready();
    const record = readRecord(first.s.current.endpoint);
    assert.ok(record && alive(record.pid), "the service wrote its record");
    assert.equal(first.s.current.ours, true);
    assert.equal(first.s.current.env, "login");
    assert.ok(first.states.includes("starting"));

    // Warm: a second app finds it and starts nothing.
    const second = supervisor(home);
    second.s.start();
    await second.s.ready();
    assert.equal(readRecord(second.s.current.endpoint)?.pid, record!.pid);
    second.s.stop();

    // finx dies: the supervisor notices on its control connection and starts another one.
    process.kill(record!.pid, "SIGKILL");
    await until(() => first.states.includes("reconnecting"));
    await until(() => first.s.current.state === "ready" && readRecord(first.s.current.endpoint)?.pid !== record!.pid);
    const replacement = readRecord(first.s.current.endpoint)!;
    assert.notEqual(replacement.pid, record!.pid);

    // Quitting the app leaves the service running.
    first.s.stop();
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(alive(replacement.pid), "the service outlives the app");
    process.kill(replacement.pid, "SIGTERM");
    await until(() => !alive(replacement.pid));
  } finally {
    cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a service of another version is replaced once no task runs", { skip: !built && "run `cargo build` first" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fxw-"));
  try {
    const old = supervisor(home);
    old.s.start();
    await old.s.ready();
    const before = readRecord(old.s.current.endpoint)!;
    old.s.stop();
    // An app that expects another version: it uses the running service at once, then swaps it.
    const app = supervisor(home, { expected: "99.0.0" });
    app.s.start();
    await app.s.ready();
    await until(() => readRecord(app.s.current.endpoint)?.pid !== before.pid && app.s.current.state === "ready");
    assert.ok(!alive(before.pid), "the old service stopped");
    // The new one is the app's own: it stays, whatever version it reports.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(app.s.current.replacing, false);
    app.s.stop();
    const now = readRecord(app.s.current.endpoint);
    if (now) process.kill(now.pid, "SIGTERM");
  } finally {
    cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("after an update puts a new finx at the app's path, the service still running the old one is replaced", { skip: !built && "run `cargo build` first" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fxw-"));
  try {
    // The app's own finx: same version before and after, as when only the window changed.
    const binary = path.join(home, "app", "finx");
    fs.mkdirSync(path.dirname(binary));
    fs.copyFileSync(finx, binary);
    const starts = path.join(home, "starts.json");
    const old = supervisor(home, { binary, starts });
    old.s.start();
    await old.s.ready();
    const before = readRecord(old.s.current.endpoint)!;
    old.s.stop();
    // Another app's start with the same file in place keeps the service.
    const same = supervisor(home, { binary, starts });
    same.s.start();
    await same.s.ready();
    assert.equal(same.s.current.replacing, false);
    same.s.stop();
    // The update: a new file at the same path (Squirrel swaps the whole bundle).
    fs.copyFileSync(finx, binary + ".new");
    fs.renameSync(binary + ".new", binary);
    const updated = supervisor(home, { binary, starts });
    updated.s.start();
    await updated.s.ready();
    await until(() => readRecord(updated.s.current.endpoint)?.pid !== before.pid && updated.s.current.state === "ready");
    assert.ok(!alive(before.pid), "the old service stopped");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(updated.s.current.replacing, false, "the new service, started from the new file, stays");
  } finally {
    cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a socket path that is too long fails with a reason instead of starting finx", async () => {
  const home = path.join(os.tmpdir(), "x".repeat(90));
  const { s } = supervisor(home);
  s.start();
  await assert.rejects(s.ready(), /longer than 103 bytes/);
  assert.equal(s.current.state, "failed");
  assert.equal((await tryConnect(s.current.endpoint, 50)).ok, false);
});
