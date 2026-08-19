/**
 * Settings hydrate from disk with shipped defaults for anything missing or
 * out of band. A hand-edited extra key must not enter memory or fail a save.
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

describe('unknown keys on disk', () => {
  it('keeps the operator’s other values and drops the extra key', () => {
    const settings = migrate({
      ...defaultSettings(),
      engineerName: 'ada',
      notASetting: 'nope',
    });
    expect(settings.engineerName).toBe('ada');
    expect('notASetting' in settings).toBe(false);
  });

  it('does not write the extra key back to disk on the next patch', () => {
    const store = seed({
      ...defaultSettings(),
      engineerName: 'ada',
      notASetting: 'nope',
    });
    const result = store.patch({ engineerName: 'grace' });
    expect(result.ok).toBe(true);
    const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(onDisk.notASetting).toBeUndefined();
    expect(onDisk.engineerName).toBe('grace');
  });

  it('strips a patch that tries to introduce one', () => {
    const store = seed(defaultSettings() as unknown as Record<string, unknown>);
    const result = store.patch({ notASetting: 'nope' } as never);
    expect(result.ok).toBe(true);
    expect(result.ok && 'notASetting' in result.settings).toBe(false);
  });

  it('reads a model id as an opaque provider/model string', () => {
    const settings = migrate({ ...defaultSettings(), defaultModel: 'bridge-claude/claude-opus-5' });
    expect(settings.defaultModel).toBe('bridge-claude/claude-opus-5');
  });
});

describe('readiness defaults', () => {
  it('defaults to inherit / high on a fresh install', () => {
    expect(defaultSettings().readinessModel).toBe('inherit');
    expect(defaultSettings().readinessReasoningEffort).toBe('high');
  });

  it('fills readiness fields when they are missing', () => {
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

  it('reads 0.8 when the field is missing', () => {
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
    // A hand-edited out-of-band value still has to load: a threshold of 2
    // would mean compaction could never fire.
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

  it('reads 2 when the field is missing', () => {
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

  it('reads pr_writer when the field is missing', () => {
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

  it('fills the default when the field is missing', () => {
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
});

describe('hiddenModelIds', () => {
  it('defaults to [] on a fresh install', () => {
    expect(defaultSettings().hiddenModelIds).toEqual([]);
  });

  it('reads [] when the field is missing', () => {
    const stored = { ...defaultSettings() } as Record<string, unknown>;
    delete stored.hiddenModelIds;
    expect(migrate(stored).hiddenModelIds).toEqual([]);
    expect(seed(stored).get().hiddenModelIds).toEqual([]);
  });

  it('normalizes junk values to []', () => {
    expect(
      migrate({ ...defaultSettings(), hiddenModelIds: 'nope' as never }).hiddenModelIds,
    ).toEqual([]);
    expect(migrate({ ...defaultSettings(), hiddenModelIds: [1] as never }).hiddenModelIds).toEqual(
      [],
    );
    expect(migrate({ ...defaultSettings(), hiddenModelIds: null as never }).hiddenModelIds).toEqual(
      [],
    );
    expect(
      migrate({ ...defaultSettings(), hiddenModelIds: ['', '   ', 'valid/model'] }).hiddenModelIds,
    ).toEqual(['   ', 'valid/model']);
  });

  it('dedupes and filters empty strings from stored arrays', () => {
    expect(
      migrate({
        ...defaultSettings(),
        hiddenModelIds: ['openai/gpt-5', '', 'openai/gpt-5', 'anthropic/claude-3'],
      }).hiddenModelIds,
    ).toEqual(['openai/gpt-5', 'anthropic/claude-3']);
  });

  it('persists and round-trips via patch', () => {
    const store = seed(defaultSettings() as unknown as Record<string, unknown>);
    const result = store.patch({ hiddenModelIds: ['bridge-claude/claude-opus-5'] });
    expect(result.ok).toBe(true);
    expect(store.get().hiddenModelIds).toEqual(['bridge-claude/claude-opus-5']);
    const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(onDisk.hiddenModelIds).toEqual(['bridge-claude/claude-opus-5']);
  });
});
