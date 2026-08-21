/**
 * Settings hydrate from disk with shipped defaults for anything missing or
 * out of band. A hand-edited extra key must not enter memory or fail a save.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../helpers/tmp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsStore, defaultSettings, migrate } from '../../../src/main/store/settings.js';
import { DEFAULT_PR_AGENT } from '../../../src/shared/types.js';

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

describe('helper defaults', () => {
  it('defaults to inherit / high on a fresh install', () => {
    expect(defaultSettings().helperModel).toBe('inherit');
    expect(defaultSettings().helperReasoningEffort).toBe('high');
  });

  it('migrates the former readiness and detection settings into one pair', () => {
    const migrated = migrate({
      ...defaultSettings(),
      helperModel: undefined,
      helperReasoningEffort: undefined,
      readinessModel: 'provider/ready',
      detectModel: 'provider/detect',
      readinessReasoningEffort: 'max',
    });
    expect(migrated.helperModel).toBe('provider/ready');
    expect(migrated.helperReasoningEffort).toBe('max');
    expect('readinessModel' in migrated).toBe(false);
    expect('detectModel' in migrated).toBe(false);
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

describe('obsolete settings', () => {
  it('drops appearance, polling, retry, rewind, timeout, and bridge keys during self-healing', () => {
    const migrated = migrate({
      ...defaultSettings(),
      appearance: 'dark',
      pollCadenceMs: 9_000,
      envelopeRetries: 0,
      gateRetries: 0,
      rewindAfterCorrections: 0,
      turnTimeoutMs: 30 * 60_000,
      bridgePort: 37_799,
    });
    for (const key of [
      'appearance',
      'pollCadenceMs',
      'envelopeRetries',
      'gateRetries',
      'rewindAfterCorrections',
      'turnTimeoutMs',
      'bridgePort',
    ]) {
      expect(key in migrated).toBe(false);
    }
  });
});

describe('codingAgent', () => {
  it('defaults to automatic on a fresh install', () => {
    expect(defaultSettings().codingAgent).toBeNull();
  });

  it('reads automatic when the field is missing', () => {
    const stored = { ...defaultSettings() } as Record<string, unknown>;
    delete stored.codingAgent;
    expect(migrate(stored).codingAgent).toBeNull();
    expect(seed(stored).get().codingAgent).toBeNull();
  });

  it('keeps a valid catalogued agent', () => {
    const store = seed(defaultSettings() as unknown as Record<string, unknown>);
    expect(store.patch({ codingAgent: 'claude' })).toMatchObject({ ok: true });
    expect(store.get().codingAgent).toBe('claude');
    expect(store.patch({ codingAgent: 'pi' })).toMatchObject({ ok: true });
    expect(store.get().codingAgent).toBe('pi');
  });

  it('refuses an unknown agent rather than storing it', () => {
    const store = seed(defaultSettings() as unknown as Record<string, unknown>);
    expect(store.patch({ codingAgent: 'cursor' as never }).ok).toBe(false);
    expect(store.get().codingAgent).toBeNull();
  });

  it('repairs a stored garbage agent name back to automatic', () => {
    expect(
      migrate({ ...defaultSettings(), codingAgent: 'cursor' as never }).codingAgent,
    ).toBeNull();
    expect(migrate({ ...defaultSettings(), codingAgent: '' as never }).codingAgent).toBeNull();
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
