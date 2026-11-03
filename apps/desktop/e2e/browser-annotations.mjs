#!/usr/bin/env node
// Verify "add to chat": a part of a page, picked in the embedded browser, lands in the composer.
import { execFileSync, spawn } from "node:child_process";
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

// Short: the kernel's socket lives under it, and a socket path has at most 103 bytes.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxc-"));
const home = path.join(work, "finx");
const profile = path.join(work, "profile");
const userHome = path.join(work, "home");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(userHome, { recursive: true });
const env = { ...process.env, FINX_HOME: home, HOME: userHome, FINX_CREDENTIAL_STORE: "file", FINX_NO_BROWSER: "1" };
// ── the app, driven over the DevTools protocol (as e2e/stale-model.mjs) ──
let app = null;
async function launch() {
  const port = 9400 + Math.floor(Math.random() * 400);
  app = spawn(electron, [desktop, ...(process.env.FINXWORK_E2E_NO_SANDBOX ? ["--no-sandbox"] : []), `--remote-debugging-port=${port}`], {
    env: { ...env, FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINXWORK_NO_BROWSER: "1" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(200);
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => []);
    target = list.find((t) => t.type === "page" && /^(app:|file:)/.test(t.url) && !t.url.includes("#settings"));
  }
  check(target, "the main window never showed up");
  const page = await devtools(target.webSocketDebuggerUrl);
  const cdp = page.call;
  // Expressions answer with plain values (a DOM node cannot cross).
  const run = async (expr) => {
    const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) fail(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const until = async (what, expr, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await run(expr);
      if (v) return v;
      if (Date.now() > end) fail(`timed out waiting for ${what}`);
      await sleep(150);
    }
  };
  const shot = async (name) => {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    await sleep(450); // sections fade in
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, "base64"));
  };
  const theme = (dark) => cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1240, height: 820, deviceScaleFactor: 0, mobile: false });
  return { cdp, run, until, shot, theme, port, close: page.close };
}

/** A DevTools connection: `call` sends a command and resolves to its result. */
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
  const timeout = setTimeout(() => app.kill("SIGKILL"), 3000);
  await exited;
  clearTimeout(timeout);
}


