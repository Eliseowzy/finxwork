import assert from "node:assert/strict";
import { test } from "node:test";
import { userText } from "@finx/client";
import type { Event } from "@finx/protocol";
import {
  aiQuestion, commentText, docxEditDetails, requestEvent, requestSent, requestStarted, selectedParagraphs, stepRow, stepRowStart,
  wordCommentInput, wordRequestInput, type StepRow, type WordRequest,
} from "./aiPrompt.ts";

const labels = { request: (file: string, what: string) => `在《${file}》：${what}`, action: (a: string) => ({ polish: "润色", custom: "自定义" })[a] ?? a };
const paragraphs = [{ id: "1A2B3C4D", text: "第一段。" }, { id: "1:5", text: "第二段。" }];
const base: WordRequest = { path: "/w/合同.docx", docxId: "d1", action: "polish", selection: "第一段。\n第二段。", paragraphs };
const texts = (content: { type: string; text?: string }[]) => content.map((c) => c.text ?? "");

test("a request shows as a compact line and a quote; the context goes to the model unseen", () => {
  const input = wordRequestInput(base, labels);
  const shown = userText(input);
  assert.equal(shown.text, "在《合同.docx》：润色");
  assert.equal(shown.quotes.length, 1);
  assert.deepEqual(shown.quotes[0].paragraphs, ["1A2B3C4D", "1:5"]);
  assert.equal(shown.quotes[0].text, "第一段。\n第二段。");
  const context = texts(input).at(-1)!;
  assert.match(context, /"docx_id": "d1"/);
  assert.match(context, /"path": "\/w\/合同.docx"/);
  assert.match(context, /"action": "polish"/);
  assert.match(context, /"id": "1:5"/);
  assert.match(context, /docx_edit in suggest mode and change only these paragraphs: 1A2B3C4D, 1:5\./);
  assert.match(context, /Do not accept your own revisions\./);
  assert.match(context, /one sentence/);
});

test("custom, continue and summarize ask for what they are", () => {
  const custom = wordRequestInput({ ...base, action: "custom", input: "改成被动语态" }, labels);
  assert.equal(userText(custom).text, "在《合同.docx》：改成被动语态");
  assert.match(texts(custom).at(-1)!, /"ask": "改成被动语态"/);
  const more = texts(wordRequestInput({ ...base, action: "continue" }, labels)).at(-1)!;
  assert.match(more, /insert_paragraphs after the last paragraph \(1:5\)/);
  const sum = texts(wordRequestInput({ ...base, action: "summarize" }, labels)).at(-1)!;
  assert.match(sum, /add_comment anchored to these paragraphs \(1A2B3C4D, 1:5\)/);
  assert.doesNotMatch(sum, /suggest mode/);
});

test("a comment's question asks for reply_comment, and revisions when the text must change", () => {
  const input = wordCommentInput({ path: "/w/a.docx", docxId: "d1", commentId: 7, question: "这里合规吗？", paragraphs: paragraphs.slice(0, 1) }, { comment: (f, q) => `${f}：${q}` });
  assert.equal(userText(input).text, "a.docx：这里合规吗？");
  const context = texts(input).at(-1)!;
  assert.match(context, /"comment_id": 7/);
  assert.match(context, /reply_comment on comment 7/);
  assert.match(context, /suggest mode, only in these paragraphs: 1A2B3C4D/);
});

test("@AI is told apart", () => {
  assert.equal(aiQuestion("@AI 这句话什么意思"), "这句话什么意思");
  assert.equal(aiQuestion("  @ai: rewrite this"), "rewrite this");
  assert.equal(aiQuestion("＠AI，帮我看看"), "帮我看看");
  assert.equal(aiQuestion("@AI"), null);
  assert.equal(aiQuestion("@AIDA is a model"), null);
  assert.equal(aiQuestion("ask @AI later"), null);
  assert.equal(commentText([{ type: "paragraph", content: [{ type: "run", content: [{ type: "text", text: "@AI " }, { type: "text", text: "why?" }] }] }]), "@AI why?");
});

