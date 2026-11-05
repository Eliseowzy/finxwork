import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import gfm from "remark-gfm";
import math from "remark-math";
import directive from "remark-directive";
import { createMarkdownSlices, pendingText } from "./parse.ts";

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [gfm, [math, { singleDollarTextMath: false }], directive], children: text })).replace(/>\s+</g, "><");
const cases = [
  "Intro\n\n1. first\n\n2. second\n\nEnd",
  "[!reference]\n\n[!reference]: https://example.com",
  "```bad`info\n[ref]\n\n[ref]: https://example.com",
  "`unclosed [ref]\n\n[ref]: https://example.com",
  "Read [doc][r].\n\n[r]: https://example.com",
  "A[^1].\n\n[^1]: source",
  "````md\n```js\n\nexample\n```\n````\n\nDone",
  "```text\n| a | b |\n```",
  "# 标题\n\n正文\n\n下一段。\n\n标题二\n---\n\n最后",
  "| A | B |\n|---|---|\n| a\\|b | `x` |\n\nEnd",
  "> one\n>\n> two\n\n> three\n\nEnd",
  "- first\n\n  second paragraph\n\n  - nested\n\n- next\n\nEnd",
  "$$\nx^2 + y^2\n$$\n\n$100 and $200",
  ':::details{title="Details"}\nInside\n\nMore\n:::\n\nEnd',
];
for (const text of cases) test(`chunk invariant: ${text.slice(0, 35)}`, () => {
  for (const size of [1, 3, 11, text.length]) {
    const split = createMarkdownSlices();
    for (let i = size; i < text.length; i += size) split(text.slice(0, i), true);
    const live = split(text, true);
    const final = split(text, false);
    assert.deepEqual(live.map((b) => b.id), final.map((b) => b.id));
    assert.equal(final.map((b) => render(b.text)).join(""), render(text));
  }
});

test("code and escaped pipes never disappear as provisional tables", () => {
  assert.equal(pendingText("```text\n| a | b |"), "```text\n| a | b |");
  assert.equal(pendingText("|a|b|"), "");
  const table = "|a|b|\n|-|-|\n|x\\|y|z|";
  assert.equal(pendingText(table), table);
});
test("replaced source resets cached prefixes", () => {
  const split = createMarkdownSlices();
  split("# old\n\nold tail", true);
  assert.equal(split("# new\n\nnew tail", false).map((b) => render(b.text)).join(""), render("# new\n\nnew tail"));
});
