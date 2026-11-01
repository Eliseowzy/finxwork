import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptLanguage, chromeOverride, clientHintHeaders, hintsGo } from "./identity.ts";

const ua =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) FinxWork/0.1.0 Chrome/152.0.7977.167 Electron/42.0.0 Safari/537.36";

test("a tab tells sites the same Chrome in its user agent and its client hints", () => {
  const o = chromeOverride(ua, "152.0.7977.167", "zh-CN", { os: "darwin", arch: "arm64", systemVersion: "26.2.0" });
  assert.equal(o.userAgent, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36");
  const m = o.userAgentMetadata;
  assert.deepEqual(m.brands.map((b) => `${b.brand} ${b.version}`), ["Not?A_Brand 24", "Chromium 152", "Google Chrome 152"]);
  assert.deepEqual(m.fullVersionList.map((b) => b.version), ["24.0.0.0", "152.0.7977.167", "152.0.7977.167"]);
  assert.equal(m.platform, "macOS");
  assert.equal(m.platformVersion, "26.2.0");
  assert.equal(m.architecture, "arm");
  assert.equal(m.bitness, "64");
  assert.equal(m.mobile, false);
  assert.equal(o.platform, "MacIntel");
  assert.equal(o.acceptLanguage, "zh-CN,zh");
  const intel = chromeOverride(ua, "152.0.7977.167", "en", { os: "darwin", arch: "x64", systemVersion: "15.6.0" });
  assert.equal(intel.userAgentMetadata.architecture, "x86");
});

test("the languages follow the app's", () => {
  assert.equal(acceptLanguage("zh-CN"), "zh-CN,zh");
  assert.equal(acceptLanguage("en"), "en-US,en");
});

test("the client hint headers name the same brands, and go to secure origins only", () => {
  assert.deepEqual(clientHintHeaders("152.0.7977.167", "darwin"), {
    "sec-ch-ua": '"Not?A_Brand";v="24", "Chromium";v="152", "Google Chrome";v="152"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
  });
  for (const url of ["https://www.baidu.com/s?wd=x", "http://localhost:5173/", "http://127.0.0.1:3000", "wss://example.com/socket"]) assert.ok(hintsGo(url), url);
  for (const url of ["http://example.com/", "file:///tmp/a.html", "about:blank", "data:text/plain,x", "nonsense"]) assert.ok(!hintsGo(url), url);
});
