import assert from "node:assert/strict";
import { test } from "node:test";
import { handedTabBlock, handedTabsBlock, docViewingBlock, type DocQuote, type WebComment } from "@finx/client";
import { docAttachment, fromInput, toInput, webAttachment, type Attachment } from "./attachments.ts";

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
  const sent = toInput("全都有", [file, image("a"), webAttachment(comment("c1"), "SHOT-W"), image("b"), docAttachment(quote("q1"), "SHOT-D"), folder]);
  const back = fromInput(sent);
  assert.equal(back.text, "全都有");
  assert.deepEqual(back.attachments.map((a) => a.kind), ["image", "image", "file", "folder", "web", "doc"]);
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
  // The document in view is said again when it is sent, as it is then.
  const viewing = fromInput([words, docViewingBlock("/work/a.pdf", "d1", 3, 10)]);
  assert.equal(viewing.text, words.text);
  assert.deepEqual(viewing.attachments, []);
  // Handed-over tabs stay the session's: their block goes along, as it was.
  for (const block of [handedTabBlock("Inbox", "https://mail.a.io/"), handedTabsBlock([{ url: "https://a.io", title: "A", current: true }])]) {
    const sent = [words, block];
    const back = fromInput(sent);
    assert.equal(back.text, words.text);
    assert.deepEqual(back.attachments.map((a) => a.kind), ["tabs"]);
    assert.deepEqual(toInput(back.text, back.attachments), sent);
  }
});
