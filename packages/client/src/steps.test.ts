import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantContent, Event, EventMsg, SessionInfo, TranscriptItem, Usage } from "@finx/protocol";
import { applyEvents, callTarget, fromSnapshot, type SessionView } from "./session.ts";
import { approvalPreview, attachedBlock, docQuoteBlock, docViewingBlock, messageIdOf, messageQuoteBlock, presentationViewingBlock, quoteForSend, quoteIsGone, quoteTextOf, sheetViewingBlock, webCommentBlock, conversation, describe, settledSteps, withStreaming, toolObject, userText, workSummary, type MessageQuote } from "./steps.ts";
import { clockText, costText, tokensText } from "./text.ts";

const info: SessionInfo = { session_id: "s", cwd: "/w/app", session_file: "/f.jsonl", model: "p/m", thinking: "off", permission_mode: "manual", context_window: 1000, archived: false };
const usage: Usage = { input: 1, output: 1, cache_read: 0, cache_write: 0, cost: { currency: "USD", input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 } };

function play(msgs: EventMsg[]): SessionView {
  const events = msgs.map((m, i) => ({ seq: i + 1, ts: 1000 + i, ...m }) as Event);
  return applyEvents(fromSnapshot({ session: info, last_seq: 0, transcript: { items: [] }, usage: { per_model: {} } }), events);
}

const assistant = (id: string, content: AssistantContent[]): EventMsg => ({
  type: "message_completed",
  message_id: id,
  message: { role: "assistant", content, provider: "p", api: "a", model: "m", usage, stop_reason: "stop", ts: 1 },
});
const result = (id: string, text: string, is_error = false): EventMsg => ({
  type: "tool_completed",
  call_id: id,
  result: { call_id: id, tool_name: "bash", content: [{ type: "text", text }], is_error, ts: 2 },
});

test("thinking and tool calls between the model's words become one step; words and messages stay apart", () => {
  const v = play([
    { type: "task_started", task_id: "t1" },
    { type: "message_completed", message_id: "u1", message: { role: "user", content: [{ type: "text", text: "hi" }], ts: 1 } },
    assistant("a1", [
      { type: "thinking", text: "look first" },
      { type: "text", text: "Looking." },
      { type: "tool_call", id: "c1", name: "bash", arguments: { command: "ls -la\nmore" } },
    ]),
    { type: "tool_started", call_id: "c1", name: "bash", args: { command: "ls -la" }, category: "execute", title: "ls -la" },
    { type: "tool_running", call_id: "c1" },
    result("c1", "a\nb"),
    assistant("a2", [
      { type: "tool_call", id: "c2", name: "read", arguments: { path: "/w/app/src/main.rs" } },
      { type: "tool_call", id: "c3", name: "edit", arguments: { path: "/w/app/src/main.rs" } },
    ]),
    result("c2", "fn main() {}"),
    { type: "message_started", message_id: "a3", role: "assistant" },
    { type: "message_delta", message_id: "a3", delta: { type: "text", index: 0, text: "Do" } },
    { type: "message_delta", message_id: "a3", delta: { type: "text", index: 0, text: "ne" } },
  ]);
  const steps = conversation(v);
  assert.deepEqual(steps.map((s) => s.kind), ["user", "work", "text", "work", "text"]);
  const work = steps[3];
  assert.ok(work.kind === "work");
  assert.deepEqual(work.items.map((i) => (i.kind === "tool" ? `${i.tool.name}:${i.tool.state}` : "thinking")), ["bash:done", "read:done", "edit:pending"]);
  assert.equal(work.live, true);
  const draft = steps.at(-1);
  assert.ok(draft?.kind === "text" && draft.live && draft.text === "Done");
  // The edit is still to run in the task in progress; once the task ends without running it, it was not run.
  const ended = applyEvents(v, [{ seq: 100, ts: 9, type: "task_interrupted", task_id: "t1", returned_input: [], usage: { per_model: {} } }]);
  const w = conversation(ended).find((s) => s.kind === "work" && s.items.length === 3);
  assert.ok(w?.kind === "work" && w.items[2].kind === "tool" && w.items[2].tool.state === "cancelled");
});

