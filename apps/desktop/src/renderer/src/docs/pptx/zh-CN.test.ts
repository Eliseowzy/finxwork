import assert from "node:assert/strict";
import { test } from "node:test";
import { en } from "@nimbleoffice/pptx-i18n/en";
import { presentationZhCN } from "./zh-CN.ts";

function leaves(value: object, prefix = ""): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (entry && typeof entry === "object") {
      for (const pair of leaves(entry, path)) result.set(...pair);
    } else {
      assert.equal(typeof entry, "string", `${path} must not fall back to English`);
      assert.ok(entry.trim(), `${path} must not be empty`);
      result.set(path, entry);
    }
  }
  return result;
}

test("every editor UI string has a Chinese translation with intact interpolation variables", () => {
  const source = leaves(en), translated = leaves(presentationZhCN);
  assert.deepEqual([...translated.keys()].sort(), [...source.keys()].sort());
  for (const [key, original] of source) {
    const value = translated.get(key)!;
    const variables = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(variables(value), variables(original), `${key} interpolation variables`);
    // These have no words to translate: only variables, signs and units.
    if (key !== "_lang" && key !== "presentation.slideCounter" && key !== "proposals.geometryValues") {
      assert.match(value, /\p{Script=Han}/u, `${key} must contain Chinese UI text`);
    }
  }
});
