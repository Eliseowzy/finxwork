#!/usr/bin/env node
// The agent edits a presentation (docs/desktop/presentation-deck-edit.md), in the real app: with
// the kernel holding the deck, a pptx opens in the file panel; the model reads it and changes the
// title with deck_edit. Asking for permissions, the standard approval asks first, naming each step,
// and nothing changes until it is allowed; allowed, the title reaches the editor once (by
// deck/sync) and the file on disk stays as it was. A second change is taken back with the step's
// 撤销; with edits accepted, a third is made without asking. deck_save then writes the deck, and
// only that slide's part of the file changes.
//
// A model server on this Mac plays the agent: it reads the ids it needs from the tool results it
// is sent. finx and the app are real.
//
//   node apps/desktop/e2e/deck-edit.mjs
//   FINXWORK_E2E_SHOTS=<folder> node apps/desktop/e2e/deck-edit.mjs   also screenshots
//   FINXWORK_E2E_NO_BUILD=1 …    uses the builds there are
import { cdpPort } from "./lib/port.mjs";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "../..");
const finx = path.join(root, "target/debug/finx");
const electron = path.join(desktop, "node_modules/.bin/electron");
const shots = process.env.FINXWORK_E2E_SHOTS;
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const step = (s) => console.log(`\n▶ ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => {
  throw new Error(message);
};
const check = (ok, message) => ok || fail(message);

// Short: the kernel's socket lives under it, and a socket path has at most 103 bytes.
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fxd-")));
const home = path.join(work, "finx");
fs.mkdirSync(path.join(work, "home"), { recursive: true });
const profile = path.join(work, "profile");
const socket = path.join(home, "run/finx.sock");
const proj = path.join(work, "proj");
fs.mkdirSync(proj);
const pptx = path.join(proj, "review.pptx");
fs.copyFileSync(path.join(root, "crates/finx-slide/tests/fixtures/editor.pptx"), pptx);
const original = fs.readFileSync(pptx);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

// The fixture's first slide is titled "Quarterly review".
const FIRST = { find: "Quarterly", text: "年度经营" };
const NEW_TITLE = "年度经营 review";
const SECOND = { find: "review", text: "复盘（不要）" };
// Made under full access: no card, straight into the deck.
const DIRECT = { find: "review", text: "总结" };

// ── the agent ──
const sse = (delta, finish) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\ndata: [DONE]\n\n`;
let calls = 0;
const requests = [];
const text = (m) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((c) => c.text ?? "").join("") : "");
/** The title's slide_id and shape_id, from the latest deck_read result in the conversation. */
function ids(messages) {
  const read = messages.filter((m) => m.role === "tool" && /## Slide 1/.test(text(m))).at(-1);
  if (!read) return null;
  const body = text(read);
  const slide = body.match(/slide_id (\S+)/)?.[1];
  const lines = body.split("\n");
  // The object whose text follows it holds the title.
  let shape = null;
  for (let i = 0; i < lines.length && !shape; i++) {
    const m = lines[i].match(/- \[\S+ (\S+) "/);
    if (m && lines.slice(i, i + 3).some((l) => l.includes("Quarterly review") || l.includes(NEW_TITLE))) shape = m[1];
  }
  return slide && shape ? { slide, shape } : null;
}
const tool = (name, args) => ({ index: 0, id: `call_${++calls}`, type: "function", function: { name: "call_tool", arguments: JSON.stringify({ name, arguments: args }) } });
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (!req.url?.endsWith("/chat/completions")) return res.writeHead(404).end();
    const { messages } = JSON.parse(body);
    requests.push(messages);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const lastUser = messages.findLastIndex((m) => m.role === "user");
    const ask = text(messages[lastUser]);
    // What this turn has done: the tools called since the person spoke.
    const done = messages.slice(lastUser + 1).filter((m) => m.role === "assistant").flatMap((m) => m.tool_calls ?? []).map((c) => JSON.parse(c.function.arguments).name);
    const reply = (content) => res.end(sse({ role: "assistant", content }, "stop"));
    const call = (name, args) => res.end(sse({ role: "assistant", tool_calls: [tool(name, args)] }, "tool_calls"));
    if (ask.includes("打开")) return reply("在这里：[演示](review.pptx)");
    if (ask.includes("读一下")) {
      if (!done.includes("deck_read")) return call("deck_read", { deck: path.join(proj, "saved-copy.pptx"), slides: "1", detail: "objects" });
      return reply("读过了。");
    }
    if (ask.includes("改标题")) {
      if (!done.includes("deck_open")) return call("deck_open", { deck: pptx });
      if (!done.includes("deck_read")) return call("deck_read", { deck: pptx, slides: "1", detail: "objects" });
      const at = ids(messages);
      if (!at) return reply(`读不到标题：${messages.filter((m) => m.role === "tool").map(text).join("\n---\n").slice(0, 2000)}`);
      if (!done.includes("deck_edit")) return call("deck_edit", { deck: pptx, note: "把标题改成年度经营", edits: [{ op: "replace_text", slide_id: at.slide, shape_id: at.shape, ...FIRST }] });
      return reply("提议好了，请过目。");
    }
    if (ask.includes("再改")) {
      if (!done.includes("deck_read")) return call("deck_read", { deck: pptx, slides: "1", detail: "objects" });
      const at = ids(messages);
      if (!at) return reply("读不到标题");
      if (!done.includes("deck_edit")) return call("deck_edit", { deck: pptx, note: "再改一处", edits: [{ op: "replace_text", slide_id: at.slide, shape_id: at.shape, ...SECOND }] });
      return reply("又提议了一处。");
    }
    if (ask.includes("直接改")) {
      if (!done.includes("deck_read")) return call("deck_read", { deck: pptx, slides: "1", detail: "objects" });
      const at = ids(messages);
      if (!at) return reply("读不到标题");
      if (!done.includes("deck_edit")) return call("deck_edit", { deck: pptx, note: "直接改", edits: [{ op: "replace_text", slide_id: at.slide, shape_id: at.shape, ...DIRECT }] });
      return reply("改好了。");
    }
    if (ask.includes("保存")) {
      if (!done.includes("deck_save")) return call("deck_save", { deck: pptx });
      return reply("保存了。");
    }
    reply("ok");
  });
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(
  path.join(home, "models.toml"),
  `[providers.mock]\nname = "Mock"\napi = "openai-chat"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nauth = "none"\n\n[[providers.mock.models]]\nid = "mock-1"\nname = "Mock One"\ncontext_window = 128000\nmax_output_tokens = 2000\n`,
);
fs.writeFileSync(path.join(home, "config.toml"), `model = "mock/mock-1"\npermission_mode = "manual"\n[models]\nnetwork = false\n`);

/** One request to finx over its socket. */
function finxCall(method, params = {}) {
  return finxCalls([[method, params]]);
}

/** Requests in order on one connection (an attach holds for the ones after it); the last one's answer. */
function finxCalls(calls) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(socket);
    let buf = "";
    const send = (id, m, p) => s.write(JSON.stringify({ jsonrpc: "2.0", id, method: m, params: p }) + "\n");
    s.on("connect", () => send(0, "initialize", { protocol_version: 2, client_info: { name: "e2e" } }));
    s.on("data", (c) => {
      buf += c;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (typeof msg.id !== "number") continue;
        if (msg.id < calls.length && (msg.id === 0 || !msg.error)) send(msg.id + 1, ...calls[msg.id]);
        else {
          s.end();
          resolve(msg);
        }
      }
    });
    s.on("error", reject);
    s.on("close", () => reject(new Error("the kernel closed the connection")));
  });
}

