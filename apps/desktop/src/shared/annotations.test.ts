import assert from "node:assert/strict";
import { test } from "node:test";
import { webComment } from "./annotations.ts";

test("a page comment takes the tab's URL and title, the person's words trimmed", () => {
  const anchor = { selector: "#h", tag: "h1", text: "Hello", x: .5, y: .5 };
  assert.deepEqual(webComment("https://example.com/", "Example", { anchor, body: "  shorter <b>  " }),
    { url: "https://example.com/", title: "Example", tag: "h1", text: "Hello", selector: "#h", comment: "shorter <b>" });
  assert.equal(webComment("https://example.com/", "", { anchor, body: "" }).comment, "");
  for (const bad of [{ anchor, body: "x".repeat(4001) }, { anchor: { ...anchor, x: 2 }, body: "" }, { anchor: { ...anchor, selector: "" }, body: "" }, { anchor }]) {
    assert.throws(() => webComment("https://example.com/", "", bad));
  }
});
