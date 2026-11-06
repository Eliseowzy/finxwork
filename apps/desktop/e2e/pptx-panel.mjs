#!/usr/bin/env node
// A presentation opened from a bot's message (docs/desktop/presentation-editor-design.md), in the
// real app: the pptx a bot sent opens beside the conversation, fills the file panel's body, and
// its slide strip and preview stay inside the panel. The panel's remembered width — kept from a
// wider window — gives way to the conversation's room instead of pushing the conversation off the
// page and drawing the presentation outside the panel.
//
// A model server on this Mac answers with the file; finx and the app are real. The width in the
// browser's storage is set before the panel opens, which is the state the bug report came from.
//
//   node apps/desktop/e2e/pptx-panel.mjs
//   FINXWORK_E2E_SHOTS=<folder> node apps/desktop/e2e/pptx-panel.mjs   also screenshots
//   FINXWORK_E2E_NO_BUILD=1 …    uses the builds there are
import { cdpPort } from "./lib/port.mjs";
import { execFileSync, spawn } from "node:child_process";
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
const near = (got, want, slack, what) => (Math.abs(got - want) <= slack ? undefined : fail(`${what}: ${got}, not ${want} (±${slack})`));

// Short: the kernel's socket lives under it, and a socket path has at most 103 bytes.
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fxp-")));
const home = path.join(work, "finx");
fs.mkdirSync(path.join(work, "home"), { recursive: true });
const profile = path.join(work, "profile");
const socket = path.join(home, "run/finx.sock");
// The presentation the bot sends: a real file of pages, shapes and text.
const proj = path.join(work, "proj");
fs.mkdirSync(proj);
const pptx = path.join(proj, "sample-presentation.pptx");
fs.copyFileSync(path.join(root, "crates/finx-slide/tests/fixtures/text-layout.pptx"), pptx);
const notes = path.join(proj, "notes.md");
fs.writeFileSync(notes, "# Notes\n\nBeside the slides.\n");

