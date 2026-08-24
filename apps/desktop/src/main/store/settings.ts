/**
 * App-scope settings. Validated on change with inline errors, never on save:
 * a value that cannot round-trip is rejected where the user typed it.
 */

import { join } from 'node:path';
import { z } from 'zod';
import { REASONING_EFFORTS, isReasoningEffort } from '@shared/reasoning-effort.js';
import { DEFAULT_PR_AGENT, type AppSettings } from '@shared/types.js';
import { JsonStore } from './json-store.js';

/**
 * The band a compaction threshold is useful in. Below it a run compacts more
 * than it works; at 1 it never compacts before the context wall, which is the
 * failure the setting exists to avoid.
 */
const COMPACTION_BAND = [0.5, 0.95] as const;

/** Same shape a roster agent name has: the setting names one of them. */
const PR_AGENT_NAME = /^[a-z][a-z0-9_-]*$/;

export const appSettingsSchema = z.object({
  theme: z.enum(['dark', 'light']),
  helperModel: z.string().min(1),
  helperReasoningEffort: z.enum(REASONING_EFFORTS),
  engineerName: z.string().min(1).max(80),
  prAgent: z
    .string()
    .min(1)
    .regex(PR_AGENT_NAME, 'lowercase letters, digits, dash, underscore; must start with a letter'),
  defaultModel: z.string().min(1),
  defaultReasoningEffort: z.enum(REASONING_EFFORTS),
  healingModel: z.string().min(1),
  healingReasoningEffort: z.enum(REASONING_EFFORTS),
  smithModel: z.string().min(1),
  smithReasoningEffort: z.enum(REASONING_EFFORTS),
  compactionThreshold: z.number().min(COMPACTION_BAND[0]).max(COMPACTION_BAND[1]),
  notifications: z.object({
    accepted: z.boolean(),
    rejected: z.boolean(),
    failed: z.boolean(),
    needsInput: z.boolean(),
  }),
  dockBadge: z.boolean(),
  retentionDays: z.number().int().min(1).max(3650).nullable(),
  onboarded: z.boolean(),
  hiddenModelIds: z.array(z.string().min(1)),
});

export function defaultSettings(): AppSettings {
  return {
    theme: 'dark',
    helperModel: 'inherit',
    helperReasoningEffort: 'high',
    engineerName: process.env.USER || 'engineer',
    prAgent: DEFAULT_PR_AGENT,
    defaultModel: 'inherit',
    defaultReasoningEffort: 'medium',
    healingModel: 'inherit',
    healingReasoningEffort: 'medium',
    smithModel: 'inherit',
    smithReasoningEffort: 'medium',
    compactionThreshold: 0.8,
    notifications: { accepted: true, rejected: true, failed: true, needsInput: true },
    dockBadge: true,
    retentionDays: null,
    onboarded: false,
    hiddenModelIds: [],
  };
}

/**
 * Reads a stored file into the current shape. Unknown keys are dropped so a
 * hand-edited file cannot smuggle fields the schema never declared; missing
 * or out-of-band values fall back to the shipped defaults rather than
 * leaving the app with no setting at all.
 */
export function migrate(raw: unknown): AppSettings {
  const base = defaultSettings();
  const stored = raw && typeof raw === 'object' ? (raw as Partial<AppSettings>) : {};
  const legacy = stored as Record<string, unknown>;
  const merged = { ...base };
  for (const key of Object.keys(base) as (keyof AppSettings)[]) {
    if (Object.hasOwn(stored, key) && stored[key] !== undefined) {
      Object.assign(merged, { [key]: stored[key] });
    }
  }

  if (merged.theme !== 'dark' && merged.theme !== 'light') merged.theme = base.theme;
  if (!isNonEmptyString(stored.helperModel)) {
    merged.helperModel = legacyHelperModel(legacy) || base.helperModel;
  }
  if (
    stored.helperReasoningEffort === undefined &&
    typeof legacy.readinessReasoningEffort === 'string'
  ) {
    merged.helperReasoningEffort =
      legacy.readinessReasoningEffort as AppSettings['helperReasoningEffort'];
  }
  if (!isNonEmptyString(merged.smithModel)) merged.smithModel = base.smithModel;
  if (!isNonEmptyString(merged.healingModel)) merged.healingModel = base.healingModel;
  if (!isNonEmptyString(merged.prAgent) || !PR_AGENT_NAME.test(merged.prAgent)) {
    merged.prAgent = DEFAULT_PR_AGENT;
  }

  // A stored effort outside the known set is repaired to the shipped default.
  // Whether the chosen model actually offers the level is a separate question,
  // answered against the live catalog rather than against a stored file.
  for (const key of [
    'helperReasoningEffort',
    'defaultReasoningEffort',
    'healingReasoningEffort',
    'smithReasoningEffort',
  ] as const) {
    if (!isReasoningEffort(merged[key])) merged[key] = base[key];
  }

  // A read is not a save, so an out-of-band value is clamped rather than
  // rejected: refusing it here would leave the app with no threshold at all.
  merged.compactionThreshold = clamp(
    merged.compactionThreshold,
    base.compactionThreshold,
    COMPACTION_BAND,
  );
  merged.hiddenModelIds = Array.isArray(merged.hiddenModelIds)
    ? [...new Set(merged.hiddenModelIds.filter(isNonEmptyString))]
    : [];
  return merged;
}

/**
 * Readiness and detection each carried their own model before one helper pair
 * replaced them; a file written back then still names the old keys. Readiness
 * wins because it was the more deliberate of the two, and its `inherit` is not
 * a choice worth carrying forward.
 */
function legacyHelperModel(legacy: Record<string, unknown>): string | undefined {
  const { readinessModel, detectModel } = legacy;
  if (typeof readinessModel === 'string' && readinessModel !== 'inherit') return readinessModel;
  return typeof detectModel === 'string' ? detectModel : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function clamp(
  value: number | undefined,
  fallback: number,
  [min, max]: readonly [number, number],
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export class SettingsStore {
  private readonly store: JsonStore<AppSettings>;

  constructor(appSupportDir: string) {
    this.store = new JsonStore<AppSettings>(
      join(appSupportDir, 'settings.json'),
      defaultSettings,
      (raw) => migrate(raw),
    );
  }

  get(): AppSettings {
    return this.store.read();
  }

  /** Returns the accepted settings, or the validation issues that blocked them. */
  patch(
    patch: Partial<AppSettings>,
  ): { ok: true; settings: AppSettings } | { ok: false; issues: string[] } {
    const merged = { ...this.get(), ...patch };
    const parsed = appSettingsSchema.safeParse(merged);
    if (!parsed.success) {
      return {
        ok: false,
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      };
    }
    return { ok: true, settings: this.store.write(parsed.data) };
  }
}
