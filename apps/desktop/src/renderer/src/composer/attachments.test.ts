import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEvents, fromSnapshot, handedTabBlock, handedTabsBlock, docViewingBlock, sheetViewingBlock, type DocQuote, type MessageQuote, type WebComment } from "@finx/client";
import type { Event, SessionInfo, Usage } from "@finx/protocol";
import { addAttachments, docAttachment, fromInput, saidAttachment, saidWords, toInput, webAttachment, type Attachment } from "./attachments.ts";

// A message taken back comes to the composer as it was, and sent again it says the same
// (message-resend-design §5.4).

const image = (n: string): Attachment => ({ kind: "image", path: `/tmp/${n}.png`, name: `${n}.png`, mime_type: "image/png", data: `DATA-${n}` });
const file: Attachment = { kind: "file", path: "/work/报告 草稿.xlsx", name: "报告 草稿.xlsx" };
const folder: Attachment = { kind: "folder", path: "/work/data", name: "data" };
const comment = (c: string): WebComment => ({ url: "https://a.io/x", title: "T", tag: "div", text: "t", selector: "div.x", comment: c });
const quote = (text: string): DocQuote => ({ path: "/work/a.pdf", doc_id: "d1", page: 3, text });

/** What the owner sees of an attachment and the model gets; a name or a path the message never carried aside. */
const seen = (a: Attachment) => {
  switch (a.kind) {
    case "image":
      return { kind: a.kind, mime_type: a.mime_type, data: a.data };
    case "web":
      return { kind: a.kind, comment: { ...a.comment, image: undefined }, shot: a.image };
    case "doc":
      return { kind: a.kind, quote: { ...a.quote, image: undefined }, shot: a.image };
    case "tabs":
      return { kind: a.kind, block: a.block };
    case "said":
      return { kind: a.kind, path: a.path, name: a.name, quote: a.quote };
    default:
      return { kind: a.kind, path: a.path, name: a.name };
  }
};

for (const [name, text, attachments] of [
  ["words alone", "把报告改成三段式", []],
  ["a skill's mention", "/skill:review 看一下 /skill:lint", []],
  ["several lines", "第一行\n\n第三行", []],
  ["images", "看图", [image("a"), image("b")]],
  ["no words", "", [image("a"), file]],
  ["a file and a folder", "看这些", [file, folder]],
  ["parts of pages, with a picture and without", "看这里", [webAttachment(comment("这里"), "SHOT"), webAttachment(comment("那里"))]],
  ["quotes, with a picture and without", "看这段", [docAttachment(quote("q1"), "SHOT"), docAttachment(quote("q2"))]],
  ["parts of the conversation", "看这里", [saidAttachment({ role: "assistant", text: "第 3 步：先备份", key: "a1:0", whole: true }), saidAttachment({ role: "user", text: "按第二种来", key: "u1" })]],
] as [string, string, Attachment[]][]) {
  test(`${name}: back as it was, and the same when sent again`, () => {
    const sent = toInput(text, attachments);
    const back = fromInput(sent);
    assert.equal(back.text, text);
    assert.deepEqual(back.attachments.map(seen), attachments.map(seen));
    assert.deepEqual(toInput(back.text, back.attachments), sent);
  });
}

test("all kinds at once: grouped as the bubble shows them, and each picture still the right one", () => {
  const sent = toInput("全都有", [file, image("a"), webAttachment(comment("c1"), "SHOT-W"), image("b"), docAttachment(quote("q1"), "SHOT-D"), folder, saidAttachment({ role: "assistant", text: "看这里", key: "a1:0" })]);
  const back = fromInput(sent);
  assert.equal(back.text, "全都有");
  assert.deepEqual(back.attachments.map((a) => a.kind), ["image", "image", "file", "folder", "web", "doc", "said"]);
  const web = back.attachments.find((a) => a.kind === "web");
  const doc = back.attachments.find((a) => a.kind === "doc");
  assert.ok(web?.kind === "web" && doc?.kind === "doc");
  assert.equal(web.image, "SHOT-W");
  assert.equal(doc.image, "SHOT-D");
  // Sent again, the numbers follow where the pictures went.
  const again = toInput(back.text, back.attachments);
  const images = again.flatMap((c) => (c.type === "image" ? [c.data] : []));
  assert.deepEqual([...images].sort(), ["DATA-a", "DATA-b", "SHOT-D", "SHOT-W"]);
  const trip = fromInput(again);
  const webAgain = trip.attachments.find((a) => a.kind === "web");
  const docAgain = trip.attachments.find((a) => a.kind === "doc");
  assert.ok(webAgain?.kind === "web" && docAgain?.kind === "doc");
  assert.equal(webAgain.image, "SHOT-W");
  assert.equal(docAgain.image, "SHOT-D");
  assert.deepEqual(trip.attachments.map(seen), back.attachments.map(seen), "a second trip changes nothing");
});