// ── what the bot sends ──
const sse = (delta, finish) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\ndata: [DONE]\n\n`;
let calls = 0;
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (!req.url?.endsWith("/chat/completions")) return res.writeHead(404).end();
    const request = JSON.parse(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (!request.tools?.some((t) => t.function?.name === "send_to_user")) return res.end(sse({ role: "assistant", content: "ok" }, "stop"));
    const args = { type: "attachment", files: [{ path: pptx }, { path: notes }], end_turn: true };
    const call = { index: 0, id: `call_${++calls}`, type: "function", function: { name: "send_to_user", arguments: JSON.stringify(args) } };
    res.end(sse({ role: "assistant", tool_calls: [call] }, "tool_calls"));
  });
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(
  path.join(home, "models.toml"),
  `[providers.mock]\nname = "Mock"\napi = "openai-chat"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nauth = "none"\n\n[[providers.mock.models]]\nid = "mock-1"\nname = "Mock One"\ncontext_window = 128000\nmax_output_tokens = 2000\n`,
);
fs.writeFileSync(path.join(home, "config.toml"), `model = "mock/mock-1"\npermission_mode = "manual"\n[models]\nnetwork = false\n`);

/** One request to finx over its socket: the service the app started outlives the app. */
function finxCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(socket);
    let buf = "";
    const send = (id, m, p) => s.write(JSON.stringify({ jsonrpc: "2.0", id, method: m, params: p }) + "\n");
    s.on("connect", () => send(1, "initialize", { protocol_version: 2, client_info: { name: "e2e" } }));
    s.on("data", (c) => {
      buf += c;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (msg.id === 1) send(2, method, params);
        if (msg.id === 2) {
          s.end();
          resolve(msg);
        }
      }
    });
    s.on("error", reject);
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
async function launch() {
  const port = cdpPort();
  // ELECTRON_RUN_AS_NODE (set in some shells) would run Electron as plain Node.
  const env = { ...process.env, FINX_HOME: home, HOME: path.join(work, "home"), FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINX_CREDENTIAL_STORE: "file" };
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
  const clickAt = async (point) => {
    await sleep(100);
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  };
  const click = async (selector, nth = 0) => {
    const box = await run(`(() => { const e = document.querySelectorAll(${JSON.stringify(selector)})[${nth}]; if (!e) return null; e.scrollIntoView({ block: "nearest" }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    check(box, `nothing to click: ${selector}[${nth}]`);
    await clickAt(box);
  };
  /** The file tile a bot message carries, by its name (a name may come up in several messages). */
  const clickTile = async (name) => {
    const box = await run(`(() => { const e = [...document.querySelectorAll(".tr.bots .bfiles .tile")].find((t) => t.textContent.includes(${JSON.stringify(name)})); if (!e) return null; e.scrollIntoView({ block: "nearest" }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    check(box, `nothing to click: the tile of ${name}`);
    await clickAt(box);
  };
  const size = (w, h) => cdp("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 0, mobile: false });
  await size(1240, 820);
  return { cdp, run, until, shot, click, clickTile, size, close: page.close };
}

async function quit() {
  if (!app || app.exitCode !== null) return;
  const exited = new Promise((r) => app.once("exit", r));
  app.kill("SIGTERM");
  await Promise.race([exited, sleep(5000)]);
}

/** The panel, the conversation's column and the presentation's surfaces, in page pixels. */
const layout = `(() => {
  const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { left: +b.left.toFixed(1), right: +b.right.toFixed(1), width: +b.width.toFixed(1), top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1) }; };
  return { win: innerWidth, spage: r(".spage"), scol: r(".scol"), panel: r(".bgp"), strip: r(".bgp .brp-strip"), main: r(".fpn-main"), load: r(".pptx-load"), card: r(".pptx-load-card"), surface: r(".pptx-surface"), tobottom: r(".tobottom"), composer: r(".cmp-zone") };
})()`;

/** Says something to the bot and waits for its files. */
async function ask(page, text) {
  await page.run(`(() => { const s = document.querySelector(".cscroll"); s.scrollTop = s.scrollHeight; })()`);
  await sleep(80);
  await page.run(`document.querySelector(".cmp-in").focus()`);
  await page.cdp("Input.insertText", { text });
  await page.until("Send enabled", `!document.querySelector("button.send")?.disabled`);
  const before = await page.run(`document.querySelectorAll(".tr.bots > .bm:not(.working)").length`);
  await page.run(`document.querySelector("button.send").click()`);
  await page.until(`the answer to ${text}`, `document.querySelectorAll(".tr.bots > .bm:not(.working)").length > ${before} && !document.querySelector(".tr.bots .bm.working")`, 40000);
  await sleep(300);
}

/** A presentation is on, and shown inside the panel: the loading card first, then the editor. */
async function opened(page) {
  await page.until("the panel with the presentation", `[...document.querySelectorAll(".bgp.fpn .brp-tab-t")].some((t) => t.textContent.includes(".pptx"))`, 20000);
  const early = await page.run(layout);
  if (early.card) {
    const cardMid = early.card.left + early.card.width / 2;
    const panelMid = early.panel.left + early.panel.width / 2;
    await near(cardMid, panelMid, 1, "the loading card sits in the panel's middle");
    await check(early.card.right <= early.win + 0.5, `the loading card is off the page: ${JSON.stringify(early.card)}`);
  }
  await page.until("the presentation's editor", `!!document.querySelector(".pptx-surface aside")`, 90000);
  return page.run(layout);
}

/** The panel stands beside the conversation and on the page, whatever width it remembers. */
async function beside(page, l, room, what) {
  await check(l.panel, `${what}: no panel`);
  await near(l.panel.right, l.win, 0.5, `${what}: the panel ends at the window's edge`);
  await check(l.panel.left >= l.scol.left + room - 0.5, `${what}: the conversation keeps its room: ${JSON.stringify({ scol: l.scol, panel: l.panel })}`);
  await near(l.strip.right, l.panel.right, 0.5, `${what}: the tab strip ends with the panel`);
  await check(l.surface && l.surface.right <= l.panel.right + 0.5, `${what}: the presentation is inside the panel: ${JSON.stringify(l.surface)}`);
  await check(!l.tobottom || l.tobottom.right <= l.panel.left + 0.5, `${what}: the conversation's button is not over the panel: ${JSON.stringify(l.tobottom)}`);
  await check(!l.composer || l.composer.right <= l.panel.left + 0.5, `${what}: the composer is not over the panel: ${JSON.stringify(l.composer)}`);
}

let failed = false;
try {
  if (!process.env.FINXWORK_E2E_NO_BUILD) {
    step("building finx and the app");
    sh("cargo", ["build", "-p", "finx-cli"], { cwd: root });
    sh("pnpm", ["--dir", desktop, "build"]);
  }

  const page = await launch();
  step("Bot mode, with a presentation in the conversation");
  await page.until("the window", `!!document.querySelector(".seg.mode")`, 60000);
  await page.run(`document.querySelector('.seg.mode [data-mode=bots]').click()`);
  await page.until("FinxBot's page", `!!document.querySelector(".bempty") || document.querySelectorAll(".tr.bots > *").length > 0`);
  await page.until("the first-time note", `!!document.querySelector(".knote .btn.primary")`);
  await page.run(`document.querySelector(".knote .btn.primary").click()`);
  await page.until("the note closed", `!document.querySelector(".knote")`);
  for (const text of ["看看这个", "还有这个", "就它了"]) await ask(page, text);
  await page.until("the files", `document.querySelectorAll(".tr.bots .bfiles .tile").length >= 6`);
  await page.shot("01-conversation");

  step("the panel opens beside the conversation, though its width was kept from a wider window");
  // The state the bug was reported from: a width remembered from a wider window.
  await page.run(`localStorage.setItem("finxwork.filePanelWidth", "1400")`);
  // The owner scrolled up the conversation to find the presentation.
  await page.run(`(() => { const s = document.querySelector(".cscroll"); s.scrollTop = 0; })()`);
  await page.clickTile("sample-presentation.pptx");
  await page.until("the panel", `!!document.querySelector(".bgp.fpn")`, 20000);
  const first = await opened(page);
  await beside(page, first, 360, "the remembered width");
  await page.shot("02-opened");

  step("the slide strip and the preview are inside the panel");
  const inside = await page.run(`(() => {
    const strip = document.querySelector(".pptx-surface aside")?.getBoundingClientRect();
    const panel = document.querySelector(".bgp").getBoundingClientRect();
    const canvas = document.querySelector(".pptx-surface aside canvas")?.getBoundingClientRect();
    return { strip: strip && { left: strip.left, right: strip.right }, canvas: canvas && { left: canvas.left, right: canvas.right }, panel: { left: panel.left, right: panel.right } };
  })()`);
  await check(inside.strip && inside.strip.right <= inside.panel.right + 0.5 && inside.strip.left >= inside.panel.left - 0.5, `the slide strip is inside the panel: ${JSON.stringify(inside)}`);
  await check(!inside.canvas || (inside.canvas.left >= inside.panel.left - 0.5 && inside.canvas.right <= inside.panel.right + 0.5), `a slide's preview is inside the panel: ${JSON.stringify(inside)}`);

  step("reopened, the remembered width still gives way");
  await page.run(`location.reload()`);
  await page.until("the conversation", `document.querySelectorAll(".tr.bots > .bm").length > 0`, 30000);
  await page.run(`(() => { const s = document.querySelector(".cscroll"); s.scrollTop = 0; })()`);
  await page.clickTile("sample-presentation.pptx");
  const again = await opened(page);
  await beside(page, again, 360, "reopened");
  await page.shot("03-reopened");

  step("narrowing the window keeps the panel on the page and the conversation its room");
  for (const width of [1000, 900]) {
    await page.size(width, 820);
    await sleep(300);
    const l = await page.run(layout);
    await near(l.panel.right, width, 0.5, `at ${width}: the panel ends at the window's edge`);
    await check(l.scol.width >= 360 - 0.5, `at ${width}: the conversation keeps its room: ${JSON.stringify(l.scol)}`);
    await check(l.surface.right <= width + 0.5, `at ${width}: the presentation is inside the window`);
  }
  await page.shot("04-narrow");
  await page.size(1240, 820);
  await sleep(300);

  step("a plain file keeps its room, and the presentation more");
  await page.run(`[...document.querySelectorAll('.bgp button.tb.on[aria-pressed="true"]')].at(-1).click()`);
  await page.until("the panel closed", `!document.querySelector(".bgp")`);
  await page.run(`localStorage.removeItem("finxwork.filePanelWidth")`);
  await page.clickTile("notes.md");
  await page.until("the panel with the note", `[...document.querySelectorAll(".bgp.fpn .brp-tab-t")].some((t) => t.textContent.includes("notes.md"))`, 20000);
  const plain = await page.run(layout);
  await near(plain.panel.right, plain.win, 0.5, "the plain file's panel ends at the window's edge");
  await check(plain.scol.width >= 160 - 0.5, `the conversation keeps the browser's room: ${JSON.stringify(plain.scol)}`);
  await page.click(".bgp.fpn .brp-tab", 0);
  const presentation = await opened(page);
  await beside(page, presentation, 360, "the presentation after a plain file");
  await page.shot("05-plain-then-pptx");

  page.close();
  console.log("\n✔ a presentation opens beside the conversation, whatever width the panel remembers");
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