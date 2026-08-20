/**
 * App-scope settings. Validated on change with inline errors, never on save:
 * a value that cannot round-trip is rejected where the user typed it.
 */

import { join } from 'node:path';
import { z } from 'zod';
import { CODING_AGENTS, DEFAULT_PR_AGENT, type AppSettings } from '@shared/types.js';
import { BRIDGE_PORT_MAX, BRIDGE_PORT_MIN, DEFAULT_BRIDGE_PORT } from '../bridge/manager.js';
import { JsonStore } from './json-store.js';

/**
 * The band a compaction threshold is useful in. Below it a run compacts more
 * than it works; at 1 it never compacts before the context wall, which is the
 * failure the setting exists to avoid.
 */
const COMPACTION_BAND = [0.5, 0.95] as const;

/** Mission-bounded band for the app-owned Bridge; the manager scans up in it. */
const BRIDGE_PORT_BAND = [BRIDGE_PORT_MIN, BRIDGE_PORT_MAX] as const;

export const appSettingsSchema = z.object({
  detectModel: z.string().min(1),
  readinessModel: z.string().min(1),
  readinessReasoningEffort: z.enum(['off', 'low', 'medium', 'high', 'xhigh', 'max']),
  engineerName: z.string().min(1).max(80),
  prAgent: z
    .string()
    .min(1)
    .regex(
      /^[a-z][a-z0-9_-]*$/,
      'lowercase letters, digits, dash, underscore; must start with a letter',
    ),
  defaultModel: z.string().min(1),
  defaultReasoningEffort: z.enum(['off', 'low', 'medium', 'high', 'xhigh', 'max']),
  pollCadenceMs: z.number().int().min(250).max(2000),
  turnTimeoutMs: z.number().int().min(300_000).max(3_600_000),
  envelopeRetries: z.number().int().min(0).max(5),
  gateRetries: z.number().int().min(0).max(5),
  compactionThreshold: z.number().min(COMPACTION_BAND[0]).max(COMPACTION_BAND[1]),
  /** 0 disables; the useful range stops well before a phase's retry budgets. */
  rewindAfterCorrections: z.number().int().min(0).max(20),
  bridgePort: z.number().int().min(BRIDGE_PORT_BAND[0]).max(BRIDGE_PORT_BAND[1]),
  notifications: z.object({
    accepted: z.boolean(),
    rejected: z.boolean(),
    failed: z.boolean(),
    needsInput: z.boolean(),
  }),
  dockBadge: z.boolean(),
  terminalApp: z.enum(['terminal', 'iterm', 'ghostty', 'warp', 'alacritty', 'kitty']),
  codingAgent: z.enum(['droid', 'claude', 'codex', 'opencode', 'pi']),
  appearance: z.enum(['system', 'dark']),
  retentionDays: z.number().int().min(1).max(3650).nullable(),
  onboarded: z.boolean(),
  hiddenModelIds: z.array(z.string().min(1)),
});

export function defaultSettings(): AppSettings {
  return {
    detectModel: 'inherit',
    readinessModel: 'inherit',
    readinessReasoningEffort: 'high',
    engineerName: process.env.USER || 'engineer',
    prAgent: DEFAULT_PR_AGENT,
    defaultModel: 'inherit',
    defaultReasoningEffort: 'medium',
    pollCadenceMs: 500,
    turnTimeoutMs: 20 * 60_000,
    envelopeRetries: 3,
    gateRetries: 2,
    compactionThreshold: 0.8,
    rewindAfterCorrections: 2,
    bridgePort: DEFAULT_BRIDGE_PORT,
    notifications: { accepted: true, rejected: true, failed: true, needsInput: true },
    dockBadge: true,
    // Terminal.app ships with macOS, so the default always resolves.
    terminalApp: 'terminal',
    // Droid is what existing Smith sessions already start.
    codingAgent: 'droid',
    appearance: 'system',
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
  const merged = { ...base };
  for (const key of Object.keys(base) as (keyof AppSettings)[]) {
    if (Object.hasOwn(stored, key) && stored[key] !== undefined) {
      Object.assign(merged, { [key]: stored[key] });
    }
  }
  if (!merged.detectModel) merged.detectModel = base.detectModel;
  if (typeof merged.prAgent !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(merged.prAgent)) {
    merged.prAgent = DEFAULT_PR_AGENT;
  }
  if (!CODING_AGENTS.some((agent) => agent.id === merged.codingAgent)) {
    merged.codingAgent = 'droid';
  }
  if (!merged.readinessModel) merged.readinessModel = base.readinessModel;
  if (
    merged.readinessReasoningEffort !== 'off' &&
    merged.readinessReasoningEffort !== 'low' &&
    merged.readinessReasoningEffort !== 'medium' &&
    merged.readinessReasoningEffort !== 'high' &&
    merged.readinessReasoningEffort !== 'xhigh' &&
    merged.readinessReasoningEffort !== 'max'
  ) {
    merged.readinessReasoningEffort = base.readinessReasoningEffort;
  }
  // A read is not a save, so an out-of-band value is clamped rather than
  // rejected: refusing it here would leave the app with no threshold at all.
  merged.compactionThreshold = clamp(
    merged.compactionThreshold,
    base.compactionThreshold,
    COMPACTION_BAND,
  );
  merged.rewindAfterCorrections = Math.round(
    clamp(merged.rewindAfterCorrections, base.rewindAfterCorrections, [0, 20]),
  );
  merged.bridgePort = Math.round(clamp(merged.bridgePort, base.bridgePort, BRIDGE_PORT_BAND));
  if (!Array.isArray(merged.hiddenModelIds)) {
    merged.hiddenModelIds = [];
  } else {
    merged.hiddenModelIds = [
      ...new Set(
        merged.hiddenModelIds.filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    ];
  }
  return merged;
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
