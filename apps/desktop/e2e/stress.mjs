#!/usr/bin/env node
// The window under a heavy owner's lists: 1000+ bots and 1000+ sessions with long conversations,
// from the mock kernel (FINXWORK_KERNEL=mock, FINXWORK_MOCK_STRESS), nothing sent to a model.
// The development build in a temporary profile, driven over the DevTools protocol, behind the
// person's work. It measures memory, how long each step takes to show, scrolling frames, and the
// main thread while lists change many times a second; it checks the lists stay whole and in order.
//
//   node apps/desktop/e2e/stress.mjs
//   … --bots 1200 --sessions 1500 --turns 60 --churn 40   (the default load)
//   … --scenario deep --sessions 10000 --projects 100 --messages 5000
//                                     sessions only: the list, then one conversation read back to its start
//   … --json <file>                   also writes the numbers
//   FINXWORK_E2E_NO_BUILD=1 …         uses the build there is
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cdpPort } from "./lib/port.mjs";

const desktop = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const scenario = opt("scenario", "lists");
const load =
  scenario === "deep"
    ? { sessions: Number(opt("sessions", 10000)), projects: Number(opt("projects", 100)), messages: Number(opt("messages", 5000)), churn: Number(opt("churn", 40)), pages: Number(opt("pages", 200)) }
    : { bots: Number(opt("bots", 1200)), sessions: Number(opt("sessions", 1500)), turns: Number(opt("turns", 60)), churn: Number(opt("churn", 40)) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`\n▶ ${s}`);
const note = (s) => console.log(`  · ${s}`);
const results = {};

if (!process.env.FINXWORK_E2E_NO_BUILD) execFileSync("pnpm", ["exec", "electron-vite", "build"], { cwd: desktop, stdio: "ignore" });

// ── the app ──

let app = null;
let page = null;

async function launch(stress, env = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxs-"));
  // A private HOME: the app registers the extension's host in the browsers under it.
  const userHome = path.join(work, "home");
  fs.mkdirSync(userHome);
  const port = cdpPort();
  app = spawn(path.join(desktop, "node_modules/.bin/electron"), [desktop, `--remote-debugging-port=${port}`], {
    env: {
      ...process.env, FINXWORK_KERNEL: "mock", FINXWORK_MOCK_STRESS: stress, FINXWORK_E2E_BACKGROUND: process.env.FINXWORK_E2E_FOREGROUND ? "" : "1",
      ...env, FINX_HOME: path.join(work, "finx"), HOME: userHome, FINXWORK_USER_DATA: path.join(work, "profile"), FINXWORK_NO_BROWSER: "1", FINX_NO_BROWSER: "1",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  let target;
  for (let i = 0; i < 150 && !target; i++) {
    await sleep(200);
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => []);
    target = list.find((t) => t.type === "page" && t.url.startsWith("app://finxwork/") && !t.url.includes("#settings"));
  }
  assert.ok(target, "the window did not open");
  page = await connectPage(target.webSocketDebuggerUrl);
  await page.call("Runtime.enable");
  await page.call("Performance.enable");
  await page.call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  // From the document's start: when the first rows show, long tasks, and input delays.
  await page.call("Page.enable");
  await page.call("Page.addScriptToEvaluateOnNewDocument", { source: probe });
  await page.call("Page.reload", { ignoreCache: false });
  await until("!!window.__stress", "the page again, with the probe");
  await until("!!document.querySelector('.mainwrap .side, .onb-foot')", "main window");
  if (await page.run("!!document.querySelector('.onb-foot button')")) {
    await page.run("document.querySelector('.onb-foot button').click()");
    await until("!!document.querySelector('.mainwrap .side')", "past onboarding");
  }
}

async function quit() {
  page?.close();
  if (app && app.exitCode === null) {
    const exited = once(app, "exit");
    app.kill("SIGTERM");
    await exited;
  }
  app = null;
}

async function connectPage(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    const w = pending.get(m.id);
    if (!w) return;
    pending.delete(m.id);
    m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result);
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const run = async (expression) => {
    const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    // -0, NaN and the infinities come apart from the value.
    return r.result.unserializableValue !== undefined ? Number(r.result.unserializableValue) : r.result.value;
  };
  return { call, run, errors, close: () => ws.close() };
}

async function until(expression, label, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await page.run(`Boolean(${expression})`)) return;
    await sleep(50);
  }
  throw new Error(`timed out: ${label}\n${page.errors.join("\n")}`);
}

// In the page from its first line: marks, long tasks, input-to-paint of each key.
const probe = `(() => {
  const s = window.__stress = { marks: {}, long: [], events: [] };
  const mark = (name, sel) => {
    if (s.marks[name] || !document.querySelector(sel)) return;
    s.marks[name] = -1;
    requestAnimationFrame(() => setTimeout(() => { s.marks[name] = performance.now(); }));
  };
  new MutationObserver(() => { mark("side", ".mainwrap .side"); mark("botRow", ".brow"); mark("sessionRow", ".srow"); })
    .observe(document, { childList: true, subtree: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) s.long.push({ at: e.startTime, ms: e.duration }); }).observe({ type: "longtask", buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === "keydown" || e.name === "click" || e.name === "pointerdown") s.events.push({ name: e.name, at: e.startTime, ms: e.duration }); })
    .observe({ type: "event", durationThreshold: 16, buffered: true });
})();`;