// ── the app, driven over the DevTools protocol ──
async function devtools(url) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  const waiting = new Map();
  let next = 0;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result);
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      waiting.set(++next, { resolve, reject });
      ws.send(JSON.stringify({ id: next, method, params }));
    });
  return { call, close: () => ws.close() };
}

let app = null;
let port = 0;
async function launch() {
  port = cdpPort();
  const env = { ...process.env, FINX_HOME: home, HOME: path.join(work, "home"), FINXWORK_DEFAULT_MODE: "sessions", FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINX_CREDENTIAL_STORE: "file" };
  delete env.ELECTRON_RUN_AS_NODE;
  app = spawn(electron, [desktop, `--remote-debugging-port=${port}`], { env, stdio: ["ignore", "ignore", "inherit"] });
  let target;
  for (let i = 0; i < 200 && !target; i++) {
    await sleep(200);
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => []);
    target = list.find((t) => t.type === "page" && !t.url.includes("#settings") && !t.url.startsWith("devtools"));
  }
  check(target, "the main window never showed up");
  const page = await devtools(target.webSocketDebuggerUrl);
  const cdp = page.call;
  const run = async (expr) => {
    const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const until = async (what, expr, ms = 30000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await run(expr);
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(120);
    }
  };
  const shot = async (name) => {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, "base64"));
  };
  /** A real click on the element: the editor's review is caught on the window's capture phase. */
  const click = async (selector) => {
    const at = () => run(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: "nearest" }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    // Where it stays: a panel still sliding in would take the click somewhere else.
    let box = await at();
    for (let i = 0; i < 30 && box; i++) {
      await sleep(100);
      const next = await at();
      if (next && next.x === box.x && next.y === box.y) break;
      box = next;
    }
    check(box, `nothing to click: ${selector}`);
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  };
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 0, mobile: false });
  return { cdp, run, until, shot, click, close: page.close };
}

