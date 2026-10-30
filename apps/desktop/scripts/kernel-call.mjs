#!/usr/bin/env node
// Sends one request to the finx service on a socket and prints the result:
//   node scripts/kernel-call.mjs <socket> <method> [params-json]
// For checking the service an app started (desktop-kernel-integration §13).
import net from "node:net";

const [socket, method, params = "{}"] = process.argv.slice(2);
if (!socket || !method) {
  console.error("usage: kernel-call.mjs <socket> <method> [params-json]");
  process.exit(2);
}
const conn = net.createConnection(socket);
conn.setEncoding("utf8");
let buffer = "";
const send = (id, m, p) => conn.write(JSON.stringify({ jsonrpc: "2.0", id, method: m, params: p }) + "\n");
conn.on("connect", () => {
  send(1, "initialize", { protocol_version: 2, client_info: { name: "kernel-call" } });
  send(2, method, JSON.parse(params));
});
conn.on("data", (chunk) => {
  buffer += chunk;
  for (let i; (i = buffer.indexOf("\n")) >= 0; ) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    const msg = JSON.parse(line);
    if (msg.id === 2) {
      console.log(JSON.stringify(msg.error ?? msg.result, null, 2));
      conn.end();
      process.exit(msg.error ? 1 : 0);
    }
  }
});
conn.on("error", (e) => {
  console.error(e.message);
  process.exit(1);
});
