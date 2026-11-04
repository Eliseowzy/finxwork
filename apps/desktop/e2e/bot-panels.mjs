#!/usr/bin/env node
// A bot's page and its list (bot-mode-design §6.5, §6.5.1, §6.6, §6.16): its name in the middle opens its settings under a
// real click, with the name and avatar; a row's menu is pin, rename in place and delete; a file in
// a message opens in the file panel, a PDF in the document column; a link opens in the built-in
// browser, and the bot drives it too. A model server on the Mac stands in for the provider.
//
// A PDF needs PDFium, which the packaged app carries: run against it to check that as well.
//
//   node apps/desktop/e2e/bot-panels.mjs
//   FINXWORK_E2E_APP=dist/FinxWork.app/Contents/MacOS/FinxWork …   the packaged app, PDF included
//   FINXWORK_E2E_SHOTS=<folder> …   also screenshots each step
//   FINXWORK_E2E_NO_BUILD=1 …       uses the builds there are
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

const packaged = process.env.FINXWORK_E2E_APP ? path.resolve(process.env.FINXWORK_E2E_APP) : null;

const sse = (delta, finish) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\ndata: [DONE]\n\n`;
const call = (name, args) => ({ role: "assistant", tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const send = (text) => call("send_to_user", { text, end_turn: true });
let toolResult = "";
let lastRequest = null;
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/page") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<title>测试页面</title><h1>hello</h1>");
    if (!req.url?.endsWith("/chat/completions")) return res.writeHead(404).end();
    lastRequest = JSON.parse(body);
    const { messages, tools } = lastRequest;
    const last = messages.at(-1);
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (last.role === "tool") {
      toolResult = typeof last.content === "string" ? last.content : last.content.map((c) => c.text ?? "").join("");
      return res.end(sse(send("开好了。"), "tool_calls"));
    }
    const said = typeof last.content === "string" ? last.content : last.content.map((c) => c.text ?? "").join("");
    const page = `http://127.0.0.1:${provider.address().port}/page`;
    if (said.includes("打开")) {
      const direct = tools.some((t) => t.function?.name === "browser_navigate");
      return res.end(sse(direct ? call("browser_navigate", { url: page }) : call("call_tool", { name: "browser_navigate", arguments: { url: page } }), "tool_calls"));
    }
    res.end(sse(send(`笔记在 \`note.md\`，报告在 \`report.pdf\`，页面在 [这里](${page})。`), "tool_calls"));
  });
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));

/** The smallest PDF: one page with a line of text. */
function pdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "<< /Length 40 >>\nstream\nBT /F1 18 Tf 40 100 Td (Report) Tj ET    \nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const at = objects.map((o, i) => {
    const offset = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return offset;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${at.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxq-"));
const home = path.join(work, "finx");
const profile = path.join(work, "profile");
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(
  path.join(home, "models.toml"),
  `[providers.mock]\nname = "Mock"\napi = "openai-chat"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nauth = "none"\ncompat = { thinking_format = "openai" }\n\n[[providers.mock.models]]\nid = "mock-1"\nname = "Mock One"\ncontext_window = 128000\nmax_output_tokens = 2000\n\n[[providers.mock.models]]\nid = "mock-2"\nname = "Mock Two"\nreasoning = true\nthinking = ["off", "high"]\ncontext_window = 128000\nmax_output_tokens = 2000\n`,
);
fs.writeFileSync(path.join(home, "config.toml"), `model = "mock/mock-1"\n[models]\nnetwork = false\n`);

/** One request to finx over its socket. */
function finxCall(home, method, params = {}) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(path.join(home, "run/finx.sock"));
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
let app = null;
async function launch(home, profile) {
  const port = 9400 + Math.floor(Math.random() * 400);
  app = spawn(packaged ?? electron, packaged ? [`--remote-debugging-port=${port}`] : [desktop, `--remote-debugging-port=${port}`], {
    env: { ...process.env, FINX_HOME: home, FINXWORK_USER_DATA: profile, ...(packaged ? {} : { FINXWORK_FINX: finx }), FINX_CREDENTIAL_STORE: "file" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  let target;
  for (let i = 0; i < 150 && !target; i++) {
    await sleep(200);
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => []);
    target = list.find((t) => t.type === "page" && !t.url.includes("#settings") && !t.url.startsWith("devtools"));
  }
  check(target, "the main window never showed up");
  const page = await devtools(target.webSocketDebuggerUrl);
  const cdp = page.call;
  const run = async (expr) => {
    const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) fail(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const until = async (what, expr, ms = 30000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await run(expr);
      if (v) return v;
      if (Date.now() > end) fail(`timed out waiting for ${what}`);
      await sleep(250);
    }
  };
  const shot = async (name) => {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, "base64"));
  };
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 0, mobile: false });
  return { cdp, run, until, shot, close: page.close };
}

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

