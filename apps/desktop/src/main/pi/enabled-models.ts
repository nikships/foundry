/**
 * What this install may actually appoint: the reachable catalog minus the
 * models the operator hid in Settings.
 *
 * One answer for every caller that asks — the model picker, the Orchestrator's
 * planning prompt, the start-time rail, the transports, and Smith — because a
 * picker offering a model the rail then refuses is the disagreement worth
 * spending a module to prevent. This module is the only reader of the hidden
 * list outside Settings itself: everything downstream receives the enabled
 * catalog and has no concept of "hidden" to disagree with.
 *
 * Loaded lazily and fail-soft (for UI callers), exactly as the picker's own
 * read is: building pi's runtime restores catalogs off disk, and an
 * unbuildable runtime (a half-written catalog, no credentials at all) is an
 * empty list rather than a thrown call nothing above can act on. The
 * transport-shaped read propagates instead — a session that cannot see the
 * enabled catalog must not quietly run on the raw one.
 */

import type { ModelInfo } from '@shared/types.js';
import { withoutHiddenModels } from '@shared/model-visibility.js';
import { modelKey, type PiModel } from './model.js';

/** Live source of the models a session may run on or fail over onto. */
export type EnabledModelsSource = () => Promise<readonly PiModel[]>;

/**
 * The enabled catalog in pi's own shape — the form a session's model
 * operations (`setModel`, `cycleModel`) need. Throws when the runtime or its
 * catalog cannot be read; callers that must not fail a turn catch for
 * themselves.
 */
export async function enabledPiModels(
  supportDir: string,
  hiddenModelIds: readonly string[],
): Promise<PiModel[]> {
  const { modelRuntime } = await import('./runtime.js');
  const runtime = await modelRuntime(supportDir);
  const hidden = new Set(hiddenModelIds);
  return (await runtime.getAvailable()).filter((model) => !hidden.has(modelKey(model)));
}

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

export async function enabledModelIds(
  supportDir: string,
  hiddenModelIds: readonly string[],
): Promise<string[]> {
  return (await enabledModels(supportDir, hiddenModelIds)).map((model) => model.id);
}