async function quit() {
  if (!app || app.exitCode !== null) return;
  const exited = new Promise((r) => app.once("exit", r));
  app.kill("SIGTERM");
  const timeout = setTimeout(() => app.kill("SIGKILL"), 3000);
  await exited;
  clearTimeout(timeout);
  try {
    execFileSync("pkill", ["-f", `remote-debugging-port=${port}`]);
  } catch {}
}

/** Sets the conversation's permission mode, as its menu does. */
async function permission(mode) {
  const listed = await finxCall("session/list", {});
  const sessions = listed.result?.sessions ?? [];
  const sid = (sessions.find((x) => x.cwd === proj) ?? sessions[0])?.session_id;
  check(sid, `the session: ${JSON.stringify(listed).slice(0, 400)}`);
  const set = await finxCalls([["session/attach", { session_id: sid }], ["session/op", { session_id: sid, op: { type: "set_permission_mode", mode } }]]);
  check(!set.error, `set_permission_mode: ${JSON.stringify(set.error)}`);
}

/** Says something and waits for the turn to end. */
async function ask(page, words) {
  await page.run(`document.querySelector(".cmp-in").focus()`);
  await page.cdp("Input.insertText", { text: words });
  await page.until("send enabled", `!document.querySelector("button.send")?.disabled`);
  const before = requests.length;
  await page.run(`document.querySelector("button.send").click()`);
  await page.until(`the model asked about ${words}`, `${requests.length > before}`, 20000).catch(() => {});
  await sleep(300);
  await page.until(`the turn ${words} ended`, `!document.querySelector(".working")`, 60000).catch(async (e) => fail(`${e.message}: ${await page.run(`[...document.querySelectorAll(".working")].map((w) => w.closest("[class]")?.parentElement?.className + " :: " + w.innerText).join(" | ")`)}`));
}

const edits = `[...document.querySelectorAll("[data-testid=deck-edit]")]`;
const approval = `document.querySelector(".appr")`;
const outline = `[...document.querySelectorAll(".fpn .pptx-outline")].map((e) => e.innerText).join("\\n")`;
const count = (hay, needle) => hay.split(needle).length - 1;
const deckDirs = () => (fs.existsSync(path.join(home, "decks")) ? fs.readdirSync(path.join(home, "decks")).filter((d) => fs.existsSync(path.join(home, "decks", d, "source.pptx"))) : []);
/** Says something; the turn goes on to wait for an approval. */
async function say(page, words) {
  await page.run(`document.querySelector(".cmp-in").focus()`);
  await page.cdp("Input.insertText", { text: words });
  await page.until("send enabled", `!document.querySelector("button.send")?.disabled`);
  await page.run(`document.querySelector("button.send").click()`);
}
// A zip's parts by name, read by Python's zipfile (unzip takes "[Content_Types].xml" for a pattern).
const zipRead = "import base64, json, sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nprint(json.dumps({n: base64.b64encode(z.read(n)).decode() for n in z.namelist()}))";
const parts = (file) => Object.fromEntries(Object.entries(JSON.parse(execFileSync("python3", ["-I", "-c", zipRead, file], { encoding: "utf8", maxBuffer: 256 << 20 }))).map(([n, b]) => [n, Buffer.from(b, "base64")]));


