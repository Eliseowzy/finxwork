#!/usr/bin/env node
// Verify Settings › Browser shows each site's icon (browser-design §10.1) and connects the user's own browser (browser-design §8.4,
// connectors-entry-design §6.1): the row says it is not connected; Connect registers finx and
// puts the extension in its folder; once the extension (in a real Chrome, loaded from that
// folder) connects, the guide turns it on (`browser.extension`) and the row says so; the
// composer's + › Connectors switches it too, and Settings follows at once; Stop Using turns it
// off; the built-in browser has its own switch (`browser.enabled`). Everything stays in a
// private HOME, so the developer's own Chrome is never touched. Needs `pnpm build`, `cargo
// build -p finx-cli` and Google Chrome.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "../..");
const finx = path.join(root, "target/debug/finx");
const chromeExe = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const electron = createRequire(import.meta.url)("electron");
const shots = process.env.FINXWORK_E2E_SHOTS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => {
  throw new Error(message);
};
const check = (ok, message) => ok || fail(message);
if (!fs.existsSync(chromeExe)) {
  console.log("no Google Chrome; skipping");
  process.exit(0);
}

// Short: the kernel's socket lives under it, and a socket path has at most 103 bytes.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxs-"));
const home = path.join(work, "finx");
const profile = path.join(work, "profile");
const userHome = path.join(work, "home");
// Chrome's own data folder in the private HOME: where the app registers the host.
const chromeData = path.join(userHome, "Library/Application Support/Google/Chrome");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(chromeData, { recursive: true });
const env = { ...process.env, FINX_HOME: home, HOME: userHome, FINX_CREDENTIAL_STORE: "file", FINX_NO_BROWSER: "1" };
// Two sites already allowed: one on the internet, whose icon the page shows, and a local one.
fs.writeFileSync(
  path.join(home, "config.toml"),
  `permission_mode = "manual"\n[models]\nnetwork = false\n[browser]\n[browser.sites]\n"https://github.com" = "act"\n"http://localhost:3000" = "navigate"\n`,
);

// ── the app, driven over the DevTools protocol ──
let app = null;
let chrome = null;
const port = 9400 + Math.floor(Math.random() * 400);

async function targets() {
  return fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => []);
}

async function attach(match, what) {
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(200);
    target = (await targets()).find(match);
  }
  check(target, `${what} never showed up`);
  const page = await devtools(target.webSocketDebuggerUrl);
  const cdp = page.call;
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
      if (Date.now() > end) fail(`timed out waiting for ${label}: ${await run("document.body.innerText.slice(0, 600)")}`);
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

