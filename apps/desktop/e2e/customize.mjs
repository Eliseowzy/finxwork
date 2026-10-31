#!/usr/bin/env node
// The 自定义 page against the real finx (customize-design §15, CG1: one source of truth).
// The catalog is empty for now, so 发现 shows its empty state. A skill is added from the
// command line and must show up in 我的; in the app a custom connector with a locked secret is
// added. `finx exec` then uses both, and `finx mcp remove` deletes the connector, which the
// page must show within seconds while the keychain loses its secret.
//
// Runs the development build (electron-vite build) against the repository's
// target/debug/finx in a temporary FINX_HOME and profile, with finx-mock as the model and
// finx-mcp-server as the connector, so the person's own finxwork and finx are not touched.
// The window shows up while it runs.
//
//   node apps/desktop/e2e/customize.mjs
//   FINXWORK_E2E_SHOTS=<folder> node apps/desktop/e2e/customize.mjs   also screenshots, light and dark
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "../..");
const finx = path.join(root, "target/debug/finx");
const mockModel = path.join(root, "target/debug/finx-mock");
const mcpServer = path.join(root, "target/debug/finx-mcp-server");
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
const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxc-"));
const home = path.join(work, "finx");
const profile = path.join(work, "profile");
const userHome = path.join(work, "home");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(userHome, { recursive: true });
const env = { ...process.env, FINX_HOME: home, HOME: userHome, FINX_CREDENTIAL_STORE: "file", FINX_NO_BROWSER: "1" };
const credentials = () => (fs.existsSync(path.join(home, "credentials.toml")) ? fs.readFileSync(path.join(home, "credentials.toml"), "utf8") : "");

