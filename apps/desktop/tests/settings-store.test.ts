/**
 * Settings written by an older build must still load. Autonomy was a setting
 * once; a file that still carries it is a file a real user has on disk, and
 * dropping the key must not cost them the rest of their configuration.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsStore, defaultSettings, migrate } from '../src/main/store/settings.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foundry-settings-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed(raw: Record<string, unknown>): SettingsStore {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), `${JSON.stringify(raw, null, 2)}\n`);
  return new SettingsStore(dir);
}

const legacy = () => ({
  ...defaultSettings(),
  defaultAutonomy: 'low',
  engineerName: 'ada',
  turnTimeoutMs: 900_000,
});

describe('settings written before autonomy was removed', () => {
  it('loads without error and keeps the operator’s other values', () => {
    const settings = seed(legacy()).get();
    expect(settings.engineerName).toBe('ada');
    expect(settings.turnTimeoutMs).toBe(900_000);
  });

  it('drops the stale key rather than carrying it forward', () => {
    const settings = migrate(legacy());
    expect('defaultAutonomy' in settings).toBe(false);
  });

  it('does not write the stale key back to disk on the next patch', () => {
    const store = seed(legacy());
    const result = store.patch({ engineerName: 'grace' });
    expect(result.ok).toBe(true);
    const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(onDisk.defaultAutonomy).toBeUndefined();
    expect(onDisk.engineerName).toBe('grace');
  });

  it('strips it from a patch that tries to reintroduce it', () => {
    const store = seed(legacy());
    const result = store.patch({ defaultAutonomy: 'high' } as never);
    expect(result.ok).toBe(true);
    expect(result.ok && 'defaultAutonomy' in result.settings).toBe(false);
  });

  it('still carries the pre-multi-CLI droidPath across', () => {
    const settings = migrate({ droidPath: '/custom/bin/droid', defaultAutonomy: 'medium' });
    expect(settings.clis.droid.path).toBe('/custom/bin/droid');
    expect('defaultAutonomy' in settings).toBe(false);
  });
});