test("what is being written goes after the settled steps, which stay the same objects", () => {
  const before: EventMsg[] = [
    { type: "task_started", task_id: "t1" },
    { type: "message_completed", message_id: "u1", message: { role: "user", content: [{ type: "text", text: "hi" }], ts: 1 } },
    assistant("a1", [{ type: "thinking", text: "first" }]),
  ];
  const v = play([...before, { type: "message_started", message_id: "a2", role: "assistant" }, { type: "message_delta", message_id: "a2", delta: { type: "thinking", index: 0, text: "more" } }]);
  const settled = settledSteps(v);
  const [, group] = settled;
  assert.equal(group.kind === "work" && group.items.length, 1);
  const steps = withStreaming(settled, v);
  // The thinking joins the group before it, in a copy.
  assert.equal(steps.length, settled.length);
  assert.ok(steps[0] === settled[0]);
  const joined = steps.at(-1)!;
  assert.deepEqual(joined.kind === "work" && [joined.items.length, joined.live], [2, true]);
  assert.deepEqual(group.kind === "work" && [group.items.length, group.live], [1, false]);
  assert.deepEqual(steps, conversation(v));
  // Nothing being written: the very same list.
  const quiet = play(before);
  const still = settledSteps(quiet);
  assert.equal(withStreaming(still, quiet), still);
});

test("a group's line counts its calls kind by kind; thinking counts only alone", () => {
  const tool = (category: "read" | "execute", state: "done" | "denied" = "done") =>
    ({ kind: "tool", key: Math.random().toString(), tool: { call_id: "", name: "", category, title: "", args: {}, state } }) as const;
  assert.deepEqual(workSummary([tool("read"), tool("execute"), tool("read"), { kind: "thinking", key: "k", text: "", redacted: false, live: false }]), [
    { kind: "read", count: 2 },
    { kind: "execute", count: 1 },
  ]);
  assert.deepEqual(workSummary([tool("execute", "denied")]), [{ kind: "denied", count: 1 }]);
  assert.deepEqual(workSummary([{ kind: "thinking", key: "k", text: "", redacted: false, live: false }]), [{ kind: "thinking", count: 1 }]);
});

test("the built-in tools are described from their arguments, paths relative to the project", () => {
  assert.deepEqual(describe("bash", { command: "cargo test\n--nocapture" }, "/w"), { category: "execute", title: "cargo test …" });
  assert.deepEqual(describe("read", { path: "/w/src/a.rs" }, "/w"), { category: "read", title: "read src/a.rs" });
  assert.deepEqual(describe("write", { path: "/elsewhere/b" }, "/w"), { category: "edit", title: "write /elsewhere/b" });
  assert.equal(toolObject({ name: "read", title: "read src/a.rs", category: "read" }), "src/a.rs");
  assert.equal(toolObject({ name: "bash", title: "read me", category: "execute" }), "read me");
});

test("an approval previews the command, the change, or what is written", () => {
  assert.deepEqual(approvalPreview("bash", { command: "rm -rf build" }, "x"), { kind: "command", text: "rm -rf build" });
  assert.deepEqual(approvalPreview("edit", { path: "a", edits: [{ old_text: "x\ny\n", new_text: "z" }] }, ""), {
    kind: "diff",
    lines: [{ sign: "-", text: "x" }, { sign: "-", text: "y" }, { sign: "+", text: "z" }],
    more: 0,
  });
  const long = approvalPreview("write", { path: "a", content: "1\n2\n3\n4" }, "", 3);
  assert.deepEqual(long, { kind: "content", lines: ["1", "2", "3"], more: 1 });
  assert.deepEqual(approvalPreview("fetch", { url: "u" }, "fetch u"), { kind: "args", text: "fetch u" });
  assert.deepEqual(approvalPreview("browser_eval", { expression: "document.title" }, "run a script on https://a.example"), {
    kind: "content",
    lines: ["document.title"],
    more: 0,
  });
});

test("a message's attached files go to the model as a block of paths and come back as files, not words", () => {
  const content = [{ type: "text", text: "look at these" }, { type: "image", mime_type: "image/png", data: "AAAA" }, attachedBlock(["/w/a.rs", "/w/docs/"])] as const;
  assert.deepEqual(userText([...content]), { text: "look at these", files: ["/w/a.rs", "/w/docs/"], comments: [], quotes: [], said: [], tabs: [] });
  assert.deepEqual(userText([attachedBlock(["/w/b"])]), { text: "", files: ["/w/b"], comments: [], quotes: [], said: [], tabs: [] });
  const web = { url: "https://example.com/", title: "Example", tag: "h1", text: "Hello", selector: "#h", comment: "shorter" };
  assert.deepEqual(userText([{ type: "text", text: "see" }, webCommentBlock([web])]), { text: "see", files: [], comments: [web], quotes: [], said: [], tabs: [] });
  const v = play([{ type: "message_completed", message_id: "u1", message: { role: "user", content: [...content], ts: 1 } }]);
  const [u] = conversation(v);
  assert.ok(u.kind === "user");
  assert.equal(u.text, "look at these");
  assert.deepEqual(u.images, [{ mime_type: "image/png", data: "AAAA" }]);
  assert.deepEqual(u.files, ["/w/a.rs", "/w/docs/"]);
});

