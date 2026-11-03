#!/usr/bin/env node
// Real service + isolated CLI fixture: an interrupted login RPC must be resumable.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";
const root = path.resolve(import.meta.dirname, "../../..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "fx-login-"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "crates/finx-core/src/connectors/feishu.json")));
const dir = path.join(home, "connectors/feishu/config");
const release = path.join(home, "connectors/feishu/releases", manifest.version);
fs.mkdirSync(dir, { recursive: true });
fs.mkdirSync(release, { recursive: true });
const fixture = `#!/bin/sh
D="$LARKSUITE_CLI_CONFIG_DIR"
case "$1 $2" in
 "config init")
   echo $$ >> "$D/starts"
   while ! test -f "$D/allow-url"; do sleep 0.02; done
   echo 'https://open.feishu.cn/page/cli?user_code=setup'
   while ! test -f "$D/setup-finish"; do sleep 0.02; done
   echo '{}' > "$D/config.json" ;;
 "auth login")
   echo $$ >> "$D/starts"
   echo '{"verification_uri_complete":"https://accounts.feishu.cn/oauth/v1/device/verify?user_code=consent"}'
   while ! test -f "$D/finish"; do sleep 0.02; done
   touch "$D/account" ;;
 "auth status") if test -f "$D/account"; then echo '{"identity":"user"}'; else echo '{"identity":"bot"}'; fi ;;
 "auth logout") rm -f "$D/account" ;;
esac
`;
fs.writeFileSync(path.join(release, "cli"), fixture, { mode: 0o700 });
fs.writeFileSync(path.join(release, "receipt.json"), JSON.stringify({ version: manifest.version, binary_sha256: createHash("sha256").update(fixture).digest("hex") }));
const server = spawn(path.join(root, "target/debug/finx"), ["serve", "--stdio"], {
  cwd: home, env: { ...process.env, FINX_HOME: home, HOME: home, FINX_CREDENTIAL_STORE: "file", FINX_NO_BROWSER: "1" }, stdio: ["pipe", "pipe", "inherit"],
});
let next = 0;
const pending = new Map();
const notifications = [];
createInterface({ input: server.stdout }).on("line", line => {
  const m = JSON.parse(line);
  if (m.id !== undefined) { pending.get(m.id)?.(m); pending.delete(m.id); }
  else notifications.push(m);
});
const send = m => server.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
function request(method, params) {
  const id = ++next;
  const result = new Promise(resolve => pending.set(id, resolve));
  send({ id, method, params });
  return { id, result };
}
async function rpc(method, params) {
  const reply = await request(method, params).result;
  assert(!reply.error, `${method}: ${JSON.stringify(reply.error)}`);
  return reply.result;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { if (await check()) return; await sleep(25); }
  assert.fail("timed out waiting for login state");
}
const starts = () => fs.readFileSync(path.join(dir, "starts"), "utf8").trim().split("\n");
const timer = setTimeout(() => { console.error("login regression timed out"); server.kill(); process.exitCode = 1; }, 60000);
try {
  await rpc("initialize", { protocol_version: 2, client_info: { name: "login-resume-regression" } });
  const installed = await rpc("connectors/install", { id: "feishu" });
  await rpc("config/write", { layer: "user", edits: [{ key_path: "mcp_servers.feishu", value: installed.server, merge: "replace" }] });
  await rpc("mcp/list", {}); // subscribe to completion/progress notifications
  const first = request("mcp/login", { name: "feishu" });
  await until(() => fs.existsSync(path.join(dir, "starts")));
  send({ method: "$/cancel_request", params: { id: first.id } });
  assert((await first.result).error, "the original RPC should be cancelled");
  fs.writeFileSync(path.join(dir, "allow-url"), "");
  const [resumed, duplicate] = await Promise.all([rpc("mcp/login", { name: "feishu" }), rpc("mcp/login", { name: "feishu" })]);
  assert.equal(resumed.login_id, duplicate.login_id);
  assert.equal(starts().length, 1, "resuming must not create a second app registration process");
  assert(resumed.authorize_url.includes("/page/cli"));
  fs.writeFileSync(path.join(dir, "setup-finish"), "");
  await until(async () => (await rpc("mcp/login", { name: "feishu" })).authorize_url.includes("/device/verify"));
  const consent = await rpc("mcp/login", { name: "feishu" });
  assert.equal(consent.login_id, resumed.login_id);
  assert.equal(starts().length, 2, "only the setup and consent processes should start");
  assert.equal((await rpc("mcp/check", { name: "feishu" })).server.enabled, false);
  await rpc("mcp/login_cancel", { name: "feishu" });
  const retry = await rpc("mcp/login", { name: "feishu" });
  assert.notEqual(retry.login_id, resumed.login_id);
  assert(retry.authorize_url.includes("/device/verify"), "retry should retain completed app setup");
  fs.writeFileSync(path.join(dir, "finish"), "");
  await until(() => notifications.some(n => n.method === "mcp/changed" && n.params.login_id === retry.login_id && !n.params.authorize_url));
  const completed = notifications.find(n => n.method === "mcp/changed" && n.params.login_id === retry.login_id && !n.params.authorize_url);
  assert(!completed.params.login_error, completed.params.login_error);
  assert.equal((await rpc("mcp/check", { name: "feishu" })).server.enabled, true);
  await rpc("mcp/logout", { name: "feishu" });
  console.log("PASS: cancelled RPC, concurrent resume, latest stage, cancel-and-retry, authorization gate");
} finally {
  clearTimeout(timer);
  server.kill();
  await new Promise(r => server.once("exit", r));
  fs.rmSync(home, { recursive: true, force: true });
}
