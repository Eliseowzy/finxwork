#!/usr/bin/env node
// Managed office connectors: discovery → install → cancel → retry → login → MCP call → logout.
// Uses real Electron/finx with an isolated CLI fixture; never authorizes a real account.
// Build first: cargo build -p finx-cli -p finx-mock && pnpm --filter @finx/desktop build
// Run once per provider: FINX_CONNECTOR_E2E=dingtalk|feishu|wecom node apps/desktop/e2e/dingtalk.mjs
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "../..");
const finx = path.join(root, "target/debug/finx");
const mockModel = path.join(root, "target/debug/finx-mock");
const electron = path.join(desktop, "node_modules/.bin/electron");
const shots = process.env.FINXWORK_E2E_SHOTS;
const step = (s) => console.log(`\n▶ ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => {
  throw new Error(message);
};
const check = (ok, message) => ok || fail(message);

// Short: the kernel's socket lives under it, and a socket path has at most 103 bytes.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxd-"));
const home = path.join(work, "finx");
const profile = path.join(work, "profile");
const userHome = path.join(work, "home");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(userHome, { recursive: true });
const env = { ...process.env, FINX_HOME: home, HOME: userHome, FINX_CREDENTIAL_STORE: "file", FINX_NO_BROWSER: "1" };

/** `finx <args>` as a person would type it, with the test's home. */
function cli(args) {
  return execFileSync(finx, args, { env, cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// ── the app, driven over the DevTools protocol (as e2e/stale-model.mjs) ──
let app = null;
async function launch() {
  const port = 9400 + Math.floor(Math.random() * 400);
  app = spawn(electron, [desktop, `--remote-debugging-port=${port}`], {
    env: { ...env, FINXWORK_DEFAULT_MODE: "sessions", FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINXWORK_NO_BROWSER: "1" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(200);
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => []);
    target = list.find((t) => t.type === "page" && !t.url.includes("#settings") && !t.url.startsWith("devtools"));
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
  return { cdp, run, until, shot, theme, close: page.close };
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
  await exited;
}

// Page helpers, as expressions run in the window.
const click = (selector, text) =>
  `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${text ? `e.textContent.includes(${JSON.stringify(text)})` : "true"}); if (!el) return false; el.click(); return true; })()`;
const t = Object.fromEntries(["en", "zh-CN"].map((l) => [l, JSON.parse(fs.readFileSync(path.join(desktop, "src/locales", l, "customize.json"), "utf8"))]));
const words = (pick) => ["en", "zh-CN"].map((l) => pick(t[l]));
const anyText = (list) => `(${JSON.stringify(list)}).find((w) => document.body.innerText.includes(w))`;

const provider = process.env.FINX_CONNECTOR_E2E || "dingtalk";
check(["dingtalk", "feishu", "wecom"].includes(provider), "unknown fixture provider");
const manifest = JSON.parse(fs.readFileSync(path.join(root, `crates/finx-core/src/connectors/${provider}.json`), "utf8"));
const release = path.join(home, `connectors/${provider}/releases`, manifest.version);
const configDir = path.join(home, `connectors/${provider}/config`);
const accountFile = provider === "wecom" ? "credentials.enc" : "account";
const partialGrant = provider === "feishu" && process.env.FINX_CONNECTOR_E2E_PARTIAL === "1";
fs.mkdirSync(release, { recursive: true });
const statusTrue = provider === "wecom" ? "authorized" : JSON.stringify({ [manifest.auth.status_field]: manifest.auth.status_value ?? true });
const statusFalse = provider === "wecom" ? "unauthorized" : JSON.stringify({ [manifest.auth.status_field]: provider === "feishu" ? "bot" : false });
const loginURL = `${manifest.auth.authorize_origin}${manifest.auth.authorize_path}?state=e2e-fixture`;
const loginOutput = provider === "feishu" ? JSON.stringify({ verification_uri: `${manifest.auth.authorize_origin}${manifest.auth.authorize_path}`, verification_uri_complete: loginURL }) : loginURL;
const fixture = `#!/bin/sh
D="$${manifest.config_env}"
case "$1 $2" in
 "config init")
   echo $$ > "$D/pid"
   echo 'https://open.feishu.cn/page/cli?user_code=setup'
   while ! test -f "$D/setup-finish"; do sleep 0.05; done
   echo '{}' > "$D/config.json" ;;
 "${manifest.auth.status.slice(0, 2).join(" ")}") if test -f "$D/${accountFile}"; then echo '${statusTrue}'; else echo '${statusFalse}'; fi ;;
 "${manifest.auth.login.slice(0, 2).join(" ")}")
   echo $$ > "$D/pid"
   echo '${loginOutput}'
   while ! test -f "$D/finish"; do sleep 0.05; done
   touch "$D/${accountFile}"
   ${partialGrant ? `echo '{"event":"authorization_complete","user_open_id":"fixture","missing":["example:scope"],"warning":{"type":"missing_scope"}}'; exit 3` : ""} ;;
 "auth logout") rm -f "$D/${accountFile}" ;;
 *) printf '%s\\n' "$@" ;;
