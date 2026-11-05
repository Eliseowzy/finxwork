import assert from "node:assert/strict";
import { test } from "node:test";
import { editTextOf, inputOp, isHardcoded, lensAt, lensText, parseTsv, pasteOps, readable, selectionStats, sizeKey, sizesOf, statText, toMarkdown, toTsv, withLens, type Lens } from "./model.ts";

test("what is typed reads as Excel reads it", () => {
  const v = (raw: string) => inputOp("S", "A1", raw);
  assert.deepEqual(v(""), { op: "clear", sheet: "S", range: "A1" });
  assert.deepEqual(v("  "), { op: "clear", sheet: "S", range: "A1" });
  assert.deepEqual(v("=SUM(B1:B3)"), { op: "set_formula", sheet: "S", cell: "A1", formula: "=SUM(B1:B3)" });
  assert.deepEqual(v("="), { op: "set_value", sheet: "S", cell: "A1", value: "=" });
  assert.deepEqual(v("'0012"), { op: "set_value", sheet: "S", cell: "A1", value: "0012" });
  assert.deepEqual(v("1,234.5"), { op: "set_value", sheet: "S", cell: "A1", value: 1234.5 });
  assert.deepEqual(v("12%"), { op: "set_value", sheet: "S", cell: "A1", value: 0.12 });
  assert.deepEqual(v("-1e3"), { op: "set_value", sheet: "S", cell: "A1", value: -1000 });
  assert.deepEqual(v("true"), { op: "set_value", sheet: "S", cell: "A1", value: true });
  for (const text of ["1,2", "-", "12 apples", "1.2.3"]) assert.deepEqual(v(text), { op: "set_value", sheet: "S", cell: "A1", value: text }, text);
});

test("editing starts from the formula, then the value, then the text", () => {
  assert.equal(editTextOf({ cell: "A1", text: "3", formula: "=1+2", value: { type: "number", value: 3 }, look: {} } as never), "=1+2");
  assert.equal(editTextOf({ cell: "A1", text: "12%", value: { type: "number", value: 0.12 }, look: {} } as never), "0.12");
  assert.equal(editTextOf({ cell: "A1", text: "#DIV/0!", value: { type: "error", value: "#DIV/0!" }, look: {} } as never), "#DIV/0!");
  assert.equal(editTextOf(undefined), "");
});

test("dark text is lightened only on a dark background", () => {
  assert.equal(readable("000000", false), "#000000");
  assert.equal(readable("000000", true), "rgb(140,140,140)");
  assert.equal(readable("FFFF00", true), "#FFFF00");
  assert.equal(readable(null, true), undefined);
});

test("a selection copies as TSV and quotes as a Markdown table", () => {
  const cells = new Map([["A1", "a"], ["B1", "x|y"], ["A2", "two\nlines"]]);
  const area = { r1: 1, c1: 1, r2: 2, c2: 2 };
  assert.equal(toTsv(area, (c) => cells.get(c)), "a\tx|y\ntwo\nlines\t");
  assert.equal(toMarkdown(area, (c) => cells.get(c)), "| | A | B |\n|---|---|---|\n| 1 | a | x\\|y |\n| 2 | two lines |  |");
});

test("dragged sizes are kept by sheet", () => {
  const m = new Map([[sizeKey("S", 3), 80], [sizeKey("T", 3), 40], [sizeKey("S", 7), 20]]);
  assert.deepEqual([...sizesOf(m, "S")], [[3, 80], [7, 20]]);
});

test("the status bar counts what Excel counts", () => {
  const n = (cell: string, value: number) => ({ cell, text: String(value), value: { type: "number", value } }) as never;
  const area = { r1: 1, c1: 1, r2: 5, c2: 1 };
  const cells = [n("A1", 22.5), n("A2", 72), { cell: "A3", text: "label", value: { type: "text", value: "label" } } as never, { cell: "A4", text: "TRUE", value: { type: "bool", value: true } } as never];
  assert.deepEqual(selectionStats(cells, area), { count: 4, numbers: 2, sum: 94.5, average: 47.25, error: false });
  // Text only: a count, no sum.
  assert.deepEqual(selectionStats([cells[2]], area), { count: 1, numbers: 0, sum: 0, average: null, error: false });
  // An error value: the sum is not told.
  assert.equal(selectionStats([...cells, { cell: "A5", text: "#REF!", value: { type: "error", value: "#REF!" } } as never], area)!.error, true);
  // One cell, or nothing in the selection: no figures.
  assert.equal(selectionStats([n("A1", 1)], { r1: 1, c1: 1, r2: 1, c2: 1 }), null);
  assert.equal(selectionStats([], area), null);
});

