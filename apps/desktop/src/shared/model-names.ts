import type { ModelsListResult } from "@finx/protocol";

/**
 * A model's name in the app's language, from the names its source offers by language tag: the
 * language itself ("zh-CN"), else its base ("zh"). Other languages are left out: `name`, which the
 * kernel chose without knowing the app's language, is what a model without this one goes by.
 */
export function nameIn(names: Record<string, string> | undefined, language: string): string | undefined {
  if (!names) return undefined;
  const wanted = language.toLowerCase();
  const base = wanted.split("-")[0];
  const entries = Object.entries(names);
  const find = (tag: string) => entries.find(([key]) => key.toLowerCase() === tag)?.[1];
  return find(wanted) ?? find(base);
}

/** The list with each model and provider named in the app's language, for everything that shows `name`. */
export function modelsIn(result: ModelsListResult, language: string): ModelsListResult {
  if (!result.models.some((m) => m.names) && !result.providers.some((p) => p.names)) return result;
  const named = <T extends { name: string; names?: Record<string, string> }>(item: T): T => ({ ...item, name: nameIn(item.names, language) ?? item.name });
  return { ...result, models: result.models.map(named), providers: result.providers.map(named) };
}
