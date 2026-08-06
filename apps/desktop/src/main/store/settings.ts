/**
 * App-scope settings. Validated on change with inline errors, never on save:
 * a value that cannot round-trip is rejected where the user typed it.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { AppSettings } from '@shared/types.js';
import { JsonStore } from './json-store.js';

export const appSettingsSchema = z.object({
  droidPath: z.string().min(1),
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
});

/** PATH lookup so a fresh machine needs no configuration to find droid. */
export function findDroid(): string {
  try {
    const which = execFileSync('/usr/bin/which', ['droid'], { encoding: 'utf8' }).trim();
    if (which) return which;
  } catch {
    // Fall through to the well-known install locations.
  }
  const candidates = [
    join(process.env.HOME ?? '', '.npm-global/bin/droid'),
    '/opt/homebrew/bin/droid',
    '/usr/local/bin/droid',
    join(process.env.HOME ?? '', '.local/bin/droid'),
  ];
  return candidates.find((c) => existsSync(c)) ?? 'droid';
}

export function defaultSettings(): AppSettings {
  return {
    droidPath: findDroid(),
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
  };
}

export class SettingsStore {
  private readonly store: JsonStore<AppSettings>;

  constructor(appSupportDir: string) {
    this.store = new JsonStore<AppSettings>(
      join(appSupportDir, 'settings.json'),
      defaultSettings,
      (raw) => ({ ...defaultSettings(), ...(raw as Partial<AppSettings>) }),
    );
  }

  get(): AppSettings {
    return this.store.read();
  }

  /** Returns the accepted settings, or the validation issues that blocked them. */
  patch(patch: Partial<AppSettings>): { ok: true; settings: AppSettings } | { ok: false; issues: string[] } {
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
