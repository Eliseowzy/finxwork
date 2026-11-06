#!/usr/bin/env node
// Verifies a change as far as it needs, behind whatever the person is doing (e2e/README.md).
//
//   node apps/desktop/e2e/run.mjs                   what the uncommitted changes call for
//   node apps/desktop/e2e/run.mjs --since origin/main   also what this branch's commits call for
//   node apps/desktop/e2e/run.mjs send-modes resend these scripts
//   node apps/desktop/e2e/run.mjs --all             every script that runs in the background
//   … --foreground      also those that need the screen: they run last, one at a time
//   … --list            says what it would run, and runs nothing
//   … --no-unit         without the type check and unit tests
//   … --no-build        with what is built already
//   … -j <n>            how many scripts at once
//   … --timeout <s>     how long a script may take
import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { watchFront } from "./lib/front.mjs";
import { scripts } from "./lib/manifest.mjs";
import { plan, split } from "./lib/select.mjs";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "../..");
const { values: opts, positionals: named } = parseArgs({
  allowPositionals: true,
  options: {
    all: { type: "boolean", default: false },
    since: { type: "string" },
    foreground: { type: "boolean", default: false },
    list: { type: "boolean", default: false },
    "no-unit": { type: "boolean", default: false },
    "no-build": { type: "boolean", default: false },
    jobs: { type: "string", short: "j", default: String(Math.max(1, Math.floor(os.cpus().length / 3))) },
    // The slowest script takes about 35 s: this much longer is a script that hangs.
    timeout: { type: "string", default: "180" },
  },
});
const jobs = Number(opts.jobs);
const timeoutMs = Number(opts.timeout) * 1000;
const git = (...args) => execFileSync("git", ["-c", "core.quotepath=off", ...args], { cwd: root, encoding: "utf8" });

function changedFiles() {
  const files = git("status", "--porcelain", "--untracked-files=all")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).split(" -> ").at(-1).replace(/^"|"$/g, ""));
  if (opts.since) files.push(...git("diff", "--name-only", `${opts.since}...HEAD`).split("\n").filter(Boolean));
  return [...new Set(files)];
}

function decide() {
  if (named.length > 0) {
    for (const name of named) if (!scripts[name]) throw new Error(`no script ${name}: see e2e/lib/manifest.mjs`);
    // Asked for by name: that is the asking, whatever it needs.
    const { background, foreground, manual } = split([...new Set(named)]);
    return { level: 2, unit: false, background, foreground: [...foreground, ...manual], skipped: [], unmatched: [], look: [] };
  }
  if (opts.all) {
    const { background, foreground, manual } = split(Object.keys(scripts).sort());
    return { level: 2, unit: true, background, foreground: opts.foreground ? foreground : [], skipped: opts.foreground ? manual : [...foreground, ...manual], unmatched: [], look: [] };
  }
  const files = changedFiles();
  const chosen = plan(files);
  console.log(`${files.length} changed file${files.length === 1 ? "" : "s"}`);
  return {
    ...chosen,
    foreground: opts.foreground ? chosen.foreground : [],
    skipped: opts.foreground ? chosen.manual : [...chosen.foreground, ...chosen.manual],
  };
}

const log = fs.mkdtempSync(path.join(os.tmpdir(), "finxwork-e2e-"));
const seconds = (since) => `${((Date.now() - since) / 1000).toFixed(0)}s`;

/** One command, its output kept in a file. */
function stage(name, command, args, cwd) {
  const started = Date.now();
  const file = path.join(log, `${name}.log`);
  return new Promise((resolve) => {
    execFile(command, args, { cwd, maxBuffer: 1 << 28 }, (error, stdout, stderr) => {
      fs.writeFileSync(file, stdout + stderr);
      console.log(`${error ? "✗" : "✓"} ${name}  ${seconds(started)}`);
      if (error) tail(file);
      resolve(!error);
    });
  });
}

function tail(file) {
  const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
  console.log(lines.slice(-25).map((l) => `    ${l}`).join("\n"));
  console.log(`    all of it: ${file}`);
}

/** Stops a script and what it started. */
function kill(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {}
}

const live = new Map();
process.on("SIGINT", () => {
  for (const child of live.values()) kill(child, "SIGTERM");
  process.exit(130);
});

