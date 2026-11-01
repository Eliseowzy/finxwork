import assert from "node:assert/strict";
import { test } from "node:test";
import { typedURL } from "./url.ts";

test("what the person types becomes a URL to open, or nothing", () => {
  assert.equal(typedURL("example.com"), "https://example.com");
  assert.equal(typedURL("  github.com/finx  "), "https://github.com/finx");
  assert.equal(typedURL("localhost:5173"), "http://localhost:5173");
  assert.equal(typedURL("127.0.0.1:3000/app"), "http://127.0.0.1:3000/app");
  assert.equal(typedURL("example.com:8443/x"), "https://example.com:8443/x");
  assert.equal(typedURL("http://example.com"), "http://example.com");
  assert.equal(typedURL("about:blank"), "about:blank");
  for (const refused of ["", "   ", "javascript:alert(1)", "chrome://settings", "data:text/html,hi", "two words"]) {
    assert.equal(typedURL(refused), null, refused);
  }
});