// In the page: helpers the steps share.
const helpers = `(() => {
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  /** Runs an action and waits until what it changed has painted (two frames). */
  window.__time = async (action, ready) => {
    const t0 = performance.now();
    action();
    const end = t0 + 10000;
    if (ready) while (!ready()) {
      if (performance.now() > end) throw new Error("not ready in 10 s: " + ready + " · selected " + JSON.stringify(document.querySelector(".srow.sel .stitle, .brow.sel .bname")?.textContent) + " · picked " + JSON.stringify(window.__picked) + " · rows " + document.querySelectorAll("[data-step-key]").length);
      await new Promise((r) => setTimeout(r, 5));
    }
    await frame(); await frame();
    return performance.now() - t0;
  };
  /**
   * Scrolls a list from top to bottom, a fast wheel's distance a frame: the gaps between frames, and
   * the frames whose middle and ends showed no row (a list drawing only what is in sight drew too little).
   */
  window.__scroll = async (sel, perFrame, rows) => {
    const el = document.querySelector(sel);
    el.scrollTop = 0;
    await frame();
    const gaps = [];
    let blank = 0;
    let last = performance.now();
    while (el.scrollTop + el.clientHeight < el.scrollHeight - 2) {
      el.scrollTop += perFrame;
      await frame();
      const t = performance.now();
      gaps.push(t - last);
      last = t;
      if (rows) {
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        // A point may fall in the 1-2 px between two rows: empty only if one 3 px lower is too.
        const hit = (y) => [y, y + 3].some((z) => document.elementFromPoint(x, z)?.closest(rows));
        if ([r.top + 40, r.top + r.height / 2, r.bottom - 16].some((y) => !hit(y))) blank++;
      }
      if (gaps.length > 3000) break;
    }
    return { gaps, blank };
  };
})();`;

const sum = (a) => a.reduce((n, x) => n + x, 0);
const pct = (a, p) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const median = (a) => pct(a, 50);
const mb = (bytes) => Math.round((bytes / 1048576) * 10) / 10;
const ms = (x) => Math.round(x * 10) / 10;

