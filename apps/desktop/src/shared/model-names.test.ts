import assert from "node:assert/strict";
import test from "node:test";
import type { ModelSummary, ModelsListResult } from "@finx/protocol";
import { modelsIn, nameIn } from "./model-names.ts";

const names = { zh: "标准", en: "Standard" };

test("a model's name follows the app's language", () => {
  assert.equal(nameIn(names, "zh-CN"), "标准");
  assert.equal(nameIn(names, "en"), "Standard");
});

test("the language's own tag comes before its base, in any case", () => {
  assert.equal(nameIn({ zh: "简", "zh-CN": "大陆" }, "zh-CN"), "大陆");
  assert.equal(nameIn({ "ZH-cn": "大陆" }, "zh-CN"), "大陆");
  assert.equal(nameIn({ "en-US": "US" }, "en-US"), "US");
});

test("without the app's language there is no name to pick", () => {
  assert.equal(nameIn({ zh: "标准" }, "en"), undefined);
  assert.equal(nameIn(undefined, "en"), undefined);
});

const model = (id: string, name: string, localized?: Record<string, string>) =>
  ({ id, name, ...(localized ? { names: localized } : {}) }) as ModelSummary;

test("the list keeps a model's name when it has none in the app's language", () => {
  const list: ModelsListResult = {
    providers: [],
    models: [model("q/flash", "标准", names), model("q/zh-only", "千问", { zh: "千问" }), model("d/deepseek", "DeepSeek")],
  };
  assert.deepEqual(modelsIn(list, "en").models.map((m) => m.name), ["Standard", "千问", "DeepSeek"]);
  assert.deepEqual(modelsIn(list, "zh-CN").models.map((m) => m.name), ["标准", "千问", "DeepSeek"]);
  assert.deepEqual(modelsIn(list, "en").models.map((m) => m.id), ["q/flash", "q/zh-only", "d/deepseek"], "requests keep the id");
});

test("a provider is named in the app's language too", () => {
  const provider = (id: string, name: string, localized?: Record<string, string>) =>
    ({ id, name, ...(localized ? { names: localized } : {}) }) as ModelsListResult["providers"][number];
  const list: ModelsListResult = {
    models: [],
    providers: [provider("q", "千问办公", { zh: "千问办公", en: "QwenWork" }), provider("d", "DeepSeek")],
  };
  assert.deepEqual(modelsIn(list, "en").providers.map((p) => p.name), ["QwenWork", "DeepSeek"]);
  assert.deepEqual(modelsIn(list, "zh-CN").providers.map((p) => p.name), ["千问办公", "DeepSeek"]);
  assert.deepEqual(modelsIn(list, "en").providers.map((p) => p.id), ["q", "d"]);
});

test("a list with no names by language is the same list", () => {
  const list: ModelsListResult = { providers: [], models: [model("d/deepseek", "DeepSeek")] };
  assert.equal(modelsIn(list, "en"), list);
});