/** `finx <args>` as a person would type it, with the test's home. */
function cli(args) {
  return execFileSync(finx, args, { env, cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// ── the app, driven over the DevTools protocol (as e2e/stale-model.mjs) ──
let app = null;
async function launch() {
  const port = 9400 + Math.floor(Math.random() * 400);
  app = spawn(electron, [desktop, `--remote-debugging-port=${port}`], {
    env: { ...env, FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINXWORK_NO_BROWSER: "1" },
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
const type = (selector, index, value) =>
  `(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const set = Object.getOwnPropertyDescriptor(proto, "value").set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`;
const rows = `[...document.querySelectorAll(".cz-row .nm")].map((e) => e.textContent)`;
const toast = `document.querySelector(".toast")?.innerText ?? ""`;
const t = Object.fromEntries(["en", "zh-CN"].map((l) => [l, JSON.parse(fs.readFileSync(path.join(desktop, "src/locales", l, "customize.json"), "utf8"))]));
const words = (pick) => ["en", "zh-CN"].map((l) => pick(t[l]));
const anyText = (list) => `(${JSON.stringify(list)}).find((w) => document.body.innerText.includes(w))`;

let model = null;
let failed = false;
try {
  if (!process.env.FINXWORK_E2E_NO_BUILD) {
    step("building finx, its test servers and the app");
    sh("cargo", ["build", "-p", "finx-cli", "-p", "finx-mock"], { cwd: root });
    sh("pnpm", ["--dir", desktop, "build"]);
  }

  step("the model: finx-mock, scripted by the prompt");
  model = spawn(mockModel, [], { stdio: ["ignore", "pipe", "inherit"] });
  // It prints its base URL, then a models.toml that ends with the model's cost.
  const toml = await new Promise((resolve) => {
    let out = "";
    model.stdout.on("data", (c) => {
      out += c;
      if (/^cost = .*$/m.test(out)) resolve(out);
    });
  });
  fs.writeFileSync(path.join(home, "models.toml"), toml.replace(/^# .*\n/m, ""));
  fs.writeFileSync(path.join(home, "config.toml"), `model = "mock/mock-1"\npermission_mode = "manual"\n`);

  step("自定义 › 发现: empty for now");
  const page = await launch();
  await page.until("the sidebar", click(".nav-i", words((x) => x.title)[1]) + " || " + click(".nav-i", words((x) => x.title)[0]));
  await page.until("the empty catalog", `!!document.querySelector(".cz-empty") && !document.querySelector(".cz-card")`);
  await page.theme(false);
  await page.shot("1-discover-skills-light");
  await page.theme(true);
  await page.shot("1-discover-skills-dark");

  step("finx skills add, and 我的 follows");
  await page.run(`[...document.querySelectorAll(".cz-seg button")][0].click()`);
  const review = path.join(work, "code-review");
  fs.mkdirSync(review, { recursive: true });
  fs.writeFileSync(
    path.join(review, "SKILL.md"),
    "---\nname: code-review\ndescription: Review the current changes for correctness. Use when asked to review.\n---\n\n# Reviewing changes\n\nRead the diff, then report only what is worth changing.\n",
  );
  const added = Date.now();
  console.log("  " + cli(["skills", "add", review]).trim());
  await page.until("code-review in 我的", `${rows}.includes("code-review")`, 6000);
  console.log(`  the page followed in ${Date.now() - added} ms`);

  step("添加 › 添加连接器: a command, its variable locked, checked before it is written");
  const openAdd = async () => {
    await page.run(click(".cz-addbtn"));
    await page.until("the add menu", `!!document.querySelector(".cz-menu")`);
    await page.run(`[...document.querySelectorAll(".cz-menu .mi")].at(-1).click()`);
    await page.until("the first step", `!!document.querySelector("dialog[open] textarea")`);
  };
  const primary = `document.querySelector("dialog[open] .sheet-foot .btn.primary")`;
  await page.run(click(".cz-tab", words((x) => x.tab.connectors)[1]) + " || " + click(".cz-tab", words((x) => x.tab.connectors)[0]));
  await openAdd();
  await page.run(type("dialog[open] input", 0, "vault"));
  // A variable before the command: split off, and locked because its name looks secret.
  await page.run(type("dialog[open] textarea", 0, `API_KEY=sk-desk-1 ${mcpServer} --name vault --tools 2`));
  await page.theme(false);
  await page.shot("2-add-connector-light");
  await page.run(`${primary}.click()`);
  await page.until("the command's form", `document.querySelector("dialog[open] .cz-add-body")?.dataset.step === "local"`);
  check(await page.run(`document.querySelector("dialog[open] .cz-kvrow input[type=password]")?.value === "sk-desk-1"`), "the variable is not locked");
  await page.shot("2-add-local-light");
  await page.run(`${primary}.click()`);
  await page.until("added after its check", `document.querySelector("dialog[open] .cz-add-body")?.dataset.step === "done"`, 30000);
  check(await page.run(`document.querySelectorAll("dialog[open] .cz-toolchips span").length > 0`), "no tools shown");
  await page.run(`${primary}.click()`);
  await page.until("the sheet closed and the server listed", `!document.querySelector("dialog[open]") && ${rows}.includes("vault")`);
  console.log(`  toast: ${await page.run(toast)}`);
  const config = fs.readFileSync(path.join(home, "config.toml"), "utf8");
  check(config.includes("${credential:mcp.vault.API_KEY}") && !config.includes("sk-desk-1"), `the configuration:\n${config}`);
  check(credentials().includes("mcp.vault.API_KEY"), "the secret is not in the credential store");
  await page.until("vault ready", `!![...document.querySelectorAll(".cz-row")].find((r) => r.querySelector(".nm")?.textContent === "vault")?.querySelector(".cz-st.ok")`);
  // Its logo, declared in the handshake, is kept and shown (mcp-design §13.9).
  await page.until("vault's logo", `!![...document.querySelectorAll(".cz-row")].find((r) => r.querySelector(".nm")?.textContent === "vault")?.querySelector(".cz-tile.img img[src^='data:image/png']")`);
  // The same command under another name is the same service (§13.10): said at once, not added.
  await openAdd();
  await page.run(type("dialog[open] textarea", 0, `${mcpServer} --name vault --tools 2`));
  await page.until("the duplicate named", `document.querySelector("dialog[open] .cz-detect.bad")?.textContent.includes("vault")`);
  check(await page.run(`${primary}.disabled`), "a second vault could be connected");
  await page.run(`document.querySelector("dialog[open] .sheet-foot .btn:not(.primary)").click()`);
  await page.until("the sheet closed", `!document.querySelector("dialog[open]")`);
  await page.shot("3-mine-connectors-light");
  await page.theme(true);
  await page.shot("3-mine-connectors-dark");
  await page.run(`[...document.querySelectorAll(".cz-row")].find((r) => r.querySelector(".nm")?.textContent === "vault").click()`);
  await page.until("vault's page", `!!document.querySelector(".cz-hero")`);
  await page.shot("4-connector-page-dark");
  await page.theme(false);
  await page.shot("4-connector-page-light");
  await page.run(`document.querySelector(".cz-back").click()`);

  step("添加 › 添加连接器: an OAuth server, checked, signed in, then written");
  const oauthServer = spawn(mcpServer, ["--http", "127.0.0.1:0", "--oauth", "--name", "tracker"], { stdio: ["ignore", "pipe", "inherit"] });
  const trackerUrl = await new Promise((resolve) => oauthServer.stdout.once("data", (d) => resolve(String(d).trim().split("\n")[0])));
  try {
    await openAdd();
    await page.run(type("dialog[open] textarea", 0, trackerUrl));
    await page.run(type("dialog[open] input", 0, "tracker"));
    await page.run(`${primary}.click()`);
    await page.until("the check, then the settings", `document.querySelector("dialog[open] .cz-add-body")?.dataset.step === "remote"`, 30000);
    const picked = await page.run(`[...document.querySelectorAll("dialog[open] .cz-pop .lbl")].map((e) => e.textContent).join(" | ")`);
    check(/用账号登录/.test(picked), `OAuth is not chosen: ${picked}`);
    await page.shot("2-add-remote-dark");
    check(!fs.readFileSync(path.join(home, "config.toml"), "utf8").includes("tracker"), "written before signing in");
    await page.run(`${primary}.click()`);
    await page.until("waiting for the browser", `!!document.querySelector("dialog[open] [data-authorize]")`);
    const authorize = await page.run(`document.querySelector("dialog[open] [data-authorize]").dataset.authorize`);
    // The browser: the authorization server approves and sends it back to finx.
    const back = await fetch(authorize, { redirect: "follow" });
    check(back.ok && (await back.text()).includes("FinxWork"), `the sign-in page: ${back.status}`);
    await page.until("signed in and added", `document.querySelector("dialog[open] .cz-add-body")?.dataset.step === "done"`, 30000);
    await page.run(`${primary}.click()`);
    await page.until("tracker listed", `${rows}.includes("tracker")`);
    const written = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    check(/\[mcp_servers\.tracker\][^[]*auth = "oauth"/.test(written), `the configuration:\n${written}`);
    check(credentials().includes("mcp-oauth.tracker") && !written.includes("access_token"), "the token is not in the credential store");
    const used = cli(["exec", "--json", "[[mock:mcp_env:tracker:HOME]] read it"]).trim().split("\n").map((l) => JSON.parse(l));
    check(used.some((e) => e.type === "task_completed" && String(e.last_message).startsWith("mcp done")), "the session could not use the signed-in server");
    console.log("  signed in through the page; a session used it");

    // Signed out elsewhere: the connector's page offers to sign in again, and does (mcp-design §13.8).
    const trackerRow = `[...document.querySelectorAll(".cz-row")].find((r) => r.querySelector(".nm")?.textContent === "tracker")`;
    cli(["mcp", "logout", "tracker"]);
    await page.until("tracker needs a sign-in", `!!${trackerRow}?.querySelector(".cz-st.warn")`, 10000);
    await page.run(`${trackerRow}.click()`);
    await page.until("tracker's page offers to sign in", `!!document.querySelector(".cz-dsec .btn.primary")`);
    await page.run(`document.querySelector(".cz-dsec .btn.primary").click()`);
    await page.until("waiting for the browser", `!!document.querySelector("[data-authorize]")`);
    const again = await fetch(await page.run(`document.querySelector("[data-authorize]").dataset.authorize`), { redirect: "follow" });
    check(again.ok, `the second sign-in: ${again.status}`);
    await page.until("signed in again and connected", `!!document.querySelector(".cz-hero .cz-st.ok")`, 30000);
    await page.run(`document.querySelector(".cz-back").click()`);
    console.log("  signed out, then signed in again from the connector's page");
  } finally {
    oauthServer.kill();
  }

  step("finx exec uses what the page added");
  const exec = (prompt) =>
    cli(["exec", "--json", prompt])
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  const secret = exec("[[mock:mcp_env:vault:API_KEY]] read it");
  const secretReply = secret.find((e) => e.type === "task_completed")?.last_message ?? "";
  check(secretReply.includes("sk-desk-1"), `the connector's secret did not reach it: ${secretReply}`);
  const skill = exec("[[mock:skill:code-review]] review my changes");
  const read = skill.filter((e) => e.type === "tool_started" && JSON.stringify(e).includes("code-review/SKILL.md"));
  check(read.length > 0 && skill.some((e) => e.type === "task_completed"), "the skill was not followed");
  console.log("  the session read the skill and got the secret's value");

  step("finx mcp remove, and the page follows");
  await page.run(click(".cz-tab", words((x) => x.tab.connectors)[1]) + " || " + click(".cz-tab", words((x) => x.tab.connectors)[0]));
  await page.run(`[...document.querySelectorAll(".cz-seg button")][0].click()`);
  await page.until("vault in 我的", `${rows}.includes("vault")`);
  const removed = Date.now();
  console.log("  " + cli(["mcp", "remove", "vault"]).trim().split("\n").join("\n  "));
  await page.until("vault gone from the page", `!${rows}.includes("vault")`, 6000);
  console.log(`  the page followed in ${Date.now() - removed} ms`);
  check(!credentials().includes("mcp.vault.API_KEY"), "the secret is still in the credential store");

  step("the skill's page, and 我的");
  await page.run(click(".cz-tab", words((x) => x.tab.skills)[1]) + " || " + click(".cz-tab", words((x) => x.tab.skills)[0]));
  await page.until("code-review in 我的", `${rows}.includes("code-review")`);
  await page.shot("5-mine-skills-light");
  await page.theme(true);
  await page.shot("5-mine-skills-dark");
  await page.run(`[...document.querySelectorAll(".cz-row")].find((r) => r.querySelector(".nm")?.textContent === "code-review").click()`);
  await page.until("its page", `!!document.querySelector(".cz-hero")`);
  await page.run(`[...document.querySelectorAll(".cz-dtab")][1].click()`);
  await page.until("its SKILL.md", `document.querySelector(".cz-code")?.textContent.includes("Reviewing changes")`);
  await page.shot("6-skill-page-dark");
  page.close();
  console.log("\n✓ the page and the command line saw the same skills and connectors");
} catch (e) {
  failed = true;
  console.error(`\n✗ ${e.message}`);
} finally {
  await quit();
  model?.kill();
  // finx outlives the app; stop the test's own.
  try {
    execFileSync("pkill", ["-f", `${home}/run/finx.sock`]);
  } catch {
    // Already gone.
  }
  if (!failed) fs.rmSync(work, { recursive: true, force: true });
  else console.error(`  left for a look: ${work}`);
}
process.exit(failed ? 1 : 0);