test("an attached workbook tells the model to use Finx document tools and remains a file chip", () => {
  const workbook = attachedBlock(["/w/model.XLSX"]);
  assert.equal(workbook.type, "text");
  assert.match(workbook.text, /doc_open, then doc_read/);
  assert.match(workbook.text, /instead of .*shell\/Python/);
  assert.deepEqual(userText([workbook]), { text: "", files: ["/w/model.XLSX"], comments: [], quotes: [], said: [], tabs: [] });

  // Messages written before the workbook hint was added still render as file chips.
  assert.deepEqual(userText([{ type: "text", text: "Attached files:\n/w/old.xlsx" }]), {
    text: "",
    files: ["/w/old.xlsx"],
    comments: [],
    quotes: [],
    said: [],
    tabs: [],
  });
});

test("numbers as the window shows them", () => {
  assert.equal(clockText(252), "4:12");
  assert.equal(clockText(3723), "1:02:03");
  assert.equal(tokensText(950), "950");
  assert.equal(tokensText(1500), "1.5K");
  assert.equal(tokensText(412_000), "412K");
  assert.equal(tokensText(1_800_000), "1.8M");
  assert.equal(costText({ currency: "CNY", total: 0.42 }), "¥0.42");
  assert.equal(costText({ currency: "USD", total: 0.004 }), "$0.0040");
});

test("a coded warning becomes a notice, the latest per code, and leaving bypass-permissions drops its notice", () => {
  const bypass: EventMsg = { type: "warning", message: "Permission mode bypass-permissions: …", code: "bypass_permissions" };
  const mode = (permission_mode: "manual" | "bypass-permissions"): EventMsg => ({ type: "settings_changed", model: "p/m", thinking: "off", permission_mode, context_window: 1000 });
  const v = play([bypass, { type: "warning", message: "nothing to compact" }, bypass]);
  assert.deepEqual(v.notices.map((n) => [n.code, n.ts]), [["bypass_permissions", 1002]]);
  assert.deepEqual(v.entries.map((e) => (e.type === "note" && e.note === "warning" ? e.message : e.type)), ["nothing to compact"]);
  assert.equal(play([bypass, mode("bypass-permissions")]).notices.length, 1);
  assert.deepEqual(play([bypass, mode("manual")]).notices, []);
});

test("a call through call_tool is told as the tool it runs", () => {
  assert.deepEqual(callTarget("call_tool", { name: "cua_snapshot", arguments: { app: "com.apple.finder" } }), { name: "cua_snapshot", args: { app: "com.apple.finder" } });
  assert.deepEqual(callTarget("read", { path: "a" }), { name: "read", args: { path: "a" } });
  assert.deepEqual(callTarget("call_tool", {}), { name: "call_tool", args: {} });
  assert.equal(describe("call_tool", { name: "read", arguments: { path: "/p/a.md" } }, "/p").title, "read a.md");
  assert.deepEqual(describe("call_tool", { name: "web_search", arguments: { query: "贵州茅台 三季报" } }, "/p"), { category: "search", title: "贵州茅台 三季报" });
});

test("quoted parts of documents come back as quotes, and what the column shows is not shown", () => {
  const quote = { path: "/w/合同.pdf", doc_id: "0123456789abcdef", page: 3, text: "违约金为合同总额的 20%", block: "p3.b12" };
  const content = [{ type: "text" as const, text: "这条合理吗" }, docQuoteBlock([quote]), docViewingBlock("/w/合同.pdf", "0123456789abcdef", 3, 12)];
  assert.deepEqual(userText(content), { text: "这条合理吗", files: [], comments: [], quotes: [quote], said: [], tabs: [] });
  assert.match((content[2] as { text: string }).text, /page 3 of 12/);
});

test("a workbook range comes back as a quote, and its live selection is not shown", () => {
  const quote = { path: "/w/model.xlsx", doc_id: "fedcba9876543210", sheet: "利润表", range: "B3:D6", text: "| | B | C | D |" };
  const content = [{ type: "text" as const, text: "分析这个区域" }, docQuoteBlock([quote]), sheetViewingBlock(quote.path, quote.doc_id, quote.sheet, quote.range, "1,344.00")];
  assert.deepEqual(userText(content), { text: "分析这个区域", files: [], comments: [], quotes: [quote], said: [], tabs: [] });
});

