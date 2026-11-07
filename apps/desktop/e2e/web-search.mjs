#!/usr/bin/env node
// 联网搜索 (docs/kernel/web-search-design.md §2): Settings › 联网搜索 is one list of services, top
// to bottom the first usable; a key is tried before it is kept and goes first; rows are dragged or
// moved with the keys; each service that has what it needs has a switch. The "+" menu has only the
// master switch. In the conversation a search reads as the words searched for and opens to the
// pages found; a failover and a failure say what happened. Exa is no longer in 发现.
//
// Runs the development build against the repository's target/debug/finx in a private HOME and
// FINX_HOME, with a model and search services on this Mac that the script can make fail.
//
//   node apps/desktop/e2e/web-search.mjs
//   FINXWORK_E2E_SHOTS=<folder> node apps/desktop/e2e/web-search.mjs   also screenshots
import { cdpPort } from "./lib/port.mjs";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
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
const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxs-"));
const home = path.join(work, "finx");
const userHome = path.join(work, "home");
const profile = path.join(work, "profile");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(userHome, { recursive: true });

// ── the model and the search services ──
const PAGES = [
  { title: "贵州茅台 2026 年第三季度报告", url: "https://static.cninfo.com.cn/finalpage/2026-10-31/1225649896.PDF", date: "2026-10-30", text: "营业收入 402.67 亿元，同比增长 3.08%。" },
  { title: "茅台三季度营收 402 亿", url: "https://www.bjnews.com.cn/detail/1793357129129135.html", date: null, text: "新京报报道。" },
  { title: "Old page", url: "https://example.org/old?utm_source=x", date: "2020-01-02", text: "An older page." },
];
const failing = {};
const searches = [];
const modelRequests = [];
const send = (res, status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
const sse = (delta, finish) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\ndata: [DONE]\n\n`;

let calls = 0;
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    if (url.pathname.endsWith("/chat/completions")) {
      const body = JSON.parse(raw);
      modelRequests.push(body);
      const last = body.messages.at(-1);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (last.role === "tool") return res.end(sse({ role: "assistant", content: "查好了。" }, "stop"));
      const said = typeof last.content === "string" ? last.content : last.content.map((c) => c.text ?? "").join("");
      const asked = /^search:(.*?)(?:\|only=(.*))?$/.exec(said);
      if (!asked) return res.end(sse({ role: "assistant", content: "好的。" }, "stop"));
      const args = { query: asked[1], ...(asked[2] ? { allowed_domains: asked[2].split(",") } : {}) };
      const call = { index: 0, id: `call_${++calls}`, type: "function", function: { name: "call_tool", arguments: JSON.stringify({ name: "web_search", arguments: args }) } };
      return res.end(sse({ role: "assistant", tool_calls: [call] }, "tool_calls"));
    }
    const service = url.pathname.split("/")[1];
    const key = req.headers.authorization?.replace(/^Bearer /, "") ?? req.headers["x-subscription-token"] ?? null;
    searches.push({ service, key, query: raw ? JSON.parse(raw).query : url.searchParams.get("q") });
    if (key === "bad-key") return send(res, 401, { error: "invalid key" });
    if (failing[service]) return send(res, failing[service], { error: "no" });
    if (service === "tavily") return send(res, 200, { results: PAGES.map((p) => ({ title: p.title, url: p.url, content: p.text, published_date: p.date })) });
    if (service === "brave") return send(res, 200, { web: { results: PAGES.map((p) => ({ title: p.title, url: p.url, description: p.text, page_age: p.date })) } });
    send(res, 503, { error: "down" });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

fs.writeFileSync(
  path.join(home, "models.toml"),
  `[providers.mock]\nname = "Mock"\napi = "openai-chat"\nbase_url = "${base}/v1"\nauth = "none"\n\n[[providers.mock.models]]\nid = "mock-1"\nname = "Mock One"\ncontext_window = 128000\nmax_output_tokens = 2000\n`,
);
fs.writeFileSync(
  path.join(home, "config.toml"),
  `model = "mock/mock-1"\n[models]\nnetwork = false\n[web_search.endpoints]\nexa = "${base}/exa/mcp"\nparallel = "${base}/parallel/mcp"\ntavily = "${base}/tavily"\nbrave = "${base}/brave"\nbocha = "${base}/bocha"\n`,
);
const config = () => fs.readFileSync(path.join(home, "config.toml"), "utf8");
const searchTable = () => config().split("[web_search]")[1]?.split("[web_search.endpoints]")[0] ?? "";
const credentials = () => {
  try {
    return fs.readFileSync(path.join(home, "credentials.toml"), "utf8");
  } catch {
    return "";
  }
};

// ── the app, driven over the DevTools protocol ──
const port = cdpPort();
let app = null;

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
      if (Date.now() > end) fail(`timed out waiting for ${label}: ${await run("document.body.innerText.slice(0, 1200)")}`);
      await sleep(100);
    }
  };
  const shot = async (name) => {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    await sleep(350);
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

// The page, in the app's language (the private HOME has no preference; both are accepted).
const strings = Object.fromEntries(["en", "zh-CN"].map((l) => [l, JSON.parse(fs.readFileSync(path.join(desktop, "src/locales", l, "settings.json"), "utf8"))]));
const session = Object.fromEntries(["en", "zh-CN"].map((l) => [l, JSON.parse(fs.readFileSync(path.join(desktop, "src/locales", l, "session.json"), "utf8"))]));
const either = (pick, from = strings) => JSON.stringify(Object.values(from).map(pick));
const row = (name) => `[...document.querySelectorAll('.ws-row')].find(r => r.querySelector('.fn').firstChild.textContent === ${JSON.stringify(name)})`;
const order = `[...document.querySelectorAll('.ws-row')].map(r => r.querySelector('.fn').firstChild.textContent)`;
const currentRow = `document.querySelector('.ws-row .badge')?.closest('.ws-row').querySelector('.fn').firstChild.textContent`;
const button = (scope, ...labels) => `[...${scope}.querySelectorAll('button')].find(b => ${JSON.stringify(labels.flat())}.includes(b.textContent.trim()))`;
const each = (pick, from = strings) => Object.values(from).map(pick);
const lastTool = `[...document.querySelectorAll('.tool')].at(-1)`;

let failed = false;
try {
  if (!process.env.FINXWORK_E2E_NO_BUILD) {
    step("building finx and the app");
    sh("cargo", ["build", "-p", "finx-cli"], { cwd: root });
    sh("pnpm", ["--dir", desktop, "build"]);
  }
  const env = { ...process.env, FINX_HOME: home, HOME: userHome, FINX_CREDENTIAL_STORE: "file", FINX_NO_BROWSER: "1", FINXWORK_DEFAULT_MODE: "sessions", FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINXWORK_NO_BROWSER: "1" };
  for (const k of Object.keys(env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete env[k];
  app = spawn(electron, [desktop, `--remote-debugging-port=${port}`], { env, stdio: ["ignore", "ignore", "inherit"] });
  const main = await attach((t) => t.type === "page" && !t.url.includes("#settings") && !t.url.startsWith("devtools"), "the main window");
  await main.until("the composer", `!!document.querySelector('.cmp-in')`);

  step("Exa is not in 发现 any more");
  await main.run(`[...document.querySelectorAll('.side-nav .nav-i')].find(r => ['自定义','Customize'].some(t => r.textContent.includes(t))).click()`);
  await main.until("自定义", `!![...document.querySelectorAll('.cz-tab')].find(e => ['连接器','Connectors'].includes(e.textContent.trim()))`);
  await main.run(`[...document.querySelectorAll('.cz-tab')].find(e => ['连接器','Connectors'].includes(e.textContent.trim())).click()`);
  await main.until("发现 lists its connectors", `document.body.innerText.includes('钉钉') || document.body.innerText.includes('DingTalk')`);
  check(!(await main.run(`/\\bExa\\b/.test(document.querySelector('.cz-page, main, body').innerText)`)), "Exa is still offered in 发现");
  await main.shot("1-discover");
  await main.run(`document.querySelector('.cz-back')?.click()`);

  step("Settings › 联网搜索: the list as it comes");
  await main.run(`window.finx.openSettings("search")`);
  const set = await attach((t) => t.type === "page" && t.url.includes("#settings"), "the settings window");
  await set.cdp("Emulation.setDeviceMetricsOverride", { width: 820, height: 760, deviceScaleFactor: 0, mobile: false });
  await set.until("the rows", `document.querySelectorAll('.ws-row').length === 6`);
  check(JSON.stringify(await set.run(order)) === JSON.stringify(["DeepSeek", "Exa", "Parallel", "Tavily", "Brave", "博查"]), `order: ${await set.run(order)}`);
  check((await set.run(currentRow)) === "Exa", `in use: ${await set.run(currentRow)}`);
  const deepseek = await set.run(`${row("DeepSeek")}.innerText`);
  check(each((s) => s.search.connect).some((w) => deepseek.includes(w)), `DeepSeek without an account: ${deepseek}`);
  check(!(await set.run(`!!${row("DeepSeek")}.querySelector('.sw')`)), "DeepSeek without an account has a switch");
  check(await set.run(`!!${row("Exa")}.querySelector('.sw.on')`), "Exa needs nothing, so its switch is on");
  check(!(await set.run(`!!${row("Tavily")}.querySelector('.sw')`)), "Tavily without a key has a switch");
  await set.shot("2-settings-first");

  step("a key the service refuses is not kept");
  await set.run(`${button(row("Tavily"), each((s) => s.search.addKey))}.click()`);
  await set.until("the sheet", `!!document.querySelector('dialog.sheet input')`);
  await set.run(`document.querySelector('dialog.sheet input').focus()`);
  await set.cdp("Input.insertText", { text: "bad-key" });
  await set.shot("3-key-sheet");
  await set.until("the button", `!document.querySelector('dialog.sheet button[type=submit]').disabled`);
  await set.run(`document.querySelector('dialog.sheet button[type=submit]').click()`);
  await set.until("the refusal", `!!document.querySelector('.ws-err')`);
  check(!credentials().includes("web-search.tavily"), `a refused key was saved: ${credentials()}`);
  check(!config().includes("order"), `a refused key moved the row: ${config()}`);
  check(searches.at(-1).service === "tavily" && searches.at(-1).key === "bad-key", `not tried: ${JSON.stringify(searches.at(-1))}`);
  await set.shot("4-key-refused");

  step("a good key is tried, kept and goes first, and its switch shows");
  await set.run(`document.querySelector('dialog.sheet input').select()`);
  await set.cdp("Input.insertText", { text: "tavily-good-key" });
  await set.run(`document.querySelector('dialog.sheet button[type=submit]').click()`);
  await set.until("the sheet closed", `!document.querySelector('dialog.sheet')`);
  await set.until("Tavily first", `${order}[0] === 'Tavily' && ${currentRow} === 'Tavily'`);
  check(await set.run(`!!${row("Tavily")}.querySelector('.sw.on')`), "Tavily with a key has no switch");
  check(credentials().includes("web-search.tavily"), `the key was not saved: ${credentials()}`);
  check(!config().includes("tavily-good-key"), "the key went into the configuration");
  const toast = await set.until("the toast", `document.querySelector('.toast')?.innerText`);
  check(toast.includes("Tavily") && toast.includes("3"), `toast: ${toast}`);

  await set.run(`${button(row("Brave"), each((s) => s.search.addKey))}.click()`);
  await set.until("the sheet", `!!document.querySelector('dialog.sheet input')`);
  await set.run(`document.querySelector('dialog.sheet input').focus()`);
  await set.cdp("Input.insertText", { text: "brave-good-key" });
  await set.run(`document.querySelector('dialog.sheet button[type=submit]').click()`);
  await set.until("Brave first", `${order}[0] === 'Brave'`);
  await set.shot("5-keys-added");

  step("dragging a row changes the order, and the configuration");
  // Painted positions: wait for the rows to stop gliding from the last change of order.
  await sleep(400);
  const point = (el) => `(() => { const r = ${el}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`;
  const from = await set.run(point(`${row("Tavily")}.querySelector('.ws-grip')`));
  const to = await set.run(point(`${row("Brave")}.querySelector('.ws-grip')`));
  await set.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
  await set.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
  await set.until("the row lifted", `!!document.querySelector('.ws-row.dragging')`);
  // One big jump: a fast drag passes rows without stopping on them.
  await set.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: to.y - 12, button: "left", buttons: 1 });
  await set.until("it moved", `${order}[0] === 'Tavily'`);
  await set.shot("6-dragging");
  await set.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: from.x, y: to.y - 12, button: "left", buttons: 1, clickCount: 1 });
  await set.until("put down", `!document.querySelector('.ws-row.dragging')`);
  await set.until("written", `true`);
  for (let i = 0; i < 50 && !/order = \[\s*"tavily",\s*"brave"/.test(config()); i++) await sleep(100);
  check(/order = \[\s*"tavily",\s*"brave"/.test(config()), `the order in the file: ${config()}`);
  await set.until("the first row in use", `${currentRow} === 'Tavily'`);

  step("the keys move a row too, and the grip keeps the focus");
  await set.run(`${row("DeepSeek")}.querySelector('.ws-grip').focus()`);
  await set.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
  await set.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
  await set.until("moved down", `${order}.indexOf('DeepSeek') === 3`);
  check(await set.run(`document.activeElement === ${row("DeepSeek")}.querySelector('.ws-grip')`), "the grip lost the focus");

  step("a service's switch: searches skip it, and it stays in its place");
  await set.run(`${row("Tavily")}.querySelector('.sw').click()`);
  await set.until("off", `!${row("Tavily")}.querySelector('.sw.on') && ${currentRow} === 'Brave'`);
  for (let i = 0; i < 50 && !/disabled = \[\s*"tavily"/.test(config()); i++) await sleep(100);
  check(/disabled = \[\s*"tavily"/.test(config()), `disabled in the file: ${config()}`);
  check((await set.run(order))[0] === "Tavily", "switching it off moved it");
  await set.shot("7-switched-off");
  await set.run(`${row("Tavily")}.querySelector('.sw').click()`);
  await set.until("on again", `!!${row("Tavily")}.querySelector('.sw.on') && ${currentRow} === 'Tavily'`);

  step("the \"+\" menu has the master switch, and no service");
  await main.run(`document.querySelector('.side-nav .nav-i')?.click()`);
  await main.until("the composer again", `!!document.querySelector('.cmp-plus')`);
  await main.run(`document.querySelector('.cmp-plus').click()`);
  const quick = `[...document.querySelectorAll('.vmenu .cn-row.quick')].find(r => ${either((s) => s.composer.searchSwitch, session)}.includes(r.querySelector('.nm').textContent))`;
  await main.until("the switch", `${quick}?.getAttribute('aria-checked') === 'true' && !${quick}.hasAttribute('aria-disabled')`);
  const labels = await main.run(`[...document.querySelectorAll('.vmenu .cn-row.quick .nm')].map(n => n.textContent)`);
  check(!labels.some((l) => /Exa|Tavily|Brave|Parallel|DeepSeek|博查/.test(l)), `a service in the + menu: ${labels}`);
  await main.shot("8-plus-menu");
  await main.run(`document.querySelector('.cmp-plus').click()`);

  step("a search in the conversation: the words, then the pages and who answered");
  const write = async (text) => {
    await main.until("no task running", `${either((s) => [s.composer.reply, s.composer.placeholder], session)}.flat().includes(document.querySelector('.cmp-in')?.getAttribute('aria-placeholder')) || !document.querySelector('.cmp-stop, button.stop')`, 30000);
    await main.run(`document.querySelector('.cmp-in').focus()`);
    await main.cdp("Input.insertText", { text });
    await main.until("send enabled", `!document.querySelector('button.send')?.disabled`);
    await main.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await main.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  };
  const searchedAt = () => modelRequests.length;
  const before = searches.length;
  await write("search:贵州茅台 三季报|only=cninfo.com.cn,bjnews.com.cn");
  await main.until("the row", `${lastTool}?.querySelector('.sm2')?.textContent.includes('贵州茅台 三季报')`);
  await main.until("done", `${either((s) => s.steps.search.done, { zh: JSON.parse(fs.readFileSync(path.join(desktop, "src/locales/zh-CN/common.json"), "utf8")), en: JSON.parse(fs.readFileSync(path.join(desktop, "src/locales/en/common.json"), "utf8")) })}.includes(${lastTool}.querySelector('.vb').textContent)`);
  await main.until("the answer", `document.body.innerText.includes('查好了')`);
  const object = await main.run(`${lastTool}.querySelector('.sm2').textContent`);
  check(object.includes("cninfo.com.cn") && object.includes("bjnews.com.cn"), `the row should say the sites: ${object}`);
  check(searches.at(-1).service === "tavily" && searches.at(-1).key === "tavily-good-key", `who was asked: ${JSON.stringify(searches.slice(before))}`);
  await main.run(`${lastTool}.querySelector('.th').click()`);
  await main.until("the pages", `document.querySelectorAll('.ws-hit').length === 2`);
  const hits = await main.run(`[...document.querySelectorAll('.ws-hit')].map(h => [h.querySelector('.t').textContent, h.querySelector('.m').textContent, h.getAttribute('href')])`);
  check(hits[0][0].includes("贵州茅台") && hits[0][1] === "static.cninfo.com.cn · 2026-10-30", `first page: ${hits[0]}`);
  check(hits[1][1] === "bjnews.com.cn", `a page without a date: ${hits[1]}`);
  const foot = await main.run(`document.querySelector('.ws-foot').textContent`);
  check(foot.includes("Tavily") && foot.includes("2"), `the foot: ${foot}`);
  await main.shot("9-results");
  const text = modelRequests.at(-1).messages.at(-1).content;
  const said = typeof text === "string" ? text : text.map((c) => c.text ?? "").join("");
  check(said.startsWith("<search-results>") && !said.includes("example.org"), `what the model read: ${said}`);
  const system = modelRequests.at(-1).messages[0].content;
  check(JSON.stringify(system).includes("- web:"), "the catalog does not list the web group");

  step("the service fails: the next one answers, and both places say so");
  failing.tavily = 429;
  await write("search:第二次");
  await main.until("the row", `${lastTool}?.querySelector('.sm2')?.textContent.includes('第二次')`);
  await main.until("the answer", `document.querySelectorAll('.am').length >= 2 && !${lastTool}.querySelector('.shimmer')`);
  await main.run(`${lastTool}.querySelector('.th').click()`);
  await main.until("the foot", `${lastTool}.querySelector('.ws-foot')?.textContent.includes('Brave')`);
  const failedOver = await main.run(`${lastTool}.querySelector('.ws-foot').textContent`);
  check(failedOver.includes("Tavily") && failedOver.includes("Brave"), `the foot: ${failedOver}`);
  await main.shot("10-failover");
  check(JSON.stringify(modelRequests.at(-1).messages[0]) === JSON.stringify(modelRequests[searchedAt() - 3].messages[0]), "a failover changed the prompt");
  await set.run(`window.dispatchEvent(new Event('focus'))`);
  await set.until("the row says it", `!!${row("Tavily")}.querySelector('.fdesc.warn') && ${currentRow} === 'Brave'`);
  await set.shot("11-row-failed");

  step("every service fails: the row says why, and takes you to the settings");
  failing.brave = 429;
  await write("search:第三次");
  await main.until("the row failed", `${lastTool}?.querySelector('.sm2')?.textContent.includes('第三次') && ${either((s) => s.webSearch.failed, session)}.includes(${lastTool}.querySelector('.vb').textContent)`, 40000);
  check(await main.run(`${lastTool}.classList.contains('err')`), "the row is not marked failed");
  await main.run(`${lastTool}.querySelector('.th').click()`);
  await main.until("the reasons", `!!${lastTool}.querySelector('.ws-fail')`);
  const reasons = await main.run(`${lastTool}.querySelector('.ws-fail span').textContent`);
  check(["Tavily", "Brave", "Exa", "Parallel"].every((n) => reasons.includes(n)), `the reasons: ${reasons}`);
  await main.shot("12-failed");
  await set.run(`[...document.querySelectorAll('.side-nav .nav-i')][0].click()`);
  await set.until("another page", `!document.querySelector('.search-set')`);
  await main.run(`${lastTool}.querySelector('.ws-fail .btn').click()`);
  await set.until("the search page", `!!document.querySelector('.search-set')`);
  await set.until("the rows", `document.querySelectorAll('.ws-row').length === 6`);

  step("the prompt's catalog changes only with the master switch");
  const prompt = (i = -1) => JSON.stringify(modelRequests.at(i).messages[0]);
  const withWeb = prompt();
  await main.run(`document.querySelector('.cmp-plus').click()`);
  // Usable once the configuration is read.
  await main.until("the switch", `${quick}?.getAttribute('aria-checked') === 'true' && !${quick}.hasAttribute('aria-disabled')`);
  await main.run(`${quick}.click()`);
  await main.until("off", `${quick}?.getAttribute('aria-checked') === 'false'`);
  for (let i = 0; i < 50 && !searchTable().includes("enabled = false"); i++) await sleep(100);
  check(searchTable().includes("enabled = false"), `the master switch in the file: ${config()}`);
  await main.run(`document.querySelector('.cmp-plus').click()`);
  await set.until("the list dims", `!!document.querySelector('.search-set section.ws-dim')`);
  await set.shot("13-master-off");
  await write("没开搜索");
  await main.until("the answer", `document.body.innerText.includes('好的')`);
  check(JSON.stringify(modelRequests.at(-1).messages.at(-1)).includes("没开搜索"), "not the request asked about");
  check(!prompt().includes("- web:"), "the group is still in the catalog with the master switch off");
  await set.run(`document.querySelector('.search-set .frow .sw').click()`);
  await set.until("on", `!document.querySelector('.search-set section.ws-dim')`);
  for (let i = 0; i < 50 && !searchTable().includes("enabled = true"); i++) await sleep(100);
  await write("又开了");
  for (let i = 0; i < 100 && !JSON.stringify(modelRequests.at(-1).messages.at(-1)).includes("又开了"); i++) await sleep(100);
  check(prompt() === withWeb, "turning it back on did not restore the same prompt");

  step("all off: the call says so, and the model is told to point at the settings");
  for (const name of ["Tavily", "Brave", "Exa", "Parallel"]) {
    await set.run(`${row(name)}.querySelector('.sw').click()`);
    await sleep(150);
  }
  await set.until("the note", `!!document.querySelector('.ws-none')`);
  await set.shot("14-all-off");
  await write("search:都关了");
  await main.until("the row failed", `${lastTool}?.querySelector('.sm2')?.textContent.includes('都关了') && ${either((s) => s.webSearch.failed, session)}.includes(${lastTool}.querySelector('.vb').textContent)`, 30000);
  await main.run(`${lastTool}.querySelector('.th').click()`);
  await main.until("the words", `!!${lastTool}.querySelector('.ws-fail')`);
  const noService = JSON.stringify(modelRequests.at(-1).messages.at(-1).content);
  check(noService.includes("Settings › Web Search"), `what the model read: ${noService}`);
  for (const name of ["Tavily", "Brave", "Exa", "Parallel"]) {
    await set.run(`${row(name)}.querySelector('.sw').click()`);
    await sleep(150);
  }

  step("removing a key asks first; the row goes back to adding one");
  await set.run(`${row("Tavily")}.querySelector('.tb').click()`);
  await set.until("its menu", `!!document.querySelector('.vmenu .mi')`);
  await set.shot("15-row-menu");
  await set.run(`[...document.querySelectorAll('.vmenu .mi')].find(m => ${either((s) => s.search.removeKey)}.includes(m.textContent.trim())).click()`);
  await set.until("the question", `!!document.querySelector('dialog.sheet')`);
  check(credentials().includes("web-search.tavily"), "the key went before the answer");
  await set.run(`${button("document.querySelector('dialog.sheet')", each((s) => s.search.remove))}.click()`);
  await set.until("the row again", `!${row("Tavily")}.querySelector('.sw') && !!${button(row("Tavily"), each((s) => s.search.addKey))}`);
  check(!credentials().includes("web-search.tavily"), `the key is still kept: ${credentials()}`);

  step("the pages found are kept with the session: they come back after a reload");
  const logged = fs.readdirSync(path.join(home, "sessions"), { recursive: true }).filter((f) => String(f).endsWith(".jsonl")).map((f) => fs.readFileSync(path.join(home, "sessions", String(f)), "utf8")).join("");
  check(logged.includes('"source_name":"Tavily"') && logged.includes("static.cninfo.com.cn"), "the results are not in the session's log");
  await main.run(`location.reload()`);
  await main.until("the conversation again", `document.querySelectorAll('.tool').length >= 3`);
  await main.run(`[...document.querySelectorAll('.tool')].find(t => t.querySelector('.sm2')?.textContent.includes('贵州茅台')).querySelector('.th').click()`);
  await main.until("its pages", `document.querySelectorAll('.ws-hit').length === 2`);
  check((await main.run(`document.querySelector('.ws-foot').textContent`)).includes("Tavily"), "who answered is gone after a reload");

  step("both themes; the conversation with the settings window closed (it blurs the window under it)");
  const theme = (page, dark) => page.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  await theme(set, true);
  await set.shot("16-settings-dark");
  await theme(set, false);
  await set.shot("17-settings-light");
  // Not awaited: a window that closes first never answers.
  void set.run(`window.close()`).catch(() => {});
  await sleep(800);
  const showRow = (at) => main.run(`[...document.querySelectorAll('.tool')].filter(t => t.querySelector('.ws-res'))[${at}]?.scrollIntoView({ block: 'center' })`);
  await main.run(`[...document.querySelectorAll('.tool')].filter(t => !t.querySelector('.ws-res')).slice(0, 2).forEach(t => t.querySelector('.th').click())`);
  await main.run(`document.querySelector('.cmp-plus').click()`);
  await main.until("the switch", `!!${quick}`);
  await main.shot("18-plus-menu");
  await main.run(`document.querySelector('.cmp-plus').click()`);
  for (const dark of [true, false]) {
    await theme(main, dark);
    const name = dark ? "dark" : "light";
    await showRow(0);
    await main.shot(`19-results-${name}`);
    await showRow(1);
    await main.shot(`20-failover-${name}`);
    await showRow(2);
    await main.shot(`21-failed-${name}`);
  }

  console.log("\n✅ web search in the app works end to end");
} catch (e) {
  failed = true;
  console.error(`\n❌ ${e.stack ?? e}`);
  console.error(`work dir kept: ${work}`);
}
await quit();
server.close();
if (!failed) fs.rmSync(work, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
