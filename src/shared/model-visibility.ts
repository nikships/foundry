import type { ModelInfo } from './types.js';

export function withoutHiddenModels(
  models: readonly ModelInfo[],
  hiddenModelIds: readonly string[],
): ModelInfo[] {
  if (hiddenModelIds.length === 0) return [...models];
  const hidden = new Set(hiddenModelIds);
  return models.filter((model) => !hidden.has(model.id));
}
