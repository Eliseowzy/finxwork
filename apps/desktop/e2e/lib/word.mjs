// What the Word scripts (word-editor.mjs, word-ai.mjs) share: a private home, a scripted model
// standing in for the agent, the real kernel and the real app driven over the DevTools protocol.
import { cdpPort } from "./port.mjs";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "../..");
const root = path.resolve(desktop, "../..");
const finx = path.join(root, "target/debug/finx");
const electron = path.join(desktop, "node_modules/.bin/electron");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const fail = (message) => {
  throw new Error(message);
};
export const check = (ok, message) => ok || fail(message);
export const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
export const step = (s) => console.log(`\n▶ ${s}`);
export const text = (m) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((c) => c.text ?? "").join("") : "");

// A zip's parts by name, read by Python's zipfile.
const zipRead = "import base64, json, sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nprint(json.dumps({n: base64.b64encode(z.read(n)).decode() for n in z.namelist()}))";
export const parts = (file) => Object.fromEntries(Object.entries(JSON.parse(execFileSync("python3", ["-I", "-c", zipRead, file], { encoding: "utf8", maxBuffer: 256 << 20 }))).map(([n, b]) => [n, Buffer.from(b, "base64")]));
/** The names of the parts that differ between two zips. */
export function changedParts(a, b) {
  const changed = [];
  for (const [name, bytes] of Object.entries(a)) {
    if (!b[name]) changed.push(`${name} (gone)`);
    else if (!bytes.equals(b[name])) changed.push(name);
  }
  for (const name of Object.keys(b)) if (!a[name]) changed.push(`${name} (new)`);
  return changed;
}
/** The text of a part's w:t runs, joined. */
export const runs = (xml) => [...xml.matchAll(/<w:(?:t|delText)(?: [^>]*)?>([^<]*)</g)].map((m) => m[1]).join("");

