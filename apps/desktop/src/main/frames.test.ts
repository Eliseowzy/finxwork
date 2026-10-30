import assert from "node:assert/strict";
import { test } from "node:test";
import { LineCutter } from "./frames.ts";

test("whole lines pass at once; a partial one waits for the rest", () => {
  const c = new LineCutter();
  assert.equal(c.push('{"a":1}\n{"b"'), '{"a":1}\n');
  assert.equal(c.push(":2}"), "");
  assert.equal(c.push('\n{"c":3}\n'), '{"b":2}\n{"c":3}\n');
  assert.equal(c.push(""), "");
});

test("multi-byte text split anywhere stays intact", () => {
  const c = new LineCutter();
  const line = '{"text":"跑一下测试"}\n';
  let out = "";
  for (const ch of line) out += c.push(ch);
  assert.equal(out, line);
});