test("status figures read without float noise", () => {
  assert.equal(statText(0.1 + 0.2, "en"), "0.3");
  assert.equal(statText(1234567.891, "en"), "1,234,567.89");
  assert.equal(statText(1122.6666666667, "en"), "1,122.67");
  assert.equal(statText(22.222222222, "en"), "22.2222");
  assert.equal(statText(0.085, "en"), "0.085");
});

test("a paste reads as Excel writes the clipboard", () => {
  assert.deepEqual(parseTsv("a\tb\n1\t2\n"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(parseTsv("a\r\nb"), [["a"], ["b"]]);
  assert.deepEqual(parseTsv('"x\ty"\t"say ""hi"""\n"two\nlines"'), [["x\ty", 'say "hi"'], ["two\nlines"]]);
  assert.deepEqual(parseTsv('5" disk\t1'), [['5" disk', "1"]]);
  assert.deepEqual(parseTsv("a\t\tc"), [["a", "", "c"]]);
  const ops = pasteOps("S", { r: 2, c: 2 }, [["1,234", "=B1"], ["", "x"]]);
  assert.deepEqual(ops, [
    { op: "set_value", sheet: "S", cell: "B2", value: 1234 },
    { op: "set_formula", sheet: "S", cell: "C2", formula: "=B1" },
    { op: "clear", sheet: "S", range: "B3" },
    { op: "set_value", sheet: "S", cell: "C3", value: "x" },
  ]);
  assert.equal(pasteOps("S", { r: 1, c: 1 }, []), null);
});

test("a lens shows amounts in a unit and leaves the rest as the file shows it", () => {
  const n = (text: string, value: number, formula?: string) => ({ cell: "A1", text, value: { type: "number", value }, formula }) as never;
  const wan: Lens = { area: { r1: 1, c1: 1, r2: 9, c2: 1 }, unit: 1e4, decimals: 2 };
  assert.equal(lensText(n("1,234,567.89", 1234567.89), wan, "en"), "123.46");
  assert.equal(lensText(n("(12,000)", -12000), wan, "en"), "(1.20)");
  assert.equal(lensText(n("-12000", -12000), wan, "en"), "-1.20");
  // Percentages, dates and scientific notation stay.
  for (const text of ["8.5%", "2024/1/1", "1.2E+06", "12:30"]) assert.equal(lensText(n(text, 1), wan, "en"), null, text);
  // Text stays; the file's own decimals when the lens keeps them.
  assert.equal(lensText({ cell: "A1", text: "x", value: { type: "text", value: "x" } } as never, wan, "en"), null);
  assert.equal(lensText(n("1,344.00", 1344), { ...wan, unit: 1e3, decimals: null }, "en"), "1.34");
  assert.equal(lensText(n("1,344.00", 1344), { ...wan, unit: 1, decimals: 0 }, "en"), "1,344");
  // The last lens over a cell wins; one wholly under a new one goes.
  const a = withLens([], { r1: 1, c1: 1, r2: 9, c2: 3 }, { unit: 1e4 });
  const b = withLens(a, { r1: 2, c1: 2, r2: 2, c2: 2 }, { decimals: (d) => (d ?? 2) + 1 });
  assert.equal(lensAt(b, 2, 2)!.decimals, 3);
  assert.equal(lensAt(b, 2, 2)!.unit, 1e4);
  assert.equal(lensAt(b, 3, 3)!.decimals, null);
  assert.deepEqual(withLens(b, { r1: 1, c1: 1, r2: 9, c2: 3 }, { unit: 1, decimals: () => null }), []);
});

test("a number typed among formulas is marked", () => {
  const grid: Record<string, unknown> = {
    "1:1": { formula: "=X", value: { type: "number", value: 1 } },
    "1:2": { value: { type: "number", value: 2 } },
    "1:3": { formula: "=Y", value: { type: "number", value: 3 } },
    "2:2": { value: { type: "number", value: 4 } },
  };
  const at = (r: number, c: number) => grid[`${r}:${c}`] as never;
  assert.equal(isHardcoded(at, 1, 2), true);
  assert.equal(isHardcoded(at, 1, 1), false);
  assert.equal(isHardcoded(at, 2, 2), false);
});