let failed = false;
// The image never finishes, so the page is still loading the whole time: annotating
// waits for the document only, not for everything on it.
const site = http.createServer((req, res) => req.url === "/slow.png" ? res.writeHead(200, { "content-type": "image/png" }).flushHeaders() : res.end(`<title>Annotation test</title><img src="/slow.png" width="1" height="1"><style>body{font:20px system-ui;padding:40px;background:#f5f7fb;color:#242938}h1{margin:0 0 30px}p{height:900px}</style><h1 id="heading">A page worth discussing</h1><a id="link" href="#changed">This link must not navigate in annotation mode</a><p>Scroll to test anchored comments.</p><script>window.keys=0;document.addEventListener('keydown',()=>keys++)</script>`));
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
try {
  const page = await launch();
  await page.until("kernel ready", `(async () => (await window.finx?.kernelStatus())?.state === "ready")()`, 60000);
  await sleep(1000);
  await page.until("app loaded", `!!document.querySelector("button")`);
  // The onboarding page may show up after the first check: keep leaving it until the home page is there.
  await page.until("onboarding left", `(() => { const skip = [...document.querySelectorAll("button")].find(b => /稍后|later|skip/i.test(b.textContent)); if (skip) { skip.click(); return false; } return !!document.querySelector(".ctool button[aria-pressed]"); })()`);
  await page.until("home browser", `!!document.querySelector('.ctool button[aria-pressed]')`);
  await page.run(`document.querySelector('.ctool button[aria-pressed]').click()`);
  await page.until("browser ready", `!!document.querySelector('.brp-url')`);
  const url = `http://127.0.0.1:${site.address().port}/`;
  await page.run(`(async () => { const tabs = await window.finx.browserTabs(); window.finx.browserTabCommand(tabs[0].targetId, { command: 'go', url: ${JSON.stringify(url)} }); })()`);
  await page.until("site loaded", `document.querySelector('.brp-tab-t')?.textContent === 'Annotation test' && !document.querySelector('.brp-annotate').disabled`).catch(async e => { console.error(await page.run(`(async () => JSON.stringify({tabs:await window.finx.browserTabs(),html:document.querySelector('.brp')?.outerHTML}))()`)); throw e; });
  check((await page.run(`(async () => (await window.finx.browserTabs()).every(t => t.loading))()`)) === true, "the page should still be loading while it can be annotated");
  const targets = await fetch(`http://127.0.0.1:${page.port}/json/list`).then(r => r.json());
  const target = targets.find(t => t.url === url);
  check(target, "browser target missing");
  const browser = await devtools(target.webSocketDebuggerUrl);
  const run = async expression => {
    const r = await browser.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) fail(r.exceptionDetails.text);
    return r.result.value;
  };
  await browser.call('DOM.enable');
  const nodes = async () => {
    const { root } = await browser.call('DOM.getDocument', { depth: -1, pierce: true });
    const result = [];
    const walk = n => { result.push(n); for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) walk(c); };
    walk(root); return result;
  };
  const attr = (n, key) => { const a = n.attributes ?? []; const i = a.indexOf(key); return i < 0 ? null : a[i + 1]; };
  const find = async (predicate, wait = true) => {
    for (let i=0; i<(wait ? 80 : 1); i++) { const n = (await nodes()).find(predicate); if (n) return n; await sleep(100); }
    if (wait) fail('annotation UI node missing');
    return null;
  };
  const klass = name => n => (attr(n, 'class') ?? '').split(' ').includes(name);
  const invoke = async (n, functionDeclaration) => {
    const { object } = await browser.call('DOM.resolveNode', { nodeId: n.nodeId });
    return browser.call('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration, returnByValue: true });
  };
  const click = async (x, y) => {
    await browser.call('Input.dispatchMouseEvent', { type:'mousePressed', x,y,button:'left',clickCount:1 });
    await browser.call('Input.dispatchMouseEvent', { type:'mouseReleased', x,y,button:'left',clickCount:1 });
  };
  const write = async body => {
    const n = await find(n => n.nodeName === 'TEXTAREA');
    await invoke(n, `function(){this.focus();this.value=${JSON.stringify(body)};this.dispatchEvent(new Event('input',{bubbles:true}));}`);
  };
  const key = async (key, code, keyCode, text) => {
    await browser.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, text });
    await browser.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
  };
  const webTiles = `[...document.querySelectorAll('.cmp .tile.web')].map(t => t.title)`;
  await page.run(`document.querySelector('.brp-annotate').click()`);
  await page.until('pick mode', `document.querySelector('.brp-annotate').getAttribute('aria-pressed') === 'true'`);
  const position = await run(`(() => {const r=document.querySelector('#heading').getBoundingClientRect(); return {x:r.left+25,y:r.top+20};})()`);
  await click(position.x, position.y);
  await write('把这个标题改得更简洁 <script>alert(1)</script>');
  await key('s', 'KeyS', 83, 's');
  check(await run('keys') === 0, 'typing in the editor reached the page shortcuts');
  if(shots){ fs.mkdirSync(shots,{recursive:true}); await sleep(300); const {data}=await browser.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(shots,'add-to-chat-editor.png'),Buffer.from(data,'base64')); }
  await key('Enter', 'Enter', 13, '\r');
  await page.until('tile in the composer', `${webTiles}.length === 1`);
  const [tile] = await page.run(webTiles);
  check(tile.includes('<script>') && tile.includes(url) && tile.includes('A page worth discussing'), `tile lacks the comment, page or element: ${tile}`);
  check(await run(`window.finx === undefined && document.querySelector('[data-finx-annotations]').shadowRoot === null`), 'website has privileged bridge or open shadow root');
  await run(`document.querySelector('#heading').style.marginTop='120px'`);
  const pin = await find(klass('pin'));
  let pinY = 0;
  for(let i=0;i<50;i++){ pinY = (await invoke(pin, 'function(){return this.getBoundingClientRect().y}')).result.value; if(pinY>position.y+60) break; await sleep(100); }
  check(pinY > position.y + 60, 'marker did not follow moving content');
  await page.shot('add-to-chat');
  // The tile, clicked, shows the element's picture and what it is.
  await page.run(`document.querySelector('.cmp .tile.web .tile-open').click()`);
  await page.until('the details over the tile', `!!document.querySelector('.wdt')`);
  check(await page.run(`!!document.querySelector('.wdt-shot img') && document.querySelector('.wdt-shot img').naturalWidth > 0`), 'the details have no picture of the element');
  check(await page.run(`document.querySelector('.wdt').innerText.includes('A page worth discussing') || document.querySelector('.wdt').innerText.includes('<h1')`), 'the details do not say what the element is');
  await page.shot('add-to-chat-details');
  await page.run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await page.until('the details closed', `!document.querySelector('.wdt')`);
  const link = await run(`(() => {const r=document.querySelector('#link').getBoundingClientRect();return {x:r.x+20,y:r.y+10};})()`);
  await click(link.x,link.y); await find(n=>n.nodeName==='TEXTAREA');
  check(await run('location.hash') === '', 'pick mode followed website link');
  await write('还没添加的想法');
  await key('Escape', 'Escape', 27);
  await find(klass('draft-pin'));
  check(!(await find(n => n.nodeName === 'TEXTAREA', false)), 'Escape did not close the editor');
  await invoke(await find(klass('draft-pin')), 'function(){this.click()}');
  const kept = await invoke(await find(n=>n.nodeName==='TEXTAREA'), 'function(){return this.value}');
  check(kept.result.value === '还没添加的想法', 'unsent draft was lost');
  check((await page.run(webTiles)).length === 1, 'a draft reached the composer');
  await page.run(`document.querySelector('.brp-annotate').click()`);
  await page.until('browse mode', `document.querySelector('.brp-annotate').getAttribute('aria-pressed') === 'false'`);
  await click(link.x,link.y);
  for(let i=0;i<50 && await run('location.hash') !== '#changed';i++) await sleep(100);
  check(await run('location.hash') === '#changed', 'normal browsing did not resume');
  browser.close(); page.close();
  console.log('✓ add to chat: picking, composer tile, isolation, key isolation, moving markers, drafts and normal browsing');
} catch (error) {
  failed = true; console.error(error);
} finally {
  await quit(); site.closeAllConnections(); site.close();
  try { execFileSync("pkill", ["-f", `${home}/run/finx.sock`]); } catch {}
  if (!failed) fs.rmSync(work, { recursive: true, force: true });
  else console.error(`left for inspection: ${work}`);
}
process.exit(failed ? 1 : 0);
