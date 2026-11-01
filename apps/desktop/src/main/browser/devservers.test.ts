import assert from "node:assert/strict";
import { test } from "node:test";
import { candidates, frameworkOf, parseLsof, parseNetstat, parseSs, titleOf } from "./devservers.ts";

test("lsof's listing becomes each process's sockets", () => {
  const out = ["p653", "cControlCenter", "f9", "n*:7000", "p900", "cnode", "f20", "n127.0.0.1:5173", "f21", "n[::1]:5173", "p901", "cpython3", "f3", "n192.168.1.5:8000", ""].join("\n");
  assert.deepEqual(parseLsof(out), [
    { host: "*", port: 7000, pid: 653, process: "ControlCenter" },
    { host: "127.0.0.1", port: 5173, pid: 900, process: "node" },
    { host: "[::1]", port: 5173, pid: 900, process: "node" },
    { host: "192.168.1.5", port: 8000, pid: 901, process: "python3" },
  ]);
});

test("ss's listing, with and without the owning process", () => {
  const out = [
    "LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:((\"node\",pid=123,fd=20))",
    "LISTEN 0 128 [::]:8080 [::]:*",
  ].join("\n");
  assert.deepEqual(parseSs(out), [
    { host: "127.0.0.1", port: 3000, pid: 123, process: "node" },
    { host: "[::]", port: 8080, pid: 0, process: "" },
  ]);
});

test("netstat's listing on Windows, named by tasklist", () => {
  const out = [
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1012",
    "  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       4242",
    "  TCP    127.0.0.1:5173         127.0.0.1:50000        ESTABLISHED     4242",
    "  TCP    [::1]:3000             [::]:0                 LISTENING       4343",
  ].join("\r\n");
  const tasks = "\"svchost.exe\",\"1012\",\"Services\",\"0\",\"9,000 K\"\r\n\"node.exe\",\"4242\",\"Console\",\"1\",\"50,000 K\"\r\n";
  assert.deepEqual(parseNetstat(out, tasks), [
    { host: "0.0.0.0", port: 135, pid: 1012, process: "svchost" },
    { host: "127.0.0.1", port: 5173, pid: 4242, process: "node" },
    { host: "[::1]", port: 3000, pid: 4343, process: "" },
  ]);
});

test("only ports reachable here, worth a browser, and not the app's own are asked, once each", () => {
  const got = candidates([
    { host: "[::1]", port: 5173, pid: 900, process: "node" },
    { host: "127.0.0.1", port: 5173, pid: 900, process: "node" },
    { host: "192.168.1.5", port: 8000, pid: 901, process: "python3" },
    { host: "127.0.0.1", port: 5432, pid: 902, process: "postgres" },
    { host: "*", port: 7000, pid: 653, process: "ControlCenter" },
    { host: "127.0.0.1", port: 4100, pid: 1, process: "FinxWork" },
    { host: "*", port: 3000, pid: 903, process: "node" },
  ], new Set([1]));
  assert.deepEqual(got.map((l) => [l.port, l.host]), [[3000, "*"], [5173, "127.0.0.1"]]);
  // The app's own dev server is left out by its port.
  assert.deepEqual(candidates([{ host: "127.0.0.1", port: 5173, pid: 900, process: "node" }], new Set(), new Set([5173])), []);
});

test("a page's title and the tool that serves it", () => {
  assert.equal(titleOf("<html><head><title>\n  My &amp; App </title>"), "My & App");
  assert.equal(titleOf("<html>no title</html>"), "");
  assert.equal(frameworkOf("<script type=\"module\" src=\"/@vite/client\"></script>", {}), "Vite");
  assert.equal(frameworkOf("<script id=\"__NEXT_DATA__\">", {}), "Next.js");
  assert.equal(frameworkOf("", { "x-powered-by": "Express" }), "Express");
  assert.equal(frameworkOf("<html></html>", {}), undefined);
});
