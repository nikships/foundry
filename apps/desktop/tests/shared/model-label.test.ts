import { describe, expect, it } from 'vitest';
import { modelLabel } from '@shared/model-label.js';

describe('modelLabel', () => {
  it('hides the provider half of catalog model slugs', () => {
    expect(modelLabel('bridge-gemini/gemini-3.7-flash-high')).toBe('gemini-3.7-flash-high');
    expect(modelLabel('openrouter/anthropic/claude-opus-4')).toBe('anthropic/claude-opus-4');
  });

  it('keeps bare and custom model labels readable', () => {
    expect(modelLabel('gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(modelLabel('custom:acme:muse-spark-1.2')).toBe('muse-spark-1.2');
    expect(modelLabel(null)).toBe('inherit');
  });
});