let failed = false;
try {
  if (!process.env.FINXWORK_E2E_NO_BUILD) {
    step("building finx and the app");
    sh("cargo", ["build", "-p", "finx-cli"], { cwd: root });
    sh("pnpm", ["--dir", desktop, "build"]);
  }
  const page = await launch();
  await page.until("the new session page", `!!document.querySelector(".cmp-in")`, 60000);
  await page.run(`localStorage.setItem("finx.deck.kernelAuthority", "1")`);
  await page.run(`localStorage.setItem("main-view", JSON.stringify({ ...JSON.parse(localStorage.getItem("main-view") ?? "{}"), draft: { cwd: ${JSON.stringify(proj)}, model: null, thinking: null, permission: "manual" } }))`);
  await page.run(`location.reload()`);
  await page.until("the new session page again", `!!document.querySelector(".cmp-in")`, 60000);

  step("the kernel holds the presentation the file panel opens");
  await ask(page, "打开演示");
  const chip = `[...document.querySelectorAll(".am .fref")].find((c) => c.textContent.includes("演示"))`;
  await page.until("the link to the presentation", `!!${chip}`);
  await page.run(`${chip}.click()`);
  await page.until("the presentation over the window", `!!document.querySelector(".fpv-panel") || !!document.querySelector(".fpn")`, 20000).catch(async (e) => fail(`${e.message}: ${await page.run(`document.body.innerText.slice(-800)`)} ${await page.run(`${chip}.outerHTML`)}`));
  await page.run(`document.querySelector(".fpv-panel")?.click()`);
  await page.until("the presentation's editor in the panel", `!!document.querySelector(".fpn .pptx-surface aside")`, 90000);
  await page.until("the editor ready", `!!document.querySelector(".fpn .pptx-outline-bar button:not(:disabled)")`, 60000);
  check(deckDirs().length === 1, `the kernel holds the deck: ${JSON.stringify(deckDirs())}`);
  await page.run(`document.querySelector(".fpn .pptx-outline-bar button").click()`);
  await page.until("the outline", `(${outline}).includes("Quarterly review")`);
  await page.shot("01-opened");

  const tabStatus = `document.querySelector(".fpn-tools .fpn-state")?.textContent.trim() ?? ""`;
  step("asking for permissions: the approval names the step, and nothing changes until it is allowed");
  await say(page, "改标题");
  await page.until("the approval", `!!${approval}`, 30000).catch(async (e) => fail(`${e.message}: ${await page.run(`document.querySelector(".cscroll")?.innerText.slice(-1500)`)}`));
  const asked = await page.run(`${approval}.innerText`);
  check(asked.includes(`replace "Quarterly" with "年度经营"`), `the approval names the step: ${asked}`);
  check(!(await page.run(outline)).includes(NEW_TITLE), "the deck changed before it was allowed");
  check(sha(fs.readFileSync(pptx)) === sha(original), "the file changed before anything was allowed");
  await page.shot("02-asked");

  step("allowed: the title reaches the editor once, the file untouched, the step offers 撤销");
  await page.click(`.appr .btn.primary`);
  await page.until("the turn ended", `!document.querySelector(".working") && !${approval}`, 60000);
  await page.until("the new title in the editor", `(${outline}).includes(${JSON.stringify(NEW_TITLE)})`, 20000).catch(async (e) => fail(`${e.message}: ${await page.run(outline)}`));
  await sleep(1000);
  const after = await page.run(outline);
  check(count(after, "年度经营") === 1, `the title applied once: ${after}`);
  check(sha(fs.readFileSync(pptx)) === sha(original), "the edit wrote the file");
  await page.until("the step's actions", `${edits}.length === 1`, 10000).catch(async (e) => fail(`${e.message}: ${await page.run(`document.querySelector(".cscroll")?.innerText.slice(-1500)`)}`));
  check((await page.run(`${edits}[0].innerText`)).includes("查看第 1 页"), "the step names the page");
  await page.until("the tab says unsaved", `${tabStatus} === "未保存"`, 10000).catch(async (e) => fail(`${e.message}: ${await page.run(tabStatus)}`));
  await page.shot("03-applied");

  step("a second change, taken back with the step's 撤销");
  await say(page, "再改一处");
  await page.until("the approval", `!!${approval}`, 30000);
  await page.click(`.appr .btn.primary`);
  await page.until("the second change in the editor", `(${outline}).includes("复盘")`, 20000).catch(async (e) => fail(`${e.message}: ${await page.run(outline)}`));
  await page.until("its step", `${edits}.length === 2`, 10000);
  await page.run(`${edits}[1].querySelector(".deck-edit-undo")?.click()`);
  await page.until("the step says undone", `!!${edits}[1].querySelector(".deck-edit-done")`, 10000).catch(async (e) => fail(`${e.message}: ${await page.run(`${edits}[1].innerText`)}`));
  await page.until("the change gone from the editor", `!(${outline}).includes("复盘") && (${outline}).includes(${JSON.stringify(NEW_TITLE)})`, 20000).catch(async (e) => fail(`${e.message}: ${await page.run(outline)}`));
  await page.shot("04-undone");

  step("edits accepted: deck_edit is made without asking");
  await permission("accept-edits");
  await ask(page, "直接改");
  check(!(await page.run(`!!${approval}`)), "an approval was asked under accepted edits");
  await page.until("the change in the editor", `(${outline}).includes("年度经营 总结")`, 20000).catch(async (e) => fail(`${e.message}: ${await page.run(outline)}`));
  await page.shot("05-accept-edits");

  step("deck_save writes the deck, and only its slide's part changes");
  await ask(page, "保存");
  for (let i = 0; i < 100 && sha(fs.readFileSync(pptx)) === sha(original); i++) await sleep(100);
  check(sha(fs.readFileSync(pptx)) !== sha(original), "deck_save did not write the file");
  await page.until("the tab says saved", `${tabStatus} === "已保存"`, 10000).catch(async (e) => fail(`${e.message}: ${await page.run(tabStatus)}`));
  const orig = path.join(work, "original.pptx");
  fs.writeFileSync(orig, original);
  const before = parts(orig), now = parts(pptx);
  const slide1 = now["ppt/slides/slide1.xml"].toString("utf8");
  check(slide1.includes("年度经营 总结") && !slide1.includes("复盘"), `the saved slide has the kept changes only: ${slide1.match(/<a:t>[^<]*/g)}`);
  const changed = [];
  for (const [name, bytes] of Object.entries(before)) {
    if (!now[name]) changed.push(`${name} (gone)`);
    else if (!bytes.equals(now[name])) changed.push(name);
  }
  for (const name of Object.keys(now)) if (!before[name]) changed.push(`${name} (new)`);
  check(JSON.stringify(changed) === JSON.stringify(["ppt/slides/slide1.xml"]), `only the first slide changed: ${JSON.stringify(changed)}`);
  await page.shot("06-saved");

  page.close();
  console.log("\n✔ the agent's edit is asked about, made in the deck, taken back with 撤销, made without asking under accepted edits, and saved");
} catch (e) {
  failed = true;
  console.error(`\n✘ ${e.message}`);
} finally {
  await quit();
  await finxCall("server/shutdown", {}).catch(() => {});
  provider.close();
  if (!failed) fs.rmSync(work, { recursive: true, force: true });
  else console.error(`  kept ${work} (finx's log is in finx/logs)`);
}
process.exit(failed ? 1 : 0);