test("the open presentation goes along with a message but is not shown", () => {
  const block = presentationViewingBlock("/w/deck.pptx", false);
  assert.match((block as { text: string }).text, /deck\.pptx/);
  assert.equal(userText([{ type: "text", text: "当前打开的ppt内容是啥" }, block]).text, "当前打开的ppt内容是啥");
});

test("files sent with no words tell the model to wait to be asked, and still render as chips", () => {
  const bare = attachedBlock(["/w/book.pdf", "/w/model.xlsx"], true);
  assert.ok(bare.type === "text");
  assert.match(bare.text, /Do not open, read, render or screenshot them yet/);
  assert.match(bare.text, /doc_open, then doc_read/);
  assert.deepEqual(userText([bare]), { text: "", files: ["/w/book.pdf", "/w/model.xlsx"], comments: [], quotes: [], said: [], tabs: [] });
  const asked = attachedBlock(["/w/a.pdf"]);
  assert.ok(asked.type === "text");
  assert.doesNotMatch(asked.text, /Do not open/);
});

test("parts of the conversation come back as quotes, and a broken block stays words", () => {
  const quote: MessageQuote = { role: "assistant", text: "第 3 步：先备份", key: "a1:0", whole: true };
  const doc = { path: "/w/a.pdf", doc_id: "d1", page: 2, text: "原文" };
  const web = { url: "https://a.io", title: "T", tag: "p", text: "t", selector: "p", comment: "" };
  const content = [{ type: "text" as const, text: "这一步怎么做" }, docQuoteBlock([doc]), messageQuoteBlock([quote]), webCommentBlock([web])];
  assert.deepEqual(userText(content), { text: "这一步怎么做", files: [], comments: [web], quotes: [doc], said: [quote], tabs: [] });

  const v = play([{ type: "message_completed", message_id: "u1", message: { role: "user", content, ts: 1 } }]);
  const [u] = conversation(v);
  assert.ok(u.kind === "user");
  assert.deepEqual(u.said, [quote]);

  const empty = (messageQuoteBlock([]) as { type: "text"; text: string }).text;
  const broken = { type: "text" as const, text: empty.slice(0, -3) + "not json" };
  const wrong = { type: "text" as const, text: empty + JSON.stringify([{ role: "system", text: "x", key: "k" }]) };
  for (const bad of [broken, wrong]) assert.deepEqual(userText([bad]), { text: bad.text, files: [], comments: [], quotes: [], said: [], tabs: [] });
});

/** A session as it came back from disk: its transcript in the snapshot. */
function restored(items: TranscriptItem[]): SessionView {
  return fromSnapshot({ session: info, last_seq: items.length, transcript: { items }, usage: { per_model: {} } });
}

const userItem = (id: string, text: string): TranscriptItem => ({ type: "message", message_id: id, message: { role: "user", content: [{ type: "text", text }], ts: 1 } });
const saidItem = (id: string, text: string): TranscriptItem => ({ type: "message", message_id: id, message: { role: "assistant", content: [{ type: "text", text }], provider: "p", api: "a", model: "m", usage, stop_reason: "stop", ts: 1 } });

test("a quote is cut by what the model can still see, and says so from the snapshot on", () => {
  const fragment: MessageQuote = { role: "assistant", text: "字".repeat(2500), key: "a2:0" };
  const whole: MessageQuote = { role: "assistant", text: "字".repeat(300), key: "a2:0", whole: true };

  // In this window: the message came after the snapshot, so it is in the context.
  const live = play([{ type: "message_completed", message_id: "a2", message: { role: "assistant", content: [{ type: "text", text: "字".repeat(2500) }], provider: "p", api: "a", model: "m", usage, stop_reason: "stop", ts: 2 } }]);
  for (const [quote, most] of [[fragment, 2000], [whole, 200]] as [MessageQuote, number][]) {
    const cut = quoteForSend(quote, live);
    assert.ok(Array.from(cut.text).length <= most);
    assert.equal(cut.excerpt, true);
    assert.equal(cut.cut, undefined);
  }

  // In the snapshot from disk: it may have been compacted, so all of it goes, up to 8000.
  const fromDisk = restored([userItem("u1", "问题"), saidItem("a2", "字".repeat(9000))]);
  const cut = quoteForSend({ ...fragment, text: "字".repeat(9000) }, fromDisk);
  assert.ok(Array.from(cut.text).length <= 8000);
  assert.equal(cut.cut, true);
  assert.equal(cut.excerpt, undefined);

  // A compaction seen after the snapshot ends the context: what came before it may be gone.
  const before = applyEvents(fromDisk, [{ seq: 3, ts: 3, type: "compaction_completed", reason: "threshold", tokens_before: 10, tokens_after: 1 }] as Event[]);
  assert.equal(quoteForSend({ ...whole, text: "字".repeat(9000) }, before).cut, true);

  // A message that arrives after that is in the context again.
  const after = applyEvents(before, [{ seq: 4, ts: 4, type: "message_completed", message_id: "a3", message: { role: "assistant", content: [{ type: "text", text: "字".repeat(9000) }], provider: "p", api: "a", model: "m", usage, stop_reason: "stop", ts: 4 } }] as Event[]);
  const fresh = quoteForSend({ ...whole, text: "字".repeat(9000), key: "a3:0" }, after);
  assert.equal(fresh.excerpt, true);
  assert.equal(fresh.cut, undefined);
});

