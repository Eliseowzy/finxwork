import assert from "node:assert/strict";
import { test } from "node:test";
import { demoModels } from "./mock/data.ts";
import { draftModel } from "./models.ts";

const models = demoModels();

test("a new session asks for the model chosen while its provider is there", () => {
  assert.equal(draftModel(models, "deepseek/deepseek-v4-pro"), "deepseek/deepseek-v4-pro");
  // A provider without a key is still there: the page asks for the key, not another model.
  assert.equal(draftModel(models, "anthropic/claude-sonnet-5-5"), "anthropic/claude-sonnet-5-5");
  assert.equal(draftModel(models, null), null);
});

test("a model whose connection is gone gives way to the default", () => {
  assert.equal(draftModel(models, "local-35e57942-0000-4000-8000-000000000001/flash"), null);
});

test("before the list comes the choice stands", () => {
  assert.equal(draftModel({ models: [], providers: [] }, "local-35e57942-0000-4000-8000-000000000001/flash"), "local-35e57942-0000-4000-8000-000000000001/flash");
});
