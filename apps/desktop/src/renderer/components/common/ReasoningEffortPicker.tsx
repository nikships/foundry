import { useMemo } from 'react';
import { supportedReasoningEfforts } from '@shared/reasoning-effort.js';
import type { ModelInfo, ReasoningEffort } from '@shared/types.js';
import { Dropdown, type DropdownOption } from '../ui/Dropdown.js';

const LABELS: Record<ReasoningEffort, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
};

/**
 * Reasoning-effort chooser filtered by what one model actually offers.
 *
 * The option list comes from the model's own capabilities rather than a global
 * enum, because a level outside a model's thinking-level map is a value the
 * provider rejects.
 *
 * `model` is null for `inherit` or a catalog that has not loaded. Every level
 * is offered there because the model is the runtime's to choose and there is
 * nothing to filter against; the level is passed through, and pi maps an
 * unsupported one down itself.
 *
 * A `value` the model does not support is still shown, marked, rather than
 * silently displaying a level the operator did not choose — the effective
 * level is main's answer (`activeReasoningEffort`), not this control's.
 */
export default function ReasoningEffortPicker({
  value,
  model,
  disabled,
  ariaLabel = 'Reasoning effort',
  onChange,
  'data-testid': testId,
}: {
  value: ReasoningEffort;
  /** The model the effort applies to, or null when it is not known here. */
  model: ModelInfo | null;
  disabled?: boolean;
  ariaLabel?: string;
  onChange: (effort: ReasoningEffort) => void;
  'data-testid'?: string;
}): React.JSX.Element {
  const supported = useMemo(() => supportedReasoningEfforts(model), [model]);

  const options = useMemo<DropdownOption[]>(() => {
    const next: DropdownOption[] = supported.map((effort) => ({
      value: effort,
      label: LABELS[effort],
    }));
    if (!supported.includes(value)) {
      next.unshift({ value, label: `${LABELS[value]} (unsupported)` });
    }
    return next;
  }, [supported, value]);

  return (
    <Dropdown
      value={value}
      options={options}
      onChange={(next) => onChange(next as ReasoningEffort)}
      disabled={disabled}
      aria-label={ariaLabel}
      {...(testId ? { 'data-testid': testId } : {})}
    />
  );
}
