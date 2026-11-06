#!/usr/bin/env node
// Temporary diagnostic: render the real PPTX surface and dump the command
// toolbar layout at several narrow widths. Deleted after the fix lands.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { build } from "vite";
import react from "@vitejs/plugin-react";

const desktop = path.resolve(import.meta.dirname, "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "fx-probe-"));
const privateHome = path.join(work, "home");
fs.mkdirSync(privateHome);
const out = path.join(work, "web");
const shotDir = "/tmp/fx/probe";
fs.mkdirSync(shotDir, { recursive: true });
const sourceFile = process.env.FINXWORK_E2E_PPTX ?? path.join(desktop, "../../crates/finx-slide/tests/fixtures/editor.pptx");
let bytes = fs.readFileSync(sourceFile);
const originalBytes = bytes;
const hash = () => crypto.createHash("sha256").update(bytes).digest("hex");
const nativeFile = path.join(work, "editor.pptx");
if (process.env.FINXWORK_E2E_NATIVE === "1") {
  const home = path.join(work, "finx");
  fs.mkdirSync(home);
  fs.writeFileSync(nativeFile, bytes);
  fs.writeFileSync(path.join(home, "config.toml"), 'model = "mock/mock-1"\n[models]\nnetwork = false\n');
  fs.writeFileSync(path.join(home, "models.toml"), '[providers.mock]\nname = "Mock"\napi = "openai-chat"\nbase_url = "http://127.0.0.1:1/v1"\nauth = "none"\n[[providers.mock.models]]\nid = "mock-1"\nname = "Mock"\ncontext_window = 128000\nmax_output_tokens = 2000\n');
  const kernel = spawn(path.join(desktop, "../../target/debug/finx"), ["serve", "--stdio"], {
    env: { ...process.env, HOME: privateHome, FINX_HOME: home, FINX_CREDENTIAL_STORE: "file" }, stdio: ["pipe", "pipe", "inherit"],
  });
  let id = 0;
  const waiting = new Map();
  createInterface({ input: kernel.stdout }).on("line", (line) => {
    const message = JSON.parse(line), pending = waiting.get(message.id);
    if (!pending) return;
    waiting.delete(message.id);
    clearTimeout(pending.timeout);
    message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result);
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timeout = setTimeout(() => { waiting.delete(requestId); reject(new Error(`finx timeout: ${method}`)); }, 30000);
    waiting.set(requestId, { resolve, reject, timeout });
    kernel.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
  });
  await call("initialize", { protocol_version: 2, client_info: { name: "probe" } });
  const session = (await call("session/new", { cwd: work })).session_id;
  var nativeCall = (method, params) => call(method, { ...params, session_id: session, path: nativeFile });
}
await build({ configFile: false, root: path.join(import.meta.dirname, "pptx"), plugins: [react()],
  resolve: { dedupe: ["react", "react-dom"] }, build: { outDir: out, emptyOutDir: true }, logLevel: "warn" });
