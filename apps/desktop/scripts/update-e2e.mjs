#!/usr/bin/env node
// Updates finxwork the way people get updates (docs/desktop/desktop-release.md §7).
// Builds two Developer ID–signed versions, A < B, whose releases are a server
// on this Mac laid out as GitHub's (the newest release's address redirects to
// a release's own); serves B as the newest release; has A find, download and
// verify it, then restart into it; and checks that B runs where A was and
// replaced the finx A had started. Signed, not notarized: Squirrel checks the
// signature, not the notarization.
//
// The apps' profile and FINX_HOME are a temporary folder built into the test
// builds (the relaunched B uses it too), so the person's own finxwork, its
// settings and their finx are not touched. Windows of A and B show up while
// it runs. Takes about 5 minutes: two builds, then the update in under one.
//
//   node apps/desktop/scripts/update-e2e.mjs
//   FINXWORK_E2E_SHOTS=<folder> node apps/desktop/scripts/update-e2e.mjs   also screenshots of the ready update
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { feedName, zipName } from "../src/shared/update.ts";

const desktop = path.resolve(import.meta.dirname, "..");
const [from, to] = ["0.0.1", "0.0.2"];
const arch = process.arch === "arm64" ? "arm64" : "x64";
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const step = (s) => console.log(`\n▶ ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!/Developer ID Application/.test(execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" }))) {
  console.error("needs a Developer ID Application identity in the keychain: Squirrel installs only signed updates");
  process.exit(1);
}

// Short: the kernel's socket lives under it, and a socket path has at most 103 bytes.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "fxu-"));
const home = path.join(work, "home");
const releases = path.join(work, "releases");
const appPath = path.join(work, "a", "FinxWork.app");
// What Squirrel keeps under the bundle ID, shared with the person's own finxwork: removed after, unless it was there before.
const caches = ["com.finxwork.app", "com.finxwork.app.ShipIt"].map((d) => path.join(os.homedir(), "Library/Caches", d)).filter((d) => !fs.existsSync(d));
const requests = [];

// GitHub's layout: /releases/latest/download/<file> redirects to the newest release's /releases/download/v<version>/<file>.
const server = http.createServer((req, res) => {
  const p = new URL(req.url ?? "/", "http://localhost").pathname;
  requests.push(p);
  const latest = /^\/releases\/latest\/download\/([^/]+)$/.exec(p);
  if (latest) {
    res.writeHead(302, { location: `${base}/download/v${to}/${latest[1]}` });
    return res.end();
  }
  const m = /^\/releases\/download\/(v[^/]+)\/([^/]+)$/.exec(p);
  const file = m && path.join(releases, m[1], m[2]);
  if (!file || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  // The zip held back a little, as a download takes a while.
  setTimeout(() => {
    res.writeHead(200, { "content-length": fs.statSync(file).size });
    fs.createReadStream(file).pipe(res);
  }, file.endsWith(".zip") ? 2000 : 0);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/releases`;

let ok = false;
try {
  const buildVersion = (version, dir) => {
    step(`building ${version}`);
    sh(process.execPath, [path.join(desktop, "scripts/build-app.mjs")], {
      env: {
        ...process.env, VERSION: version, FINXWORK_ARCH: arch, FINXWORK_DIST: path.join(work, dir), FINXWORK_RELEASES: base,
        FINXWORK_TEST_HOME: home, FINXWORK_NO_DMG: "1", FINXWORK_SIGNING_IDENTITY: "", FINXWORK_NOTARY_PROFILE: "", FINXWORK_NOTARY_KEY_PATH: "",
      },
    });
  };
  buildVersion(from, "a");
  buildVersion(to, "b");
  fs.mkdirSync(path.join(releases, `v${to}`), { recursive: true });
  for (const f of [zipName(arch), feedName(arch)]) fs.copyFileSync(path.join(work, "b", f), path.join(releases, `v${to}`, f));

  step(`running ${from}`);
  const port = 9300 + Math.floor(Math.random() * 500);
  spawn(path.join(appPath, "Contents/MacOS/finxwork"), [`--remote-debugging-port=${port}`], { stdio: "ignore", detached: true }).unref();
  const page = await until(() => connect(port), 30_000, "the window's page");
  await until(async () => (await page.evaluate("!!window.finx && typeof window.finx.updates === 'function'")) || null, 15_000, "the bridge");
  const lock = path.join(home, "finx", "run", "finx.lock");
  const kernelA = await until(() => record(lock), 30_000, "finx started by the app");
  console.log(`  finx ${kernelA.pid} started by ${from}`);
  // The scheduled look comes 30 s after launch; a manual check, as from the menu, is at once.
  await page.evaluate("window.finx.checkForUpdates()");
  const states = [];
  const ready = await until(async () => {
    const info = await page.evaluate("window.finx.updates()");
    if (states.at(-1) !== info.update.state) states.push(info.update.state);
    if (info.update.state === "error") throw new Error(`update failed: ${info.update.reason}: ${info.update.message}`);
    return info.update.state === "ready" ? info : null;
  }, 120_000, "the update to be downloaded and verified");
  console.log(`  states: ${states.join(" → ")}; ready: ${ready.update.version}`);
  if (ready.update.version !== to) throw new Error(`ready with ${ready.update.version}, expected ${to}`);
  if (!(await until(() => page.evaluate("!!document.querySelector('.upd')"), 5_000, "the sidebar's reminder"))) throw new Error("no reminder");
  const shots = process.env.FINXWORK_E2E_SHOTS;
  if (shots) {
    // The sidebar's reminder, and Settings › About with the update ready.
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot(path.join(shots, "update-ready-sidebar.png"));
    await page.evaluate("window.finx.openSettings('about')");
    const settings = await until(() => connect(port, "#settings"), 15_000, "the settings window");
    await until(() => settings.evaluate("!!document.querySelector('.upd-busy, .sw')"), 10_000, "Software Update");
    await sleep(500);
    await settings.screenshot(path.join(shots, "update-ready-settings.png"));
    settings.close();
    console.log(`  screenshots in ${shots}`);
  }
  // The app read the newest feed; Squirrel read that version's own feed and its zip, never "the newest".
  const want = [`/releases/latest/download/${feedName(arch)}`, `/releases/download/v${to}/${feedName(arch)}`, `/releases/download/v${to}/${zipName(arch)}`];
  for (const w of want) if (!requests.includes(w)) throw new Error(`no request for ${w}: ${requests.join(", ")}`);

  step("restarting to update");
  await page.evaluate("window.finx.installUpdate()").catch(() => {});
  page.close();
  const plist = path.join(appPath, "Contents/Info.plist");
  await until(() => readVersion(plist) === to || null, 120_000, `${to} in place of ${from}`);
  await until(() => running(appPath) || null, 60_000, `${to} to be running again`);
  console.log(`  ${appPath} is ${to} and running`);
  // The new app finds finx still running A's binary and replaces it, as no task runs.
  const kernelB = await until(() => {
    const r = record(lock);
    return r && r.pid !== kernelA.pid ? r : null;
  }, 60_000, "the new app to replace the old finx");
  if (alive(kernelA.pid)) throw new Error(`the old finx ${kernelA.pid} is still running`);
  console.log(`  finx ${kernelA.pid} replaced by ${kernelB.pid}`);
  ok = true;
  console.log(`\n✓ ${from} updated to ${to}: found, downloaded, verified, installed, relaunched; finx followed`);
} finally {
  server.close();
  try {
    execFileSync("pkill", ["-f", path.join(appPath, "Contents/MacOS/finxwork")]);
  } catch {
    // Not running.
  }
  const r = record(path.join(home, "finx", "run", "finx.lock"));
  if (r && alive(r.pid)) process.kill(r.pid, "SIGTERM");
  // Both write as they quit: wait for them before removing their folder.
  await until(() => !running(appPath) && !(r && alive(r.pid)), 15_000, "the app and finx to quit").catch(() => {});
  for (const d of caches) fs.rmSync(d, { recursive: true, force: true });
  if (ok) fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  else console.error(`\n✗ left for a look: ${work}`);
}

/** Polls until f returns something truthy; f may throw to stop. */
async function until(f, ms, what) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const v = await f();
      if (v) return v;
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("update failed")) throw e;
      last = e;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message ?? last}` : ""}`);
}

