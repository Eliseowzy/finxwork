#!/usr/bin/env node
// Browser-only integration: production Markdown components, isolated mock store.
import { cdpPort } from "./lib/port.mjs";
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
  const port = cdpPort();
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
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  // Formulas: the stylesheet matches the renderer, so a subscript is smaller than its base.
  await run(`window.setMarkdown('\\\\(x_i\\\\)', false)`);
  await until('document.querySelector(".katex .msupsub")');
  const subscript = await run(`(() => { const k = document.querySelector('.katex'); return [parseFloat(getComputedStyle(k.querySelector('.msupsub .sizing .mord, .msupsub .mord')).fontSize), parseFloat(getComputedStyle(k).fontSize)]; })()`);
  assert.ok(subscript[0] < subscript[1] * .8, `subscript ${subscript[0]}px on ${subscript[1]}px`);
  await run('window.setMarkdown(window.fixtureText, false)');
  await until('document.querySelector(".md-table")');
  // A short table is as wide as its content, on the prose's left edge; its tools wait for the pointer.
  const small = await run(`(() => { const box = document.querySelector('.md-table-box').getBoundingClientRect(); const prose = document.querySelector('.md p').getBoundingClientRect(); const tools = document.querySelector('.md-table-tools'); return { width: box.width, left: box.left, proseLeft: prose.left, proseWidth: prose.width, opacity: getComputedStyle(tools).opacity, x: box.left + box.width / 2, y: box.top + 40 }; })()`);
  assert.ok(small.width < small.proseWidth, `short table is ${small.width}px`);
  assert.equal(Math.round(small.left), Math.round(small.proseLeft));
  assert.equal(small.opacity, '0');
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: small.x, y: small.y });
  await until('getComputedStyle(document.querySelector(".md-table-tools")).opacity === "1"');
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
  // Copy gives a sheet tabs and a document a table.
  assert.deepEqual(await run(`(async () => {
    let item; navigator.clipboard.write = async ([i]) => { item = i; };
    document.querySelector('.md-table-tools button').click();
    for (let n = 0; n < 50 && !item; n++) await new Promise(r => setTimeout(r, 20));
    const plain = await (await item.getType('text/plain')).text();
    const html = await (await item.getType('text/html')).text();
    return [plain.split('\\n')[0], html.startsWith('<table')];
  })()`), ['指标\t本期\t上期', true]);
  // Table expansion closes with Escape and returns focus.
  await run('document.querySelector(".md-table .md-tools button:last-of-type").click()');
  await until('document.querySelector("dialog[open]")');
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await until('!document.querySelector("dialog[open]")');
  // Written cell by cell: columns never shrink, the left edge stays, finishing moves nothing.
  const written = await run(`(async () => {
    const rows = [['收入', '123,456.78', '+3.2%', '主营业务'], ['成本', '98,765,432.10', '-12.45%', '原材料和人工上涨导致成本结构变化较大'], ['研发费用', '1,234,567,890.12', '+128.33%', '本期新增两个大型项目，投入明显增加，需要后续继续观察'], ['净利润', '-5,432.10', '-1.1%', '短']];
    const source = '| 项目 | 本期金额 | 环比 | 说明 |\\n|:--|--:|--:|:--|\\n' + rows.map(r => '| ' + r.join(' | ') + ' |').join('\\n') + '\\n';
    const read = () => [...document.querySelectorAll('th')].map(c => Math.round(c.getBoundingClientRect().width));
    window.setMarkdown('', true); await new Promise(r => setTimeout(r, 100));
    let last = null, shrunk = 0, left = null, slid = 0;
    for (let n = 8; n < source.length; n += 8) {
      window.setMarkdown(source.slice(0, n), true); await new Promise(r => setTimeout(r, 48));
      const now = read(); if (!now.length) continue;
      if (last?.length === now.length && now.some((w, i) => w < last[i])) shrunk++;
      const x = document.querySelector('table').getBoundingClientRect().left;
      if (left !== null && Math.abs(x - left) > 1) slid++;
      last = now; left = x;
    }
    window.setMarkdown(source, true); await new Promise(r => setTimeout(r, 100));
    const end = read(); const height = document.querySelector('table').getBoundingClientRect().height;
    window.setMarkdown(source, false); await new Promise(r => setTimeout(r, 200));
    return { shrunk, slid, end, done: read(), heightEnd: height, heightDone: document.querySelector('table').getBoundingClientRect().height };
  })()`);
  assert.equal(written.shrunk, 0, 'a column shrank while being written');
  assert.equal(written.slid, 0, 'the table slid while being written');
  assert.deepEqual(written.done, written.end, 'finishing moved the columns');
  assert.equal(written.heightDone, written.heightEnd, 'finishing changed the height');
  console.log('Table written:', written.done.join(','));
  // A bracket in passing rebuilds nothing, and links stay links.
  const bracket = await run(`(async () => {
    const head = '# 标题\\n\\n[链接](https://example.com)\\n\\n\`\`\`ts\\nconst a = 1;\\n\`\`\`\\n\\n| A | B |\\n|---|---|\\n| 1 | 2 |\\n\\n';
    window.setMarkdown(head + '继续写', true); await new Promise(r => setTimeout(r, 200));
    const code = document.querySelector('.cblock'), table = document.querySelector('table');
    window.setMarkdown(head + '继续写，看 \`arr[0]\` 和 [备注] 的值\\n\\n再写一段', true); await new Promise(r => setTimeout(r, 200));
    return { code: code === document.querySelector('.cblock'), table: table === document.querySelector('table'), links: document.querySelectorAll('.md a[href]').length };
  })()`);
  assert.deepEqual(bracket, { code: true, table: true, links: 1 });
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
