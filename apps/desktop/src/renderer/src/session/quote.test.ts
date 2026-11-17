import assert from "node:assert/strict";
import { test } from "node:test";
import { selectionQuoteOf } from "./quote.ts";

// What a selection may quote (message-quote-design §4.2, D-642): one step's words, both ends in it.

test("a selection is quoted when both ends are in one step's words", () => {
  assert.deepEqual(selectionQuoteOf({ key: "a1:0", role: "assistant" }, { key: "a1:0", role: "assistant" }, " 第 3 步：先备份\n"), {
    role: "assistant",
    text: "第 3 步：先备份",
    key: "a1:0",
  });
  assert.deepEqual(selectionQuoteOf({ key: "u1", role: "user" }, { key: "u1", role: "user" }, "按第二种来"), { role: "user", text: "按第二种来", key: "u1" });
});

test("a selection across two messages, a tool row, or empty words is not quoted", () => {
  assert.equal(selectionQuoteOf({ key: "a1:0", role: "assistant" }, { key: "a2:0", role: "assistant" }, "两条消息"), null);
  assert.equal(selectionQuoteOf({ key: "a1:0", role: "assistant" }, { key: "a1:0", role: "user" }, "两边的字"), null);
  // A tool row is no quotable part: neither end is in one.
  assert.equal(selectionQuoteOf(null, { key: "c1", role: "assistant" }, "命令输出"), null);
  assert.equal(selectionQuoteOf({ key: "c1", role: "" }, { key: "c1", role: "" }, "命令输出"), null);
  assert.equal(selectionQuoteOf({ key: "u1", role: "user" }, { key: "u1", role: "user" }, "   \n"), null);
});
