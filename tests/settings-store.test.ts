/**
 * Settings written by an older build must still load. Autonomy, CLI paths, a
 * daemon port and a Factory API key were all settings once; a file that still
 * carries them is a file a real user has on disk, and dropping those keys must
 * not cost them the rest of their configuration.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsStore, defaultSettings, migrate } from '../src/main/store/settings.js';
import {
  BRIDGE_PORT_MAX,
  BRIDGE_PORT_MIN,
  DEFAULT_BRIDGE_PORT,
} from '../src/main/bridge/manager.js';
import { DEFAULT_PR_AGENT } from '../src/shared/types.js';

let dir: string;

beforeEach(() => {
  dir = tempDir('foundry-settings-');
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
});

describe('settings written before the migration to pi', () => {
  const droidEra = () => ({
    ...defaultSettings(),
    engineerName: 'ada',
    turnTimeoutMs: 900_000,
    clis: { droid: { path: '/custom/bin/droid', extraArgs: [] } },
    defaultCli: 'droid',
    detectCli: 'default',
    daemonPort: 37_650,
    factoryApiKey: 'fk-a-real-key',
    mcpServers: [{ id: 'mcp_1', name: 'local', type: 'stdio', command: 'npx' }],
    droidPath: '/custom/bin/droid',
  });

  it('drops every retired key, credential included', () => {
    const settings = migrate(droidEra()) as unknown as Record<string, unknown>;
    for (const key of [
      'clis',
      'defaultCli',
      'detectCli',
      'daemonPort',
      'factoryApiKey',
      'mcpServers',
      'droidPath',
    ]) {
      expect(key in settings, key).toBe(false);
    }
  });

  it('keeps everything the operator actually still configures', () => {
    const settings = migrate(droidEra());
    expect(settings.engineerName).toBe('ada');
    expect(settings.turnTimeoutMs).toBe(900_000);
    expect(settings.defaultModel).toBe('inherit');
  });

  // A credential left in settings.json is a credential nothing reads and
  // everything can see, so the first write after an upgrade has to remove it.
  it('removes the stored Factory key from disk on the next patch', () => {
    const store = seed(droidEra());
    expect(store.patch({ engineerName: 'grace' }).ok).toBe(true);
    const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(onDisk.factoryApiKey).toBeUndefined();
    expect(onDisk.clis).toBeUndefined();
    expect(onDisk.daemonPort).toBeUndefined();
    expect(onDisk.mcpServers).toBeUndefined();
    expect(onDisk.engineerName).toBe('grace');
  });

  it('strips a patch that tries to reintroduce one', () => {
    const store = seed(defaultSettings() as unknown as Record<string, unknown>);
    const result = store.patch({ factoryApiKey: 'fk-again' } as never);
    expect(result.ok).toBe(true);
    expect(result.ok && 'factoryApiKey' in result.settings).toBe(false);
  });

  it('reads a model id as an opaque provider/model string', () => {
    // Model ids are no longer validated against a CLI's catalog: a stored
    // `bridge-claude/claude-opus-5` must survive a read untouched.
    const settings = migrate({ ...droidEra(), defaultModel: 'bridge-claude/claude-opus-5' });
    expect(settings.defaultModel).toBe('bridge-claude/claude-opus-5');
  });
});

describe('readiness defaults', () => {
  it('defaults to inherit / high on a fresh install', () => {
    expect(defaultSettings().readinessModel).toBe('inherit');
    expect(defaultSettings().readinessReasoningEffort).toBe('high');
  });

  it('fills readiness fields for a settings file written before they existed', () => {
    const stored = { ...defaultSettings() } as Record<string, unknown>;
    delete stored.readinessModel;
    delete stored.readinessReasoningEffort;
    const migrated = migrate(stored);
    expect(migrated.readinessModel).toBe('inherit');
    expect(migrated.readinessReasoningEffort).toBe('high');
  });
});

describe('the compaction threshold', () => {
  it('defaults to 0.8 on a fresh install', () => {
    expect(defaultSettings().compactionThreshold).toBe(0.8);
  });

  it('reads 0.8 for a settings file written before the field existed', () => {
    const stored = { ...defaultSettings() } as Record<string, unknown>;
    delete stored.compactionThreshold;
    expect(migrate(stored).compactionThreshold).toBe(0.8);
    expect(seed(stored).get().compactionThreshold).toBe(0.8);
  });

  it('accepts a value inside the useful band', () => {
    const store = seed(defaultSettings() as unknown as Record<string, unknown>);
    expect(store.patch({ compactionThreshold: 0.6 })).toMatchObject({ ok: true });
    expect(store.get().compactionThreshold).toBe(0.6);
  });

  it('refuses a value outside the band rather than storing it', () => {
    const store = seed(defaultSettings() as unknown as Record<string, unknown>);
    for (const value of [0.1, 0.99, 1, 0]) {
      expect(store.patch({ compactionThreshold: value }).ok).toBe(false);
    }
    // A rejected patch leaves the last good value on disk.
    expect(store.get().compactionThreshold).toBe(0.8);
  });

  it('clamps a stored value that is out of band into it', () => {
    // Hand-edited files and files from a build with a different band still have
    // to load: a threshold of 2 would mean compaction could never fire.
    expect(migrate({ ...defaultSettings(), compactionThreshold: 2 }).compactionThreshold).toBe(
      0.95,
    );
    expect(migrate({ ...defaultSettings(), compactionThreshold: 0 }).compactionThreshold).toBe(0.5);
    expect(
      migrate({ ...defaultSettings(), compactionThreshold: 'lots' as never }).compactionThreshold,
    ).toBe(0.8);
  });
});

describe('rewindAfterCorrections', () => {
  it('defaults to 2 on a fresh install', () => {
    expect(defaultSettings().rewindAfterCorrections).toBe(2);
  });

  it('reads 2 for a settings file written before the field existed', () => {
    const stored = { ...defaultSettings() } as Record<string, unknown>;
    delete stored.rewindAfterCorrections;
    expect(migrate(stored).rewindAfterCorrections).toBe(2);
    expect(seed(stored).get().rewindAfterCorrections).toBe(2);
  });

  it('accepts 0 (disabled) and other non-negative integers', () => {
    const store = seed(defaultSettings() as unknown as Record<string, unknown>);
    expect(store.patch({ rewindAfterCorrections: 0 })).toMatchObject({ ok: true });
    expect(store.get().rewindAfterCorrections).toBe(0);
    expect(store.patch({ rewindAfterCorrections: 5 })).toMatchObject({ ok: true });
    expect(store.get().rewindAfterCorrections).toBe(5);
  });

  it('refuses a negative or non-integer value rather than storing it', () => {
    const store = seed(defaultSettings() as unknown as Record<string, unknown>);
    for (const value of [-1, 1.5, 21]) {
      expect(store.patch({ rewindAfterCorrections: value }).ok).toBe(false);
    }
    expect(store.get().rewindAfterCorrections).toBe(2);
  });

  it('clamps a stored out-of-range value into the accepted band', () => {
    expect(
      migrate({ ...defaultSettings(), rewindAfterCorrections: -3 }).rewindAfterCorrections,
    ).toBe(0);
    expect(
      migrate({ ...defaultSettings(), rewindAfterCorrections: 99 }).rewindAfterCorrections,
    ).toBe(20);
  });
});

describe('prAgent', () => {
  it('defaults to pr_writer on a fresh install', () => {
    expect(defaultSettings().prAgent).toBe(DEFAULT_PR_AGENT);
  });

  it('reads pr_writer for a settings file written before the field existed', () => {
    const stored = { ...defaultSettings() } as Record<string, unknown>;
    delete stored.prAgent;
    expect(migrate(stored).prAgent).toBe(DEFAULT_PR_AGENT);
    expect(seed(stored).get().prAgent).toBe(DEFAULT_PR_AGENT);
  });

  it('keeps a valid custom writer name', () => {
    const store = seed(defaultSettings() as unknown as Record<string, unknown>);
    expect(store.patch({ prAgent: 'my_writer' })).toMatchObject({ ok: true });
    expect(store.get().prAgent).toBe('my_writer');
  });

  it('refuses an invalid writer name rather than storing it', () => {
    const store = seed(defaultSettings() as unknown as Record<string, unknown>);
    for (const value of ['', 'PR Writer', '1writer', 'MyWriter']) {
      expect(store.patch({ prAgent: value }).ok).toBe(false);
    }
    expect(store.get().prAgent).toBe(DEFAULT_PR_AGENT);
  });

  it('repairs a stored garbage writer name back to pr_writer', () => {
    expect(migrate({ ...defaultSettings(), prAgent: 'PR Writer' }).prAgent).toBe(DEFAULT_PR_AGENT);
    expect(migrate({ ...defaultSettings(), prAgent: '' }).prAgent).toBe(DEFAULT_PR_AGENT);
    expect(migrate({ ...defaultSettings(), prAgent: 12 as never }).prAgent).toBe(DEFAULT_PR_AGENT);
  });
});

describe('bridgePort', () => {
  it('defaults to the Bridge manager’s own default on a fresh install', () => {
    expect(defaultSettings().bridgePort).toBe(DEFAULT_BRIDGE_PORT);
  });

  it('fills the default for a settings file written before the field existed', () => {
    const stored = { ...defaultSettings() } as Record<string, unknown>;
    delete stored.bridgePort;
    expect(migrate(stored).bridgePort).toBe(DEFAULT_BRIDGE_PORT);
    expect(seed(stored).get().bridgePort).toBe(DEFAULT_BRIDGE_PORT);
  });

  it('accepts a value inside the mission band', () => {
    const store = seed(defaultSettings() as unknown as Record<string, unknown>);
    expect(store.patch({ bridgePort: BRIDGE_PORT_MIN + 5 })).toMatchObject({ ok: true });
    expect(store.get().bridgePort).toBe(BRIDGE_PORT_MIN + 5);
  });

  it('refuses a value outside the band rather than storing it', () => {
    const store = seed(defaultSettings() as unknown as Record<string, unknown>);
    for (const value of [80, 9_999, BRIDGE_PORT_MIN - 1, BRIDGE_PORT_MAX + 1, 37.5]) {
      expect(store.patch({ bridgePort: value }).ok, String(value)).toBe(false);
    }
    expect(store.get().bridgePort).toBe(DEFAULT_BRIDGE_PORT);
  });

  it('clamps a stored out-of-range value into the mission band', () => {
    expect(migrate({ ...defaultSettings(), bridgePort: 80 }).bridgePort).toBe(BRIDGE_PORT_MIN);
    expect(migrate({ ...defaultSettings(), bridgePort: 99_999 }).bridgePort).toBe(BRIDGE_PORT_MAX);
    expect(migrate({ ...defaultSettings(), bridgePort: 'busy' as never }).bridgePort).toBe(
      DEFAULT_BRIDGE_PORT,
    );
  });

  // The daemon port was in a different band, so carrying it forward would put
  // the Bridge on a port its manager never scans.
  it('does not inherit a stored daemonPort', () => {
    const settings = migrate({ ...defaultSettings(), daemonPort: 37_650 });
    expect(settings.bridgePort).toBe(DEFAULT_BRIDGE_PORT);
  });
});