/** A script as a process group of its own, its output in a file. Says passed, failed or skipped. */
function runScript(name, inBackground) {
  const started = Date.now();
  const file = path.join(log, `${name}.log`);
  const out = fs.openSync(file, "w");
  // Its temporary files in a folder of its own: short, since a kernel's socket lives inside and a
  // socket's path has a limit, and named, since kernels outlive a script that does not stop them.
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "fxe-"));
  const env = { ...process.env, FINXWORK_E2E_NO_BUILD: "1", TMPDIR: tmp };
  if (inBackground) env.FINXWORK_E2E_BACKGROUND = "1";
  else delete env.FINXWORK_E2E_BACKGROUND;
  const child = spawn(process.execPath, [path.join(import.meta.dirname, `${name}.mjs`)], { cwd: root, env, stdio: ["ignore", out, out], detached: true });
  live.set(name, child);
  return new Promise((resolve) => {
    let timedOut = false;
    const limit = setTimeout(() => {
      timedOut = true;
      kill(child, "SIGTERM");
      setTimeout(() => kill(child, "SIGKILL"), 5000).unref();
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(limit);
      live.delete(name);
      fs.closeSync(out);
      const lastLine = fs.readFileSync(file, "utf8").trimEnd().split("\n").at(-1) ?? "";
      // Without Chrome or the PDF it needs a script says so and exits as if it had passed.
      const status = timedOut ? "timed out" : code !== 0 ? "failed" : /\bskip(ped|ping)\b/.test(lastLine) ? "skipped" : "passed";
      execFile("pkill", ["-f", `${path.basename(tmp)}/`], () => {
        // A script keeps what it left when it failed, and says where.
        if (status === "passed" || status === "skipped") fs.rmSync(tmp, { recursive: true, force: true });
      });
      console.log(`${{ passed: "✓", skipped: "–" }[status] ?? "✗"} ${name}  ${seconds(started)}${status === "passed" ? "" : `  ${status}`}`);
      if (status === "failed" || status === "timed out") tail(file);
      if (status === "skipped") console.log(`    ${lastLine}`);
      resolve({ name, status, ms: Date.now() - started });
    });
  });
}

async function inTurn(names, inBackground, width) {
  const waiting = [...names];
  const results = [];
  const worker = async () => {
    for (let name; (name = waiting.shift()); ) results.push(await runScript(name, inBackground));
  };
  await Promise.all(Array.from({ length: Math.min(width, names.length) }, worker));
  return results;
}

const chosen = decide();
const { background, foreground, skipped, unmatched, look, unit } = chosen;
const wantsUnit = unit && !opts["no-unit"];
if (unmatched.length > 0) console.log(`No script answers for these, so the basic ones run:\n${unmatched.map((f) => `  ${f}`).join("\n")}`);
console.log(`Unit tests and types: ${wantsUnit ? "yes" : "no"}`);
console.log(`In the background (${background.length}): ${background.join(" ") || "none"}`);
if (foreground.length > 0) console.log(`On screen, one at a time (${foreground.length}): ${foreground.join(" ")}`);
if (skipped.length > 0) console.log(`Not run, need asking for (${skipped.length}): ${skipped.map((n) => `${n} (${scripts[n].foreground ?? scripts[n].manual})`).join(", ")}`);
if (look.length > 0) console.log(`Have a look at these, a running page shows them best:\n${look.map((f) => `  ${f}`).join("\n")}`);
if (opts.list) process.exit(0);

const started = Date.now();
if (wantsUnit) {
  const [types, tests] = await Promise.all([
    stage("types", "pnpm", ["--dir", desktop, "--silent", "typecheck"], root),
    stage("unit tests", "pnpm", ["--dir", desktop, "--silent", "test"], root),
  ]);
  if (!types || !tests) {
    console.log("\nStopped: fix these first. Nothing end-to-end has run.");
    process.exit(1);
  }
}

const results = [];
if (background.length + foreground.length > 0) {
  if (!opts["no-build"]) {
    if (!(await stage("kernel build", "cargo", ["build", "-p", "finx-cli", "-p", "finx-mock"], root))) process.exit(1);
    if (!(await stage("app build", "pnpm", ["--dir", desktop, "--silent", "build"], root))) process.exit(1);
  }
  const tookFront = new Set();
  const stopWatching = watchFront(
    () => [...live.values()].map((child) => child.pid),
    (pid) => {
      for (const [name, child] of live) if (child.pid === pid) tookFront.add(name);
    },
  );
  results.push(...(await inTurn(background, true, jobs)));
  stopWatching();
  for (const result of results) if (tookFront.has(result.name) && result.status === "passed") result.status = "took the front";
  for (const name of tookFront) console.log(`✗ ${name}  came to the front of the person's work`);
  results.push(...(await inTurn(foreground, false, 1)));
}

const count = (status) => results.filter((r) => r.status === status).length;
const bad = results.filter((r) => !["passed", "skipped"].includes(r.status));
const line = `${count("passed")} passed, ${bad.length} not, ${count("skipped")} skipped, ${seconds(started)}`;
console.log(`\n${results.length > 0 ? line : `Nothing end-to-end to run, ${seconds(started)}`}`);
if (bad.length > 0) console.log(`Not passed: ${bad.map((r) => `${r.name} (${r.status})`).join(", ")}`);
console.log(`Logs: ${log}`);
// A run this long is left alone, so it says when it ends. A notification takes no focus.
if (opts.all && process.platform === "darwin") {
  const message = JSON.stringify(line);
  execFile("osascript", ["-e", `display notification ${message} with title "FinxWork end-to-end"`], () => {});
}
process.exitCode = bad.length > 0 ? 1 : 0;
