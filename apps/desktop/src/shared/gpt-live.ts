/**
 * GPT-Live voice catalog and session constants. Shared so Settings, the
 * voice overlay, main's session create, and tests name the same voices.
 *
 * Voice is fixed at session start (`audio.output.voice`). Changing it means
 * a new session. Custom voices exist but need OpenAI sales authorization, so
 * Smith only offers this pre-baked list.
 */

/** The Live model Smith speaks with. */
export const GPT_LIVE_MODEL = 'gpt-live-1';

export const GPT_LIVE_VOICES = [
  {
    id: 'marin',
    label: 'Marin',
    description: 'Default · English',
  },
  {
    id: 'vesper',
    label: 'Vesper',
    description: 'English',
  },
  {
    id: 'quartz',
    label: 'Quartz',
    description: 'Australian English · feminine',
  },
  {
    id: 'ripple',
    label: 'Ripple',
    description: 'Australian English · masculine',
  },
  {
    id: 'willow',
    label: 'Willow',
    description: 'Irish English · feminine',
  },
  {
    id: 'stone',
    label: 'Stone',
    description: 'Irish English · masculine',
  },
  {
    id: 'gleam',
    label: 'Gleam',
    description: 'North American English · feminine',
  },
  {
    id: 'meridian',
    label: 'Meridian',
    description: 'North American English · masculine',
  },
  {
    id: 'bossa',
    label: 'Bossa',
    description: 'Brazilian Portuguese · feminine',
  },
  {
    id: 'tempo',
    label: 'Tempo',
    description: 'Brazilian Portuguese · masculine',
  },
  {
    id: 'beacon',
    label: 'Beacon',
    description: 'Filipino English · masculine',
  },
  {
    id: 'delta',
    label: 'Delta',
    description: 'Southern U.S. English · feminine',
  },
  {
    id: 'cinder',
    label: 'Cinder',
    description: 'Southern U.S. English · masculine',
  },
] as const;

export type GptLiveVoiceId = (typeof GPT_LIVE_VOICES)[number]['id'];

export const DEFAULT_GPT_LIVE_VOICE: GptLiveVoiceId = 'marin';

const VOICE_IDS = new Set<string>(GPT_LIVE_VOICES.map((voice) => voice.id));

export function isGptLiveVoiceId(value: unknown): value is GptLiveVoiceId {
  return typeof value === 'string' && VOICE_IDS.has(value);
}

export function gptLiveVoiceLabel(id: GptLiveVoiceId): string {
  return GPT_LIVE_VOICES.find((voice) => voice.id === id)?.label ?? id;
}
