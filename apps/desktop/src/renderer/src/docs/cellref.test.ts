import assert from "node:assert/strict";
import { test } from "node:test";
import { addr, areaOf, colName, onSheet, parseAddr, parseRange, RANGE, rangeText, splitRef } from "./cellref.ts";

test("columns are named as Excel names them", () => {
  assert.deepEqual([1, 26, 27, 52, 702, 703, 16384].map(colName), ["A", "Z", "AA", "AZ", "ZZ", "AAA", "XFD"]);
  assert.equal(addr({ r: 12, c: 2 }), "B12");
});

test("addresses parse with or without $, within the sheet", () => {
  assert.deepEqual(parseAddr("b12"), { r: 12, c: 2 });
  assert.deepEqual(parseAddr("$XFD$1048576"), { r: 1048576, c: 16384 });
  for (const bad of ["XFE1", "A0", "A1048577", "1A", "A", ""]) assert.equal(parseAddr(bad), null, bad);
  assert.deepEqual(parseRange("C3:A1"), { r1: 1, c1: 1, r2: 3, c2: 3 });
  assert.deepEqual(parseRange("B2"), { r1: 2, c1: 2, r2: 2, c2: 2 });
  assert.equal(parseRange("A1:Q"), null);
});

test("areas read back as a cell or a range", () => {
  assert.equal(rangeText(areaOf({ r: 3, c: 3 }, { r: 1, c: 1 })), "A1:C3");
  assert.equal(rangeText(areaOf({ r: 2, c: 2 }, { r: 2, c: 2 })), "B2");
  assert.ok(RANGE.test("A1:C3") && RANGE.test("a1") && !RANGE.test("$A$1"));
});

test("sheet refs split at the last !, quotes taken off", () => {
  assert.deepEqual(splitRef("Sheet1!A1"), { sheet: "Sheet1", cell: "A1" });
  assert.deepEqual(splitRef("'It''s here!'!B2:C3"), { sheet: "It's here!", cell: "B2:C3" });
  assert.equal(splitRef("A1"), null);
  assert.equal(splitRef("!A1"), null);
  assert.deepEqual(onSheet(["S!A1", "T!B2", "S!C3", "bad"], "S"), ["A1", "C3"]);
});
