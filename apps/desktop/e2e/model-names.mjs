#!/usr/bin/env node
// A model's name follows the app's language: a QwenWork connection whose catalog names its models
// by language, seen in the model menu in Chinese and in English. The menu shows the name of the
// app's language, a model without one keeps its own, and the choice stays the model's id.
//
// Runs the development build against the repository's target/debug/finx in a temporary FINX_HOME
// and profile, so the person's own finxwork, its settings and their finx are not touched.
//
//   node apps/desktop/e2e/run.mjs model-names
//   FINXWORK_E2E_SHOTS=<folder> node apps/desktop/e2e/model-names.mjs   also screenshots
import { cdpPort } from "./lib/port.mjs";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "../..");
const finx = path.join(root, "target/debug/finx");
const electron = path.join(desktop, "node_modules/.bin/electron");
const shots = process.env.FINXWORK_E2E_SHOTS;
const step = (s) => console.log(`\n▶ ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => {
  throw new Error(message);
};
const check = (ok, message) => ok || fail(message);

// Short: the kernel's socket lives under it, and a socket path has at most 103 bytes.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxn-"));
const home = path.join(work, "finx");
fs.mkdirSync(path.join(work, "home"), { recursive: true });
const profile = path.join(work, "profile");
fs.mkdirSync(profile, { recursive: true });
const socket = path.join(home, "run/finx.sock");
const connection = "35e57942-0000-4000-8000-00000000e2e1";

// As the real catalog has them on 2026-11-06, and a model named in one language only.
const model = (id, name, names) => ({ id, name, names, context_window: 1000000, max_output_tokens: null });
fs.mkdirSync(path.join(home, "connections"), { recursive: true });
fs.writeFileSync(
  path.join(home, "models.toml"),
  `[providers.mock]\nname = "Mock"\napi = "openai-chat"\nbase_url = "http://127.0.0.1:9/v1"\nauth = "none"\n\n[[providers.mock.models]]\nid = "mock-1"\nname = "Mock One"\ncontext_window = 128000\nmax_output_tokens = 4096\n`,
);
fs.writeFileSync(path.join(home, "config.toml"), `model = "mock/mock-1"\n[models]\nnetwork = false\n`);
fs.writeFileSync(
  path.join(home, "connections/config.json"),
  JSON.stringify({
    schema: 1,
    connections: [{
      connection_id: connection, adapter_id: "qwenwork", identity_key: "e2e", enabled: true, idempotency_key: "e2e",
      models: [
        model("mode-5d41402a", "标准", { en: "Standard", zh: "标准" }),
        model("mode-7d793037", "高级", { en: "Pro", zh: "高级" }),
        model("mode-1f3870be", "千问专属", { zh: "千问专属" }),
        model("qwen3.8-max-preview", "Qwen3.8-Max", { en: "Qwen3.8-Max", zh: "Qwen3.8-Max" }),
      ],
    }],
  }),
);

function finxCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(socket);
    let buf = "";
    const send = (id, m, p) => s.write(JSON.stringify({ jsonrpc: "2.0", id, method: m, params: p }) + "\n");
    s.on("connect", () => send(1, "initialize", { protocol_version: 2, client_info: { name: "e2e" } }));
    s.on("data", (c) => {
      buf += c;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (msg.id === 1) send(2, method, params);
        if (msg.id === 2) {
          s.end();
          resolve(msg);
        }
      }
    });
    s.on("error", reject);
    s.on("close", () => reject(new Error("the kernel closed the connection")));
  });
}

let app = null;
async function launch(language) {
  fs.writeFileSync(path.join(profile, "preferences.json"), JSON.stringify({ language }));
  const port = cdpPort();
  app = spawn(electron, [desktop, `--remote-debugging-port=${port}`], {
    env: { ...process.env, FINX_HOME: home, HOME: path.join(work, "home"), FINXWORK_DEFAULT_MODE: "sessions", FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINX_CREDENTIAL_STORE: "file" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(200);
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => []);
    target = list.find((t) => t.type === "page" && !t.url.includes("#settings") && !t.url.startsWith("devtools"));
  }
  check(target, "the main window never showed up");
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
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, "base64"));
  };
  return { run, until, shot, close: () => ws.close() };
}

async function quit() {
  if (!app || app.exitCode !== null) return;
  const exited = new Promise((r) => app.once("exit", r));
  app.kill("SIGTERM");
  await exited;
}

const modelTitles = ["en", "zh-CN"].map((l) => JSON.parse(fs.readFileSync(path.join(desktop, "src/locales", l, "session.json"), "utf8")).composer.model);
const picker = `[...document.querySelectorAll("button.mb")].find((b) => ${JSON.stringify(modelTitles)}.includes(b.title))`;
const pickerLabel = `(${picker})?.querySelector(".lbl")?.textContent ?? ""`;
const row = (name) => `[...document.querySelectorAll("button.mi")].find((b) => b.textContent.startsWith(${JSON.stringify(name)}))`;

/** Opens the menu in this language and checks what it calls each model. */
async function menu(page, language, group, expected, absent) {
  await page.run(`(${picker}).click()`);
  for (const name of expected) await page.until(`${name} in the ${language} menu`, `!!${row(name)}`);
  for (const name of absent) check(!(await page.run(`!!${row(name)}`)), `${name} is in the ${language} menu`);
  await page.until(`the provider called ${group}`, `!!document.querySelector(${JSON.stringify(`[role=group][aria-label="${group}"]`)})`);
  await page.shot(`menu-${language}`);
}

const flash = `local-${connection}/mode-5d41402a`;
const chosen = `JSON.parse(localStorage.getItem("main-view") ?? "{}").draft?.model`;
let failed = false;
try {
  if (!process.env.FINXWORK_E2E_NO_BUILD) {
    step("building finx and the app");
    execFileSync("cargo", ["build", "-p", "finx-cli"], { cwd: root, stdio: "inherit" });
    execFileSync("pnpm", ["--dir", desktop, "build"], { stdio: "inherit" });
  }

  step("in English: the English names, and the Chinese one where there is no other");
  let page = await launch("en");
  await page.until("the new session page with its models", `(${pickerLabel}) === "Mock One"`);
  await menu(page, "en", "QwenWork", ["Standard", "Pro", "千问专属", "Qwen3.8-Max", "Mock One"], ["标准", "高级"]);
  await page.run(`${row("Standard")}.click()`);
  await page.until("Standard chosen", `(${pickerLabel}) === "Standard"`);
  await page.until("the model's id saved, not its name", `${chosen} === ${JSON.stringify(flash)}`);
  await sleep(500);
  page.close();
  await quit();

  step("in Chinese: the same choice under its Chinese name");
  page = await launch("zh-CN");
  await page.until("the same model, named in Chinese", `(${pickerLabel}) === "标准"`);
  check((await page.run(chosen)) === flash, "the choice changed with the language");
  // Mock One has no key: a menu shows it only while it is the current model.
  await menu(page, "zh-CN", "千问办公", ["标准", "高级", "千问专属", "Qwen3.8-Max"], ["Standard", "Pro"]);
  page.close();
  console.log("\n✔ a model's name follows the app's language, and its id stays what is chosen");
} catch (e) {
  failed = true;
  console.error(`\n✘ ${e.message}`);
} finally {
  await quit();
  await finxCall("server/shutdown", {}).catch(() => {});
  fs.rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
