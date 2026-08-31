/**
 * What this install may actually appoint: the reachable catalog minus the
 * models the operator hid in Settings.
 *
 * One answer for every caller that asks — the model picker, the Orchestrator's
 * planning prompt, the start-time rail, and Smith — because a picker offering
 * a model the rail then refuses is the disagreement worth spending a module to
 * prevent.
 *
 * Loaded lazily and fail-soft, exactly as the picker's own read is: building
 * pi's runtime restores catalogs off disk, and an unbuildable runtime (a
 * half-written catalog, no credentials at all) is an empty list rather than a
 * thrown call nothing above can act on.
 */

import type { ModelInfo } from '@shared/types.js';
import { withoutHiddenModels } from '@shared/model-visibility.js';

export async function enabledModels(
  supportDir: string,
  hiddenModelIds: readonly string[],
): Promise<ModelInfo[]> {
  try {
    const { availableModels } = await import('./catalog.js');
    return withoutHiddenModels(await availableModels(supportDir), hiddenModelIds);
  } catch {
    return [];
  }
}
