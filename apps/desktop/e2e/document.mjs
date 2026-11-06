#!/usr/bin/env node
// Verify the document column (docs/desktop/document-editor-design.md, phase one), as a person
// meets it, on a real Chinese broker report: the agent opens it (doc_open, through call_tool),
// it waits as a tab until the toolbar's button shows the column and its pages; the agent finds a figure (doc_find) and cites it; the citation's
// mark says where it points and, clicked, lights the source up; text selected in the column
// goes to the composer as a quote read by finx, a drawn region with its picture; the message
// sent carries the quote and what the column shows; a selection over two pages is one quote of
// both. An encrypted PDF opened from the conversation asks for its password in the column, says
// so when it is wrong, and opens with the right one. finxdoc:// serves nothing without a token.
// Everything stays in a private HOME. Needs `pnpm build`, `cargo build -p finx-cli` and PDFium
// (tools/pdfium, see crates/finx-docs). The PDF: FINX_DOC_PDF, else pdf_oxide's 1.pdf.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "../..");
const finx = path.join(root, "target/debug/finx");
const electron = createRequire(import.meta.url)("electron");
const shots = process.env.FINXWORK_E2E_SHOTS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => {
  throw new Error(message);
};
const check = (ok, message) => ok || fail(message);

const source = process.env.FINX_DOC_PDF ?? path.join(os.homedir(), "pdf_oxide/tests/fixtures/1.pdf");
if (!fs.existsSync(source)) {
  console.log(`document: no PDF at ${source} (set FINX_DOC_PDF), skipped`);
  process.exit(0);
}

