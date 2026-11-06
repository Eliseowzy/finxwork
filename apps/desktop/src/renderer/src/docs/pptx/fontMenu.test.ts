import assert from "node:assert/strict";
import { test } from "node:test";
import { fontMenu } from "./fontMenu.ts";

const installed = [
  { family: "Arial" },
  { family: "DengXian", localized: "等线" },
  { family: "Helvetica Neue" },
  { family: "STXingkai", localized: "华文行楷" },
];

test("a Chinese UI shows Chinese names first and keeps English names as the stored family", () => {
  const menu = fontMenu(installed, [], "zh-CN");
  assert.deepEqual(menu.all.map((f) => f.label), ["等线", "华文行楷", "Arial", "Helvetica Neue"]);
  assert.equal(menu.all[1].family, "STXingkai");
  assert.ok(menu.all[1].cjk);
});

test("an English UI lists every family by its English name", () => {
  assert.deepEqual(fontMenu(installed, [], "en").all.map((f) => f.label), ["Arial", "DengXian", "Helvetica Neue", "STXingkai"]);
});

test("the document section keeps the deck's families, including ones the machine lacks", () => {
  const menu = fontMenu(installed, ["Calibri", "dengxian", "Calibri"], "zh-CN");
  assert.deepEqual(menu.document.map((f) => [f.family, f.label]), [["Calibri", "Calibri"], ["dengxian", "等线"]]);
});

test("search matches either name, ignoring case and spaces", () => {
  assert.deepEqual(fontMenu(installed, [], "zh-CN", "行楷").all.map((f) => f.family), ["STXingkai"]);
  assert.deepEqual(fontMenu(installed, [], "en", "helveticaneue").all.map((f) => f.family), ["Helvetica Neue"]);
  assert.deepEqual(fontMenu(installed, ["Calibri"], "en", "xing").document, []);
});
