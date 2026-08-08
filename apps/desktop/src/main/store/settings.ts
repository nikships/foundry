/**
 * App-scope settings. Validated on change with inline errors, never on save:
 * a value that cannot round-trip is rejected where the user typed it.
 */

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  type AppSettings,
  type BrandId,
  type CliConfig,
  type CliVendor,
  CLI_VENDOR_IDS,
} from '@shared/types.js';
import { defaultCliConfig } from '../cli/index.js';
import { JsonStore } from './json-store.js';

/**
 * The window's background colour and the renderer's token sheet both have to be
 * the right brand before anything paints, and `SettingsStore` is only readable
 * after `AppContext` exists. This reads the one field directly, synchronously,
 * so `createWindow` can be called with it.
 */
export function readBrandSync(supportDir: string): BrandId {
  try {
    const raw = readFileSync(join(supportDir, 'settings.json'), 'utf8');
    const stored = JSON.parse(raw) as { brand?: unknown };
    if (stored.brand === 'murmur' || stored.brand === 'prism') return stored.brand;
  } catch {
    // First launch, or a settings file the store will repair on load.
  }
  return 'prism';
}

const cliConfigSchema = z.object({
  path: z.string().min(1),
  extraArgs: z.array(z.string()),
});

export const appSettingsSchema = z.object({
  clis: z.object({
    droid: cliConfigSchema,
    claude: cliConfigSchema,
    codex: cliConfigSchema,
    junie: cliConfigSchema,
    grok: cliConfigSchema,
  }),
  defaultCli: z.enum(['droid', 'claude', 'codex', 'junie', 'grok']),
  detectCli: z.enum(['default', 'droid', 'claude', 'codex', 'junie', 'grok']),
  detectModel: z.string().min(1),
  engineerName: z.string().min(1).max(80),
  defaultAutonomy: z.enum(['low', 'medium', 'high']),
  defaultModel: z.string().min(1),
  defaultReasoningEffort: z.enum(['off', 'low', 'medium', 'high']),
  pollCadenceMs: z.number().int().min(250).max(2000),
  turnTimeoutMs: z.number().int().min(300_000).max(3_600_000),
  envelopeRetries: z.number().int().min(0).max(5),
  gateRetries: z.number().int().min(0).max(5),
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
  brand: z.enum(['prism', 'murmur']),
});

/**
 * Every vendor gets a resolved path at first launch, whether or not it is
 * installed, so choosing a CLI in the roster never requires a trip to Settings
 * first. An absent binary resolves to its bare name and the doctor explains it.
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
    defaultAutonomy: 'medium',
    defaultModel: 'claude-opus-5',
    defaultReasoningEffort: 'medium',
    pollCadenceMs: 500,
    turnTimeoutMs: 20 * 60_000,
    envelopeRetries: 3,
    gateRetries: 2,
    notifications: { accepted: true, rejected: true, failed: true, needsInput: true },
    dockBadge: true,
    appearance: 'system',
    retentionDays: null,
    onboarded: false,
    brand: 'prism',
  };
}

/**
 * Settings files written before multi-CLI support carry a single `droidPath`.
 * Carrying it over matters: a user who pointed Foundry at a non-standard droid
 * build would otherwise silently get whatever is on PATH after an update.
 */
export function migrate(raw: unknown): AppSettings {
  const base = defaultSettings();
  const stored = (raw ?? {}) as Partial<AppSettings> & { droidPath?: string };
  const clis = { ...base.clis };
  for (const vendor of CLI_VENDOR_IDS) {
    const kept = stored.clis?.[vendor];
    if (kept?.path) clis[vendor] = { path: kept.path, extraArgs: kept.extraArgs ?? [] };
  }
  if (stored.droidPath && !stored.clis?.droid) {
    clis.droid = { path: stored.droidPath, extraArgs: clis.droid.extraArgs };
  }
  const merged: AppSettings = { ...base, ...stored, clis } as AppSettings;
  // Settings files written before detection was configurable have neither
  // field, and an empty string would fail the schema on the next patch.
  if (!merged.detectCli) merged.detectCli = base.detectCli;
  if (!merged.detectModel) merged.detectModel = base.detectModel;
  // Existing installs won't have brand; default to prism.
  if (
    (merged as unknown as { brand?: string }).brand !== 'prism' &&
    (merged as unknown as { brand?: string }).brand !== 'murmur'
  ) {
    (merged as AppSettings).brand = 'prism';
  }
  delete (merged as { droidPath?: string }).droidPath;
  return merged;
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
