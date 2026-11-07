import assert from "node:assert/strict";
import { test } from "node:test";
import { faceCatalog, setBundledFontLoader, setFontQuery } from "../pptx/fonts.ts";
import { providerFor } from "./fonts.ts";

const face = (family: string, style: string, size = 4) => ({
  family, style, fullName: `${family} ${style}`, postscriptName: `${family}-${style}`.replace(/\s/g, ""),
  blob: async () => ({ size, arrayBuffer: async () => new Uint8Array(size).fill(family.length).buffer }) as Blob,
});
const MAC = [
  face("PingFang SC", "Regular"), face("PingFang SC", "Semibold"), face("Songti SC", "Regular"), face("Songti SC", "Bold"),
  face("Heiti SC", "Medium"), face("Arial", "Regular"), face("Arial", "Bold"), face("Times New Roman", "Regular"),
];

async function provider() {
  setFontQuery(async () => MAC);
  setBundledFontLoader(async (file) => new TextEncoder().encode(file));
  return providerFor(await faceCatalog());
}
const text = async (load: (() => Promise<ArrayBuffer>) | undefined) => load && new TextDecoder().decode(await load());

test("Calibri and Cambria measure as themselves on the bundled Carlito/Caladea faces", async () => {
  const p = await provider();
  const calibri = p.resolve("Calibri", true, false)!;
  assert.equal(calibri.measureAs, "Calibri");
  assert.equal(await text(calibri), "Carlito-Bold.ttf");
  assert.equal(await text(p.resolve("Cambria", false, true)), "Caladea-Italic.ttf");
});

test("Chinese families resolve to the machine's Chinese faces, Windows names included", async () => {
  const p = await provider();
  assert.equal((await p.resolve("宋体", false, false)!()).byteLength, 4);
  assert.ok(p.resolve("SimSun", true, false));
  assert.ok(p.resolve("黑体", false, false));
  assert.ok(p.resolve("Microsoft YaHei", false, false));
  assert.equal(p.resolve("No Such Font", false, false), undefined);
});

test("Chinese text never lacks a face: script and per-family fallbacks are system CJK faces", async () => {
  const p = await provider();
  const bytes = async (load: (() => Promise<ArrayBuffer>) | undefined) => new Uint8Array(await load!())[0];
  assert.equal(await bytes(p.resolveScriptFallback!("cjk-sc", false, false)), "PingFang SC".length);
  // Calibri (a stand-in) draws its Chinese in PingFang, Cambria's in Songti.
  assert.equal(await bytes(p.resolveGlyphFallback!("Calibri", false, false)), "PingFang SC".length);
  assert.equal(await bytes(p.resolveGlyphFallback!("Cambria", false, false)), "Songti SC".length);
});

test("an unknown family falls back to Arial or Times New Roman only when nothing else loads", async () => {
  const p = await provider();
  const sans = p.resolveLastResort!("Segoe UI", false, false)!;
  assert.equal(sans.onlyIfPrimaryFails, true);
  assert.equal(new Uint8Array(await sans())[0], "Arial".length);
  assert.equal(new Uint8Array(await p.resolveLastResort!("Times", false, false)!())[0], "Times New Roman".length);
});
