#!/usr/bin/env node
// Verify that files a reply points at open in the one file panel (document-editor-design §7,
// content-actions-design): a PDF's tag shows it in pdf.js with its own bar of tools under the path,
// a text file's tag opens beside it as another tab, without that bar, and a PDF picked in the
// panel's tree joins them.
// Everything stays in a private HOME. Needs `pnpm build`, `cargo build -p finx-cli` and PDFium
// (tools/pdfium, see crates/finx-docs). The PDF: FINX_DOC_PDF, else pdf_oxide's 1.pdf.
import { spawn } from "node:child_process";
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

const source = process.env.FINX_DOC_PDF ?? path.join(os.homedir(), "pdf_oxide/tests/fixtures/1.pdf");
if (!fs.existsSync(source)) {
  console.log(`doc-links: no PDF at ${source} (set FINX_DOC_PDF), skipped`);
  process.exit(0);
}

// Short: the kernel's socket lives under it, and a socket path has at most 103 bytes.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxl-"));
const home = path.join(work, "finx");
const profile = path.join(work, "profile");
const userHome = path.join(work, "home");
const project = path.join(work, "proj");
for (const d of [home, userHome, project]) fs.mkdirSync(d, { recursive: true });
fs.copyFileSync(source, path.join(project, "report.pdf"));
fs.copyFileSync(source, path.join(project, "second.pdf"));
fs.writeFileSync(path.join(project, "notes.md"), "# Notes\n");
const env = { ...process.env, FINX_HOME: home, HOME: userHome, FINX_CREDENTIAL_STORE: "file", FINX_NO_BROWSER: "1" };

