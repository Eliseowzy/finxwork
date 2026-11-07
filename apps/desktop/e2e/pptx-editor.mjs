#!/usr/bin/env node
// Build the production PPTX surface, exercise it in a private Electron window, edit
// real Canvas text with keyboard input, save, reopen, and check panel persistence.
// Requires macOS Arial faces. Does not open or change the user's presentations.
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
const work = fs.mkdtempSync(path.join(os.tmpdir(), "fx-pptx-"));
const privateHome = path.join(work, "home");
fs.mkdirSync(privateHome);
const out = path.join(work, "web");
const shotDir = process.env.FINXWORK_E2E_SHOTS ?? work;
const vector = process.env.FINXWORK_E2E_VECTOR === "1";
const textLayout = process.env.FINXWORK_E2E_TEXT_LAYOUT === "1";
const ribbon = process.env.FINXWORK_E2E_RIBBON === "1";
if (textLayout) for (const variant of ["default", "list", "inherit", "table", "mixed"]) execFileSync("python3", [path.join(import.meta.dirname, "pptx/text-layout-fixture.py"), path.join(work, `text-layout-${variant}.pptx`), variant]);
const textSample = textLayout && process.env.FINXWORK_E2E_TEXT_LAYOUT_SAMPLE;
if (textSample) execFileSync("python3", [path.join(import.meta.dirname, "pptx/text-layout-fixture.py"), path.join(work, "text-layout-sample.pptx"), "sample", textSample]);
const sourceFile = (textLayout ? path.join(work, "text-layout-default.pptx") : process.env.FINXWORK_E2E_PPTX) ?? path.join(desktop, `../../crates/finx-slide/tests/fixtures/${vector ? "ole-preview" : ribbon ? "ribbon" : "editor"}.pptx`);
let bytes = fs.readFileSync(sourceFile);
const originalBytes = bytes;
const hash = () => crypto.createHash("sha256").update(bytes).digest("hex");
let saves = 0;
let kernel;
let nativeCall;
let nativeSession;
const nativeFile = path.join(work, "editor.pptx");
if (process.env.FINXWORK_E2E_NATIVE === "1") {
  const home = path.join(work, "finx");
  fs.mkdirSync(home);
  fs.writeFileSync(nativeFile, bytes);
  fs.writeFileSync(path.join(home, "config.toml"), 'model = "mock/mock-1"\n[models]\nnetwork = false\n');
  fs.writeFileSync(path.join(home, "models.toml"), '[providers.mock]\nname = "Mock"\napi = "openai-chat"\nbase_url = "http://127.0.0.1:1/v1"\nauth = "none"\n[[providers.mock.models]]\nid = "mock-1"\nname = "Mock"\ncontext_window = 128000\nmax_output_tokens = 2000\n');
  kernel = spawn(path.join(desktop, "../../target/debug/finx"), ["serve", "--stdio"], {
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
  kernel.on("exit", () => { for (const p of waiting.values()) { clearTimeout(p.timeout); p.reject(new Error("finx exited")); } waiting.clear(); });
  nativeCall = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timeout = setTimeout(() => { waiting.delete(requestId); reject(new Error(`finx timeout: ${method}`)); }, 30000);
    waiting.set(requestId, { resolve, reject, timeout });
    kernel.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
  });
  await nativeCall("initialize", { protocol_version: 2, client_info: { name: "pptx-e2e" } });
  nativeSession = (await nativeCall("session/new", { cwd: work })).session_id;
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
      if (textLayout && method === "test/reset") {
        const variant = params.variant ?? "default";
        if (!["default", "list", "inherit", "table", "mixed", ...(textSample ? ["sample"] : [])].includes(variant)) throw new Error("unknown fixture");
        bytes = fs.readFileSync(path.join(work, `text-layout-${variant}.pptx`));
        if (nativeCall) fs.writeFileSync(nativeFile, bytes);
        result = {};
      } else if (nativeCall) {
        result = await nativeCall(method, { ...params, session_id: nativeSession, path: nativeFile });
        if (method === "pptx/write" && result.status === "saved") { saves++; bytes = fs.readFileSync(nativeFile); }
      }
      else if (method === "pptx/read") result = { path: "editor.pptx", data: bytes.toString("base64"), hash: hash(), writable: true, font_families: ["Arial"] };
      else if (method === "pptx/font") {
        const face = `Arial${params.bold ? " Bold" : ""}${params.italic ? " Italic" : ""}.ttf`;
        result = { data: fs.readFileSync(path.join("/System/Library/Fonts/Supplemental", face)).toString("base64") };
      } else if (method === "pptx/write") {
        if (params.base_hash !== hash()) result = { status: "conflict", hash: hash() };
        else { bytes = Buffer.from(params.data, "base64"); saves++; result = { status: "saved", hash: hash() }; }
      } else throw new Error(`unexpected RPC ${method}`);
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
fs.writeFileSync(launcher, `const {app,BrowserWindow}=require(${JSON.stringify(path.join(desktop, "node_modules/electron"))});\napp.setPath('userData',${JSON.stringify(path.join(work, "profile"))});\napp.whenReady().then(()=>{const w=new BrowserWindow({width:1400,height:950,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});w.loadURL(${JSON.stringify(`http://127.0.0.1:${server.address().port}/`)});});\napp.on('window-all-closed',()=>app.quit());`);
// Inside Electron require('electron') resolves its builtin, not the npm executable-path module.
fs.writeFileSync(launcher, fs.readFileSync(launcher, "utf8").replace(`require(${JSON.stringify(path.join(desktop, "node_modules/electron"))})`, "require('electron')"));
const app = spawn(path.join(desktop, "node_modules/.bin/electron"), [launcher, `--remote-debugging-port=${port}`], { env: { ...process.env, HOME: privateHome }, stdio: ["ignore", "ignore", "pipe"] });
let diagnostics = "";
app.stderr.on("data", (c) => { diagnostics = (diagnostics + c).slice(-12000); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
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
  const until = async (expression, label) => {
    // Large CJK fonts can take substantially longer than a Latin fixture to prepare.
    const attempts = process.env.FINXWORK_E2E_CAPTURE === "1" ? 1800 : 200;
    for (let i = 0; i < attempts; i++) { const result = await run(expression); if (result) return result; await sleep(100); }
    throw new Error(`Timed out: ${label}; ${JSON.stringify(await run("document.body.innerText"))}; ${JSON.stringify(errors)}`);
  };
  // The editor lives in its own React root; its loading panel must still be translated.
  const shownKey = await until(`(() => { const el = document.querySelector('.pptx-surface .pptx-load'); return el ? { text: el.innerText } : (window.smoke?.doc.serialize ? { text: "" } : null); })()`, "Editor loading panel");
  if (/\bpptx\.[a-zA-Z]/.test(shownKey.text)) throw new Error(`Untranslated loading text: ${JSON.stringify(shownKey.text)}`);
  await until("!!window.smoke?.doc.serialize", "PPTX Worker and Canvas");
  await until("!!document.querySelector('.pptx-outline-bar button:not(:disabled)')", "Outline button ready");
  await run("document.querySelector('.pptx-outline-bar button').click()");
  await until("!!document.querySelector('.pptx-outline-slide')", "Slide outline");
  await run("document.querySelector('.pptx-outline-slide').click()");
  await run("document.querySelector('.pptx-outline-bar button').click()");
  await until("!document.querySelector('.pptx-outline')", "Close slide outline");
  if (process.env.FINXWORK_E2E_LOADING === "1") {
    fs.mkdirSync(shotDir, { recursive: true });
    const preview = async (options, label) => {
      await run(`window.smoke.previewLoading(${JSON.stringify(options)})`);
      await until(`!!document.querySelector('.pptx-load[data-stage="${options.stage}"]')`, label);
      const visible = await run(`(() => {
        const card = document.querySelector('.pptx-load-card'), title = card.querySelector('h3');
        const bounds = card.getBoundingClientRect();
        return { text: card.innerText, color: getComputedStyle(title).color,
          fits: bounds.left >= 0 && bounds.right <= innerWidth,
          measured: document.querySelector('[role="progressbar"]').getAttribute('aria-valuenow') };
      })()`);
      if (!visible.fits || !visible.text.includes(options.name) || visible.color !== "rgb(41, 54, 75)") throw new Error(`Loading layout: ${JSON.stringify(visible)}`);
      if ((options.stage === "rendering") !== (visible.measured === null)) throw new Error("Incorrect determinate progress");
      fs.writeFileSync(path.join(shotDir, `${label}.png`), Buffer.from((await cdp("Page.captureScreenshot", { format: "png" })).data, "base64"));
    };
    const sample = { name: "2026 年度产品规划与业务回顾.pptx", bytes: 4823449, fontCount: 6 };
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await preview({ ...sample, stage: "fonts", completed: 7, total: 12, font: { completed: 7, total: 12, family: "PingFang SC", bold: true } }, "loading-fonts");
    await cdp("Emulation.setDeviceMetricsOverride", { width: 360, height: 700, deviceScaleFactor: 1, mobile: false });
    await preview({ ...sample, stage: "reading", completed: 2149120, total: sample.bytes }, "loading-narrow");
    await preview({ ...sample, stage: "rendering" }, "loading-rendering");
    await cdp("Emulation.clearDeviceMetricsOverride");
    await cdp("Emulation.setEmulatedMedia", { features: [] });
    await run("window.smoke.show()");
    await until("!!document.querySelector('[data-testid=pptx-slide-canvas]')", "Restored editor after loading preview");
    console.log(`PASS: Loading panel stages, dark-system contrast and narrow layout. Artifacts: ${shotDir}`);
  } else {
  const canvas = '[data-testid="pptx-slide-canvas"]';
  if (process.env.FINXWORK_E2E_LOCALE === "1") {
    const labels = () => run("Array.from(document.querySelectorAll('button,select,input,[role=group]')).flatMap(el=>[el.getAttribute('title'),el.getAttribute('aria-label'),el.tagName==='BUTTON'?el.textContent:null]).filter(Boolean)");
    const expectLabels = async (expected) => {
      const found = await labels();
      for (const text of expected) if (!found.some((label) => label.includes(text))) throw new Error(`Missing localized label ${text}: ${JSON.stringify(found)}`);
    };
    await expectLabels(["保存", "撤销", "重做", "文本框", "形状", "适应窗口"]);
    const english = /\b(?:Save|Undo|Redo|Text box|Shape|Fit|Font family|More controls)\b/;
    if ((await labels()).some((label) => english.test(label))) throw new Error(`English editor controls: ${JSON.stringify(await labels())}`);
    await run("window.smoke.setLanguage('en')");
    await until("Array.from(document.querySelectorAll('button')).some(el=>(el.title+' '+el.textContent).includes('Save'))", "English language switch");
    await expectLabels(["Save", "Undo", "Redo"]);
    await run("window.smoke.setLanguage('zh-CN')");
    await until("Array.from(document.querySelectorAll('button')).some(el=>(el.title+' '+el.textContent).includes('保存'))", "Chinese language switch");
    await expectLabels(["保存", "撤销", "重做"]);
    const clickControl = async (text) => {
      const clicked = await run(`(()=>{const el=Array.from(document.querySelectorAll('button')).find(el=>[el.title,el.getAttribute('aria-label'),el.textContent].some(value=>value===${JSON.stringify(text)}));if(!el)return false;el.click();return true})()`);
      if (!clicked) throw new Error(`Cannot find menu ${text}`);
    };
    await clickControl("形状");
    await expectLabels(["矩形", "圆角矩形", "椭圆", "五角星", "向右箭头"]);
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
    fs.mkdirSync(shotDir, { recursive: true });
    const shot = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(shotDir, "pptx-chinese.png"), Buffer.from(shot.data, "base64"));
    if (errors.length) throw new Error(`Browser errors: ${JSON.stringify(errors)}`);
    console.log(`PASS: Chinese controls, shape menu, live English/Chinese switching. Artifacts: ${shotDir}`);
  }

  if (ribbon) {
    // The command layer (commands/registry.ts) behind the ribbon: select, align, distribute, copy/paste, delete slide.
    const deck = async () => { await run("window.smoke.doc.edit(); window.smoke.doc.flush()"); return JSON.parse(await run("window.smoke.text()")); };
    const cards = async () => (await deck()).slides[0].shapes.filter((x) => /^Card/.test(x.name));
    const button = (id) => `document.querySelector('[data-testid="pptx-cmd-${id}"]')`;
    const press = async (id) => {
      await until(`!!${button(id)} && ${button(id)}.getAttribute("aria-disabled")!=="true"`, `${id} enabled`);
      await run(`${button(id)}.click()`);
    };
    const menu = async (id, label) => {
      await run(`document.querySelector('[data-testid="pptx-menu-${id}"]').click()`);
      await until(`Array.from(document.querySelectorAll('[role=menuitem]')).some(el=>el.textContent.includes(${JSON.stringify(label)}))`, `${label} in menu`);
      await run(`Array.from(document.querySelectorAll('[role=menuitem]')).find(el=>el.textContent.includes(${JSON.stringify(label)})).click()`);
    };
    await until(`!!document.querySelector('${canvas}') && !!${button("selectAll")}`, "ribbon with command-layer buttons");
    if (!(await run(`${button("copy")}.getAttribute("aria-disabled")==="true"`))) throw new Error("Copy is enabled with nothing selected");
    const rect = await run(`(()=>{const r=document.querySelector('${canvas}').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);
    const at = (emuX, emuY) => ({ x: rect.x + rect.width * emuX / 12192000, y: rect.y + rect.height * emuY / 6858000 });
    const click = async ({ x, y }) => {
      await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      await sleep(200);
    };
    await press("selectAll");
    await menu("alignObjects", "顶端对齐");
    await until("window.smoke.doc.revision > 0", "align edit");
    // Select all takes the title and body placeholders too: everything lines up with the topmost.
    const top = await cards();
    if (top.length !== 3 || top.some((c) => c.transform.y !== top[0].transform.y) || top[0].transform.y >= 3200400) throw new Error(`Align top: ${JSON.stringify(top.map((c) => c.transform))}`);
    await menu("alignObjects", "横向分布");
    await sleep(500);
    await sleep(300);
    // The cards end up evenly spaced (the placeholders take part too, so gaps are not the original ones).
    const spread = (await cards()).map((x) => x.transform).sort((a, b) => a.x - b.x);
    const gaps = spread.slice(1).map((t, i) => t.x - (spread[i].x + spread[i].width));
    if (Math.max(...gaps) - Math.min(...gaps) > 2 || gaps[0] === 1371600) throw new Error(`Distribute: gaps ${JSON.stringify(gaps)}`);
    await click(at(spread[0].x + spread[0].width / 2, spread[0].y + spread[0].height * .8));
    await press("copy");
    await press("paste");
    await until("window.smoke.text().then(t=>JSON.parse(t).slides[0].shapes.filter(s=>/Card|Rounded/.test(s.name)||s.geometry==='roundRect').length>=4)", "pasted card");
    const before = (await deck()).slides.length;
    await press("deleteSlide");
    await sleep(300);
    if ((await deck()).slides.length !== before - 1) throw new Error("Delete slide did not remove a slide");
    fs.mkdirSync(shotDir, { recursive: true });
    const shot = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(shotDir, "pptx-ribbon.png"), Buffer.from(shot.data, "base64"));
    if (errors.length) throw new Error(`Browser errors: ${JSON.stringify(errors)}`);
    console.log(`PASS: ribbon select all, align, distribute, copy/paste, delete slide. Artifacts: ${shotDir}`);
  } else if (textLayout) {
    const { verifyTextLayout } = await import("./pptx/text-layout.mjs");
    await verifyTextLayout({ run, cdp, until, sleep, shotDir, textSample: Boolean(textSample) });
  } else if (process.env.FINXWORK_E2E_CAPTURE === "1") {
    // Capture-only: no edits, no saves. Writes the main slide canvas of every slide as PNG.
    const stem = path.basename(sourceFile, path.extname(sourceFile)), target = 1280;
    fs.mkdirSync(shotDir, { recursive: true });
    const started = Date.now(), written = [];
    await until(`!!document.querySelector('${canvas}')`, "main canvas");
    const count = await run("document.querySelectorAll('aside > button').length") || 1;
    // Make the canvas backing store exactly 1280 wide: pick a viewport, then correct by device scale factor.
    await cdp("Emulation.setDeviceMetricsOverride", { width: 1800, height: 1100, deviceScaleFactor: 1, mobile: false });
    const widthNow = () => run(`(()=>{const c=document.querySelector('${canvas}');return c?c.width:0})()`);
    await sleep(500);
    let w = await widthNow();
    if (w && w !== target) {
      await cdp("Emulation.setDeviceMetricsOverride", { width: 1800, height: 1100, deviceScaleFactor: target / w, mobile: false });
      await sleep(500);
    }
    for (let n = 1; n <= count; n++) {
      await run(`(()=>{document.activeElement?.blur?.();const b=document.querySelectorAll('aside > button')[${n - 1}];b&&b.click()})()`);
      // Stable frame: fonts ready and the canvas pixels identical across consecutive samples.
      let last = "", stable = 0;
      for (let i = 0; i < 150 && stable < 4; i++) {
        await sleep(150);
        const sig = await run(`(async()=>{await document.fonts.ready;const c=document.querySelector('${canvas}');if(!c)return '';const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let h=2166136261;for(let i=0;i<d.length;i+=61)h=Math.imul(h^d[i],16777619);return c.width+'x'+c.height+':'+(h>>>0)})()`);
        stable = sig && sig === last ? stable + 1 : 0;
        last = sig;
      }
      if (stable < 4) throw new Error(`Slide ${n} never reached a stable frame`);
      const url = await run(`(()=>{const c=document.querySelector('${canvas}');if(c.width===${target})return c.toDataURL('image/png');const o=document.createElement('canvas');o.width=${target};o.height=Math.round(c.height*${target}/c.width);const x=o.getContext('2d');x.imageSmoothingQuality='high';x.drawImage(c,0,0,o.width,o.height);return o.toDataURL('image/png')})()`);
      const file = path.join(shotDir, `${stem}-${n}.png`);
      fs.writeFileSync(file, Buffer.from(url.split(",")[1], "base64"));
      written.push(file);
    }
    if (saves) throw new Error("Capture mode must not save");
    if (errors.length) throw new Error(`Browser errors: ${JSON.stringify(errors)}`);
    console.log(written.join("\n"));
    console.log(`CAPTURED ${written.length} slide(s) of ${stem} in ${Date.now() - started} ms (canvas ${await widthNow()}px, output ${target}px wide)`);
  } else if (process.env.FINXWORK_E2E_REORDER === "1") {
    const order = () => run("window.smoke.text().then(s=>JSON.parse(s).slides.map(p=>p.shapes.flatMap(s=>s.text?.paragraphs?.flatMap(p=>p.runs.map(r=>r.text))??[]).join(' ')))");
    const initial = await order();
    const drag = async (from, to, after) => {
      await run(`(()=>{const rows=document.querySelectorAll('aside > button');window.reorderSource=rows[${from}];window.reorderTarget=rows[${to}];window.reorderData=new DataTransfer();const r=window.reorderSource.getBoundingClientRect();window.reorderSource.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:window.reorderData,clientX:r.x+40,clientY:r.y+20}));const t=window.reorderTarget.getBoundingClientRect();window.reorderY=t.top+t.height*${after ? ".8" : ".2"};window.reorderTarget.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:window.reorderData,clientX:t.x+40,clientY:window.reorderY}));})()`);
      await until("document.querySelector('.pptx-drop-indicator')?.hidden === false", "insertion guide");
    };
    const drop = () => run("window.reorderTarget.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:window.reorderData,clientX:window.reorderTarget.getBoundingClientRect().x+40,clientY:window.reorderY}));window.reorderSource.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:window.reorderData}))");
    await drag(0, 1, true);
    await sleep(100);
    fs.mkdirSync(shotDir, { recursive: true });
    const shot = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(shotDir, "pptx-reorder-guide.png"), Buffer.from(shot.data, "base64"));
    await drop();
    await until("window.smoke.doc.revision > 0", "slide reordered");
    await run("window.smoke.doc.flush()");
    if (JSON.stringify(await order()) !== JSON.stringify([initial[1], initial[0]])) throw new Error("Drop after last slide used the wrong insertion index");
    const revision = await run("window.smoke.doc.revision");
    await drag(1, 0, false);
    await drop();
    await until(`window.smoke.doc.revision > ${revision}`, "slide restored before first");
    await run("window.smoke.doc.flush()");
    if (JSON.stringify(await order()) !== JSON.stringify(initial)) throw new Error("Drop before first slide used the wrong insertion index");
    await drag(0, 1, true);
    await run("window.reorderSource.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:window.reorderData}))");
    if (!(await run("document.querySelector('.pptx-drop-indicator').hidden"))) throw new Error("Cancelled drag left its guide behind");
    const unchanged = await run("window.smoke.doc.revision");
    await drag(0, 0, true);
    const between = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(shotDir, "pptx-reorder-between.png"), Buffer.from(between.data, "base64"));
    await drop();
    if (await run("window.smoke.doc.revision") !== unchanged) throw new Error("Dropping at the same position created an edit");
    if (errors.length) throw new Error(`Browser errors: ${JSON.stringify(errors)}`);
    console.log(`PASS: insertion guide, first/last reorder, saved slide order, drag cancellation. Artifacts: ${shotDir}`);
  } else if (vector) {
    const slide = Number(process.env.FINXWORK_E2E_SLIDE ?? 1);
    if (slide !== 1) await run(`document.querySelectorAll('aside button')[${slide - 1}].click()`);
    const bars = `(()=>{const c=document.querySelector('${canvas}');if(!c)return false;const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let red=0,green=0,purple=0;for(let i=0;i<d.length;i+=4){if(d[i]>130&&d[i+1]<130&&d[i+2]<130)red++;if(d[i]>70&&d[i]<190&&d[i+1]>120&&d[i+2]<140)green++;if(d[i]>70&&d[i]<170&&d[i+1]>50&&d[i+1]<150&&d[i+2]>100&&d[i+2]<190)purple++;}return red>100&&green>100&&purple>100})()`;
    await until(bars, "EMF chart vectors on main Canvas");
    await run("window.smoke.doc.edit(); window.smoke.doc.flush()");
    if (!saves) throw new Error("Vector deck was not saved");
    const before = path.join(work, "original.pptx"), after = path.join(work, "saved.pptx");
    fs.writeFileSync(before, originalBytes); fs.writeFileSync(after, bytes);
    execFileSync("python3", ["-c", "import sys,zipfile; a=zipfile.ZipFile(sys.argv[1]);b=zipfile.ZipFile(sys.argv[2]);names=[n for n in a.namelist() if n.endswith('.emf') or n.startswith('ppt/embeddings/')];assert names;assert all(a.read(n)==b.read(n) for n in names)", before, after]);
    await run("window.smoke.open()");
    await until("!!window.smoke.doc.serialize", "vector deck reopened");
    if (slide !== 1) await run(`document.querySelectorAll('aside button')[${slide - 1}].click()`);
    await until(bars, "EMF chart after save and reopen");
    fs.mkdirSync(shotDir, { recursive: true });
    const shot = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(shotDir, "pptx-vector-chart.png"), Buffer.from(shot.data, "base64"));
    if (errors.length) throw new Error(`Browser errors: ${JSON.stringify(errors)}`);
    console.log(`PASS: EMF vector chart, save/reopen, original EMF and OLE bytes preserved. Artifacts: ${shotDir}`);
  } else {
  const rect = await run(`(()=>{const c=document.querySelector('${canvas}'),r=c.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);
  if (!rect.width || !rect.height) throw new Error("Canvas has no visible dimensions");
  const pixels = await run(`(()=>{const c=document.querySelector('${canvas}');const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let blue=0;for(let i=0;i<d.length;i+=4)if(d[i]<80&&d[i+1]<140&&d[i+2]>180)blue++;return blue})()`);
  if (pixels < 100) throw new Error("The shape was not painted on Canvas");
  // Agent edits go through deck_edit's approval card, so the engine's proposal review stays hidden.
  if (await run("!!document.querySelector('[data-testid=pptx-proposals-button], [data-testid=pptx-proposals-panel]')")) throw new Error("The agent-proposals button is shown");
  // Arrow keys page like PowerPoint, from the slide strip and from the stage with nothing selected.
  const arrow = async (key) => { for (const type of ["keyDown", "keyUp"]) await cdp("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: key === "ArrowDown" ? 40 : 38 }); };
  const activeRow = `[...document.querySelectorAll('aside > button')].findIndex((b) => b.getAttribute('aria-current') === 'page')`;
  await run("document.querySelectorAll('aside > button')[0].click(); document.querySelectorAll('aside > button')[0].focus()");
  await until(`${activeRow} === 0`, "first slide active");
  await arrow("ArrowDown");
  await until(`${activeRow} === 1 && document.activeElement === document.querySelectorAll('aside > button')[1]`, "ArrowDown on the strip pages forward and keeps strip focus");
  await arrow("ArrowUp");
  await until(`${activeRow} === 0`, "ArrowUp on the strip pages back");
  await run("document.querySelector('[role=application]').focus()");
  await arrow("ArrowDown");
  await until(`${activeRow} === 1`, "ArrowDown on the stage pages forward");
  if (await run("getComputedStyle(document.querySelector('[role=application]')).outlineStyle") !== "none") throw new Error("The focused stage draws a focus ring");
  await arrow("ArrowUp");
  await until(`${activeRow} === 0`, "ArrowUp on the stage pages back");
  await until(`(()=>{const c=document.querySelector('${canvas}');const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let blue=0;for(let i=0;i<d.length;i+=4)if(d[i]<80&&d[i+1]<140&&d[i+2]>180)blue++;return blue>=100})()`, "first slide repainted");
  const x = rect.x + rect.width * .22, y = rect.y + rect.height * .18;
  for (let clickCount = 1; clickCount <= 2; clickCount++) {
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount });
  }
  await sleep(200);
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 4 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 4 });
  await cdp("Input.insertText", { text: "Edited in FinxWork" });
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
  await until("window.smoke.doc.revision > 0", "text edit");
  await run("window.smoke.doc.flush()");
  await until("!window.smoke.doc.dirty", "save");
  if (!saves || !(await run("window.smoke.text()")).includes("Edited in FinxWork")) throw new Error("Edited text did not survive PPTX serialization");
  // Moving a shape changes its PPTX geometry, rather than moving a preview image.
  const cardX = rect.x + rect.width * .23, cardY = rect.y + rect.height * .47;
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: cardX, y: cardY, button: "left", clickCount: 1 });
  for (let step = 1; step <= 5; step++) await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: cardX + step * 12, y: cardY + step * 4, button: "left", buttons: 1 });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: cardX + 60, y: cardY + 20, button: "left", clickCount: 1 });
  await sleep(200);
  await run("window.smoke.doc.flush()");
  const moved = JSON.parse(await run("window.smoke.text()")).slides[0].shapes.find((s) => s.name === "Blue card");
  if (moved.transform.x <= 914400) throw new Error("Dragging did not update the shape's saved position");
  await run("window.surfaceBefore = window.smoke.doc.surface; window.smoke.hide()");
  await sleep(100);
  await run("window.smoke.show()");
  await until("!!document.querySelector('[data-testid=\"pptx-slide-canvas\"]')", "panel reattach");
  if (!(await run("window.smoke.doc.surface === window.surfaceBefore"))) throw new Error("Hiding the panel replaced the editing session");
  await run("window.smoke.open()");
  await until("!!window.smoke.doc.serialize", "saved deck reopened");
  fs.mkdirSync(shotDir, { recursive: true });
  const shot = await cdp("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(shotDir, "pptx-editor.png"), Buffer.from(shot.data, "base64"));
  fs.writeFileSync(path.join(shotDir, "edited.pptx"), bytes);
  if (errors.length) throw new Error(`Browser errors: ${JSON.stringify(errors)}`);
  console.log(`PASS: Canvas paint, keyboard text editing, shape drag, save/reopen, persistent session. Artifacts: ${shotDir}`);
  }
  }
} catch (e) {
  console.error(diagnostics);
  throw e;
} finally {
  ws?.close();
  app.kill("SIGTERM");
  kernel?.kill("SIGTERM");
  await new Promise((r) => server.close(r));
}