// Short: the kernel's socket lives under it, and a socket path has at most 103 bytes.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxd-"));
const home = path.join(work, "finx");
const profile = path.join(work, "profile");
const userHome = path.join(work, "home");
const project = path.join(work, "proj");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(userHome, { recursive: true });
fs.mkdirSync(project, { recursive: true });
const pdfName = "研报_3391718_653b9cac-b45a-4027-a003-0b61cadda82f_175bb_长文件名测试.pdf";
const pdf = path.join(project, pdfName);
fs.copyFileSync(source, pdf);
const secondPdf = path.join(project, "第二份.PDF");
fs.copyFileSync(source, secondPdf);
const otherFile = path.join(project, "other.txt");
fs.writeFileSync(otherFile, "not a PDF");
// An encrypted PDF (standard security handler, RC4, revision 2), its password "s3cret".
function writeEncrypted(file, password, text) {
  const PAD = Buffer.from("28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A", "hex");
  const padded = (p) => Buffer.concat([Buffer.from(p, "latin1"), PAD]).subarray(0, 32);
  const md5 = (...parts) => crypto.createHash("md5").update(Buffer.concat(parts)).digest();
  const rc4 = (key, data) => {
    const s = [...Array(256).keys()];
    for (let i = 0, j = 0; i < 256; i++) {
      j = (j + s[i] + key[i % key.length]) % 256;
      [s[i], s[j]] = [s[j], s[i]];
    }
    const out = Buffer.alloc(data.length);
    for (let n = 0, i = 0, j = 0; n < data.length; n++) {
      i = (i + 1) % 256;
      j = (j + s[i]) % 256;
      [s[i], s[j]] = [s[j], s[i]];
      out[n] = data[n] ^ s[(s[i] + s[j]) % 256];
    }
    return out;
  };
  const id = Buffer.alloc(16, 7);
  const p = Buffer.alloc(4);
  p.writeInt32LE(-4);
  const o = rc4(md5(padded("owner")).subarray(0, 5), padded(password));
  const key = md5(padded(password), o, p, id).subarray(0, 5);
  const u = rc4(key, PAD);
  const objKey = (n) => md5(key, Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, 0, 0])).subarray(0, 10);
  const content = rc4(objKey(5), Buffer.from(`BT /F1 18 Tf 50 700 Td (${text}) Tj ET\n`, "latin1"));
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [4 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>"),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("\nendstream")]),
    Buffer.from(`<< /Filter /Standard /V 1 /R 2 /O <${o.toString("hex")}> /U <${u.toString("hex")}> /P -4 >>`),
  ];
  const parts = [Buffer.from("%PDF-1.4\n")];
  let at = parts[0].length;
  const offsets = [];
  objects.forEach((obj, i) => {
    offsets.push(at);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), obj, Buffer.from("\nendobj\n")]);
    parts.push(chunk);
    at += chunk.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 6 0 R /ID [<${id.toString("hex")}> <${id.toString("hex")}>] >>\nstartxref\n${at}\n%%EOF\n`));
  fs.writeFileSync(file, Buffer.concat(parts));
}
const locked = path.join(project, "保密.pdf");
writeEncrypted(locked, "s3cret", "Confidential terms");
const env = { ...process.env, FINX_HOME: home, HOME: userHome, FINX_CREDENTIAL_STORE: "file", FINX_NO_BROWSER: "1" };

// The model: opens the report, finds a figure, cites it; later answers what it is asked.
const requests = [];
const sse = (delta, finish) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`;
const textOf = (m) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));
const call = (id, name, args) => ({ index: 0, id, type: "function", function: { name: "call_tool", arguments: JSON.stringify({ name, arguments: args }) } });
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    if (req.method !== "POST" || !body) return res.end(JSON.stringify({ data: [] }));
    const messages = JSON.parse(body).messages ?? [];
    requests.push(messages);
    const last = messages[messages.length - 1];
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (textOf(lastUser).includes("这份研报")) {
      const tools = messages.filter((m) => m.role === "tool").map(textOf);
      if (last.role === "user") return res.end(sse({ role: "assistant", tool_calls: [call("call_open", "doc_open", { path: pdf })] }, "tool_calls"));
      const id = /doc_id ([0-9a-f]{16})/.exec(tools.join("\n"))?.[1];
      if (tools.length === 1) return res.end(sse({ role: "assistant", tool_calls: [call("call_find", "doc_find", { doc: id, query: "20-25%" })] }, "tool_calls"));
      const block = /\[(p\d+\.b\d+)\] p\. (\d+)/.exec(tools[1]);
      return res.end(sse({ role: "assistant", content: `股票占比维持在 20-25% [第 ${block?.[2]} 页](finxdoc:${id}#${block?.[1]})。DOC_DONE` }, "stop"));
    }
    res.end(sse({ role: "assistant", content: "QUOTE_SEEN" }, "stop"));
  });
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
fs.writeFileSync(path.join(home, "models.toml"), `[providers.mock]\nname = "Mock"\napi = "openai-chat"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nauth = "none"\n[[providers.mock.models]]\nid = "mock-1"\nname = "Mock One"\ncontext_window = 128000\nmax_output_tokens = 2000\ninput = ["text", "image"]\n`);
fs.writeFileSync(path.join(home, "config.toml"), `model = "mock/mock-1"\npermission_mode = "manual"\n[models]\nnetwork = false\n`);

let app = null;
const port = 9400 + Math.floor(Math.random() * 400);

async function attach(match, what) {
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(200);
    target = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => [])).find(match);
  }
  check(target, `${what} never showed up`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
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
  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      waiting.set(++next, { resolve, reject });
      ws.send(JSON.stringify({ id: next, method, params }));
    });
  const run = async (expr) => {
    const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) fail(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const until = async (label, expr, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await run(expr);
      if (v) return v;
      if (Date.now() > end) fail(`timed out waiting for ${label}: ${await run("document.body.innerText.slice(0, 800)")}`);
      await sleep(150);
    }
  };
  const shot = async (name) => {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    await sleep(400);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, "base64"));
  };
  return { cdp, run, until, shot };
}

async function quit() {
  if (!app || app.exitCode !== null) return;
  const exited = new Promise((r) => app.once("exit", r));
  app.kill("SIGTERM");
  const timeout = setTimeout(() => app.kill("SIGKILL"), 3000);
  await exited;
  clearTimeout(timeout);
}

const shows = (...texts) => `${JSON.stringify(texts)}.some(t => document.body.innerText.includes(t))`;
const send = async (main, text) => {
  await main.run(`document.querySelector('.cmp-in').focus()`);
  await main.cdp("Input.insertText", { text });
  await main.until("send enabled", `!document.querySelector('button.send')?.disabled`);
  await main.run(`document.querySelector('button.send').click()`);
};

