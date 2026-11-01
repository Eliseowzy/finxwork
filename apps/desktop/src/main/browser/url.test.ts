import assert from "node:assert/strict";
import { test } from "node:test";
import { allEngines, engineProblem, savedEngines, templateOf } from "../../shared/search.ts";
import { browserUserAgent, typedURL } from "./url.ts";

const google = (q: string) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;

test("an address is opened", () => {
  assert.equal(typedURL("example.com"), "https://example.com");
  assert.equal(typedURL("  github.com/finx  "), "https://github.com/finx");
  assert.equal(typedURL("news.bbc.co.uk/x?y#z"), "https://news.bbc.co.uk/x?y#z");
  assert.equal(typedURL("百度.中国"), "https://百度.中国");
  assert.equal(typedURL("localhost:5173"), "http://localhost:5173");
  assert.equal(typedURL("app.localhost"), "http://app.localhost");
  assert.equal(typedURL("127.0.0.1:3000/app"), "http://127.0.0.1:3000/app");
  assert.equal(typedURL("192.168.1.10:8080"), "https://192.168.1.10:8080");
  assert.equal(typedURL("myserver:8080"), "https://myserver:8080");
  assert.equal(typedURL("example.com:8443/x"), "https://example.com:8443/x");
  assert.equal(typedURL("http://example.com"), "http://example.com");
  assert.equal(typedURL("about:blank"), "about:blank");
});

test("text that is not an address is searched for, with the default engine", () => {
  for (const words of ["two words", "finxwork", "readme.txt", "v1.2", "如何 使用 a&b?", "intranet.corp", "999.1.1.1"]) {
    assert.equal(typedURL(words), google(words), words);
  }
  assert.equal(typedURL("天气", { engine: "baidu" }), "https://www.baidu.com/s?wd=%E5%A4%A9%E6%B0%94");
  assert.equal(typedURL("example.com", { engine: "baidu" }), "https://example.com", "an address is opened, whatever the engine");
  assert.equal(typedURL("x", { engine: "gone" }), google("x"), "an engine that is no more: the default");
});

test("nothing opens for nothing, or for schemes the panel does not open", () => {
  for (const refused of ["", "   ", "javascript:alert(1)", "chrome://settings", "data:text/html,hi"]) {
    assert.equal(typedURL(refused), null, refused);
  }
});

test("a keyword picks the engine", () => {
  assert.equal(typedURL("baidu.com 天气"), "https://www.baidu.com/s?wd=%E5%A4%A9%E6%B0%94");
  assert.equal(typedURL("BING.com rust"), "https://www.bing.com/search?q=rust");
  assert.equal(typedURL("example.com", { keyword: "duckduckgo" }), "https://duckduckgo.com/?q=example.com", "keyword mode always searches");
  const engines = allEngines(savedEngines([{ id: "custom-wiki", name: "Wiki", keyword: "wk", url: "https://zh.wikipedia.org/w/index.php?search=%s" }]));
  assert.equal(typedURL("wk 北京", { engines }), "https://zh.wikipedia.org/w/index.php?search=%E5%8C%97%E4%BA%AC");
  assert.equal(typedURL("wk", { engines }), google("wk"), "a keyword alone is searched for");
});

test("the person's engines are checked before they are kept", () => {
  assert.equal(templateOf("https://s.example.com/?q=%s"), "https://s.example.com/?q={searchTerms}");
  assert.equal(templateOf("https://s.example.com/?q="), null, "no place for the words");
  assert.equal(templateOf("javascript:{searchTerms}"), null);
  const engines = allEngines();
  assert.equal(engineProblem({ name: "Wiki", keyword: "wk", url: "https://w.org/?s=%s" }, engines), null);
  assert.equal(engineProblem({ name: "", keyword: "wk", url: "https://w.org/?s=%s" }, engines), "name");
  assert.equal(engineProblem({ name: "Wiki", keyword: "w k", url: "https://w.org/?s=%s" }, engines), "keyword");
  assert.equal(engineProblem({ name: "Wiki", keyword: "Baidu.com", url: "https://w.org/?s=%s" }, engines), "keywordTaken");
  assert.equal(engineProblem({ name: "Wiki", keyword: "wk", url: "https://w.org/" }, engines), "url");
  // A saved file is trusted for nothing: bad entries and second takers of a keyword are dropped.
  const saved = savedEngines([
    { id: "custom-a", name: "A", keyword: "a", url: "https://a.org/?q=%s" },
    { id: "custom-b", name: "B", keyword: "A", url: "https://b.org/?q=%s" },
    { id: "custom-c", name: "C", keyword: "c", url: "file:///etc/{searchTerms}" },
    { id: "google", name: "Fake", keyword: "f", url: "https://f.org/?q=%s" },
    "junk",
  ]);
  assert.deepEqual(saved.map((e) => e.id), ["custom-a"]);
  assert.equal(saved[0].url, "https://a.org/?q={searchTerms}");
});

test("sites see Chrome's user agent, not Electron's or the app's, with Chrome's reduced version", () => {
  const electron =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) FinxWork/0.1.0 Chrome/146.0.7680.31 Electron/44.9.0 Safari/537.36";
  assert.equal(
    browserUserAgent(electron),
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
  );
});