// The model: answers with links to a PDF and a Markdown file.
const sse = (delta, finish) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`;
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    if (req.method !== "POST" || !body) return res.end(JSON.stringify({ data: [] }));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse({ role: "assistant", content: "研报在 [研报](report.pdf)，笔记在 [笔记](notes.md)。LINKS_DONE" }, "stop"));
  });
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
fs.writeFileSync(path.join(home, "models.toml"), `[providers.mock]\nname = "Mock"\napi = "openai-chat"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nauth = "none"\n[[providers.mock.models]]\nid = "mock-1"\nname = "Mock One"\ncontext_window = 128000\nmax_output_tokens = 2000\n`);
fs.writeFileSync(path.join(home, "config.toml"), `model = "mock/mock-1"\npermission_mode = "manual"\n[models]\nnetwork = false\n`);

let app = null;
const port = 9400 + Math.floor(Math.random() * 400);

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
      if (Date.now() > end) fail(`timed out waiting for ${label}: ${await run("document.body.innerText.slice(0, 800)")}`);
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

async function quit() {
  if (!app || app.exitCode !== null) return;
  const exited = new Promise((r) => app.once("exit", r));
  app.kill("SIGTERM");
  const timeout = setTimeout(() => app.kill("SIGKILL"), 3000);
  await exited;
  clearTimeout(timeout);
}

const chip = (name) => `[...document.querySelectorAll(".am .fref")].find((c) => c.querySelector(".fref-n").textContent === ${JSON.stringify(name)})`;
const treeRow = (name) => `[...document.querySelectorAll(".fpt-row")].find((r) => r.querySelector(".fpt-name").textContent === ${JSON.stringify(name)})`;
const activeTab = `document.querySelector('.fpn-tab.on .brp-tab-t')?.textContent`;
const tabCount = `document.querySelectorAll('.fpn-tab').length`;
/** The PDF's own bar shows: the page, zoom, search, under the path. */
const pdfBar = `!!document.querySelector('.fpn .dcp-viewer:not([hidden]) .dcp-bar .dcp-page')`;

let failed = false;
try {
  app = spawn(electron, [desktop, `--remote-debugging-port=${port}`], {
    env: { ...env, FINXWORK_DEFAULT_MODE: "sessions", FINXWORK_USER_DATA: profile, FINXWORK_FINX: finx, FINXWORK_NO_BROWSER: "1" },
    stdio: ["ignore", "ignore", "inherit"],
    cwd: project,
  });
  const main = await attach((t) => t.type === "page" && /^(app:|file:|http:)/.test(t.url) && !t.url.includes("#settings"), "the main window");
  await main.cdp("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 0, mobile: false });
  await main.until("app loaded", `!!document.querySelector("button")`);
  await main.until("onboarding left", `(() => { const skip = [...document.querySelectorAll("button")].find(b => /稍后|later|skip/i.test(b.textContent)); if (skip) { skip.click(); return false; } return !!document.querySelector('.cmp-in'); })()`);
  // The project: a new session works in it.
  await main.run(`localStorage.setItem("main-view", JSON.stringify({ ...JSON.parse(localStorage.getItem("main-view") ?? "{}"), draft: { cwd: ${JSON.stringify(project)}, model: null, thinking: null, permission: "manual" } }))`);
  await main.run(`location.reload()`);
  await main.until("the new session page again", `!!document.querySelector(".cmp-in")`);

  await main.run(`document.querySelector('.cmp-in').focus()`);
  await main.cdp("Input.insertText", { text: "文件在哪" });
  await main.until("send enabled", `!document.querySelector('button.send')?.disabled`);
  await main.run(`document.querySelector('button.send').click()`);
  await main.until("the reply", `document.body.innerText.includes("LINKS_DONE")`, 30000);
  await main.until("both tags", `!!(${chip("研报")}) && !!(${chip("笔记")})`);
  check(!(await main.run(`(${chip("研报")}).classList.contains("gone")`)), "the PDF's tag is greyed though the file is there");

  // 1. The PDF's tag opens the file panel, the PDF in it with its own bar; the sidebar stays where it was.
  check(!(await main.run(`document.querySelector(".mainwrap").classList.contains("noside")`)), "the sidebar was not out to begin with");
  await main.run(`(${chip("研报")}).click()`);
  await main.until("the report in the panel", `${activeTab} === "report.pdf" && ${pdfBar}`, 30000);
  check(!(await main.run(`!!document.querySelector(".dcp")`)), "a document column of its own opened");
  check(!(await main.run(`document.querySelector(".mainwrap").classList.contains("noside")`)), "opening a PDF put the sidebar away");
  await main.shot("1-pdf-tag");

  // 2. A text file's tag opens beside it as another tab, without the PDF's bar.
  await main.run(`(${chip("笔记")}).click()`);
  await main.until("notes.md in the panel", `${activeTab} === "notes.md"`);
  check((await main.run(tabCount)) === 2, "the PDF's tab went when the text file opened");
  check(!(await main.run(pdfBar)), "the PDF's bar shows over a text file");
  await main.shot("2-md-tag");

  // 3. A PDF picked in the panel's tree opens there too, and the first one is still laid out.
  await main.until("second.pdf in the tree", `!!(${treeRow("second.pdf")})`);
  await main.run(`(${treeRow("second.pdf")}).click()`);
  await main.until("second.pdf in the panel", `${activeTab} === "second.pdf" && ${pdfBar}`, 30000);
  check((await main.run(tabCount)) === 3, "the panel does not keep all three tabs");
  check((await main.run(`document.querySelectorAll('.fpn .dcp-viewer').length`)) === 2, "both PDFs are not kept laid out");
  await main.shot("3-pdf-tree");

  // 4. The file written again under its open tab (its password changed, say): what showed is let go, the file read afresh.
  await main.run(`document.querySelector('.fpn .dcp-viewer:not([hidden])').dataset.old = "1"`);
  fs.copyFileSync(path.join(project, "report.pdf"), path.join(project, "second.pdf.new"));
  fs.renameSync(path.join(project, "second.pdf.new"), path.join(project, "second.pdf"));
  await main.until("second.pdf opened afresh", `${activeTab} === "second.pdf" && !document.querySelector('.fpn .dcp-viewer[data-old]') && ${pdfBar}`, 30000);

  console.log("\n✔ PDFs and other files open as tabs of the one file panel; only a PDF shows its own bar of tools; one written again under its tab opens afresh");
} catch (e) {
  failed = true;
  console.error(`\n✘ ${e.message}`);
} finally {
  await quit();
  provider.close();
  if (!failed) fs.rmSync(work, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