/** A window's page over the DevTools protocol (the main window's, or the one whose address has `hash`): evaluate, screenshot. */
async function connect(port, hash = "") {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((t) => t.type === "page" && t.url.startsWith("app://finxwork") && (hash ? t.url.includes(hash) : !t.url.includes("#")));
  if (!target) return null;
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  };
  const call = (method, params) =>
    new Promise((resolve) => {
      const n = ++id;
      pending.set(n, resolve);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  return {
    evaluate: async (expression) => {
      const msg = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (msg.result?.exceptionDetails) throw new Error(msg.result.exceptionDetails.text);
      return msg.result?.result?.value;
    },
    screenshot: async (file) => fs.writeFileSync(file, Buffer.from((await call("Page.captureScreenshot", { format: "png" })).result.data, "base64")),
    close: () => ws.close(),
  };
}

function record(lock) {
  try {
    const r = JSON.parse(fs.readFileSync(lock, "utf8"));
    return r && r.pid > 0 && alive(r.pid) ? r : null;
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function readVersion(plist) {
  try {
    return execFileSync("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function running(app) {
  try {
    return execFileSync("pgrep", ["-f", path.join(app, "Contents/MacOS/finxwork")], { encoding: "utf8" }).trim() !== "";
  } catch {
    return false;
  }
}
