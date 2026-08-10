/**
 * App-scope settings. Validated on change with inline errors, never on save:
 * a value that cannot round-trip is rejected where the user typed it.
 */

import { join } from 'node:path';
import { z } from 'zod';
import { type AppSettings, type CliConfig, type CliVendor, CLI_VENDOR_IDS } from '@shared/types.js';
import { defaultCliConfig } from '../cli/index.js';
import { JsonStore } from './json-store.js';

const cliConfigSchema = z.object({
  path: z.string().min(1),
  extraArgs: z.array(z.string()),
});

/**
 * The band a compaction threshold is useful in. Below it a run compacts more
 * than it works; at 1 it never compacts before the context wall, which is the
 * failure the setting exists to avoid.
 */
const COMPACTION_BAND = [0.5, 0.95] as const;

/** Mission-bounded band for the app-owned droid daemon (see architecture §9.1). */
const DAEMON_PORT_BAND = [37_600, 37_699] as const;
const DEFAULT_DAEMON_PORT = 37_643;

export const appSettingsSchema = z.object({
  clis: z.object({
    droid: cliConfigSchema,
  }),
  defaultCli: z.literal('droid'),
  detectCli: z.enum(['default', 'droid']),
  detectModel: z.string().min(1),
  engineerName: z.string().min(1).max(80),
  defaultModel: z.string().min(1),
  defaultReasoningEffort: z.enum(['off', 'low', 'medium', 'high']),
  pollCadenceMs: z.number().int().min(250).max(2000),
  turnTimeoutMs: z.number().int().min(300_000).max(3_600_000),
  envelopeRetries: z.number().int().min(0).max(5),
  gateRetries: z.number().int().min(0).max(5),
  compactionThreshold: z.number().min(COMPACTION_BAND[0]).max(COMPACTION_BAND[1]),
  /** 0 disables; the useful range stops well before a phase's retry budgets. */
  rewindAfterCorrections: z.number().int().min(0).max(20),
  daemonPort: z.number().int().min(DAEMON_PORT_BAND[0]).max(DAEMON_PORT_BAND[1]),
  notifications: z.object({
    accepted: z.boolean(),
    rejected: z.boolean(),
    failed: z.boolean(),
    needsInput: z.boolean(),
  }),
  dockBadge: z.boolean(),
  appearance: z.enum(['system', 'dark']),
  retentionDays: z.number().int().min(1).max(3650).nullable(),
  onboarded: z.boolean(),
});

/**
 * Resolves the path for droid at first launch so executing runs never require
 * a trip to Settings first. An absent binary resolves to its bare name and the
 * doctor explains it.
 */
function defaultClis(): Record<CliVendor, CliConfig> {
  const clis = {} as Record<CliVendor, CliConfig>;
  for (const vendor of CLI_VENDOR_IDS) clis[vendor] = defaultCliConfig(vendor);
  return clis;
}

export function defaultSettings(): AppSettings {
  return {
    clis: defaultClis(),
    defaultCli: 'droid',
    detectCli: 'default',
    detectModel: 'inherit',
    engineerName: process.env.USER || 'engineer',
    defaultModel: 'inherit',
    defaultReasoningEffort: 'medium',
    pollCadenceMs: 500,
    turnTimeoutMs: 20 * 60_000,
    envelopeRetries: 3,
    gateRetries: 2,
    compactionThreshold: 0.8,
    rewindAfterCorrections: 2,
    daemonPort: DEFAULT_DAEMON_PORT,
    notifications: { accepted: true, rejected: true, failed: true, needsInput: true },
    dockBadge: true,
    appearance: 'system',
    retentionDays: null,
    onboarded: false,
  };
}

/**
 * Settings files written before multi-CLI support carry a single `droidPath`.
 * Carrying it over matters: a user who pointed Foundry at a non-standard droid
 * build would otherwise silently get whatever is on PATH after an update.
 *
 * Retired keys are deleted here rather than ignored: the schema is strict on
 * patch, so a stale key that survived the read would fail the operator's next
 * save on a value they never set.
 */
export function migrate(raw: unknown): AppSettings {
  const base = defaultSettings();
  const stored = (raw ?? {}) as Partial<AppSettings> & {
    droidPath?: string;
    defaultAutonomy?: string;
  };
  const clis = { ...base.clis };
  for (const vendor of CLI_VENDOR_IDS) {
    const kept = stored.clis?.[vendor];
    if (kept?.path) clis[vendor] = { path: kept.path, extraArgs: kept.extraArgs ?? [] };
  }
  if (stored.droidPath && !stored.clis?.droid) {
    clis.droid = { path: stored.droidPath, extraArgs: clis.droid.extraArgs };
  }
  const merged: AppSettings = { ...base, ...stored, clis } as AppSettings;
  merged.defaultCli = 'droid';
  if (merged.detectCli !== 'default' && merged.detectCli !== 'droid') {
    merged.detectCli = 'default';
  }
  if (!merged.detectCli) merged.detectCli = base.detectCli;
  if (!merged.detectModel) merged.detectModel = base.detectModel;
  delete (merged as { droidPath?: string }).droidPath;
  // Foundry no longer has autonomy modes: runs are always fully autonomous.
  delete (merged as { defaultAutonomy?: string }).defaultAutonomy;
  // A read is not a save, so an out-of-band value is clamped rather than
  // rejected: refusing it here would leave the app with no threshold at all.
  merged.compactionThreshold = clamp(
    merged.compactionThreshold,
    base.compactionThreshold,
    COMPACTION_BAND,
  );
  // Same read-time clamp as the threshold: a hand-edited negative must not
  // disable validation by leaving the app with no integer at all.
  merged.rewindAfterCorrections = Math.round(
    clamp(merged.rewindAfterCorrections, base.rewindAfterCorrections, [0, 20]),
  );
  // Out-of-band ports (hand-edited or pre-field files) clamp into the mission
  // range rather than leaving the app with no daemon port at all.
  merged.daemonPort = Math.round(
    clamp(merged.daemonPort, base.daemonPort, DAEMON_PORT_BAND),
  );
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
