import { describe, expect, it } from 'vitest';
import { modelFallbackForEvents, parseModelFallbackWarning } from '@shared/model-fallback.js';

const WARNING =
  'anthropic/claude-sonnet-4 failed after 5 retries; continuing this turn on openai/gpt-5';
const SECOND = 'openai/gpt-5 failed after 5 retries; continuing this turn on google/gemini-2.5-pro';

function logEvent(
  message: string,
  name = 'scout: model',
): {
  type: 'log';
  name: string;
  payload: Record<string, unknown>;
} {
  return { type: 'log', name, payload: { message } };
}

describe('parseModelFallbackWarning', () => {
  it('preserves the failed and replacement ids from the failover sentence', () => {
    expect(parseModelFallbackWarning(WARNING)).toEqual({
      failedModel: 'anthropic/claude-sonnet-4',
      fallbackModel: 'openai/gpt-5',
      message: WARNING,
    });
  });

  it('ignores other model warnings so only failovers read as fallbacks', () => {
    expect(
      parseModelFallbackWarning('anthropic/claude-sonnet-4 is not available to this install'),
    ).toBeNull();
    expect(parseModelFallbackWarning('extension error (x): boom')).toBeNull();
    expect(parseModelFallbackWarning(null)).toBeNull();
    expect(parseModelFallbackWarning('')).toBeNull();
  });
});

describe('modelFallbackForEvents', () => {
  it('returns null when no failover warning was recorded', () => {
    expect(modelFallbackForEvents([])).toBeNull();
    expect(modelFallbackForEvents([logEvent('extension error (x): boom')])).toBeNull();
    expect(
      modelFallbackForEvents([
        { type: 'tool_call', name: 'read: x', payload: { message: WARNING } },
      ]),
    ).toBeNull();
  });

  it('keeps the emitted failed and replacement info for one hop', () => {
    const fallback = modelFallbackForEvents([logEvent(WARNING)]);
    expect(fallback?.failedModel).toBe('anthropic/claude-sonnet-4');
    expect(fallback?.fallbackModel).toBe('openai/gpt-5');
    expect(fallback?.message).toBe(WARNING);
  });

  it('collapses chained hops to the first failure and the active replacement', () => {
    const fallback = modelFallbackForEvents([logEvent(WARNING), logEvent(SECOND)]);
    expect(fallback?.failedModel).toBe('anthropic/claude-sonnet-4');
    expect(fallback?.fallbackModel).toBe('google/gemini-2.5-pro');
    expect(fallback?.message).toContain(WARNING);
    expect(fallback?.message).toContain(SECOND);
  });

  it('prefers structured failover fields while preserving the sentence', () => {
    const fallback = modelFallbackForEvents([
      {
        type: 'log',
        name: 'scout: model',
        payload: {
          message: WARNING,
          failedModel: 'anthropic/claude-sonnet-4',
          fallbackModel: 'openai/gpt-5',
        },
      },
    ]);
    expect(fallback?.failedModel).toBe('anthropic/claude-sonnet-4');
    expect(fallback?.fallbackModel).toBe('openai/gpt-5');
    expect(fallback?.message).toBe(WARNING);
  });

  it('leaves non-fallback presentation untouched by ignoring other rows', () => {
    const events = [
      {
        type: 'agent_start' as const,
        name: 'scout',
        payload: { model: 'anthropic/claude-sonnet-4' },
      },
      logEvent('extension error (x): boom'),
    ];
    expect(modelFallbackForEvents(events)).toBeNull();
  });
});
