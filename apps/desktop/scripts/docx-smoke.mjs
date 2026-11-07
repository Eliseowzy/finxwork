#!/usr/bin/env node
// The signed app writes a .docx (docs/desktop/word-design.md §2, §7): in an empty HOME, the app is
// started with a home of its own; its embedded kernel opens a document, and a save as a copy goes
// through the app's serializer process (main/docx-serializer.js and the engine's wasm, inside
// app.asar). The copy must open as a zip with the document's text.
//
//   node scripts/docx-smoke.mjs <path to FinxWork.app> [fixture.docx]
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const here = import.meta.dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One connection to the kernel's socket; `call(method, params)` answers with the result or throws its error. */
async function connect(socket) {
  const s = await new Promise((resolve, reject) => {
    const c = net.createConnection(socket);
    c.once("connect", () => resolve(c));
    c.once("error", reject);
  });
  const waiting = new Map();
  let buf = "";
  let id = 0;
  s.on("data", (chunk) => {
    buf += chunk;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      const w = waiting.get(msg.id);
      if (w) {
        waiting.delete(msg.id);
        msg.error ? w.reject(new Error(`${msg.error.message}`)) : w.resolve(msg.result);
      }
    }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const n = id++;
    waiting.set(n, { resolve, reject });
    s.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
  });
  await call("initialize", { protocol_version: 2, client_info: { name: "docx-smoke" } });
  return { call, close: () => s.destroy() };
}

/** Throws unless the signed app at `app` writes a .docx of `fixture` that parses. */
export async function smokeWord(app, fixture = path.join(here, "../e2e/fixtures/report.docx")) {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fxs-")));
  const home = path.join(work, "home");
  const finxHome = path.join(work, "finx");
  const proj = path.join(work, "proj");
  for (const d of [home, finxHome, proj]) fs.mkdirSync(d);
  const source = path.join(proj, "check.docx");
  const copy = path.join(proj, "copy.docx");
  fs.copyFileSync(fixture, source);
  // A session needs a model to be named; none is called.
  fs.writeFileSync(path.join(finxHome, "models.toml"), '[providers.mock]\nname = "Mock"\napi = "openai-chat"\nbase_url = "http://127.0.0.1:1/v1"\nauth = "none"\n\n[[providers.mock.models]]\nid = "mock-1"\nname = "Mock"\ncontext_window = 128000\nmax_output_tokens = 2000\n');
  fs.writeFileSync(path.join(finxHome, "config.toml"), 'model = "mock/mock-1"\n[models]\nnetwork = false\n');
  const env = { ...process.env, HOME: home, FINX_HOME: finxHome, FINXWORK_USER_DATA: path.join(work, "profile"), FINX_CREDENTIAL_STORE: "file", FINXWORK_E2E_BACKGROUND: "1", FINX_PDFIUM: "" };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.FINXWORK_FINX;
  const child = spawn(path.join(app, "Contents/MacOS/FinxWork"), [], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (c) => { stderr = (stderr + c).slice(-4000); });
  let kernel;
  try {
    const socket = path.join(finxHome, "run/finx.sock");
    for (let i = 0; i < 300 && !kernel; i++) {
      if (child.exitCode !== null) throw new Error(`the signed app exited (${child.exitCode}) before its kernel answered: ${stderr}`);
      await sleep(200);
      if (fs.existsSync(socket)) kernel = await connect(socket).catch(() => undefined);
    }
    if (!kernel) throw new Error(`the signed app's kernel never answered: ${stderr}`);
    const { session_id: session } = await kernel.call("session/new", { cwd: proj });
    const opened = await kernel.call("docx/open", { session_id: session, path: source });
    // The app registers as the writer a moment after the kernel is up: tries until it has.
    let saved;
    let last = "";
    for (let i = 0; i < 100 && !saved; i++) {
      try {
        saved = await kernel.call("docx/save", { session_id: session, docx_id: opened.docx_id, path: copy });
      } catch (e) {
        last = e.message;
        await sleep(300);
      }
    }
    if (!saved) throw new Error(`the signed app could not save a .docx: ${last} ${stderr}`);
    if (saved.status !== "saved") throw new Error(`the signed app's save answered ${JSON.stringify(saved)}`);
    const xml = execFileSync("python3", ["-I", "-c", "import sys, zipfile\nprint(zipfile.ZipFile(sys.argv[1]).read('word/document.xml').decode('utf8'))", copy], { encoding: "utf8" });
    if (!xml.includes("年度报告")) throw new Error(`the saved copy lacks the document's text: ${xml.slice(0, 300)}`);
    kernel.close();
  } finally {
    child.kill("SIGTERM");
    await sleep(500);
    child.kill("SIGKILL");
    try { execFileSync("pkill", ["-f", finxHome]); } catch {}
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [app, fixture] = process.argv.slice(2);
  if (!app) { console.error("usage: node scripts/docx-smoke.mjs <FinxWork.app> [fixture.docx]"); process.exit(2); }
  await smokeWord(path.resolve(app), fixture && path.resolve(fixture));
  console.log("the signed app writes a .docx that parses");
}
