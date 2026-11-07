import assert from "node:assert/strict";
import { test } from "node:test";
import { isCjk, listFonts, loadFonts, MAX_FACE_BYTES, setBundledFontLoader, setFontQuery } from "./fonts.ts";

const face = (family: string, style: string, fullName = `${family} ${style}`, size = 4) => ({
  family, style, fullName, postscriptName: `${family}-${style}`.replace(/\s/g, ""),
  blob: async () => ({ size, arrayBuffer: async () => new ArrayBuffer(size) }) as Blob,
});

test("faces come from queryLocalFonts; oversize or missing faces are skipped", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  setFontQuery(async () => [
    face("Calibri", "Regular"), face("Calibri", "Italic"), face("Calibri", "Bold"), face("Calibri", "Bold Italic"),
    face("Heiti SC", "Light", "黑体-简 细体", MAX_FACE_BYTES + 1), face("Heiti SC", "Medium", "黑体-简 中等", MAX_FACE_BYTES + 1),
  ]);
  const steps: number[] = [];
  const faces = await loadFonts(["Heiti SC", "Calibri"], (p) => steps.push(p.completed));
  assert.deepEqual(faces.map((f) => [f.family, f.bold, f.italic]), [
    ["Calibri", false, false], ["Calibri", false, true], ["Calibri", true, false], ["Calibri", true, true],
  ]);
  assert.equal(steps.at(-1), 6);
  assert.ok(warn.mock.callCount() >= 1);
});

test("Chinese names are found, listed and loaded without italic faces", async () => {
  setFontQuery(async () => [face("Kaiti SC", "Regular", "楷体-简 常规体"), face("Kaiti SC", "Bold", "楷体-简 粗体")]);
  assert.deepEqual((await listFonts()).filter((f) => !f.substitute), [{ family: "Kaiti SC", localized: "楷体-简" }]);
  const faces = await loadFonts(["楷体-简"], () => {});
  assert.deepEqual(faces.map((f) => [f.family, f.bold, f.italic]), [["楷体-简", false, false], ["楷体-简", true, false]]);
  for (const family of ["PingFang SC", "Noto Sans CJK SC", "宋体"]) assert.ok(isCjk(family));
});

const bundled = (file: string) => Uint8Array.from([...file].map((c) => c.charCodeAt(0)));
const asText = (bytes: Uint8Array) => String.fromCharCode(...bytes);

test("a Calibri or Cambria the machine lacks is drawn with Carlito or Caladea, under the deck's own name", async () => {
  const asked: string[] = [];
  setBundledFontLoader(async (file) => { asked.push(file); return bundled(file); });
  setFontQuery(async () => [face("Arial", "Regular")]);
  const faces = await loadFonts(["Calibri", "Calibri Light", "Cambria", "Carlito"], () => {});
  assert.equal(faces.length, 16);
  const calibri = faces.filter((f) => f.family === "Calibri");
  assert.deepEqual(calibri.map((f) => [f.bold, f.italic, asText(f.bytes)]), [
    [false, false, "Carlito-Regular.ttf"], [false, true, "Carlito-Italic.ttf"], [true, false, "Carlito-Bold.ttf"], [true, true, "Carlito-BoldItalic.ttf"],
  ]);
  assert.equal(asText(faces.find((f) => f.family === "Calibri Light" && !f.bold && f.italic)!.bytes), "Carlito-Italic.ttf");
  assert.equal(asText(faces.find((f) => f.family === "Cambria" && f.bold && f.italic)!.bytes), "Caladea-BoldItalic.ttf");
  assert.equal(asText(faces.find((f) => f.family === "Carlito" && !f.bold && !f.italic)!.bytes), "Carlito-Regular.ttf");
});

test("an installed Calibri wins over the bundled stand-in, and other missing families get none", async () => {
  const asked: string[] = [];
  setBundledFontLoader(async (file) => { asked.push(file); return bundled(file); });
  setFontQuery(async () => [face("Calibri", "Regular"), face("Calibri", "Bold")]);
  const faces = await loadFonts(["Calibri", "Comic Sans MS"], () => {});
  assert.deepEqual(faces.map((f) => [f.family, f.bold, f.italic, f.bytes.length]), [["Calibri", false, false, 4], ["Calibri", true, false, 4]]);
  assert.deepEqual(asked, []);
});

test("the font menu lists Calibri and Cambria as substitutes only when the machine lacks them", async () => {
  setFontQuery(async () => [face("Arial", "Regular")]);
  assert.deepEqual(await listFonts(), [
    { family: "Arial", localized: null },
    { family: "Calibri", substitute: "Carlito" },
    { family: "Calibri Light", substitute: "Carlito" },
    { family: "Cambria", substitute: "Caladea" },
  ]);
  setFontQuery(async () => [face("Calibri", "Regular"), face("Calibri Light", "Regular"), face("Cambria", "Regular")]);
  assert.ok((await listFonts()).every((f) => !f.substitute));
});