async function metrics() {
  const { metrics } = await page.call("Performance.getMetrics");
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

/** Process memory of the app (main, renderers, GPU): resident sizes in MB. */
function rss() {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,command="], { encoding: "utf8" })
    .trim().split("\n").map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(([, pid, ppid, kb, cmd]) => ({ pid: +pid, ppid: +ppid, kb: +kb, cmd }));
  const mine = new Set([app.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) if (!mine.has(r.pid) && mine.has(r.ppid)) (mine.add(r.pid), (grew = true));
  }
  const procs = rows.filter((r) => mine.has(r.pid));
  const renderer = Math.max(...procs.filter((r) => r.cmd.includes("--type=renderer")).map((r) => r.kb));
  return { total: Math.round(sum(procs.map((r) => r.kb)) / 1024), renderer: Math.round(renderer / 1024) };
}

async function memory(label) {
  await page.call("HeapProfiler.collectGarbage");
  await sleep(300);
  const m = await metrics();
  const r = rss();
  const out = { heapMB: mb(m.JSHeapUsedSize), nodes: m.Nodes, listeners: m.JSEventListeners, rendererMB: r.renderer, appMB: r.total };
  note(`${label}: JS heap ${out.heapMB} MB · DOM nodes ${out.nodes} · listeners ${out.listeners} · renderer RSS ${out.rendererMB} MB · app RSS ${out.appMB} MB`);
  return out;
}

async function scroll(sel, label, rows) {
  const { gaps, blank } = await page.run(`window.__scroll(${JSON.stringify(sel)}, 160, ${JSON.stringify(rows ?? null)})`);
  assert.ok(gaps.length > 0, `${label}: the list does not scroll`);
  const out = { frames: gaps.length, p50: ms(median(gaps)), p95: ms(pct(gaps, 95)), max: ms(Math.max(...gaps)), janky: gaps.filter((g) => g > 33.4).length };
  note(`${label}: ${out.frames} frames · p50 ${out.p50} ms · p95 ${out.p95} ms · max ${out.max} ms · frames over 33 ms ${out.janky}`);
  if (rows) assert.equal(blank, 0, `${label}: ${blank} frames showed an empty stretch of the list`);
  return out;
}

/**
 * A conversation read back with the wheel, from its end upwards (it loads earlier pages on the way):
 * real input, as a conversation following its end lets go only for the person's own scrolling.
 */
async function wheel(sel, label, steps = 120, down = false) {
  // At the conversation's left margin: over a tool's output, the wheel would scroll that box instead.
  const at = await page.run(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + 12, y: r.top + r.height / 2 }; })()`);
  const before = await page.run(`document.querySelector(${JSON.stringify(sel)}).scrollTop`);
  // Each frame: how long it took, and whether the middle of the view showed a space standing in for rows (blank).
  await page.run(`window.__frames = []; window.__blank = 0; (async () => { const box = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); let l = performance.now(); window.__wheeling = true; while (window.__wheeling) { await new Promise((r) => requestAnimationFrame(r)); const t = performance.now(); window.__frames.push(t - l); l = t; if (document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest(".vspace")) window.__blank++; } })(); 0`);
  for (let i = 0; i < steps; i++) {
    await page.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY: down ? 120 : -120 });
    await sleep(16);
  }
  await sleep(300);
  const gaps = await page.run("window.__wheeling = false; window.__frames.slice(1)");
  const blank = await page.run("window.__blank");
  const after = await page.run(`document.querySelector(${JSON.stringify(sel)}).scrollTop`);
  const moved = await page.run(`document.querySelectorAll(${JSON.stringify(sel)} + " .md, " + ${JSON.stringify(sel)} + " .bub, " + ${JSON.stringify(sel)} + " .bbub").length`);
  assert.ok(after !== before, `${label}: the conversation did not scroll`);
  const out = { frames: gaps.length, p50: ms(median(gaps)), p95: ms(pct(gaps, 95)), max: ms(Math.max(...gaps)), janky: gaps.filter((g) => g > 33.4).length, blank, messages: moved };
  note(`${label}: ${out.frames} frames · p50 ${out.p50} ms · p95 ${out.p95} ms · max ${out.max} ms · frames over 33 ms ${out.janky} · blank ${blank} · ${moved} messages drawn after`);
  return out;
}

/**
 * Main-thread work over a stretch of time: script, style and layout, long tasks; then, apart, how
 * frames come. Nothing of the measurement asks for frames while the work is counted: a sampler's
 * own requestAnimationFrame makes the page render every frame, which is work of its own.
 */
async function busy(seconds, label) {
  const a = await metrics();
  const from = await page.run("performance.now()");
  await sleep(seconds * 1000);
  const b = await metrics();
  const long = await page.run(`window.__stress.long.filter((x) => x.at >= ${from})`);
  const gaps = await page.run(`(async () => { const g = []; let l = performance.now(); const end = l + 3000;
    while (performance.now() < end) { await new Promise((r) => requestAnimationFrame(r)); const t = performance.now(); g.push(t - l); l = t; } return g; })()`);
  const out = {
    scriptPct: Math.round(((b.ScriptDuration - a.ScriptDuration) / seconds) * 1000) / 10,
    taskPct: Math.round(((b.TaskDuration - a.TaskDuration) / seconds) * 1000) / 10,
    layoutMs: ms((b.LayoutDuration - a.LayoutDuration + b.RecalcStyleDuration - a.RecalcStyleDuration) * 1000),
    longTasks: long.length,
    longMs: ms(sum(long.map((x) => x.ms))),
    frameP95: ms(pct(gaps, 95)),
    janky: gaps.filter((g) => g > 33.4).length,
  };
  note(`${label}: main thread busy ${out.taskPct}% (script ${out.scriptPct}%) · style+layout ${out.layoutMs} ms · long tasks ${out.longTasks} (${out.longMs} ms) · then frame p95 ${out.frameP95} ms, ${out.janky} of ${gaps.length} over 33 ms`);
  return out;
}

/** Keys typed into the composer: each key's time to its next paint (Event Timing, over 16 ms only). */
async function typing(count, label) {
  await page.run("document.querySelector('.cmp-in').focus()");
  const from = await page.run("performance.now()");
  const times = [];
  for (let i = 0; i < count; i++) {
    const t0 = Date.now();
    await page.call("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", text: "a", windowsVirtualKeyCode: 65 });
    await page.call("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
    times.push(Date.now() - t0);
    await sleep(30);
  }
  await sleep(200);
  const slow = await page.run(`window.__stress.events.filter((e) => e.name === "keydown" && e.at >= ${from}).map((e) => e.ms)`);
  // Clear what was typed, so a draft does not linger.
  await page.run("document.querySelector('.cmp-in').focus(); document.execCommand('selectAll'); document.execCommand('delete')");
  const out = { keys: count, slowKeys: slow.length, worstMs: slow.length ? Math.max(...slow) : 0, p95Ms: ms(pct(slow.length ? slow : [0], 95)), roundTripP95: ms(pct(times, 95)) };
  note(`${label}: ${out.keys} keys · over 16 ms to paint: ${out.slowKeys} (worst ${out.worstMs} ms) · protocol round trip p95 ${out.roundTripP95} ms`);
  return out;
}

const time = (action, ready) => page.run(`window.__time(() => { ${action} }, ${ready ? `() => ${ready}` : "null"})`);

// ── the runs ──

/**
 * Sessions only, a heavy owner's way: thousands of sessions in many projects, and one conversation of
 * thousands of messages read back to its start a page at a time, then answered while all of it is drawn.
 */
async function deepRun() {
  const spec = `bots=0,sessions=${load.sessions},projects=${load.projects},messages=${load.messages}`;
  const conv = ".content .cscroll.markdown-chat";
  step(`Sessions only: ${load.sessions} sessions in ${load.projects} projects, at least ${load.messages} messages each`);
  await launch(spec, { FINXWORK_DEFAULT_MODE: "sessions" });
  await page.run(helpers);
  await until("document.querySelector('.srow')", "session rows", 60000);
  await sleep(1500);
  const marks = await page.run("window.__stress.marks");
  const startLong = await page.run("window.__stress.long");
  results.startup = { sideMs: ms(marks.side), firstSessionRowMs: ms(marks.sessionRow), longTasks: startLong.length, longestMs: ms(Math.max(0, ...startLong.map((x) => x.ms))) };
  note(`startup: sidebar at ${results.startup.sideMs} ms · first session row at ${results.startup.firstSessionRowMs} ms · ${startLong.length} long tasks, longest ${results.startup.longestMs} ms`);
  results.listMemory = await memory("the list loaded");
  results.listIdle = await busy(5, "the new session page, idle");
  results.listScroll = await scroll(".side-list", "session list scroll", ".srow, .grp-row");
  const end = await page.run(`(() => { const l = document.querySelector('.side-list'); const rows = l.querySelectorAll('.srow'); return l.getBoundingClientRect().bottom - rows[rows.length - 1].getBoundingClientRect().bottom; })()`);
  assert.ok(end >= 0 && end <= 12, `the session list's last row ends ${end}px from its end`);
  const regroup = async (index, label) => {
    await page.run("document.querySelector('.side-lh .tb').click()");
    await until("document.querySelector('[data-pane=group]')", "view menu");
    await page.run("document.querySelector('[data-pane=group]').click()");
    await until("document.querySelectorAll('[role=menuitemradio]').length >= 3", "group menu");
    const t = await time(`document.querySelectorAll('[role=menuitemradio]')[${index}].click()`);
    note(`group by ${label}: ${ms(t)} ms`);
    return ms(t);
  };
  results.regroup = { projectMs: await regroup(2, "project") };
  results.projectScroll = await scroll(".side-list", `session list by project (${load.projects} groups) scroll`, ".srow, .grp-row");
  results.regroup.dateMs = await regroup(1, "date");
  results.regroup.statusMs = await regroup(0, "status");
  await time(`document.querySelectorAll('.side-nav .nav-i')[1].click()`, `document.querySelector('.pal-in input')`);
  const searches = [];
  for (const q of ["缓存", "支付回调", "finx", "第 3 轮", "zzz"]) {
    searches.push(await time(`const i = document.querySelector('.pal-in input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(q)}); i.dispatchEvent(new Event('input', { bubbles: true }));`));
  }
  results.searchMs = { median: ms(median(searches)), max: ms(Math.max(...searches)) };
  note(`search keystroke over ${load.sessions} sessions: median ${results.searchMs.median} ms · max ${results.searchMs.max} ms`);
  await page.run("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await until("!document.querySelector('.pal')", "search closed");

  // One conversation, opened at its end: deep in the list, past the mock's own few demo sessions at the top.
  await page.run("document.querySelector('.side-list').scrollTop = 30000");
  await sleep(200);
  const open = await time(
    `const rows = document.querySelectorAll('.srow:not(.sel)'); const r = rows[Math.min(rows.length - 1, 4)]; window.__picked = r.querySelector('.stitle').textContent; r.click();`,
    `document.querySelector('.srow.sel .stitle')?.textContent === window.__picked && document.querySelectorAll('.tr [data-step-key]').length > 3`,
  );
  const picked = await page.run("window.__picked");
  results.open = { ms: ms(open), steps: await page.run("document.querySelectorAll('.tr [data-step-key]').length") };
  note(`open a session of ${load.messages}+ messages: ${results.open.ms} ms (${results.open.steps} rows drawn: the last page)`);
  results.openTyping = await typing(20, "typing, the last page drawn");
  const reply = async (label) => {
    await page.run(`(() => { const el = document.querySelector(${JSON.stringify(conv)}); el.scrollTop = el.scrollHeight; })()`);
    await sleep(500);
    await page.run("document.querySelector('.cmp-in').focus()");
    await page.call("Input.insertText", { text: "把缓存失效策略整理一下" });
    await page.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await page.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await until("document.querySelector('.working')", "the reply under way", 10000);
    await sleep(2500);
    const out = await busy(8, label);
    out.typing = await typing(15, `${label}: typing`);
    await until("!document.querySelector('.working')", "the reply done", 60000);
    await sleep(500);
    return out;
  };
  results.streamingLast = await reply("a reply written out, the last page loaded");

  // Read back to the start: off the end with the wheel, then each page asked for at the top.
  const at = await page.run(`(() => { const r = document.querySelector(${JSON.stringify(conv)}).getBoundingClientRect(); return { x: r.left + 12, y: r.top + r.height / 2 }; })()`);
  for (let i = 0; i < 3; i++) await page.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY: -240 });
  await sleep(300);
  results.pages = [];
  results.checkpoints = [];
  const marksAt = new Set([5, 10, 20, 30, 40, 50]);
  // The page right after a checkpoint follows the forced garbage collection it measures memory with, which costs the
  // next page warm code (up to 83 ms against 71 at most otherwise): written down apart, not held to the page target.
  let afterCheckpoint = false;
  const checkpoint = async (label) => {
    const rows = await page.run("Number(document.querySelector('.tr').dataset.rows)");
    const was = await page.run(`document.querySelector(${JSON.stringify(conv)}).scrollTop`);
    const point = { pages: results.pages.length, rows, memory: await memory(`${label}: ${rows} rows held`) };
    point.idle = await busy(3, `${label}: idle`);
    point.wheel = await wheel(conv, `${label}: wheel down`, 40, true);
    point.typing = await typing(15, `${label}: typing`);
    results.checkpoints.push(point);
    afterCheckpoint = true;
    // Back where the reading up was, settled: the next page is timed as reading up, not as coming back from below.
    await page.run(`document.querySelector(${JSON.stringify(conv)}).scrollTop = ${was}`);
    await sleep(800);
  };
  for (let n = 1; n <= load.pages; n++) {
    const r = await page.run(`(async () => {
      const el = document.querySelector(${JSON.stringify(conv)});
      if (!document.querySelector('.tdiv.earlier')) return null;
      // A page came when the conversation holds more rows (it draws only those near what is in sight).
      const held = () => Number(document.querySelector('.tr').dataset.rows);
      const first = held();
      const t0 = performance.now();
      el.scrollTop = 0;
      while (held() === first) {
        if (performance.now() - t0 > 20000) return { timeout: true };
        await new Promise((r) => setTimeout(r, 5));
      }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const long = window.__stress.long.filter((x) => x.at >= t0);
      return { ms: performance.now() - t0, longest: Math.max(0, ...long.map((x) => x.ms)), long: long.reduce((a, x) => a + x.ms, 0) };
    })()`);
    if (!r) break;
    assert.ok(!r.timeout, `page ${n} of earlier history did not come in 20 s`);
    results.pages.push({ ms: ms(r.ms), longest: ms(r.longest), blocked: ms(r.long), afterCheckpoint });
    afterCheckpoint = false;
    if (n % 5 === 0 || n === 1) note(`page ${n}: ${ms(r.ms)} ms to draw, longest block ${ms(r.longest)} ms`);
    if (marksAt.has(n)) await checkpoint(`after ${n} pages`);
    await sleep(50);
  }
  const allRows = await page.run("Number(document.querySelector('.tr').dataset.rows)");
  assert.ok(!(await page.run("!!document.querySelector('.tdiv.earlier')")) || results.pages.length >= load.pages, "the conversation reads back to its start");
  note(`read back to the start: ${results.pages.length} pages, ${allRows} rows held, ${await page.run("document.querySelectorAll('.vrow').length")} drawn`);
  await checkpoint("all of it");
  await page.run(`(() => { const el = document.querySelector(${JSON.stringify(conv)}); el.scrollTop = el.scrollHeight; })()`);
  await sleep(500);
  results.readUp = await wheel(conv, "all of it: wheel up from the end", 150);
  const jump = async (to, label) => {
    const frames = await page.run(`(async () => {
      const el = document.querySelector(${JSON.stringify(conv)});
      const box = el.getBoundingClientRect();
      el.scrollTop = ${to === "top" ? "0" : "el.scrollHeight"};
      for (let i = 1; i <= 60; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        if (document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest(".vrow")) return i;
      }
      return 61;
    })()`);
    note(`${label}: rows in sight after ${frames} frames`);
    return frames;
  };
  results.jumpTop = await jump("top", "scrollbar to the top");
  await sleep(500);
  results.jumpEnd = await jump("end", "scrollbar back to the end");
  await sleep(500);

  // Answered while all of it is drawn: back to the end, a message sent, the reply written out.
  await page.run(`(() => { const el = document.querySelector(${JSON.stringify(conv)}); el.scrollTop = el.scrollHeight; })()`);
  await sleep(500);
  await page.run("document.querySelector('.cmp-in').focus()");
  await page.call("Input.insertText", { text: "把缓存失效策略整理一下" });
  await page.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await until("document.querySelector('.working')", "the reply under way", 10000);
  await sleep(2500);
  results.streaming = await busy(8, `a reply written out, ${allRows} rows held`);
  results.streamingTyping = await typing(15, "typing while it writes");
  const following = await page.run(`(() => { const el = document.querySelector(${JSON.stringify(conv)}); return el.scrollHeight - el.scrollTop - el.clientHeight; })()`);
  note(`the reply's end is ${Math.round(following)} px below the view`);
  results.followingPx = Math.round(following);

  // Somewhere else and back: the page keeps only its last page (latestPage).
  await page.run("document.querySelector('.side-list').scrollTop = 30000");
  await sleep(200);
  await time(`[...document.querySelectorAll('.srow')].find((r) => r.querySelector('.stitle')?.textContent !== ${JSON.stringify(picked)}).click()`, `document.querySelectorAll('.tr [data-step-key]').length > 3 && document.querySelector('.srow.sel .stitle')?.textContent !== ${JSON.stringify(picked)}`);
  await sleep(500);
  results.afterSwitch = await memory("another session open");
  const back = await time(`[...document.querySelectorAll('.srow')].find((r) => r.querySelector('.stitle')?.textContent === ${JSON.stringify(picked)}).click()`, `document.querySelector('.srow.sel .stitle')?.textContent === ${JSON.stringify(picked)} && document.querySelectorAll('.tr [data-step-key]').length > 3`);
  results.backMs = ms(back);
  note(`back to the long session: ${results.backMs} ms`);
  await time(`document.querySelectorAll('.side-nav .nav-i')[0].click()`, `!document.querySelector(${JSON.stringify(conv)})`);
  await sleep(800);
  results.afterLeaving = await memory("back on the new session page");
  assert.deepEqual(page.errors, [], "no page errors");
  await quit();

  // The targets the conversation is held to (conversation-virtualization-design §2).
  const all = results.checkpoints.at(-1);
  const misses = [
    all.memory.nodes > 50_000 && `${all.memory.nodes} DOM nodes with all of it read (50,000 at most)`,
    all.memory.heapMB > 60 && `${all.memory.heapMB} MB of JS heap with all of it read (60 at most)`,
    all.memory.rendererMB > 500 && `${all.memory.rendererMB} MB renderer with all of it read (500 at most)`,
    Math.max(...results.pages.filter((p) => !p.afterCheckpoint).map((p) => p.ms)) > 80 && `a page took ${Math.max(...results.pages.filter((p) => !p.afterCheckpoint).map((p) => p.ms))} ms (80 at most)`,
    Math.max(...results.pages.map((p) => p.longest)) > 50 && `a page blocked ${Math.max(...results.pages.map((p) => p.longest))} ms (50 at most)`,
    results.streaming.taskPct > results.streamingLast.taskPct + 5 && `a reply costs ${results.streaming.taskPct}% with all of it, ${results.streamingLast.taskPct}% with the last page (5 points apart at most)`,
    ...results.checkpoints.map((c) => c.typing.worstMs > 50 && `typing took ${c.typing.worstMs} ms ${c.rows} rows in (50 at most)`),
    results.streamingTyping.worstMs > 50 && `typing took ${results.streamingTyping.worstMs} ms while a reply was written (50 at most)`,
    ...results.checkpoints.map((c) => c.wheel.max > 50 && `a ${c.wheel.max} ms frame scrolling ${c.rows} rows in (50 at most)`),
    results.readUp.max > 50 && `a ${results.readUp.max} ms frame reading up (50 at most)`,
    results.readUp.blank > 0 && `${results.readUp.blank} blank frames reading up`,
    results.jumpTop > 3 && `rows came ${results.jumpTop} frames after the scrollbar went to the top (3 at most)`,
    results.jumpEnd > 3 && `rows came ${results.jumpEnd} frames after the scrollbar went to the end (3 at most)`,
  ].filter(Boolean);
  // Checked at the very end, so the rest still runs and is written down.
  results.misses = misses;
  results.slowestPages = results.pages.map((p, i) => ({ page: i + 1, ...p })).sort((a, b) => b.ms - a.ms).slice(0, 3);
  note(`slowest pages: ${results.slowestPages.map((p) => `#${p.page} ${p.ms} ms (block ${p.longest} ms${p.afterCheckpoint ? ", after a checkpoint" : ""})`).join(", ")}`);

  step(`${load.sessions} sessions changing: ${load.churn} changes a second`);
  await launch(`${spec},churn=${load.churn}`, { FINXWORK_DEFAULT_MODE: "sessions" });
  await page.run(helpers);
  await until("document.querySelector('.srow')", "session rows", 60000);
  await sleep(1500);
  results.churn = await busy(10, "session mode while sessions change");
  results.churnTyping = await typing(30, "typing in the new session composer while sessions change");
  results.churnMemory = await memory("after the changes");
  assert.deepEqual(page.errors, [], "no page errors");
  await quit();

  // A bot's one conversation, which never starts again: the same reading back, the same targets.
  step(`A bot's conversation: at least ${load.messages} messages`);
  await launch(`bots=1,sessions=0,messages=${load.messages}`);
  await page.run(helpers);
  await until("document.querySelector('.brow')", "bot rows", 60000);
  await sleep(1000);
  const chat = ".content .cscroll";
  const held = "Number(document.querySelector('.tr.bots')?.dataset.rows ?? 0)";
  // The stress bot: its name ends in its number, the demo's own bots' names do not.
  await page.run(`[...document.querySelectorAll('.brow')].find((r) => /\\d$/.test(r.querySelector('.bname').textContent)).click()`);
  await until("document.querySelectorAll('.tr.bots .vrow').length > 3", "the bot's conversation", 30000);
  await sleep(1000);
  const botReply = async (label) => {
    await page.run(`(() => { const el = document.querySelector(${JSON.stringify(chat)}); el.scrollTop = el.scrollHeight; })()`);
    await sleep(500);
    await page.run("document.querySelector('.cmp-in').focus()");
    await page.call("Input.insertText", { text: "今天的情况怎么样" });
    await page.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await page.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await until("document.querySelector('.bm.working')", "the bot at work", 10000);
    await sleep(1000);
    const out = await busy(5, label);
    out.typing = await typing(15, `${label}: typing`);
    await until("!document.querySelector('.bm.working')", "the bot done", 60000);
    await sleep(500);
    return out;
  };
  const bot = { pages: [] };
  bot.replyLast = await botReply("a bot's reply, the last page loaded");
  await page.run(`document.querySelector(${JSON.stringify(chat)}).scrollTop = 0`);
  for (let n = 1; n <= load.pages; n++) {
    const r = await page.run(`(async () => {
      const el = document.querySelector(${JSON.stringify(chat)});
      if (!document.querySelector('.tdiv.earlier')) return null;
      const held = () => ${held};
      const first = held();
      const t0 = performance.now();
      el.scrollTop = 0;
      while (held() === first) {
        if (performance.now() - t0 > 20000) return { timeout: true };
        await new Promise((r) => setTimeout(r, 5));
      }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const long = window.__stress.long.filter((x) => x.at >= t0);
      return { ms: performance.now() - t0, longest: Math.max(0, ...long.map((x) => x.ms)) };
    })()`);
    if (!r) break;
    assert.ok(!r.timeout, `page ${n} of the bot's history did not come in 20 s`);
    bot.pages.push({ ms: ms(r.ms), longest: ms(r.longest) });
    if (n % 10 === 0) note(`bot page ${n}: ${ms(r.ms)} ms to draw, longest block ${ms(r.longest)} ms`);
    await sleep(50);
  }
  note(`the bot's conversation read back: ${bot.pages.length} pages, ${await page.run(held)} rows held, ${await page.run("document.querySelectorAll('.tr.bots .vrow').length")} drawn`);
  bot.memory = await memory("the bot's conversation, all of it read");
  await page.run(`(() => { const el = document.querySelector(${JSON.stringify(chat)}); el.scrollTop = el.scrollHeight; })()`);
  await sleep(500);
  bot.readUp = await wheel(chat, "the bot's conversation: wheel up from the end", 150);
  bot.replyAll = await botReply("a bot's reply, all of it loaded");
  results.bot = bot;
  assert.deepEqual(page.errors, [], "no page errors");
  await quit();
  const botMisses = [
    bot.memory.nodes > 50_000 && `${bot.memory.nodes} DOM nodes with the bot's conversation read (50,000 at most)`,
    bot.memory.heapMB > 60 && `${bot.memory.heapMB} MB of JS heap with the bot's conversation read (60 at most)`,
    Math.max(...bot.pages.map((p) => p.ms)) > 80 && `a bot page took ${Math.max(...bot.pages.map((p) => p.ms))} ms (80 at most)`,
    Math.max(...bot.pages.map((p) => p.longest)) > 50 && `a bot page blocked ${Math.max(...bot.pages.map((p) => p.longest))} ms (50 at most)`,
    bot.replyAll.taskPct > bot.replyLast.taskPct + 5 && `a bot's reply costs ${bot.replyAll.taskPct}% with all of it, ${bot.replyLast.taskPct}% with the last page (5 points apart at most)`,
    bot.replyAll.typing.worstMs > 50 && `typing took ${bot.replyAll.typing.worstMs} ms while the bot answered (50 at most)`,
    bot.readUp.max > 50 && `a ${bot.readUp.max} ms frame reading the bot's conversation up (50 at most)`,
    bot.readUp.blank > 0 && `${bot.readUp.blank} blank frames reading the bot's conversation up`,
  ].filter(Boolean);
  assert.deepEqual([...results.misses, ...botMisses], [], "targets missed");
}