test("a cut quote is sent as it came back", () => {
  const q: MessageQuote = { role: "user", text: "只带了开头", key: "u1", cut: true };
  assert.equal(quoteForSend(q, play([])), q);
});

test("cutting stops at a sentence's end or between words", () => {
  const view = (text: string) =>
    play([{ type: "message_completed", message_id: "a9", message: { role: "assistant", content: [{ type: "text", text }], provider: "p", api: "a", model: "m", usage, stop_reason: "stop", ts: 2 } }]);
  const china = quoteForSend({ role: "assistant", text: "第一句话。".repeat(500), key: "a9:0" }, view("第一句话。".repeat(500)));
  assert.ok(china.text.endsWith("。"), china.text.slice(-10));
  assert.ok(Array.from(china.text).length <= 2000);
  const english = quoteForSend({ role: "assistant", text: "word ".repeat(500), key: "a9:0" }, view("word ".repeat(500)));
  assert.ok(english.text.endsWith("word"), english.text.slice(-10));
  assert.ok(Array.from(english.text).length <= 2000);
});

test("a whole quote is rebuilt from the step it came from", () => {
  const v = play([
    { type: "message_completed", message_id: "u1", message: { role: "user", content: [{ type: "text", text: "按第二种来" }], ts: 1 } },
    { type: "message_completed", message_id: "a1", message: { role: "assistant", content: [{ type: "text", text: "## 方案\n\n一是……" }], provider: "p", api: "a", model: "m", usage, stop_reason: "stop", ts: 2 } },
  ]);
  assert.equal(quoteTextOf(v, "u1"), "按第二种来");
  assert.equal(quoteTextOf(v, "a1:0"), "## 方案\n\n一是……");
  assert.equal(quoteTextOf(v, "a1:1"), null);
  assert.equal(quoteTextOf(v, "gone"), null);
});

test("an excerpt whose message a compaction has since taken is sent as a cut", () => {
  const words = "字".repeat(10);
  const excerpt: MessageQuote = { role: "assistant", text: words, key: "a2:0", excerpt: true };
  const live = play([{ type: "message_completed", message_id: "a2", message: { role: "assistant", content: [{ type: "text", text: words }], provider: "p", api: "a", model: "m", usage, stop_reason: "stop", ts: 2 } }]);
  assert.equal(quoteForSend(excerpt, live).excerpt, true);
  // Back from disk in the snapshot: it may have been compacted, so the model must not be sent looking for it.
  const disk = restored([userItem("u1", "问题"), saidItem("a2", words)]);
  const sent = quoteForSend(excerpt, disk);
  assert.equal(sent.cut, true);
  assert.equal(sent.excerpt, undefined);
  assert.equal(sent.text, words);
  // A cut stays a cut, even if the message is in the context again.
  const cut: MessageQuote = { role: "assistant", text: words, key: "a2:0", cut: true };
  assert.equal(quoteForSend(cut, live).cut, true);
});

test("a quote is gone with a rewind, or when nothing of it is here and nothing older can load", () => {
  const q: MessageQuote = { role: "assistant", text: "字", key: "a1:0" };
  assert.equal(quoteIsGone(q, new Set(["a1:0"]), { partial: false }), false);
  assert.equal(quoteIsGone(q, new Set(), { partial: true }), false, "an older page may still hold it");
  assert.equal(quoteIsGone(q, new Set(), { partial: false }), true);
  assert.equal(quoteIsGone(q, new Set(["b"]), { partial: true, retracted: ["a1"] }), true, "a rewind says so at once");
  assert.equal(messageIdOf("a1:2"), "a1");
  assert.equal(messageIdOf("u1"), "u1");
});
