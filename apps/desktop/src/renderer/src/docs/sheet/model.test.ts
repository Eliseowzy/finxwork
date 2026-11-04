import assert from "node:assert/strict";
import { test } from "node:test";
import { editTextOf, inputOp, readable, selectionStats, sizeKey, sizesOf, statText, toMarkdown, toTsv } from "./model.ts";

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