/** A Chrome on the private profile, loading the extension from `folder` over its pipe. */
async function chromeWithExtension(folder) {
  chrome = spawn(
    chromeExe,
    [
      "--remote-debugging-pipe",
      "--enable-unsafe-extension-debugging",
      `--user-data-dir=${chromeData}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--use-mock-keychain",
      "--password-store=basic",
      "about:blank",
    ],
    { env, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  const [input, output] = [chrome.stdio[3], chrome.stdio[4]];
  let buffer = "";
  const answers = new Map();
  output.on("data", (chunk) => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf("\0")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      answers.get(message.id)?.(message);
    }
  });
  const answer = new Promise((r) => answers.set(1, r));
  input.write(JSON.stringify({ id: 1, method: "Extensions.loadUnpacked", params: { path: folder } }) + "\0");
  const loaded = await answer;
  check(loaded.result?.id === "fgaadfmkicjchgjlomjemofnllanlcoo", `the extension did not load: ${JSON.stringify(loaded)}`);
}

async function quit() {
  chrome?.kill("SIGKILL");
  if (!app || app.exitCode !== null) return;
  const exited = new Promise((r) => app.once("exit", r));
  app.kill("SIGTERM");
  const timeout = setTimeout(() => app.kill("SIGKILL"), 3000);
  await exited;
  clearTimeout(timeout);
}

const config = () => fs.readFileSync(path.join(home, "config.toml"), "utf8");
/** A button by its label in either language. */
const button = (...labels) => `[...document.querySelectorAll('button')].find(b => ${JSON.stringify(labels)}.includes(b.textContent.trim()))`;
const shows = (...texts) => `${JSON.stringify(texts)}.some(t => document.body.innerText.includes(t))`;
const badge = (...texts) => `${JSON.stringify(texts)}.includes(document.querySelector('.browser-set .mrow .badge')?.textContent)`;
/** A row of the open menus by its text in either language. */
const menuRow = (selector, ...texts) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find(r => ${JSON.stringify(texts)}.some(t => r.textContent.includes(t)))`;
/** The + menu's browser switch, and Settings' first row. */
const quick = menuRow(".vmenu .cn-row.quick", "浏览器", "Browser");
const control = `document.querySelector('.browser-set [role=switch]')`;

let failed = false;
try {
  app = spawn(electron, [desktop, `--remote-debugging-port=${port}`], {
    env: { ...env, FINXWORK_DEFAULT_MODE: "sessions", FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINXWORK_NO_BROWSER: "1" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const main = await attach((t) => t.type === "page" && /^(app:|file:|http:)/.test(t.url) && !t.url.includes("#settings"), "the main window");
  await main.until("app loaded", `!!document.querySelector("button")`);
  await main.run(`window.finx.openSettings("browser")`);
  const set = await attach((t) => t.type === "page" && t.url.includes("#settings"), "the settings window");
  await set.cdp("Emulation.setDeviceMetricsOverride", { width: 760, height: 560, deviceScaleFactor: 0, mobile: false });

  // Not connected yet: the row offers Connect, and the built-in browser is the only default.
  await set.until("the browser page", `!!document.querySelector('.browser-set .yours-row') && !!(${button("连接", "Connect")})`);
  check(await set.run(shows("连接你的浏览器", "Connect Your Browser")), "the row does not offer to connect");
  check((await set.run(`document.querySelector('.default-browser select').options.length`)) === 1, "a default other than the built-in browser before connecting");
  // Each site's icon, asked of finx as the rows show and kept in the finx home: GitHub's own,
  // the globe for the local page, which has no site to ask.
  const siteRow = (text) => `[...document.querySelectorAll('.browser-set .site-row')].find(r => r.textContent.includes(${JSON.stringify(text)}))`;
  await set.until("GitHub's icon", `!!${siteRow("github.com")}?.querySelector('.site-icon img')?.naturalWidth`, 30000);
  check(await set.run(`!${siteRow("localhost:3000")}.querySelector('.site-icon img')`), "the local page has an icon");
  check(fs.readdirSync(path.join(home, "browser/icons")).length === 1, "the icon is not kept");
  await set.shot("1-not-connected");

  // Connect: the app registers finx and copies the extension, then asks the user to add it.
  await set.run(`(${button("连接", "Connect")}).click()`);
  // With more than one browser here, the guide first asks which: Chrome.
  await set.until("the guide", `!!document.querySelector('.bg-pick') || ${shows("开发者模式", "Developer mode")}`, 30000);
  if (await set.run(`!!document.querySelector('.bg-pick')`)) {
    await set.run(`[...document.querySelectorAll('.bg-pick [role=radio]')].find(b => b.textContent.includes("Google Chrome")).click()`);
    await set.run(`(${button("继续", "Continue")}).click()`);
  }
  await set.until("the install step", shows("开发者模式", "Developer mode"), 30000);
  await set.shot("2-add-extension");
  const manifest = JSON.parse(fs.readFileSync(path.join(chromeData, "NativeMessagingHosts/com.finxwork.browser.json"), "utf8"));
  check(manifest.allowed_origins[0] === "chrome-extension://fgaadfmkicjchgjlomjemofnllanlcoo/", "the host manifest names another extension");
  const folder = path.join(home, "browser/FinxWork Extension");
  check(fs.existsSync(path.join(folder, "manifest.json")) && !fs.existsSync(path.join(folder, "src/browser.test.js")), "the extension folder is not ready");

  // The user adds it (here: Chrome loads it from that folder) and says so; the guide waits for it.
  await set.run(`(${button("已添加", "I've Added It")}).click()`);
  await set.until("waiting", shows("正在等待", "Waiting for"));
  await set.shot("3-waiting");
  await chromeWithExtension(folder);
  await set.until("connected", shows("已连接 Google Chrome", "Connected to Google Chrome"), 30000);
  await set.shot("4-connected");
  check(/\[browser\][\s\S]*extension = true/.test(config()) && !/backend/.test(config()), `not turned on: ${config()}`);

  // Done: the row says which browser, in use.
  await set.run(`(${button("完成", "Done")}).click()`);
  await set.until("in use", badge("使用中", "In use"));
  const name = await set.run(`document.querySelector('.browser-set .mrow .fn').textContent`);
  check(/Chrome \d+/.test(name), `the row does not name the browser: ${name}`);
  // Connected: it can be the default browser, written as `browser.default`.
  const choice = `document.querySelector('.default-browser select')`;
  await set.until("a second default", `${choice}.options.length === 2`);
  await set.run(`(() => { const s = ${choice}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, "yours"); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  for (let i = 0; i < 50 && !/default = "yours"/.test(config()); i++) await sleep(100);
  check(/\[browser\][^[]*default = "yours"/.test(config()), `the default was not written: ${config()}`);
  await set.shot("5-in-use");

  // The composer's + menu has the same switch as Settings' first row: browser control. Off from
  // the menu, written, and Settings shows it at once; on again.
  await main.until("onboarding left", `(() => { const skip = [...document.querySelectorAll("button")].find(b => /稍后|later|skip/i.test(b.textContent)); if (skip) { skip.click(); return false; } return !!document.querySelector(".cmp-plus"); })()`);
  await main.run(`document.querySelector('.cmp-plus').click()`);
  await main.until("the + menu", `${quick}?.getAttribute('aria-checked') === 'true' && !${quick}.hasAttribute('aria-disabled')`);
  await main.shot("6-plus-menu");
  await main.run(`${quick}.click()`);
  await main.until("off in the menu", `${quick}?.getAttribute('aria-checked') === 'false'`);
  await set.until("off in Settings", `${control}.getAttribute('aria-checked') === 'false'`);
  check(/\[browser\][^[]*enabled = false/.test(config()), `not turned off from the menu: ${config()}`);
  await main.run(`${quick}.click()`);
  await main.until("on in the menu", `${quick}?.getAttribute('aria-checked') === 'true'`);
  await set.until("on in Settings", `${control}.getAttribute('aria-checked') === 'true'`);
  await main.run(`document.querySelector('.cmp-plus').click()`);

  // Disconnect: back to the built-in browser, the extension still there.
  await set.run(`(${button("断开", "Disconnect")}).click()`);
  await set.until("stopped", badge("已连接", "Connected"));
  check(/\[browser\][\s\S]*extension = false/.test(config()), `not turned off: ${config()}`);
  await set.shot("7-stopped");

  // Chrome goes away: the row offers to connect again.
  chrome.kill("SIGKILL");
  await set.until("lost", shows("连接你的浏览器", "Connect Your Browser"), 20000);

  // Browser control: on by default; off, written, and the default browser goes with it.
  check((await set.run(`${control}.getAttribute('aria-checked')`)) === "true", "browser control is off by default");
  await set.run(`${control}.click()`);
  await set.until("browser control off", `${control}.getAttribute('aria-checked') === 'false' && document.querySelector('.default-browser select').disabled`);
  check(/\[browser\][^[]*enabled = false/.test(config()), `browser control not turned off: ${config()}`);
  await set.run(`${control}.click()`);
  await set.until("browser control on", `${control}.getAttribute('aria-checked') === 'true'`);

  // The built-in browser's address bar searches with Google, or the engine picked here.
  const select = `document.querySelector('.search-engine select')`;
  check((await set.run(`${select}.value`)) === "google", "the address bar does not search with Google by default");
  // The home page's browser button opens the panel, a blank tab in it.
  await main.run(`document.querySelector('.ctool button[aria-pressed]').click()`);
  await main.until("the panel", `!!document.querySelector('.brp-url')`);
  const tab = async () => (await main.run(`window.finx.browserTabs()`))[0];
  await main.until("a tab", `window.finx.browserTabs().then(t => t.length === 1)`);
  await main.run(`window.finx.browserTabCommand(${JSON.stringify((await tab()).targetId)}, { command: "go", url: "finx work" })`);
  await main.until("a Google search", `window.finx.browserTabs().then(t => t[0].url.startsWith("https://www.google.com/search?q=finx%20work"))`, 20000);
  // The tab shows the site's icon once the page is loaded.
  await main.until("the tab's icon", `!!document.querySelector('.brp-tab.on .brp-tab-ic img')?.naturalWidth`, 30000);
  await main.shot("8-tab-icon");
  await set.run(`(() => { const s = ${select}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, "baidu"); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await set.until("Baidu saved", `window.finx.getPreferences().then(p => p.searchEngine === "baidu")`);
  await set.shot("8-built-in");
  await main.run(`window.finx.browserTabCommand(${JSON.stringify((await tab()).targetId)}, { command: "go", url: "天气" })`);
  // Baidu may send an embedded browser to its captcha first, with the search as the way back.
  await main.until("a Baidu search", `window.finx.browserTabs().then(t => [t[0].url, decodeURIComponent(t[0].url)].some(u => u.includes("www.baidu.com/s?wd=%E5%A4%A9%E6%B0%94")))`, 20000);

  // Words that look like a file or a version are searched for, not opened.
  await main.run(`window.finx.browserTabCommand(${JSON.stringify((await tab()).targetId)}, { command: "go", url: "readme.txt" })`);
  await main.until("readme.txt searched", `window.finx.browserTabs().then(t => [t[0].url, decodeURIComponent(t[0].url)].some(u => u.includes("wd=readme.txt")))`, 20000);

  // The person adds an engine of their own, in the shortcuts' dialog: name, keyword, URL with %s.
  await set.run(`(${button("管理…", "Manage…")}).click()`);
  await set.until("the shortcuts", `!!document.querySelector('.engines-sheet')`);
  // Each engine shows its site's icon, as the site permissions do: Google's own.
  await set.until("Google's icon", `[...document.querySelectorAll('.engines-sheet .engine-row')].some(r => r.textContent.includes("Google") && r.querySelector('img.engine-icon')?.naturalWidth)`, 30000);
  await set.run(`(${button("添加搜索引擎", "Add Search Engine")}).click()`);
  const typeInto = async (index, text) => {
    await set.run(`document.querySelectorAll('.engine-add input')[${index}].focus()`);
    await set.cdp("Input.insertText", { text });
  };
  await set.run(`(${button("添加", "Add")}).click()`);
  await set.until("the name is asked for", `!!document.querySelector('.engine-add .mrow-err')`);
  await typeInto(0, "Wiki");
  await typeInto(1, "baidu.com");
  await set.run(`(${button("添加", "Add")}).click()`);
  await set.until("a taken keyword is refused", shows("已经有搜索引擎在用", "Another search engine uses"));
  await set.run(`(() => { const i = document.querySelectorAll('.engine-add input')[1]; i.select(); })()`);
  await set.cdp("Input.insertText", { text: "wk" });
  await typeInto(2, "http://127.0.0.1:9/search?q=%s");
  await set.run(`(${button("添加", "Add")}).click()`);
  await set.until("the engine saved", `window.finx.getPreferences().then(p => p.searchEngines.length === 1 && p.searchEngines[0].keyword === "wk" && p.searchEngines[0].url === "http://127.0.0.1:9/search?q={searchTerms}")`);
  check(await set.run(shows("wk")), "the list does not show the new keyword");
  await set.shot("9-engines");

  // "keyword words" in one go, with the person's own engine.
  await main.run(`window.finx.browserTabCommand(${JSON.stringify((await tab()).targetId)}, { command: "go", url: "wk 北京" })`);
  await main.until("the custom engine", `window.finx.browserTabs().then(t => t[0].url.startsWith("http://127.0.0.1:9/search?q=%E5%8C%97%E4%BA%AC"))`, 20000);

  // Removing it: the list and the keyword are gone.
  await set.run(`[...document.querySelectorAll('.engine-row')].find(r => r.textContent.includes('Wiki')).querySelector('button').click()`);
  await set.until("the engine removed", `window.finx.getPreferences().then(p => p.searchEngines.length === 0)`);
  // Settings closes: the main window is no longer dimmed behind it.
  await set.run(`window.close()`);
  await sleep(600);
  // Keyword mode, typed as a person does: the keyword, Tab, the words, Return.
  const key = async (k, code, text) => {
    await main.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: { Tab: 9, Enter: 13 }[k] ?? 0, ...(text && { text }) });
    await main.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k, code });
  };
  await main.run(`document.querySelector('.brp-url').focus()`);
  await main.cdp("Input.insertText", { text: "duck" });
  await main.until("the Tab hint", `document.querySelector('.brp-hint')?.textContent.includes('DuckDuckGo')`);
  await main.shot("10-hint");
  await key("Tab", "Tab");
  await main.until("keyword mode", `document.querySelector('.brp-keyword')?.textContent.includes('DuckDuckGo')`);
  await main.shot("11-keyword");
  await main.cdp("Input.insertText", { text: "example.com" });
  await key("Enter", "Enter", "\r");
  await main.until("a DuckDuckGo search", `window.finx.browserTabs().then(t => t[0].url.startsWith("https://duckduckgo.com/?q=example.com"))`, 20000);
  console.log("system browser: ok");
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await quit();
  fs.rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
