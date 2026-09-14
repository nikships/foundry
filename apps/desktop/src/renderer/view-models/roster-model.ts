import { modelLabel } from '@shared/model-label.js';
import type { ModelInfo } from '@shared/types.js';

/**
 * The brand behind a stored model id, for the roster's badges and bubbles.
 *
 * Read off the catalog rather than parsed out of the id: `bridge-claude/…` and
 * `anthropic/…` are the same brand, and only the catalog knows that. An id no
 * connected provider offers has no mark, which is the same honest gap a missing
 * logo leaves everywhere else.
 */
export function providerForModel(model: string, models: ModelInfo[]): string {
  return models.find((m) => m.id === model)?.provider ?? '';
}

/** The model's label, with the inheritance sentinel named as a model default. */
export function rosterModelLabel(model: string, models: ModelInfo[]): string {
  if (model === 'inherit') return 'default model';
  if (!models.some((m) => m.id === model)) return 'inherit';
  return modelLabel(model);
}