const sse = (delta, finish) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\ndata: [DONE]\n\n`;

/**
 * Starts the scripted model and the home. `respond({ messages, ask, done, reply, call })` plays the agent:
 * `ask` is the last thing the person said, `done` the tools called since, `reply(words)` ends the turn
 * and `call(name, args)` asks for a tool.
 */
export async function setup({ prefix, fixture = "report.docx", file = "report.docx", respond, images = false, permission = "manual" }) {
  // Short: the kernel's socket lives under it, and a socket path has at most 103 bytes.
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const home = path.join(work, "finx");
  fs.mkdirSync(path.join(work, "home"), { recursive: true });
  const profile = path.join(work, "profile");
  const socket = path.join(home, "run/finx.sock");
  const proj = path.join(work, "proj");
  fs.mkdirSync(proj);
  const docx = path.join(proj, file);
  fs.copyFileSync(path.join(import.meta.dirname, "../fixtures", fixture), docx);
  const original = fs.readFileSync(docx);

  let calls = 0;
  const requests = [];
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
      const done = messages.slice(lastUser + 1).filter((m) => m.role === "assistant").flatMap((m) => m.tool_calls ?? []).map((c) => JSON.parse(c.function.arguments).name);
      const reply = (content) => res.end(sse({ role: "assistant", content }, "stop"));
      const call = (name, args) => res.end(sse({ role: "assistant", tool_calls: [{ index: 0, id: `call_${++calls}`, type: "function", function: { name: "call_tool", arguments: JSON.stringify({ name, arguments: args }) } }] }, "tool_calls"));
      try {
        respond({ messages, ask, done, reply, call, tools: messages.slice(lastUser + 1).filter((m) => m.role === "tool").map(text) });
      } catch (e) {
        reply(`script error: ${e.message}`);
      }
    });
  });
  await new Promise((r) => provider.listen(0, "127.0.0.1", r));
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "models.toml"),
    `[providers.mock]\nname = "Mock"\napi = "openai-chat"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nauth = "none"\n\n[[providers.mock.models]]\nid = "mock-1"\nname = "Mock One"\ncontext_window = 128000\nmax_output_tokens = 2000\n${images ? 'input = ["text", "image"]\n' : ""}`,
  );
  fs.writeFileSync(path.join(home, "config.toml"), `model = "mock/mock-1"\npermission_mode = "${permission}"\n[models]\nnetwork = false\n`);

  /** Requests in order on one connection (an attach holds for the ones after it); the last one's answer. */
  const finxCalls = (list) =>
    new Promise((resolve, reject) => {
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
          if (msg.id < list.length && (msg.id === 0 || !msg.error)) send(msg.id + 1, ...list[msg.id]);
          else {
            s.end();
            resolve(msg);
          }
        }
      });
      s.on("error", reject);
      s.on("close", () => reject(new Error("the kernel closed the connection")));
    });
  const finxCall = (method, params = {}) => finxCalls([[method, params]]);

  async function devtools(url) {
    const ws = new WebSocket(url);
    await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
    const waiting = new Map();
    const events = [];
    let next = 0;
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.method) events.push(m);
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
    return { call, events, close: () => ws.close() };
  }

  let app = null;
  let port = 0;
  const shots = process.env.FINXWORK_E2E_SHOTS;
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
    /** Where an element's middle is, once it has stopped moving. */
    const where = async (selector) => {
      const at = () => run(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: "nearest" }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      let box = await at();
      for (let i = 0; i < 30 && box; i++) {
        await sleep(100);
        const next = await at();
        if (next && next.x === box.x && next.y === box.y) break;
        box = next;
      }
      check(box, `nothing there: ${selector}`);
      return box;
    };
    const clickAt = async (x, y, clickCount = 1) => {
      await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount });
      await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount });
    };
    const click = async (selector) => {
      const box = await where(selector);
      await clickAt(box.x, box.y);
    };
    /** A key chord such as ⌘S, as a real key event. */
    const chord = async (key, code, modifiers) => {
      await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, modifiers, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), commands: [] });
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) });
    };
    /** The text the editor draws (its layout runs), page by page. */
    const editorText = () => run(`[...document.querySelectorAll(".fpn .layout-run-text")].map((e) => e.textContent).join("")`);
    // Where the first page's paragraphs are drawn, from the page's top (the fixture's, at 100%): the text
    // layer's boxes do not follow the canvas, so a click is aimed by these.
    const PARAGRAPH_Y = { title: 115, first: 148, conclusion: 291 };
    /** Where in the window the line of a paragraph of the fixture is: its start and end. */
    const lineOf = async (which) => {
      const c = await run(`(() => { const r = document.querySelector(".fpn .word-editor-canvas canvas").getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
      return { x: c.x + 98, x2: c.x + 470, y: c.y + PARAGRAPH_Y[which] };
    };
    /** Selects a paragraph's line by dragging across it, as a person does. */
    const select = async (which) => {
      const at = await lineOf(which);
      await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
      await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 });
      for (let i = 1; i <= 10; i++) await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x + ((at.x2 - at.x) * i) / 10, y: at.y, button: "left", buttons: 1 });
      await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x2, y: at.y, button: "left", clickCount: 1 });
      return at;
    };
    await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 0, mobile: false });
    await cdp("Runtime.enable");
    /** The page's font warnings so far: the engine's "[fontRegistry] …" ones mean it measured with made-up metrics. */
    const fontWarnings = () => page.events
      .filter((e) => e.method === "Runtime.consoleAPICalled")
      .map((e) => e.params.args.map((a) => a.value ?? a.description ?? "").join(" "))
      .filter((line) => line.includes("[fontRegistry]") || line.includes("word fonts unavailable"));
    return { cdp, events: page.events, fontWarnings, editorText, select, lineOf, run, until, shot, click, clickAt, where, chord, close: page.close };
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
  async function setPermission(mode) {
    const listed = await finxCall("session/list", {});
    const sessions = listed.result?.sessions ?? [];
    const sid = (sessions.find((x) => x.cwd === proj) ?? sessions[0])?.session_id;
    check(sid, `the session: ${JSON.stringify(listed).slice(0, 400)}`);
    const set = await finxCalls([["session/attach", { session_id: sid }], ["session/op", { session_id: sid, op: { type: "set_permission_mode", mode } }]]);
    check(!set.error, `set_permission_mode: ${JSON.stringify(set.error)}`);
  }

  /** Says something; the turn goes on from there. */
  async function say(page, words) {
    await page.run(`document.querySelector(".cmp-in").focus()`);
    await page.cdp("Input.insertText", { text: words });
    await page.until("send enabled", `!document.querySelector("button.send")?.disabled`);
    await page.run(`document.querySelector("button.send").click()`);
  }
  /** Says something and waits for the turn to end. */
  async function ask(page, words) {
    const before = requests.length;
    await say(page, words);
    await page.until(`the model asked about ${words}`, `${requests.length > before}`, 20000).catch(() => {});
    await sleep(300);
    await page.until(`the turn ${words} ended`, `!document.querySelector(".working")`, 60000).catch(async (e) => fail(`${e.message}: ${await page.run(`document.querySelector(".cscroll")?.innerText.slice(-1500)`)}`));
  }

  /** Opens the first session's page on the project, the document linked in the answer to "打开". */
  async function openDocument(page, label) {
    await page.until("the new session page", `!!document.querySelector(".cmp-in")`, 60000);
    await page.run(`localStorage.setItem("main-view", JSON.stringify({ ...JSON.parse(localStorage.getItem("main-view") ?? "{}"), draft: { cwd: ${JSON.stringify(proj)}, model: null, thinking: null, permission: ${JSON.stringify(permission)} } }))`);
    await page.run(`location.reload()`);
    await page.until("the new session page again", `!!document.querySelector(".cmp-in")`, 60000);
    await ask(page, `打开${label}`);
    const chip = `[...document.querySelectorAll(".am .fref")].find((c) => c.textContent.includes(${JSON.stringify(label)}))`;
    await page.until("the link to the document", `!!${chip}`);
    await page.run(`${chip}.click()`);
    await page.until("the Word editor in the panel", `!!document.querySelector(".fpn .word-surface")`, 90000).catch(async (e) => fail(`${e.message}: ${await page.run(`document.body.innerText.slice(-600)`)}`));
    await page.until("the first page painted", `!document.querySelector(".fpn .word-opening-overlay") && !!document.querySelector(".fpn .word-editor-canvas canvas")`, 90000);
  }

  async function finish(failed) {
    await quit();
    await finxCall("server/shutdown", {}).catch(() => {});
    provider.close();
    if (!failed) fs.rmSync(work, { recursive: true, force: true });
    else console.error(`  kept ${work} (finx's log is in finx/logs)`);
  }

  return { work, home, proj, docx, original, requests, finxCall, finxCalls, launch, setPermission, say, ask, openDocument, finish };
}