esac
`;
fs.writeFileSync(path.join(release, "cli"), fixture, { mode: 0o700 });
fs.writeFileSync(path.join(release, "receipt.json"), JSON.stringify({ version: manifest.version, binary_sha256: createHash("sha256").update(fixture).digest("hex") }));
let model = null;
let page;
async function openComposerConnector() {
  await page.run(`document.querySelector('.side-nav .nav-i').click()`);
  await page.until("new conversation composer", `!!document.querySelector('.cmp-plus')`);
  await page.run(click(".cmp-plus"));
  await page.until("connectors submenu entry", click('.vmenu [aria-haspopup="menu"]', "连接器") + " || " + click('.vmenu [aria-haspopup="menu"]', "Connectors"));
  const row = `[...document.querySelectorAll('.cn-sub .cn-row')].find(e => e.querySelector('.nm')?.textContent === ${JSON.stringify(manifest.name)})`;
  await page.until("connector in composer", `!!(${row})`);
  return row;
}
try {
  model = spawn(mockModel, [], { stdio: ["ignore", "pipe", "inherit"] });
  const toml = await new Promise((resolve) => {
    let out = "";
    model.stdout.on("data", (c) => { out += c; if (/^cost = .*$/m.test(out)) resolve(out); });
  });
  fs.writeFileSync(path.join(home, "models.toml"), toml.replace(/^# .*\n/m, ""));
  fs.writeFileSync(path.join(home, "config.toml"), 'model = "mock/mock-1"\npermission_mode = "manual"\n');
  page = await launch();
  step(`discover ${manifest.name} and open managed install sheet`);
  await page.until("sidebar", click(".nav-i", words((x) => x.title)[1]) + " || " + click(".nav-i", words((x) => x.title)[0]));
  await page.run(click(".cz-tab", words((x) => x.tab.connectors)[1]) + " || " + click(".cz-tab", words((x) => x.tab.connectors)[0]));
  await page.until("provider catalog", `!![...document.querySelectorAll('.cz-card')].find(e => e.textContent.includes(${JSON.stringify(manifest.name)}))`);
  await page.run(`[...document.querySelectorAll('.cz-card')].find(e => e.textContent.includes(${JSON.stringify(manifest.name)})).click()`);
  await page.until("catalog detail", `!!document.querySelector('.cz-hero')`);
  await page.run(click(".cz-hero button", words((x) => x.connector.add)[1]) + " || " + click(".cz-hero button", words((x) => x.connector.add)[0]));
  await page.until("install sheet", `!!document.querySelector('dialog[open] .cz-managed')`);
  await page.until("official logo in install sheet", `!!document.querySelector('dialog[open] .cz-tile img')?.naturalWidth`);
  await page.shot(`${provider}-install`);
  const primary = `document.querySelector('dialog[open] .sheet-foot .primary')`;
  await page.run(`${primary}.click()`);
  await page.until("authorizing", anyText(words((x) => x.managed.steps.authorizing)));
  await page.until("authorization URL available", anyText(words((x) => x.managed.openBrowser)));
  check(fs.readFileSync(path.join(home, "config.toml"), "utf8").includes("enabled = false"), "connector enabled before authorization");
  let rejected = false;
  try { cli(["mcp", "enable", provider]); } catch { rejected = true; }
  check(rejected, "CLI bypassed authorization gate");
  if (provider === "feishu") {
    await page.until("application setup URL", `document.querySelector('dialog[open] [data-authorize]')?.dataset.authorize?.includes('/page/cli')`);
    fs.writeFileSync(path.join(configDir, "setup-finish"), "");
    await page.until("user consent URL after setup", `document.querySelector('dialog[open] [data-authorize]')?.dataset.authorize?.includes('/device/verify')`);
    check(fs.readFileSync(path.join(home, "config.toml"), "utf8").includes("enabled = false"), "application creation incorrectly enabled Feishu");
  }
  const firstPid = Number(fs.readFileSync(path.join(configDir, "pid"), "utf8"));
  await page.shot(`${provider}-authorizing`);
  step("cancel authorization and ensure the provider process exits");
  await page.run(`document.querySelector('dialog[open] .sheet-foot .btn').click()`);
  await page.until("sheet closed", `!document.querySelector('dialog[open]')`);
  for (let i = 0; i < 100; i++) {
    let alive = true;
    try { process.kill(firstPid, 0); } catch { alive = false; }
    if (!alive) break;
    await sleep(50);
    if (i === 99) fail("cancelled CLI is still alive");
  }
  check(!fs.existsSync(path.join(configDir, accountFile)), "cancelled flow created an account");
  step("installed connector shows sign-in; retry and complete fixture authorization");
  // Closing may leave the already installed entry selected in discovery. Open its detail.
  await page.run(click(".cz-back"));
  await page.run(`[...document.querySelectorAll('.cz-seg button')][0].click()`);
  await page.until("installed connector", `!![...document.querySelectorAll('.cz-row')].find(e => e.textContent.includes(${JSON.stringify(manifest.name)}))`);
  await page.run(`[...document.querySelectorAll('.cz-row')].find(e => e.textContent.includes(${JSON.stringify(manifest.name)})).click()`);
  check(await page.run(`document.querySelector('[role=switch]')?.getAttribute('aria-checked') === 'false' && document.querySelector('[role=switch]')?.disabled`), "cancelled authorization left the switch enabled");
  await page.until("login action", anyText(words((x) => x.connector.loginTitle)));
  step("composer shows sign-in for a disabled unauthorized connector");
  const unsignedRow = await openComposerConnector();
  check(await page.run(`(${unsignedRow}).querySelector('.cn-st')?.textContent === ${JSON.stringify(t['zh-CN'].menuNeed.login)} || (${unsignedRow}).querySelector('.cn-st')?.textContent === ${JSON.stringify(t.en.menuNeed.login)}`), "composer hid the sign-in requirement");
  await page.run(`(${unsignedRow}).click()`);
  await page.until("composer opens connector sign-in", `!!document.querySelector('.cz-dtitle') && !!document.querySelector('.cz-note button')`);
  check(fs.readFileSync(path.join(home, "config.toml"), "utf8").includes("enabled = false"), "composer enabled an unauthorized connector");
  // Exercise staged progress in the existing-connector login UI as well as the sheet.
  if (provider === "feishu") fs.unlinkSync(path.join(configDir, "config.json"));
  await page.run(click(".cz-note button", words((x) => x.connector.signIn)[1]) + " || " + click(".cz-note button", words((x) => x.connector.signIn)[0]));
  await page.until("retry is waiting", `!!document.querySelector('[data-authorize]')?.dataset.authorize`);
  if (provider === "feishu") {
    await page.until("details advances to user consent", `document.querySelector('[data-authorize]')?.dataset.authorize?.includes('/device/verify')`);
    check(fs.readFileSync(path.join(home, "config.toml"), "utf8").includes("enabled = false"), "progress notification prematurely enabled the connector");
  }
  if (provider === "feishu") {
    step("reload while awaiting consent, then resume the same provider process");
    const waitingPid = fs.readFileSync(path.join(configDir, "pid"), "utf8");
    await page.cdp("Page.reload");
    await page.until("sidebar after reload", click(".nav-i", words((x) => x.title)[1]) + " || " + click(".nav-i", words((x) => x.title)[0]));
    await page.run(click(".cz-tab", words((x) => x.tab.connectors)[1]) + " || " + click(".cz-tab", words((x) => x.tab.connectors)[0]));
    await page.run(click(".cz-back"));
    await page.run(`[...document.querySelectorAll('.cz-seg button')][0]?.click()`);
    await page.until("installed connector after reload", `!![...document.querySelectorAll('.cz-row')].find(e => e.textContent.includes(${JSON.stringify(manifest.name)}))`);
    await page.run(`[...document.querySelectorAll('.cz-row')].find(e => e.textContent.includes(${JSON.stringify(manifest.name)})).click()`);
    await page.until("resume action", anyText(words((x) => x.connector.loginTitle)));
    await page.run(click(".cz-note button", words((x) => x.connector.signIn)[1]) + " || " + click(".cz-note button", words((x) => x.connector.signIn)[0]));
    await page.until("resumed consent URL", `document.querySelector('[data-authorize]')?.dataset.authorize?.includes('/device/verify')`);
    check(fs.readFileSync(path.join(configDir, "pid"), "utf8") === waitingPid, "reload started a duplicate provider process");
  }
  fs.writeFileSync(path.join(configDir, "finish"), "");
  await page.until("account connected", anyText(words((x) => x.connector.signedIn)), 30000);
  await page.until("tools listed", `document.querySelectorAll('.cz-dtools .cz-tool').length === 1`);
  await page.until("authorized connector enabled", `document.querySelector('[role=switch]')?.getAttribute('aria-checked') === 'true' && !document.querySelector('[role=switch]')?.disabled`);
  if (partialGrant) await page.until("partial permission notice", anyText(words((x) => x.managed.partialPermissions)));
  step("composer toggles an authorized connector without a project");
  const enabledRow = await openComposerConnector();
  await page.run(`(${enabledRow}).click()`);
  await page.until("composer disabled", `(${enabledRow})?.getAttribute('aria-checked') === 'false'`);
  await page.until("disabled state saved", `!document.body.innerText.includes('invalid params:')`);
  // Wait for the persisted result, not only the optimistic switch.
  for (let i = 0; !fs.readFileSync(path.join(home, "config.toml"), "utf8").includes("enabled = false"); i++) {
    if (i === 100) fail("composer did not persist disabled state");
    await sleep(50);
  }
  await sleep(300);
  await page.run(`(${enabledRow}).click()`);
  for (let i = 0; fs.readFileSync(path.join(home, "config.toml"), "utf8").includes("enabled = false"); i++) {
    if (i === 100) fail("composer could not re-enable without a project");
    await sleep(50);
  }
  await page.until("composer enabled", `(${enabledRow})?.getAttribute('aria-checked') === 'true'`);
  await page.run(click('.cn-sub .mi', "管理连接器") + " || " + click('.cn-sub .mi', "Manage connectors"));
  await page.until("connector list", `!!document.querySelector('.cz-row')`);
  await page.run(`[...document.querySelectorAll('.cz-row')].find(e => e.textContent.includes(${JSON.stringify(manifest.name)})).click()`);
  await page.until("connector detail restored", `!!document.querySelector('.cz-dtitle')`);
  await page.shot(`${provider}-connected`);
  const configured = fs.readFileSync(path.join(home, "config.toml"), "utf8");
  check(configured.includes(`connector = "${provider}"`), "managed identity did not persist");
  check(!/access_token|refresh_token|client_secret/.test(configured), "credentials leaked into config");
  step("real stdio adapter executes a tool without a shell");
  const calls = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run", arguments: { args: ["doc", "search", "$(echo literal)"] } } },
  ].map(x => JSON.stringify(x) + "\n").join("");
  const result = execFileSync(finx, ["connector", "serve", provider, "--home", home], { env, input: calls, encoding: "utf8", timeout: 30000 });
  const tool = result.trim().split("\n").map(x => JSON.parse(x)).find(x => x.id === 2);
  check(tool.result.content[0].text.includes("$(echo literal)"), "CLI arguments were not preserved literally");
  check(!tool.result.isError, "tool returned an error");
  step("logout clears provider credentials and shows sign-in again");
  await page.run(click(".cz-dacts .cz-more"));
  await page.until("menu", `!!document.querySelector('.cz-menu')`);
  await page.run(click(".cz-menu .mi", words((x) => x.connector.signOut)[1]) + " || " + click(".cz-menu .mi", words((x) => x.connector.signOut)[0]));
  await page.until("signed out", anyText(words((x) => x.connector.signedOut)));
  check(!fs.existsSync(path.join(configDir, accountFile)), "logout retained credentials");
  check(await page.run(`document.querySelector('[role=switch]')?.getAttribute('aria-checked') === 'false' && document.querySelector('[role=switch]')?.disabled`), "logout did not disable the connector");
  step("reinstall resumes through the sheet, including an immediate authorization callback");
  await page.run(click(".cz-dacts .cz-more"));
  await page.until("menu", `!!document.querySelector('.cz-menu')`);
  await page.run(click(".cz-menu .mi", words((x) => x.managed.reinstall)[1]) + " || " + click(".cz-menu .mi", words((x) => x.managed.reinstall)[0]));
  await page.until("reinstall sheet", `!!document.querySelector('dialog[open] .cz-managed')`);
  await page.run(`${primary}.click()`);
  await page.until("sheet ready", anyText(words((x) => x.managed.steps.ready)));
  if (partialGrant) await page.until("partial permission notice in sheet", anyText(words((x) => x.managed.partialPermissions)));
  await page.shot(`${provider}-ready`);
  await page.run(`${primary}.click()`);
  await page.until("sheet closed", `!document.querySelector('dialog[open]')`);
  step("CLI login/logout share the account, and removing from the page clears it");
  cli(["mcp", "logout", provider]);
  check(!fs.existsSync(path.join(configDir, accountFile)), "CLI logout retained credentials");
  cli(["mcp", "login", provider]);
  check(fs.existsSync(path.join(configDir, accountFile)), "CLI login did not use the managed account");
  await page.run(click(".cz-dacts .cz-more"));
  await page.until("menu", `!!document.querySelector('.cz-menu')`);
  await page.run(click(".cz-menu .mi", words((x) => x.connector.removeConnector)[1]) + " || " + click(".cz-menu .mi", words((x) => x.connector.removeConnector)[0]));
  for (let i = 0; i < 100; i++) {
    if (!fs.readFileSync(path.join(home, "config.toml"), "utf8").includes(`[mcp_servers.${provider}]`)) break;
    await sleep(100);
    if (i === 99) fail("removal never committed");
  }
  check(!fs.existsSync(path.join(configDir, accountFile)), "removing the connector retained credentials");
  console.log(`${provider}: PASS: discovery, install, cancellation, retry, authorization, MCP invocation logout, immediate callback, CLI parity and removal`);
} catch (e) {
  if (page) console.error("PAGE:", await page.run("document.body.innerText").catch(() => "unavailable"));
  console.error(e);
  process.exitCode = 1;
} finally {
  page?.close();
  await quit();
  model?.kill("SIGTERM");
  // Retain on failure for diagnosis; all accounts and data are local test fixtures.
  if (!process.exitCode) fs.rmSync(work, { recursive: true, force: true });
  else console.error(`Test files: ${work}`);
}
