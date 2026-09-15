import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SMITH_LIVE_VOICE,
  GEMINI_LIVE_VOICES,
  isSmithLiveVoiceSetting,
  resolveSmithLiveVoice,
} from '../../src/shared/gemini-live-voices.js';

describe('gemini-live-voices', () => {
  it('ships thirty Live/TTS voices and defaults to Puck', () => {
    expect(GEMINI_LIVE_VOICES).toHaveLength(30);
    expect(DEFAULT_SMITH_LIVE_VOICE).toBe('Puck');
    expect(GEMINI_LIVE_VOICES).toContain('Puck');
    expect(GEMINI_LIVE_VOICES).toContain('Kore');
  });

  it('accepts random and each named voice', () => {
    expect(isSmithLiveVoiceSetting('random')).toBe(true);
    expect(isSmithLiveVoiceSetting('Puck')).toBe(true);
    expect(isSmithLiveVoiceSetting('NotAVoice')).toBe(false);
  });

  it('resolves a fixed voice as-is', () => {
    expect(resolveSmithLiveVoice('Kore')).toBe('Kore');
  });

  it('resolves random once via the picker (not per utterance)', () => {
    const picks: string[] = [];
    const voice = resolveSmithLiveVoice('random', (voices) => {
      picks.push(...voices.slice(0, 1));
      return 'Fenrir';
    });
    expect(voice).toBe('Fenrir');
    expect(picks).toEqual(['Zephyr']);
    // A second resolve is a separate session start — caller invokes once per start.
    expect(resolveSmithLiveVoice('random', () => 'Aoede')).toBe('Aoede');
  });
});
