/**
 * Live API / TTS speaker voices for Smith's Gemini Live session.
 *
 * One list feeds the settings schema, the Integrations dropdown, and the
 * per-session random picker so a new Google voice cannot be half-added.
 *
 * @see https://ai.google.dev/gemini-api/docs/live-api/capabilities
 */

export const GEMINI_LIVE_VOICES = [
  'Zephyr',
  'Kore',
  'Orus',
  'Autonoe',
  'Umbriel',
  'Erinome',
  'Laomedeia',
  'Schedar',
  'Achird',
  'Sadachbia',
  'Puck',
  'Fenrir',
  'Aoede',
  'Enceladus',
  'Algieba',
  'Algenib',
  'Achernar',
  'Gacrux',
  'Zubenelgenubi',
  'Sadaltager',
  'Charon',
  'Leda',
  'Callirrhoe',
  'Iapetus',
  'Despina',
  'Rasalgethi',
  'Alnilam',
  'Pulcherrima',
  'Vindemiatrix',
  'Sulafat',
] as const;

export type GeminiLiveVoiceName = (typeof GEMINI_LIVE_VOICES)[number];

/** Settings value: a fixed voice, or pick uniformly once per live session. */
export type SmithLiveVoiceSetting = 'random' | GeminiLiveVoiceName;

/**
 * Google's Live API default when `speechConfig` is omitted. Prefer a fixed
 * default so reconnects and demos sound the same; operators can opt into
 * Random each session in Settings.
 */
export const DEFAULT_SMITH_LIVE_VOICE: SmithLiveVoiceSetting = 'Puck';

/** Every valid `AppSettings.smithLiveVoice` value, including Random. */
export const SMITH_LIVE_VOICE_SETTINGS = ['random', ...GEMINI_LIVE_VOICES] as unknown as readonly [
  SmithLiveVoiceSetting,
  ...SmithLiveVoiceSetting[],
];

export function isGeminiLiveVoiceName(value: unknown): value is GeminiLiveVoiceName {
  return typeof value === 'string' && (GEMINI_LIVE_VOICES as readonly string[]).includes(value);
}

export function isSmithLiveVoiceSetting(value: unknown): value is SmithLiveVoiceSetting {
  return value === 'random' || isGeminiLiveVoiceName(value);
}

/**
 * Resolves the settings choice into the voice name sent at connect.
 * Random is decided once per call (once per session start), never per utterance.
 */
export function resolveSmithLiveVoice(
  setting: SmithLiveVoiceSetting,
  pick: (voices: readonly GeminiLiveVoiceName[]) => GeminiLiveVoiceName = pickUniform,
): GeminiLiveVoiceName {
  if (setting === 'random') return pick(GEMINI_LIVE_VOICES);
  return setting;
}

function pickUniform(voices: readonly GeminiLiveVoiceName[]): GeminiLiveVoiceName {
  return voices[Math.floor(Math.random() * voices.length)]!;
}
