#!/usr/bin/env node
// Browser-only integration: production Markdown components, isolated mock store.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const desktop = path.resolve(import.meta.dirname, '..');
const url = 'http://127.0.0.1:5187/markdown.html';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'finx-markdown-'));
const shots = process.env.FINXWORK_E2E_SHOTS ?? path.join(profile, 'shots');
fs.mkdirSync(shots, { recursive: true });
let server, browser, socket;
try {
  if (!await fetch(url).then(r => r.ok, () => false)) server = spawn('pnpm', ['exec', 'vite', '--config', 'e2e/markdown.vite.config.ts'], { cwd: desktop, stdio: 'ignore' });
  for (let i = 0; i < 100 && !await fetch(url).then(r => r.ok, () => false); i++) await sleep(100);
  const port = 9600 + Math.floor(Math.random() * 300);
  browser = spawn(process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  let page;
  for (let i = 0; i < 100 && !page; i++) {
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json(), () => []);
    page = pages.find(p => p.type === 'page'); if (!page) await sleep(100);
  }
  assert.ok(page, 'Chrome did not start');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r,j) => { socket.onopen = r; socket.onerror = j; });
  let seq = 0;
  const waiting = new Map();
  const errors = [];
  socket.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    const w = waiting.get(m.id); if (!w) return;
    waiting.delete(m.id); m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result);
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => { waiting.set(++seq, { resolve, reject }); socket.send(JSON.stringify({ id: seq, method, params })); });
  const run = async expression => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async expression => {
    for (let i = 0; i < 250; i++) { const result = await run(`Boolean(${expression})`); if (result) return result; await sleep(100); }
    throw new Error(`Timeout: ${expression}\n${errors.join('\n')}`);
  };
  const shot = async name => { const r = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(r.data, 'base64')); };
  await call('Runtime.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await call('Page.navigate', { url });
  await until('window.setMarkdown && document.querySelector(".md h1")');
  await until('document.querySelectorAll(".katex").length >= 2');
  await until('document.querySelector(".hl")');
  await until('document.querySelector(".md-diagram-svg")?.shadowRoot?.querySelector("svg")');
  assert.equal(await run('document.querySelectorAll(".md ol").length'), 1);
  assert.equal(await run('document.querySelectorAll(".md-callout").length'), 1);
  assert.equal(await run('document.querySelector(".md-details summary").textContent'), '展开计算说明');
  assert.ok(await run('document.querySelector(".md").textContent.includes("$100 和 $200")'));
  const codeColors = await run(`Object.fromEntries([...document.querySelectorAll('.hl span[style]')].filter(el=>['const','export','123.45'].includes(el.textContent)).map(el=>[el.textContent,getComputedStyle(el).color]))`);
  assert.deepEqual(codeColors, { const: 'rgb(27, 54, 217)', export: 'rgb(27, 54, 217)', '123.45': 'rgb(117, 67, 186)' });
  await shot('light');
  await run('document.querySelector(".md-diagram").scrollIntoView({block:"center"})');
  await shot('light-diagram');
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(500);
  await shot('dark-diagram');
  await run('document.querySelector(".cscroll").scrollTop = 0');
  await shot('dark');
  await call('Emulation.setDeviceMetricsOverride', { width: 460, height: 850, deviceScaleFactor: 1, mobile: false });
  await shot('narrow');
  assert.ok(await run('document.documentElement.scrollWidth <= innerWidth'), 'page overflows horizontally');
  // Completing a stream keeps existing nodes and interactive state.
  await run('window.setMarkdown(window.fixtureText, true)'); await sleep(100);
  await run('window.keptCode = document.querySelector(".cblock"); window.keptTable = document.querySelector("table"); document.querySelector("details").open = true');
  await run('window.setMarkdown(window.fixtureText, false)'); await sleep(100);
  assert.ok(await run('window.keptCode === document.querySelector(".cblock") && window.keptTable === document.querySelector("table") && document.querySelector("details").open'));
  // Table expansion closes with Escape and returns focus.
  await run('document.querySelector(".md-table .md-tools button:last-of-type").click()');
  await until('document.querySelector("dialog[open]")');
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await until('!document.querySelector("dialog[open]")');
  // Scoped footnote links/backreferences work; anchors are not file links.
  await run('window.setMarkdown("# Footnotes\\n\\nA[^1].\\n\\n[^1]: source", false)');
  await until('document.querySelector("[data-footnote-ref]")');
  assert.ok(await run('const a=document.querySelector("[data-footnote-ref]"); const target=document.querySelector(a.getAttribute("href").replaceAll(":", "\\\\:")); a.click(); target === document.activeElement'));
  // Unsupported diagram config fails locally, leaving source visible.
  await run('window.setMarkdown("```mermaid\\n%%{init: {securityLevel: \\\"loose\\\"}}%%\\nflowchart LR\\n A-->B\\n```", false)');
  await until('document.querySelector(".md-render-note")');
  // Sustained output: large fenced code, with a final flush that cannot lose a suffix.
  const performanceResult = await run(`(async () => {
    const tasks=[]; const observer=new PerformanceObserver(list=>tasks.push(...list.getEntries().map(e=>e.duration)));
    observer.observe({type:'longtask'});
    const source = '# Stream benchmark\\n\\n' + '\`\`\`typescript\\n' + Array.from({length:600},(_,i)=>'const amount'+i+' = '+i+';').join('\\n') + '\\n\`\`\`\\n\\nFinished.';
    const start=performance.now();
    for(let n=200;n<source.length;n+=200){window.setMarkdown(source.slice(0,n),true);await new Promise(r=>setTimeout(r,20));}
    window.setMarkdown(source,false);
    await new Promise(r=>setTimeout(r,500));observer.disconnect();
    return {durationMs:Math.round(performance.now()-start),longTasks:tasks.length,maxLongTaskMs:Math.round(Math.max(0,...tasks)),codeLines:document.querySelector('.cblock code')?.textContent.split(String.fromCharCode(10)).length,finished:document.querySelector('.md').textContent.includes('Finished.')};
  })()`);
  assert.ok(performanceResult.finished);
  assert.equal(performanceResult.codeLines, 600);
  console.log('Streaming sample:', performanceResult);
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(`Markdown browser checks passed. Screenshots: ${shots}`);
} finally {
  socket?.close(); browser?.kill('SIGTERM'); server?.kill('SIGTERM');
}
