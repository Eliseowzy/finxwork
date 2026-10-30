import type { ModelsListResult } from "@finx/protocol";

/**
 * The model a new session asks for: the one chosen on the page while its provider is there, else
 * `null`, the default. A chosen model's provider goes when its connection is removed or
 * disconnected; asking for it then would only fail the send. Before the list comes there is
 * nothing to check against, and the choice stands.
 */
export function draftModel(models: ModelsListResult, chosen: string | null): string | null {
  if (!chosen || models.providers.length === 0) return chosen;
  const provider = chosen.split("/")[0];
  return models.providers.some((p) => p.id === provider) ? chosen : null;
}