const mime = { ".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html", ".css": "text/css", ".wasm": "application/wasm" };
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/rpc") {
      let body = "";
      for await (const c of req) body += c;
      const { method, params } = JSON.parse(body);
      let result;
      if (nativeCall) result = await nativeCall(method, params);
      else if (method === "pptx/read") result = { path: "editor.pptx", data: bytes.toString("base64"), hash: hash(), writable: true, font_families: ["Arial"] };
      else if (method === "pptx/font") {
        const face = `Arial${params.bold ? " Bold" : ""}${params.italic ? " Italic" : ""}.ttf`;
        result = { data: fs.readFileSync(path.join("/System/Library/Fonts/Supplemental", face)).toString("base64") };
      } else if (method === "pptx/write") { result = { status: "saved", hash: hash() }; }
      else throw new Error(`unexpected RPC ${method}`);
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    }
    const rel = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(out, `.${rel === "/" ? "/index.html" : rel}`);
    if (!file.startsWith(out + path.sep)) return res.writeHead(403).end();
    res.writeHead(200, { "content-type": mime[path.extname(file)] ?? "application/octet-stream" }).end(fs.readFileSync(file));
  } catch (e) { res.writeHead(500).end(String(e)); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const portServer = http.createServer();
await new Promise((r) => portServer.listen(0, "127.0.0.1", r));
const port = portServer.address().port;
await new Promise((r) => portServer.close(r));
const launcher = path.join(work, "electron.cjs");
fs.writeFileSync(launcher, `const {app,BrowserWindow}=require('electron');\napp.setPath('userData',${JSON.stringify(path.join(work, "profile"))});\napp.whenReady().then(()=>{const w=new BrowserWindow({width:1400,height:950,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.address().port}/`)});});\napp.on('window-all-closed',()=>app.quit());`);
const appEnv = { ...process.env, HOME: privateHome };
delete appEnv.ELECTRON_RUN_AS_NODE;
const app = spawn(path.join(desktop, "node_modules/.bin/electron"), [launcher, `--remote-debugging-port=${port}`], { env: appEnv, stdio: ["ignore", "ignore", "pipe"] });
let diagnostics = "";
app.stderr.on("data", (c) => { diagnostics = (diagnostics + c).slice(-8000); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
const report = {};
try {
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(100);
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => []);
    target = list.find((t) => t.type === "page");
  }
  if (!target) throw new Error(`Electron did not start: ${diagnostics}`);
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const waiting = new Map();
  let seq = 0;
  const errors = [];
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails);
    const pending = waiting.get(message.id);
    if (!pending) return;
    waiting.delete(message.id);
    message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
  };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { waiting.set(++seq, { resolve, reject }); ws.send(JSON.stringify({ id: seq, method, params })); });
  await cdp("Runtime.enable");
  const run = async (expression) => {
    const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const until = async (expression, label, attempts = 300) => {
    for (let i = 0; i < attempts; i++) { const result = await run(expression); if (result) return result; await sleep(100); }
    throw new Error(`Timed out: ${label}; ${JSON.stringify(await run("document.body.innerText")).slice(0, 2000)}; ${JSON.stringify(errors).slice(0, 2000)}`);
  };
  await until("!!window.smoke?.doc.serialize", "PPTX Worker");
  await until("!!document.querySelector('[data-testid=pptx-slide-canvas]')", "canvas");

  const measure = () => run(`(() => {
    const toolbar = document.querySelector('[data-testid="pptx-formatting-toolbar"]');
    if (!toolbar) return null;
    const items = toolbar.querySelector('[data-toolbar-items]');
    const moreSpan = toolbar.querySelector('[data-testid="pptx-toolbar-more"]')?.parentElement ?? null;
    const more = toolbar.querySelector('[data-testid="pptx-toolbar-more"]');
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); const s = getComputedStyle(el);
      return { x: Math.round(b.x*10)/10, y: Math.round(b.y*10)/10, w: Math.round(b.width*10)/10, h: Math.round(b.height*10)/10,
        bg: s.backgroundColor, border: s.border, radius: s.borderRadius, vis: s.visibility, pos: s.position, ariaHidden: el.getAttribute('aria-hidden'), inert: el.inert === true,
        text: (el.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 60), testid: el.getAttribute('data-testid'), role: el.getAttribute('role'), label: el.getAttribute('aria-label') }; };
    const kids = items ? Array.from(items.children).map((el) => ({ ...r(el), name: el.tagName + (el.getAttribute('aria-label') ? '[' + el.getAttribute('aria-label') + ']' : ''), children: el.children.length,
      shownButtons: Array.from(el.querySelectorAll('button')).filter((b) => getComputedStyle(b).visibility !== 'hidden' && b.getBoundingClientRect().width > 0).map((b) => (b.getAttribute('aria-label') || b.getAttribute('title') || b.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 20)) })) : [];
    const lastVisible = kids.filter((k) => k.vis !== 'hidden' && k.pos !== 'absolute' && k.w > 0).pop() ?? null;
    const itemsRect = items ? items.getBoundingClientRect() : null;
    return { viewport: innerWidth, toolbar: r(toolbar), items: r(items), moreSpan: r(moreSpan), more: r(more),
      freeAfterLast: lastVisible && itemsRect ? Math.round((itemsRect.right - (lastVisible.x + lastVisible.w))*10)/10 : null,
      itemsScroll: items ? { clientWidth: items.clientWidth, scrollWidth: items.scrollWidth } : null,
      kids };
  })()`);

  const widths = (process.env.PROBE_WIDTHS ?? "1125,1024,900,820,760").split(",").map(Number);
  for (const width of widths) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 2, mobile: false });
    await sleep(600);
    report[width] = await measure();
    const shot = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(shotDir, `toolbar-${width}.png`), Buffer.from(shot.data, "base64"));
  }
  // Zoom dropdown at the narrowest width.
  await cdp("Emulation.setDeviceMetricsOverride", { width: widths[0], height: 800, deviceScaleFactor: 2, mobile: false });
  await sleep(500);
  const opened = await run(`(() => {
    const trigger = Array.from(document.querySelectorAll('[data-testid="pptx-zoom"]'));
    const input = document.querySelector('input[data-testid="pptx-zoom"]');
    if (!input) return 'no input';
    input.focus(); input.dispatchEvent(new FocusEvent('focus'));
    input.click();
    return document.querySelector('[role="listbox"]') ? 'open' : 'clicked';
  })()`);
  await sleep(300);
  report.zoom = await run(`(() => {
    const listbox = document.querySelector('[role="listbox"]');
    const input = document.querySelector('input[data-testid="pptx-zoom"]');
    if (!listbox) return { opened: false, active: document.activeElement?.outerHTML?.slice(0,200) };
    const b = listbox.getBoundingClientRect();
    const opts = Array.from(listbox.querySelectorAll('[role="option"]')).map((el) => { const ob = el.getBoundingClientRect(); const sp = el.lastChild;
      return { text: el.innerText.replace(/\\s+/g,' ').trim(), x: ob.x, w: ob.width, h: ob.height, scrollW: el.scrollWidth, clientW: el.clientWidth };
    });
    const ir = input.getBoundingClientRect();
    return { opened: true, trigger: { x: ir.x, w: ir.width }, listbox: { x: b.x, w: b.width, h: b.height }, opts,
      style: { width: getComputedStyle(listbox).width, minWidth: getComputedStyle(listbox).minWidth } };
  })()`);
  report.zoomOpened = opened;
  const shot2 = await cdp("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(shotDir, "zoom-open.png"), Buffer.from(shot2.data, "base64"));
  if (errors.length) report.errors = errors;
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  console.error(diagnostics);
  throw e;
} finally {
  ws?.close();
  app.kill("SIGTERM");
  await new Promise((r) => server.close(r));
  fs.writeFileSync(path.join(shotDir, "source.pptx"), originalBytes);
}