async function quit() {
  if (!app || app.exitCode !== null) return;
  const exited = new Promise((r) => app.once("exit", r));
  app.kill("SIGTERM");
  await exited;
}

const bubbles = `[...document.querySelectorAll(".tr.bots .bm:not(.working) .bbub")].length`;
const items = `[...document.querySelectorAll(".vmenu .mi")].map((b) => b.textContent)`;

async function say(page, text) {
  await page.run(`document.querySelector(".cmp-in").focus()`);
  await page.cdp("Input.insertText", { text });
  await page.until("Send enabled", `!document.querySelector("button.send")?.disabled`);
  await page.run(`document.querySelector("button.send").click()`);
}

/** A click with the mouse, where the element is on screen: what is over it gets it. */
async function press(page, selector) {
  const at = await page.run(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
  await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", clickCount: 1 });
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", clickCount: 1 });
}

/** A real click on what `expr` finds; two of them with `clicks: 2`. */
async function pressOn(page, expr, clicks = 1) {
  const at = await page.run(`(() => { const r = (${expr}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
  for (let n = 1; n <= clicks; n++) {
    await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", clickCount: n });
    await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", clickCount: n });
  }
}
const menuItem = (text) => `[...document.querySelectorAll(".vmenu .mi")].find((b) => b.textContent.includes(${JSON.stringify(text)}))`;

const key = async (page, k) => {
  await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: k === "Enter" ? 13 : 27, text: k === "Enter" ? "\r" : undefined });
  await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: k === "Enter" ? 13 : 27 });
};

let failed = false;
try {
  if (!process.env.FINXWORK_E2E_NO_BUILD && !packaged) {
    step("building finx and the app");
    sh("cargo", ["build", "-p", "finx-cli"], { cwd: root });
    sh("pnpm", ["--dir", desktop, "build"]);
  }
  const page = await launch(home, profile);
  await page.until("the window", `!!document.querySelector(".seg.mode")`, 60000);
  await page.run(`document.querySelector('.seg.mode [data-mode=bots]').click()`);
  await page.until("FinxBot's page", `document.querySelector(".bhead-n")?.textContent === "FinxBot" && !!document.querySelector(".cmp-zone.bot")`, 30000);
  await page.run(`document.querySelector(".btip .btn")?.click()`);

  step("its avatar and name in the middle of the top; a hover shows the arrow, a click its settings");
  const head = await page.run(`(() => { const b = document.querySelector(".bhead").getBoundingClientRect(), t = document.querySelector(".scol > .ctool").getBoundingClientRect(); return { off: Math.abs(b.x + b.width / 2 - (t.x + t.width / 2)), more: !!document.querySelector(".ctool .tb[aria-haspopup=menu]") }; })()`);
  check(head.off < 1, `centred in the bar: ${head.off} off`);
  check(!head.more, "no ⋯ left at the top right");
  const arrow = `Number(getComputedStyle(document.querySelector(".bhead-go")).opacity)`;
  check((await page.run(arrow)) === 0, "no arrow until hovered");
  const middle = await page.run(`(() => { const r = document.querySelector(".bhead").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  // A pointer that does not move is not rechecked against a page still settling: keep it moving.
  for (let i = 0, shown = 0; !shown; i++) {
    check(i < 40, "the arrow on hover");
    await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: middle.x + i % 2, y: middle.y });
    await sleep(150);
    shown = (await page.run(arrow)) === 1;
  }
  await page.shot("m1-hover");
  await press(page, ".bhead");
  await page.until("its settings", `!!document.querySelector(".bpn .bpn-name")`);
  await page.until("it has slid in", `document.querySelector(".bpn").getAnimations().length === 0`);
  const box = await page.run(`(() => { const r = document.querySelector(".bpn").getBoundingClientRect(); return { right: r.right, width: r.width, inner: innerWidth, name: document.querySelector(".bpn-name").textContent }; })()`);
  check(box.right <= box.inner && box.width === 340 && box.name === "FinxBot", `the panel: ${JSON.stringify(box)}`);
  check(await page.run(`document.querySelector(".bpn-del").disabled`), "the default bot cannot be deleted");
  await page.shot("m1-settings");
  await press(page, ".bhead");
  await page.until("closed by its name again", `!document.querySelector(".bpn")`);

  step("a row's menu: pin, rename, delete; nothing to clear");
  await page.run(`document.querySelector(".brow .rowact").click()`);
  await page.until("the row's menu", `!!document.querySelector(".vmenu")`);
  const rowMenu = await page.run(items);
  check(rowMenu.length === 3 && rowMenu[0] === "置顶" && rowMenu[1] === "重命名" && rowMenu[2].startsWith("删除 Bot"), `the row's menu: ${rowMenu}`);
  await page.shot("m2-row-menu");

  step("rename in place: Esc keeps the name, ↩ changes it, the header follows");
  await page.run(`[...document.querySelectorAll(".vmenu .mi")].find((b) => b.textContent === "重命名").click()`);
  await page.until("the name as a field", `document.activeElement?.matches(".brow .srename")`);
  await page.cdp("Input.insertText", { text: "不要" });
  await key(page, "Escape");
  await page.until("the name back", `document.querySelector(".brow .bname")?.textContent === "FinxBot"`);
  await page.run(`document.querySelector(".brow").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
  await page.until("the name as a field, double-clicked", `document.activeElement?.matches(".brow .srename")`);
  await page.cdp("Input.insertText", { text: "小助手" });
  await page.shot("m3-renaming");
  await key(page, "Enter");
  await page.until("renamed in the list and the header", `document.querySelector(".brow .bname")?.textContent === "小助手" && document.querySelector(".bhead-n")?.textContent === "小助手"`);

  step("settings: a choice of avatar applies at once");
  await press(page, ".bhead");
  await page.until("its settings", `!!document.querySelector(".bpn-av")`);
  const hover = await page.run(`(() => { const r = document.querySelector(".bpn-av").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...hover });
  await page.until("the avatar says it can be changed", `Number(getComputedStyle(document.querySelector(".bpn-av-edit")).opacity) === 1`);
  await press(page, ".bpn-av");
  await page.until("the choices", `!!document.querySelector(".bpn-pick .bs-shape")`);
  await page.shot("m3-avatar");
  await pressOn(page, `document.querySelector('.bpn-pick .bs-shape[title="小猫"]')`);
  await page.until("the new avatar in the list, the top and the panel", `document.querySelectorAll(".brow .bav:not(.mark), .bhead .bav:not(.mark), .bpn-av .bav:not(.mark)").length === 3`);
  check((await finxCall(home, "bots/subscribe")).result.bots[0].avatar.shape === "cat", "finx keeps the character");
  await pressOn(page, `document.querySelector('.bpn-pick .bs-hue[title="梅紫"]')`);
  await page.until("the colour", `document.querySelector('.bpn-pick .bs-hue[title="梅紫"]').classList.contains("on")`);
  check((await finxCall(home, "bots/subscribe")).result.bots[0].avatar.hue === "plum", "finx keeps the colour");
  check(await page.run(`!!document.querySelector(".bpn-pick")`), "the choices stay open for the next one");
  await press(page, ".bpn-av");
  await page.until("closed by the avatar again", `!document.querySelector(".bpn-pick")`);

  step("settings: a double click on the name edits it, Esc keeps it, ↩ changes it");
  await pressOn(page, `document.querySelector(".bpn-name")`, 2);
  await page.until("the name as a field", `document.activeElement?.matches(".bpn-rename")`);
  await page.cdp("Input.insertText", { text: "不要" });
  await key(page, "Escape");
  await page.until("the name back", `document.querySelector(".bpn-name")?.textContent === "小助手"`);
  await pressOn(page, `document.querySelector(".bpn-name")`, 2);
  await page.until("the name as a field again", `document.activeElement?.matches(".bpn-rename")`);
  await page.cdp("Input.insertText", { text: "小帮手" });
  await key(page, "Enter");
  await page.until("renamed everywhere", `document.querySelector(".bpn-name")?.textContent === "小帮手" && document.querySelector(".bhead-n")?.textContent === "小帮手" && document.querySelector(".brow .bname")?.textContent === "小帮手"`);

  step("settings: the model and how hard it thinks reach the provider, and stay");
  const modelButton = `[...document.querySelectorAll(".bpn .frow")].find((r) => r.textContent.startsWith("模型"))?.querySelector(".mb")`;
  const thinkRow = `[...document.querySelectorAll(".bpn .frow")].find((r) => r.textContent.startsWith("思考强度"))`;
  check((await page.run(`${modelButton}.textContent`)).includes("Mock One"), "the bot's model shows");
  check(!(await page.run(`!!${thinkRow}`)), "a model with no levels has no thinking row");
  await pressOn(page, modelButton);
  await page.until("the models", `!!${menuItem("Mock Two")}`);
  await pressOn(page, menuItem("Mock Two"));
  await page.until("Mock Two, and its levels", `${modelButton}.textContent.includes("Mock Two") && !!${thinkRow}`);
  await pressOn(page, `${thinkRow}.querySelector(".mb")`);
  await page.until("the levels", `!!${menuItem("高")}`);
  await page.shot("m3-thinking");
  await pressOn(page, menuItem("高"));
  await page.until("high", `${thinkRow}.querySelector(".lbl").textContent === "高"`);
  await page.shot("m3-model");
  await say(page, "你好");
  await page.until("the answer", `${bubbles} > 0`, 30000);
  check(lastRequest?.model === "mock-2", `the request's model: ${lastRequest?.model}`);
  check(lastRequest?.reasoning_effort === "high", `the request's level: ${lastRequest?.reasoning_effort}`);
  await finxCall(home, "server/shutdown");
  await page.run(`location.reload()`);
  await page.until("back after finx restarted", `!!document.querySelector(".cmp-zone.bot") && document.querySelector(".bhead-n")?.textContent === "小帮手"`, 60000);
  await press(page, ".bhead");
  await page.until("its settings again", `!!${thinkRow}`, 30000);
  check((await page.run(`${modelButton}.textContent`)).includes("Mock Two") && (await page.run(`${thinkRow}.querySelector(".lbl").textContent`)) === "高", "the model and level stay after finx restarts");

  step("settings: another bot keeps its own model; deleting one closes the panel");
  const other = (await finxCall(home, "bots/create", { name: "别的", avatar: { kind: "mono", hue: "teal" } })).result.bot;
  await page.until("its row", `[...document.querySelectorAll(".brow")].some((r) => r.textContent.includes("别的"))`);
  await pressOn(page, `[...document.querySelectorAll(".brow")].find((r) => r.textContent.includes("别的"))`);
  await page.until("the panel shows that bot", `document.querySelector(".bpn-name")?.textContent === "别的" && !!${modelButton}`, 30000);
  check((await page.run(`${modelButton}.textContent`)).includes("Mock One"), "a new bot starts on the default model");
  await press(page, ".bpn-del");
  await page.until("the confirmation", `!!document.querySelector("dialog.sheet[open] .btn.danger")`);
  await press(page, "dialog.sheet[open] .btn.danger");
  await page.until("gone, the panel with it", `!document.querySelector(".bpn") && ![...document.querySelectorAll(".brow")].some((r) => r.textContent.includes("别的"))`, 30000);
  check(!(await finxCall(home, "bots/subscribe")).result.bots.some((b) => b.id === other.id), "finx deleted it");
  await pressOn(page, `[...document.querySelectorAll(".brow")].find((r) => r.textContent.includes("小帮手"))`);
  await page.until("the bot again", `document.querySelector(".bhead-n")?.textContent === "小帮手"`, 30000);

  step("a file in a message opens in the panel");
  const { result } = await finxCall(home, "bots/subscribe");
  const folder = path.join(home, "bots", result.bots[0].id, "files");
  fs.writeFileSync(path.join(folder, "note.md"), "# 笔记\n");
  fs.writeFileSync(path.join(folder, "report.pdf"), pdf(), "latin1");
  await say(page, "东西在哪");
  const before = await page.run(bubbles);
  await page.until("the message", `${bubbles} > ${before}`, 30000);
  const tag = (name) => `[...document.querySelectorAll(".tr.bots .fref")].find((e) => e.textContent.includes(${JSON.stringify(name)}))`;
  await page.until("the file tag", `!!${tag("note.md")}`, 15000);
  await page.run(`${tag("note.md")}.click()`);
  await page.until("the file panel with note.md", `!!document.querySelector(".spage.bot.bgopen") && document.body.innerText.includes("笔记")`, 15000);
  await page.shot("m4-file-panel");
  await press(page, ".bhead");
  await page.until("settings take the place of the file panel", `!!document.querySelector(".bpn") && !document.querySelector(".fpn")`);
  await page.run(`${tag("note.md")}.click()`);
  await page.until("the file panel takes it back, settings gone for good", `!!document.querySelector(".fpn") && !document.querySelector(".bpn")`, 15000);

  if (packaged) {
    step("a PDF opens in the file panel (PDFium: the packaged app)");
    await page.run(`${tag("report.pdf")}.click()`);
    await page.until("the PDF's page", `!!document.querySelector(".fpn .page canvas")`, 30000);
    await page.until("its text", `document.querySelector(".fpn .textLayer")?.textContent.includes("Report")`, 30000);
    await page.shot("m5-pdf");
  } else console.log("  · (no PDFium in a development build: run with FINXWORK_E2E_APP for the PDF)");

  step("a link opens in the built-in browser");
  await page.run(`document.querySelector(".tr.bots a.wl").click()`);
  await page.until("the browser panel", `!!document.querySelector(".brp-tabs [role=tab]")`, 30000);
  await page.until("the page's title", `[...document.querySelectorAll(".brp-tab-t")].some((e) => e.textContent.includes("测试页面"))`, 30000);
  await page.shot("m6-browser");

  step("the bot drives the browser too");
  const tabsBefore = await page.run(`document.querySelectorAll(".brp-tabs [role=tab]").length`);
  const said = await page.run(bubbles);
  await say(page, "打开那个页面");
  await page.until("its answer", `${bubbles} > ${said}`, 60000);
  const answer = await page.run(`[...document.querySelectorAll(".tr.bots .bm:not(.working) .bbub")].at(-1).innerText`);
  check(answer.includes("开好了"), `the bot's answer: ${answer}`);
  check(toolResult.includes("/page"), `the browser tool's result: ${toolResult.slice(0, 300)}`);
  console.log(`  · tabs: ${tabsBefore} → ${await page.run(`document.querySelectorAll(".brp-tabs [role=tab]").length`)}`);
  page.close();
  console.log("\n✔ a bot's page and list work end to end");
} catch (e) {
  failed = true;
  console.error(`\n✘ ${e.message}`);
} finally {
  await quit();
  await finxCall(home, "server/shutdown").catch(() => {});
  provider.close();
  if (!failed) fs.rmSync(work, { recursive: true, force: true });
  else console.error(`  kept ${work}`);
}
process.exit(failed ? 1 : 0);