async function listsRun() {
  const spec = `bots=${load.bots},sessions=${load.sessions},turns=${load.turns}`;
  step(`Static lists: ${load.bots} bots, ${load.sessions} sessions, ${load.turns} turns a conversation`);
  await launch(spec);
  await page.run(helpers);
  await until(`document.querySelector('.brow') && !document.querySelector('.side-list .loadrow')`, "bot rows");
  await sleep(1500);
  const marks = await page.run("window.__stress.marks");
  results.startup = { sideMs: ms(marks.side), firstBotRowMs: ms(marks.botRow) };
  note(`startup: sidebar at ${results.startup.sideMs} ms · first bot row at ${results.startup.firstBotRowMs} ms (from navigation)`);
  const startLong = await page.run("window.__stress.long");
  results.startup.longTasks = startLong.length;
  results.startup.longestMs = ms(Math.max(0, ...startLong.map((x) => x.ms)));
  note(`startup long tasks: ${startLong.length}, longest ${results.startup.longestMs} ms`);

  // The bot list shows every bot, in order: pinned first, then the latest message first.
  const order = await page.run(`(() => { const list = document.querySelector('.side-list.bots'); return { scrollHeight: list.scrollHeight, rowH: document.querySelector('.brow').getBoundingClientRect().height }; })()`);
  assert.ok(order.scrollHeight >= order.rowH * load.bots * 0.95, `the bot list holds every bot (${order.scrollHeight}px for ${load.bots} rows of ${order.rowH}px)`);
  results.botsMemory = await memory("bot mode, loaded");
  results.botsIdle = await busy(5, "bot mode, idle");
  results.botScroll = await scroll(".side-list.bots", "bot list scroll", ".brow");
  // Scrolled to the end, the last row drawn sits at the end of the list: nothing missing below it.
  const endGap = (list, row) => page.run(`(() => { const l = document.querySelector(${JSON.stringify(list)}); const rows = l.querySelectorAll(${JSON.stringify(row)}); return l.getBoundingClientRect().bottom - rows[rows.length - 1].getBoundingClientRect().bottom; })()`);
  const botEnd = await endGap(".side-list.bots", ".brow");
  assert.ok(botEnd >= 0 && botEnd <= 12, `the bot list's last row ends ${botEnd}px from its end`);

  // Opening bots: their long conversations.
  const botOpens = [];
  for (let i = 0; i < 8; i++) {
    const at = 40 + i * 37;
    await page.run(`document.querySelector('.side-list.bots').scrollTop = ${at * 64}`);
    await sleep(100);
    const t = await time(
      `const rows = document.querySelectorAll('.brow:not(.sel)'); window.__picked = rows[Math.min(rows.length - 1, 3)].querySelector('.bname').textContent; rows[Math.min(rows.length - 1, 3)].click();`,
      `document.querySelector('.brow.sel .bname')?.textContent === window.__picked && document.querySelector('.cmp-in') && document.querySelectorAll('.bbub').length > 3`,
    );
    botOpens.push(t);
  }
  results.botOpen = { medianMs: ms(median(botOpens)), maxMs: ms(Math.max(...botOpens)) };
  note(`open a bot (60-turn conversation): median ${results.botOpen.medianMs} ms · max ${results.botOpen.maxMs} ms`);
  results.botTyping = await typing(30, "typing in a bot's composer");
  results.botChatScroll = await wheel(".content .cscroll", "bot conversation, wheel upwards");

  // The session list.
  const toSessions = await time(`document.querySelector('[data-mode=sessions]').click()`, `document.querySelector('.srow')`);
  results.toSessionsMs = ms(toSessions);
  note(`switch to sessions: ${results.toSessionsMs} ms`);
  await sleep(500);
  results.sessionsMemory = await memory("session mode, loaded");
  results.sessionsIdle = await busy(5, "session mode, idle (running sessions at the top)");
  results.sessionScroll = await scroll(".side-list", "session list scroll", ".srow, .grp-row");
  const sessionEnd = await endGap(".side-list", ".srow");
  assert.ok(sessionEnd >= 0 && sessionEnd <= 12, `the session list's last row ends ${sessionEnd}px from its end`);

  // Grouping by project and by date, then back by status.
  const regroup = async (index, label) => {
    await page.run("document.querySelector('.side-lh .tb').click()");
    await until("document.querySelector('[data-pane=group]')", "view menu");
    await page.run("document.querySelector('[data-pane=group]').click()");
    await until("document.querySelectorAll('[role=menuitemradio]').length >= 3", "group menu");
    const t = await time(`document.querySelectorAll('[role=menuitemradio]')[${index}].click()`);
    note(`group by ${label}: ${ms(t)} ms`);
    return ms(t);
  };
  results.regroup = { projectMs: await regroup(2, "project"), dateMs: await regroup(1, "date"), statusMs: await regroup(0, "status") };

  const sessionOpens = [];
  for (let i = 0; i < 8; i++) {
    await page.run(`document.querySelector('.side-list').scrollTop = ${300 + i * 2400}`);
    await sleep(100);
    const t = await time(
      `const rows = document.querySelectorAll('.srow:not(.sel)'); const r = rows[Math.min(rows.length - 1, 4)]; window.__picked = r.querySelector('.stitle').textContent; r.click();`,
      `document.querySelector('.srow.sel .stitle')?.textContent === window.__picked && document.querySelectorAll('.tr .md, .tr .bub').length > 3`,
    );
    sessionOpens.push(t);
  }
  results.sessionOpen = { medianMs: ms(median(sessionOpens)), maxMs: ms(Math.max(...sessionOpens)) };
  note(`open a session (60-turn conversation): median ${results.sessionOpen.medianMs} ms · max ${results.sessionOpen.maxMs} ms`);
  results.sessionChatScroll = await wheel(".content .cscroll.markdown-chat", "session conversation, wheel upwards");
  results.sessionTyping = await typing(30, "typing in a session's composer");

  // Search across every session.
  await time(`document.querySelectorAll('.side-nav .nav-i')[1].click()`, `document.querySelector('.pal-in input')`);
  const searches = [];
  for (const q of ["缓存", "支付回调", "finx", "第 3 轮"]) {
    searches.push(await time(`const i = document.querySelector('.pal-in input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(q)}); i.dispatchEvent(new Event('input', { bubbles: true }));`));
  }
  results.searchMs = { median: ms(median(searches)), max: ms(Math.max(...searches)) };
  note(`search keystroke: median ${results.searchMs.median} ms · max ${results.searchMs.max} ms`);
  await page.run("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await until("!document.querySelector('.pal')", "search closed");

  results.idle = await busy(5, "session mode, a conversation open, idle");
  results.afterVisits = await memory("after opening 16 conversations");
  await time(`document.querySelectorAll('.side-nav .nav-i')[0].click()`, `!document.querySelector('.content .cscroll.markdown-chat')`);
  await sleep(500);
  results.afterLeaving = await memory("back on the new session page");
  await quit();

  step(`Lists changing: ${load.churn} changes a second`);
  await launch(`${spec},churn=${load.churn}`);
  await page.run(helpers);
  await until(`document.querySelector('.brow') && !document.querySelector('.side-list .loadrow')`, "bot rows");
  await sleep(1500);
  results.churnBots = await busy(10, "bot mode while bots change");
  results.churnBotTyping = await typing(40, "typing in a bot's composer while bots change");
  await time(`document.querySelector('[data-mode=sessions]').click()`, `document.querySelector('.srow')`);
  await sleep(500);
  results.churnSessions = await busy(10, "session mode while sessions change");
  results.churnSessionTyping = await typing(40, "typing in the new session composer while sessions change");
  results.churnMemory = await memory("after 20 s of changes");
  assert.deepEqual(page.errors, [], "no page errors");
  await quit();
}

try {
  await (scenario === "deep" ? deepRun() : listsRun());
  console.log("\n✓ stress run complete");
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await quit();
  // The numbers, whether or not every target was met.
  const file = opt("json");
  if (file) fs.writeFileSync(file, JSON.stringify({ load, results }, null, 2));
}