test("a selection's paragraphs: from where it starts, as many as its lines", () => {
  const all = [...paragraphs, { id: "3", text: "三" }];
  assert.deepEqual(selectedParagraphs(all, "1A2B3C4D", "第一").map((p) => p.id), ["1A2B3C4D"]);
  assert.deepEqual(selectedParagraphs(all, "1A2B3C4D", "段。\n第二").map((p) => p.id), ["1A2B3C4D", "1:5"]);
  assert.deepEqual(selectedParagraphs(all, "1:5", "a\nb\nc\nd").map((p) => p.id), ["1:5", "3"]);
  assert.deepEqual(selectedParagraphs(all, "nope", "x"), []);
});

const ev = (e: Record<string, unknown>) => ({ seq: 1, ts: 0, ...e }) as Event;
const edit = (details: unknown, is_error = false) => ev({ type: "tool_completed", call_id: "c", result: { call_id: "c", content: [], details, is_error, tool_name: "call_tool", ts: 0 } });

test("a request keeps the revisions its task made in its document, and ends with its task", () => {
  let s = requestSent(requestStarted(), true);
  s = requestEvent(s, ev({ type: "task_started", task_id: "t1" }), "d1");
  s = requestEvent(s, edit({ docx_id: "d1", path: "/a.docx", edit: 3, revision: 4, mode: "suggest", paragraphs: ["P1"], revisions: [11, 12] }), "d1");
  s = requestEvent(s, edit({ docx_id: "d2", path: "/b.docx", edit: 1, revision: 1, mode: "suggest", paragraphs: ["Q"], revisions: [99] }), "d1");
  s = requestEvent(s, edit({ docx_id: "d1", path: "/a.docx", edit: 4, revisions: [13] }, true), "d1");
  s = requestEvent(s, edit({ docx_id: "d1", path: "/a.docx", edit: 5, revision: 6, mode: "suggest", paragraphs: ["P1", "P2"], revisions: [12, 14] }), "d1");
  assert.deepEqual(s.revisions, [11, 12, 14]);
  assert.deepEqual(s.paragraphs, ["P1", "P2"]);
  assert.equal(requestEvent(s, ev({ type: "task_completed", task_id: "other" }), "d1").phase, "running");
  s = requestEvent(s, ev({ type: "task_completed", task_id: "t1" }), "d1");
  assert.equal(s.phase, "done");
  assert.equal(requestEvent(s, edit({ docx_id: "d1", path: "/a.docx", edit: 9, revisions: [20] }), "d1").revisions.length, 3);
});

test("a request fails, stops, or is refused", () => {
  assert.equal(requestSent(requestStarted(), false, "busy").error, "busy");
  const running = requestSent(requestStarted(), true);
  const failed = requestEvent(running, ev({ type: "task_failed", task_id: "t", error: { kind: "network", message: "offline", retryable: true } }), "d1");
  assert.deepEqual([failed.phase, failed.error], ["failed", "offline"]);
  assert.equal(requestEvent(running, ev({ type: "task_interrupted", task_id: "t", returned_input: [] }), "d1").phase, "stopped");
});

test("docx_edit details are read as the kernel sends them", () => {
  assert.equal(docxEditDetails({ deck_id: "x", path: "/a", edit: 1 }), null);
  assert.deepEqual(docxEditDetails({ docx_id: "d", path: "/a.docx", edit: 2, revision: 3, mode: "direct", paragraphs: ["A"], revisions: ["r1", 2, null] }), {
    docx_id: "d", path: "/a.docx", edit: 2, revision: 3, mode: "direct", paragraphs: ["A"], revisions: ["r1", 2],
  });
});

test("a step's row: one thing at a time, and a settled change stays settled", () => {
  const run = (...as: Parameters<typeof stepRow>[1][]) => as.reduce<StepRow>(stepRow, stepRowStart);
  assert.deepEqual(run({ type: "undo" }), { undo: "busy", review: "idle", error: null });
  assert.deepEqual(run({ type: "undo" }, { type: "review", action: "accept" }).review, "idle");
  assert.deepEqual(run({ type: "undo" }, { type: "undone" }, { type: "review", action: "accept" }), { undo: "undone", review: "idle", error: null });
  assert.deepEqual(run({ type: "undo" }, { type: "failed", message: "not the latest" }), { undo: "idle", review: "idle", error: "not the latest" });
  assert.deepEqual(run({ type: "review", action: "reject" }, { type: "reviewed", action: "reject" }, { type: "undo" }), { undo: "idle", review: "rejected", error: null });
  assert.deepEqual(run({ type: "review", action: "accept" }, { type: "failed", message: "x" }, { type: "review", action: "accept" }).review, "busy");
});