let failed = false;
try {
  app = spawn(electron, [desktop, `--remote-debugging-port=${port}`], {
    env: { ...env, FINXWORK_DEFAULT_MODE: "sessions", FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINXWORK_NO_BROWSER: "1" },
    stdio: ["ignore", "ignore", "inherit"],
    cwd: project,
  });
  const main = await attach((t) => t.type === "page" && /^(app:|file:|http:)/.test(t.url) && !t.url.includes("#settings"), "the main window");
  await main.cdp("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 0, mobile: false });
  await main.until("app loaded", `!!document.querySelector("button")`);
  await main.until("onboarding left", `(() => { const skip = [...document.querySelectorAll("button")].find(b => /稍后|later|skip/i.test(b.textContent)); if (skip) { skip.click(); return false; } return !!document.querySelector('.cmp-in'); })()`);

  // finxdoc:// answers nothing without a token finx gave out.
  const bad = await main.run(`fetch("finxdoc://0123456789abcdef0123456789abcdef/current.pdf").then(r => r.status, e => "error: " + e.message)`);
  check(bad === 404, `an unknown token was answered: ${bad}`);

  // 1. The agent opens the report: it gets a tab, but the column stays shut until asked for;
  // the toolbar's document button opens it, its pages drawn.
  await send(main, `看看这份研报 ${pdf}`);
  const docButton = `document.querySelector('.ctool button[aria-label="文档"]')`;
  await main.until("the document button", `!!${docButton}`, 60000);
  check(await main.run(`!document.querySelector('.dcp')`), "the column opened by itself");
  await main.run(`${docButton}.click()`);
  await main.until("the document column", `!!document.querySelector('.dcp .page canvas')`, 30000);
  await main.until("the page count", `document.querySelector('.dcp-page span')?.textContent === '/ 7'`);
  await main.until("the text layer", `document.querySelectorAll('.dcp .textLayer span').length > 50`, 30000);
  check(await main.run(`document.querySelector('.dcp-tab[aria-selected="true"]')?.textContent`) === pdfName, "the column does not name the file");
  check(await main.run(`document.querySelector('.dcp-tab').getBoundingClientRect().width <= 180`), "the filename occupies too much of the tab bar");
  // A long filename must yield space to the complete, single-line page control.
  const layout = await main.run(`(() => {
    const panel = document.querySelector('.bgp.dcp');
    panel.classList.add('sized'); panel.style.setProperty('--dcp-w', '380px');
    const name = document.querySelector('.dcp-tab'), form = document.querySelector('.dcp-page');
    const input = form.querySelector('input'), count = form.querySelector('span');
    const a = name.getBoundingClientRect(), b = input.getBoundingClientRect(), c = count.getBoundingClientRect();
    const ok = name.scrollWidth > name.clientWidth && b.right <= c.left && Math.abs(b.top + b.height / 2 - c.top - c.height / 2) < 1 && count.scrollWidth <= count.clientWidth;
    panel.classList.remove('sized'); panel.style.removeProperty('--dcp-w');
    return ok;
  })()`);
  check(layout, "a long filename squeezed or wrapped the page control");

  // Trackpad pinch reaches Chromium as a control-wheel; ordinary scrolling must not zoom.
  const zoomBefore = await main.run(`Number.parseInt(document.querySelector('.dcp-scale').textContent)`);
  const point = await main.run(`(() => { const r = document.querySelector('.dcp-scroll').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await main.cdp("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: 0, deltaY: -80 });
  check(await main.run(`Number.parseInt(document.querySelector('.dcp-scale').textContent)`) === zoomBefore, "ordinary scrolling changed zoom");
  await main.cdp("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: 0, deltaY: -80, modifiers: 2 });
  await main.until("pinch zoom in", `Number.parseInt(document.querySelector('.dcp-scale').textContent) > ${zoomBefore}`);
  const zoomIn = await main.run(`Number.parseInt(document.querySelector('.dcp-scale').textContent)`);
  await main.cdp("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: 0, deltaY: 80, modifiers: 2 });
  await main.until("pinch zoom out", `Number.parseInt(document.querySelector('.dcp-scale').textContent) < ${zoomIn}`);
  await main.run(`document.querySelector('.dcp-scale').click()`);
  await main.until("fit to width again", `Number.parseInt(document.querySelector('.dcp-scale').textContent) === ${zoomBefore}`);

  // 2. The reply cites its figure: the mark says where, and a click lights the source up.
  await main.until("the reply", shows("DOC_DONE"), 60000);
  await main.until("the citation mark", `!!document.querySelector('.md .cite')`);
  await main.run(`document.querySelector('.md .cite').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
  const title = await main.until("the citation's source", `document.querySelector('.md .cite')?.title || ''`);
  // The file, the page, and the start of the block cited (the figure may be further in).
  check(title.startsWith(`${pdfName} · 第 1 页\n`) && title.includes("打新"), `the citation's hover is wrong: ${title}`);
  await main.shot("1-opened-and-cited");
  await main.run(`document.querySelector('.md .cite').click()`);
  await main.until("the source lit up", `document.querySelectorAll('.dcp-flash > div').length > 0`);
  await main.shot("2-citation-source");

  // 3. Text selected on page 1 goes to the composer as finx read it.
  const picked = await main.run(`(() => {
    const spans = [...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')].filter(s => s.textContent.includes('打新'));
    const s = spans[0];
    const range = document.createRange();
    range.selectNodeContents(s);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    s.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return s.textContent;
  })()`);
  // As in the browser's add to chat: a card, its note box ready to type in; ↩ adds.
  await main.until("the add card, its note focused", `document.activeElement === document.querySelector('.dcp-card textarea')`);
  const cardQuote = await main.run(`document.querySelector('.dcp-card-quote').textContent`);
  check(cardQuote.replace(/\s+/g, "").includes(picked.replace(/\s+/g, "").slice(0, 6)), `the card does not show what was selected: ${cardQuote} / ${picked}`);
  await main.cdp("Input.insertText", { text: "这个数字怎么来的" });
  await main.shot("3-selection");
  await main.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await main.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await main.until("the quote tile", `!!document.querySelector('.cmp .tile.quote, .tile.quote')`);
  check(await main.run(`!document.querySelector('.dcp-card')`), "the card stayed after adding");
  const tile = await main.run(`document.querySelector('.tile.quote').title`);
  const norm = (s) => s.replace(/\s+/g, "");
  check(tile.includes(`${pdfName} · 第 1 页`) && norm(tile).includes(norm(picked).slice(0, 8)), `the quote is not what was selected: ${tile} / ${picked}`);
  check(tile.includes("这个数字怎么来的"), `the quote lacks its note: ${tile}`);

  // 4. A region drawn on the page: a quote of what is inside, and its picture.
  await main.run(`document.querySelector('.dcp-bar button[aria-pressed]:not([aria-pressed="true"])') && [...document.querySelectorAll('.dcp-bar button')].find(b => b.getAttribute('aria-label') === '框选区域，添加到对话').click()`);
  await main.until("the region mode's hint", `!!document.querySelector('.dcp-hint')`);
  await main.shot("3b-region-mode");
  const box = await main.run(`(() => { const r = document.querySelector('.page[data-page-number="1"] canvas').getBoundingClientRect(); const v = document.querySelector('.dcp-scroll').getBoundingClientRect(); const top = Math.max(r.top, v.top) + 40; return { x: r.left + r.width * 0.1, y: top, w: r.width * 0.5, h: Math.min(r.height * 0.15, Math.min(r.bottom, v.bottom) - top - 20) }; })()`);
  await main.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await main.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await main.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x + box.w, y: box.y + box.h, button: "left" });
  await main.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x + box.w, y: box.y + box.h, button: "left", clickCount: 1 });
  await main.until("the add card for the region", `!!document.querySelector('.dcp-card-add') && document.querySelectorAll('.dcp-mark > div').length > 0`);
  await main.shot("3c-region-card");
  const askPoint = await main.run(`(() => { const r = document.querySelector('.dcp-card-add').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await main.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...askPoint });
  await main.cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...askPoint, button: "left", clickCount: 1 });
  await main.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...askPoint, button: "left", clickCount: 1 });
  // One card for the region, as the browser's: its picture shows in its details, not as a tile of its own.
  await main.until("the region's quote", `document.querySelectorAll('.tile.quote').length === 2`);
  check(await main.run(`!document.querySelector('.cmp .tile.img')`), "the region's picture is a tile of its own");
  await main.run(`[...document.querySelectorAll('.tile.quote')].at(-1).querySelector('.tile-open').click()`);
  await main.until("the region's details with its picture", `!!document.querySelector('.wdt-shot img') && document.querySelector('.wdt-shot img').naturalWidth > 0`);
  await main.shot("3d-region-details");
  await main.run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await main.until("the details closed", `!document.querySelector('.wdt')`);
  check(await main.run(`document.querySelector('.dcp-bar .brp-annotate').getAttribute('aria-pressed') === 'true'`), "the annotate mode closed after adding");
  await main.run(`document.querySelector('.dcp-bar .brp-annotate').click()`);

  // 4b. A selection from the end of page 1 into page 2: one quote of both pages.
  await main.run(`(() => { const s = document.querySelector('.dcp-scroll'); const p2 = document.querySelector('.page[data-page-number="2"]'); s.scrollTop = p2.offsetTop - s.clientHeight / 2; })()`);
  await main.until("both pages' text", `document.querySelectorAll('.page[data-page-number="1"] .textLayer span').length > 0 && document.querySelectorAll('.page[data-page-number="2"] .textLayer span').length > 0`);
  await main.run(`(() => {
    const spans = (n) => [...document.querySelectorAll('.page[data-page-number="' + n + '"] .textLayer span')].filter(s => s.textContent.trim() && s.getBoundingClientRect().width > 0);
    const a = spans(1).filter(s => s.textContent.includes('免责')).pop() ?? spans(1).pop();
    const b = spans(2)[0];
    const range = document.createRange();
    range.setStart(a.firstChild, 0);
    range.setEnd(b.firstChild, b.firstChild.length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    b.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  })()`);
  await main.until("the add card for two pages", `!!document.querySelector('.dcp-card-add')`);
  await main.run(`document.querySelector('.dcp-card-add').click()`);
  await main.until("the two-page quote", `[...document.querySelectorAll('.tile.quote')].some(t => t.title.includes('第 1–2 页'))`);
  await main.shot("4-quotes-in-composer");

  // 5. Sent: the model gets the quotes, the picture and what the column shows.
  await send(main, "这两段说的是什么");
  await main.until("the answer", shows("QUOTE_SEEN"), 60000);
  const asked = requests.at(-1);
  const user = [...asked].reverse().find((m) => m.role === "user");
  const content = typeof user.content === "string" ? user.content : user.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  check(content.includes("The user quoted these parts of documents"), `no quote block: ${content.slice(0, 600)}`);
  check(content.includes('"region": true'), "the region was not quoted as one");
  check(content.includes('"comment": "这个数字怎么来的"'), "the quote's note did not go along");
  check(content.includes('"to_page": 2'), "the two-page quote does not say where it ends");
  check(content.includes("The user has a document open beside the conversation") && content.includes(pdfName), "what the column shows did not go along");
  check(Array.isArray(user.content) && user.content.some((c) => c.type === "image_url"), "the region's picture did not go along");
  // The conversation shows the quotes as tiles, not the blocks' text.
  check(!(await main.run(`document.querySelector('.um:last-of-type .bub')?.innerText ?? ''`)).includes("The user quoted"), "the quote block shows as words");
  check(content.includes('"image": 1'), "the region's quote does not say which image shows it");
  // In the conversation too, the region is one card: its picture is in its details.
  const lastUm = `[...document.querySelectorAll('.um')].at(-1)`;
  check(await main.run(`!${lastUm}.querySelector('.tile.img') && ${lastUm}.querySelectorAll('.tile.quote').length === 3`), "the sent region's picture shows apart from its quote");
  await main.run(`[...${lastUm}.querySelectorAll('.tile.quote')].find(t => t.title.includes('第 1 页') && !t.title.includes('这个数字')).querySelector('.tile-open').click()`);
  await main.until("the sent region's picture", `!!document.querySelector('.wdt-shot img')`);
  await main.shot("5b-sent-details");
  await main.run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await main.shot("5-sent");

  // 6. An encrypted PDF attached to a message: its tile opens it, the column asks for the password.
  await main.run(`document.querySelector('.cmp-in').focus()`);
  await main.cdp("Input.insertText", { text: "Attached files:" });
  await main.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 8 });
  await main.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 8 });
  await main.cdp("Input.insertText", { text: locked });
  await main.until("send enabled", `!document.querySelector('button.send')?.disabled`);
  await main.run(`document.querySelector('button.send').click()`);
  const lockedTile = `[...document.querySelectorAll('.um-att .tile')].find(t => t.title === ${JSON.stringify(locked)})?.querySelector('.tile-open')`;
  await main.until("the encrypted file's tile", `!!${lockedTile}`, 30000);
  await main.run(`window.reportCanvas = document.querySelector('.dcp-viewer:not([hidden]) canvas'); window.reportScale = document.querySelector('.dcp-viewer:not([hidden]) .dcp-scale').textContent`);
  await main.run(`${lockedTile}.click()`);
  await main.until("the password field", `!!document.querySelector('.dcp-unlock input[type=password]')`);
  check((await main.run(`document.querySelector('.dcp-unlock').innerText`)).includes("保密.pdf"), "the password field does not name the file");
  const typePassword = async (pw) => {
    await main.run(`document.querySelector('.dcp-unlock input').focus()`);
    await main.cdp("Input.insertText", { text: pw });
    await main.run(`document.querySelector('.dcp-unlock button.primary').click()`);
  };
  await typePassword("wrong");
  await main.until("the wrong password said", `!!document.querySelector('.dcp-unlock-bad')`);
  await main.shot("6-password");
  await typePassword("s3cret");
  await main.until("the encrypted document shown", `[...document.querySelectorAll('.dcp .textLayer span')].some(s => s.textContent.includes('Confidential'))`, 30000);
  check((await main.run(`document.querySelector('.dcp-tab[aria-selected="true"]')?.textContent`)) === "保密.pdf", "the column does not show the encrypted file");
  check(await main.run(`document.querySelectorAll('.dcp-tab').length`) === 2, "both open PDFs should have tabs");
  await main.run(`document.querySelectorAll('.dcp-tab')[0].click()`);
  await main.until("switch back to the report", `document.querySelector('.dcp-tab[aria-selected="true"]')?.textContent === ${JSON.stringify(pdfName)} && document.querySelector('.dcp-viewer:not([hidden]) .dcp-page span')?.textContent === '/ 7'`);
  check(await main.run(`document.querySelector('.dcp-viewer:not([hidden]) canvas') === window.reportCanvas && document.querySelector('.dcp-viewer:not([hidden]) .dcp-scale').textContent === window.reportScale`), "switching discarded the report's rendered canvas or zoom");
  await main.run(`window.lockedCanvas = document.querySelectorAll('.dcp-viewer')[1].querySelector('canvas')`);
  await main.run(`document.querySelectorAll('.dcp-tab')[1].click()`);
  await main.until("switch to the encrypted PDF", `document.querySelector('.dcp-tab[aria-selected="true"]')?.textContent === '保密.pdf' && document.querySelector('.dcp-viewer:not([hidden]) .dcp-page span')?.textContent === '/ 1'`);
  check(await main.run(`window.lockedCanvas && document.querySelector('.dcp-viewer:not([hidden]) canvas') === window.lockedCanvas`), "switching discarded the encrypted PDF's rendered canvas");
  // The password is kept by nobody on disk.
  const leaked = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile() && fs.statSync(f).size < 50_000_000 && fs.readFileSync(f).includes("s3cret")) leaked.push(f);
    }
  };
  walk(home);
  walk(profile);
  check(leaked.length === 0, `the password is on disk: ${leaked.join(", ")}`);
  await main.shot("7-unlocked");
  check(await main.run(`document.querySelectorAll('.dcp-tabs-bar > button').length`) === 1, "the tab bar should have one close button");
  await main.run(`document.querySelector('.dcp-tabs-bar > button').click()`);
  await main.until("all PDFs closed", `!document.querySelector('.dcp')`);
  await main.run(`${lockedTile}.click()`);
  await main.until("closed encrypted PDF asks for its password again", `!!document.querySelector('.dcp-unlock input[type=password]')`);
  check(await main.run(`document.querySelectorAll('.dcp-tab').length`) === 1, "closed PDFs remained in the tab bar");
  await main.run(`document.querySelector('.dcp-tab-close').click()`);
  await main.until("password tab closed", `!document.querySelector('.dcp')`);
  // Use real files supplied through Chromium, then deliver them as a file drop.
  await main.run(`(() => { const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.id = 'drop-test'; document.body.append(input); })()`);
  const tree = await main.cdp("DOM.getDocument");
  const input = await main.cdp("DOM.querySelector", { nodeId: tree.root.nodeId, selector: "#drop-test" });
  await main.cdp("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [pdf, secondPdf, otherFile] });
  const drop = await main.run(`(() => {
    const files = document.querySelector('#drop-test').files, data = new DataTransfer();
    for (const file of files) data.items.add(file);
    const target = document.querySelector('.spage');
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data });
    target.dispatchEvent(over);
    const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data });
    target.dispatchEvent(event);
    return over.defaultPrevented && event.defaultPrevented;
  })()`);
  check(drop, "the drop was not taken");
  // Dropped PDFs are attached like any file, not opened; their tiles open them.
  const fileTile = (p) => `[...document.querySelectorAll('.cmp .tile')].find(t => t.title === ${JSON.stringify(p)})`;
  await main.until("the dropped files attached", `!!${fileTile(pdf)} && !!${fileTile(secondPdf)} && !!${fileTile(otherFile)}`, 30000);
  check(await main.run(`!document.querySelector('.dcp')`), "a dropped PDF opened by itself");
  // A PDF is a result: over the window (content-actions-design DD-161), its button takes it to the panel.
  const toPanel = async (p) => {
    await main.run(`${fileTile(p)}.querySelector('.tile-open').click()`);
    await main.until("the PDF over the window", `!!document.querySelector('.fpv-panel')`, 30000);
    await main.run(`document.querySelector('.fpv-panel').click()`);
    await main.until("the PDF out of the preview", `!document.querySelector('.fpv')`);
  };
  await toPanel(pdf);
  await main.until("the first PDF open", `document.querySelectorAll('.dcp-tab').length === 1`, 30000);
  await toPanel(secondPdf);
  await main.until("both PDFs open", `document.querySelectorAll('.dcp-tab').length === 2 && document.querySelector('.dcp-tab[aria-selected="true"]')?.textContent === '第二份.PDF'`, 30000);
  await main.run(`document.querySelectorAll('.dcp-tab-close')[0].click()`);
  await main.until("inactive tab closed", `document.querySelectorAll('.dcp-tab').length === 1 && document.querySelector('.dcp-tab[aria-selected="true"]')?.textContent === '第二份.PDF'`);
  await toPanel(pdf);
  await toPanel(secondPdf);
  await main.until("two PDFs open again", `document.querySelectorAll('.dcp-tab').length === 2 && document.querySelector('.dcp-tab[aria-selected="true"]')?.textContent === '第二份.PDF'`);
  await main.run(`document.querySelector('.dcp-tab[aria-selected="true"]').parentElement.querySelector('.dcp-tab-close').click()`);
  await main.until("active tab closed and remaining tab selected", `document.querySelectorAll('.dcp-tab').length === 1 && document.querySelector('.dcp-tab[aria-selected="true"]')?.textContent === ${JSON.stringify(pdfName)}`);
  await main.run(`document.querySelector('.dcp-tab-close').click()`);
  await main.until("last tab closed", `!document.querySelector('.dcp')`);
  console.log("document: ok");
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await quit();
  provider.close();
  if (!failed) fs.rmSync(work, { recursive: true, force: true });
  else console.error(`kept ${work}`);
}
process.exit(failed ? 1 : 0);
