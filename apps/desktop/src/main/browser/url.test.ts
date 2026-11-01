import assert from "node:assert/strict";
import { test } from "node:test";
import { browserUserAgent, typedURL } from "./url.ts";

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

test("sites see Chrome's user agent, not Electron's or the app's", () => {
  const electron =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) FinxWork/0.1.0 Chrome/146.0.7680.31 Electron/44.9.0 Safari/537.36";
  assert.equal(
    browserUserAgent(electron),
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.31 Safari/537.36",
  );
});