test("what the app adds by itself is not the owner's words", () => {
  const words = { type: "text" as const, text: "这一页说的对吗" };
  // What the panel shows is said again when it is sent, as it is then.
  for (const block of [docViewingBlock("/work/a.pdf", "d1", 3, 10), sheetViewingBlock("/work/a.xlsx", "d2", "Sheet1", "A1", "12")]) {
    const viewing = fromInput([words, block]);
    assert.equal(viewing.text, words.text);
    assert.deepEqual(viewing.attachments, []);
  }
  // Handed-over tabs stay the session's: their block goes along, as it was.
  for (const block of [handedTabBlock("Inbox", "https://mail.a.io/"), handedTabsBlock([{ url: "https://a.io", title: "A", current: true }])]) {
    const sent = [words, block];
    const back = fromInput(sent);
    assert.equal(back.text, words.text);
    assert.deepEqual(back.attachments.map((a) => a.kind), ["tabs"]);
    assert.deepEqual(toInput(back.text, back.attachments), sent);
  }
});

const info: SessionInfo = { session_id: "s", cwd: "/w", session_file: "/f.jsonl", model: "p/m", thinking: "off", permission_mode: "manual", context_window: 1000, archived: false };
const usage: Usage = { input: 1, output: 1, cache_read: 0, cache_write: 0, cost: { currency: "USD", input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 } };

/** A conversation whose messages came in this window: `u1` is a user message, `a1:0` its reply. */
function conversationView(): ReturnType<typeof fromSnapshot> {
  const events = [
    { seq: 1, ts: 1, type: "message_completed", message_id: "u1", message: { role: "user", content: [{ type: "text", text: "按第二种来" }], ts: 1 } },
    { seq: 2, ts: 2, type: "message_completed", message_id: "a1", message: { role: "assistant", content: [{ type: "text", text: "## 方案\n\n一是……" }], provider: "p", api: "a", model: "m", usage, stop_reason: "stop", ts: 2 } },
  ] as Event[];
  return applyEvents(fromSnapshot({ session: info, last_seq: 0, transcript: { items: [] }, usage: { per_model: {} } }), events);
}

test("a whole quote comes back from the conversation, a fragment keeps the start it was sent with", () => {
  const whole: MessageQuote = { role: "user", text: "按第二", key: "u1", whole: true, excerpt: true };
  const fragment: MessageQuote = { role: "assistant", text: "先备份", key: "a1:0", cut: true };
  const sent = toInput("", [saidAttachment(whole), saidAttachment(fragment)]);
  const back = fromInput(sent, conversationView());
  const said = back.attachments.filter((a): a is Extract<Attachment, { kind: "said" }> => a.kind === "said");
  assert.equal(said[0].quote.text, "按第二种来");
  assert.equal(said[0].quote.excerpt, undefined);
  assert.equal(said[1].quote.text, "先备份");
  assert.equal(said[1].quote.cut, true);
  // With the step gone, what was sent is all there is.
  assert.deepEqual(fromInput(sent).attachments.map(seen), [saidAttachment({ ...whole }), saidAttachment({ ...fragment })].map(seen));
});

test("the same words quoted twice are one tile", () => {
  const one = saidAttachment({ role: "assistant", text: "同一段话", key: "a1:0" });
  const two = saidAttachment({ role: "assistant", text: "同一段话", key: "a1:0" });
  assert.equal(one.path, two.path);
  assert.deepEqual(addAttachments([one], [two]), [one]);
  const other = saidAttachment({ role: "assistant", text: "同一段话", key: "a1:1" });
  assert.notEqual(one.path, other.path);
});

test("a whole quote's card drops the Markdown marks, a fragment's words stay as selected", () => {
  const whole: MessageQuote = { role: "assistant", text: "## 方案\n\n**一是**先 `备份`。\n\n```ts\nconst a = 1;\n```", key: "a1:0", whole: true };
  assert.equal(saidWords(whole), "方案\n\n一是先 备份。\n\nconst a = 1;");
  const name = saidAttachment(whole).name;
  assert.ok(!name.includes("#") && !name.includes("*") && !name.includes("`"), name);
  assert.ok(name.includes("方案"), name);
  const fragment: MessageQuote = { role: "assistant", text: "a * b `c`", key: "a1:0" };
  assert.equal(saidWords(fragment), "a * b `c`");
});
