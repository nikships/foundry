/**
 * Reasoning-effort capability filtering: what a picker may offer for a model,
 * and what an unsupported choice becomes. Pure, so it is pinned directly —
 * both the renderer's pickers and the transports' clamp read this answer.
 */

import { describe, expect, it } from 'vitest';
import {
  REASONING_EFFORTS,
  isReasoningEffort,
  modelForEffortPicker,
  normalizeReasoningEffort,
  normalizeReasoningEffortForModelChoice,
  supportedReasoningEfforts,
} from '../../src/shared/reasoning-effort.js';

const conservative = {
  supportedReasoningEfforts: ['off', 'low', 'medium', 'high'],
  defaultReasoningEffort: 'medium',
};
const noReasoning = { supportedReasoningEfforts: ['off'], defaultReasoningEffort: 'off' };
const deep = {
  supportedReasoningEfforts: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
  defaultReasoningEffort: 'medium',
};

describe('isReasoningEffort', () => {
  it('accepts every level Foundry knows and nothing else', () => {
    for (const effort of REASONING_EFFORTS) expect(isReasoningEffort(effort)).toBe(true);
    for (const value of ['', 'MEDIUM', 'turbo', 3, null, undefined, {}]) {
      expect(isReasoningEffort(value)).toBe(false);
    }
  });
});

describe('supportedReasoningEfforts', () => {
  it('offers only what the model declares, in Foundry’s ascending order', () => {
    expect(supportedReasoningEfforts(conservative)).toEqual(['off', 'low', 'medium', 'high']);
    expect(
      supportedReasoningEfforts({
        supportedReasoningEfforts: ['max', 'off', 'high'],
        defaultReasoningEffort: 'high',
      }),
    ).toEqual(['off', 'high', 'max']);
    expect(
      supportedReasoningEfforts({
        supportedReasoningEfforts: ['high', 'minimal', 'low'],
      }),
    ).toEqual(['minimal', 'low', 'high']);
  });

  it('offers off alone for a model with no reasoning', () => {
    expect(supportedReasoningEfforts(noReasoning)).toEqual(['off']);
  });

  it('offers everything when the model is unknown — inherit, or a catalog that has not loaded', () => {
    expect(supportedReasoningEfforts(null)).toEqual([...REASONING_EFFORTS]);
    expect(supportedReasoningEfforts(undefined)).toEqual([...REASONING_EFFORTS]);
  });

  it('falls back to off rather than an empty list a picker could not render', () => {
    expect(supportedReasoningEfforts({ supportedReasoningEfforts: ['bogus'] })).toEqual(['off']);
  });
});

describe('normalizeReasoningEffort', () => {
  it('keeps a level the model supports', () => {
    expect(normalizeReasoningEffort('high', conservative)).toBe('high');
    expect(normalizeReasoningEffort('max', deep)).toBe('max');
  });

  it('falls back to the model default when the level is unsupported', () => {
    expect(normalizeReasoningEffort('max', conservative)).toBe('medium');
    expect(normalizeReasoningEffort('xhigh', conservative)).toBe('medium');
  });

  it('falls back to off when the default is unusable too', () => {
    expect(normalizeReasoningEffort('high', noReasoning)).toBe('off');
    expect(
      normalizeReasoningEffort('high', {
        supportedReasoningEfforts: ['off', 'low'],
        defaultReasoningEffort: 'max',
      }),
    ).toBe('off');
    expect(normalizeReasoningEffort('high', { supportedReasoningEfforts: ['off', 'low'] })).toBe(
      'off',
    );
  });

  it('takes the caller at their word for an unknown model', () => {
    expect(normalizeReasoningEffort('max', null)).toBe('max');
  });
});

describe('modelForEffortPicker', () => {
  const gemini = { id: 'bridge-gemini/gemini-3.7-flash-high' };
  const luna = { id: 'bridge-codex/gpt-5.6-luna' };
  const models = [gemini, luna];

  it('resolves a concrete choice, skipping inherit', () => {
    expect(modelForEffortPicker(gemini.id, models)).toBe(gemini);
    expect(modelForEffortPicker('inherit', models)).toBeNull();
    expect(modelForEffortPicker('inherit', models, luna.id)).toBe(luna);
  });

  it('uses the fallback only for inherit, not for a vanished catalog id', () => {
    expect(modelForEffortPicker('inherit', models, gemini.id)).toBe(gemini);
    expect(modelForEffortPicker('gone', models, luna.id)).toBeNull();
    expect(modelForEffortPicker(undefined, models, 'inherit')).toBeNull();
  });
});

describe('normalizeReasoningEffortForModelChoice', () => {
  const gpt = { id: 'bridge-codex/gpt-5.6', ...deep };
  const grok = { id: 'bridge-grok/grok-4.6', ...conservative };
  const models = [gpt, grok];

  it('clamps a persisted max effort when switching from GPT-5.6 to Grok 4.6', () => {
    expect(normalizeReasoningEffortForModelChoice('max', grok.id, models)).toBe('medium');
  });

  it('normalizes an inherited slot against the default model', () => {
    expect(normalizeReasoningEffortForModelChoice('max', 'inherit', models, grok.id)).toBe(
      'medium',
    );
  });

  it('preserves the effort while the chosen model is absent from the catalog', () => {
    expect(normalizeReasoningEffortForModelChoice('max', 'bridge-grok/grok-4.7', models)).toBe(
      'max',
    );
  });
});
