import type { AppSettings, ReasoningEffort } from '@shared/types.js';

export type SmithPurpose = 'chat' | 'compose' | 'repair';

/**
 * `inherit` follows Smith, then Agent Defaults. Effort follows the selected
 * settings tier unless explicitly overridden. Resolution never opens a model
 * or throws: chat's transport retains requireModel, while one-shots allow inherit.
 */
export function resolveSmithModel(
  settings: Pick<
    AppSettings,
    'smithModel' | 'smithReasoningEffort' | 'defaultModel' | 'defaultReasoningEffort'
  >,
  _purpose: SmithPurpose,
  override?: { model?: string; reasoningEffort?: ReasoningEffort },
): { model: string; reasoningEffort: ReasoningEffort } {
  const smith = settings.smithModel || 'inherit';
  const fallback = settings.defaultModel || 'inherit';
  const model = smith !== 'inherit' ? smith : fallback;
  const reasoningEffort =
    smith !== 'inherit' || fallback === 'inherit'
      ? settings.smithReasoningEffort
      : settings.defaultReasoningEffort;
  return {
    model: override?.model && override.model !== 'inherit' ? override.model : model,
    reasoningEffort: override?.reasoningEffort ?? reasoningEffort,
  };
}
