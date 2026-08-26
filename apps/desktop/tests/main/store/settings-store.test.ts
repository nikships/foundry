/**
 * Settings hydrate from disk with shipped defaults for anything missing or
 * out of band. A hand-edited extra key must not enter memory or fail a save.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../helpers/tmp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsStore, defaultSettings, migrate } from '../../../src/main/store/settings.js';
import { REASONING_EFFORTS } from '../../../src/shared/reasoning-effort.js';
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

describe('Linear workflow mapping', () => {
  it('defaults legacy installs to an unconfigured mapping', () => {
    const stored = { ...defaultSettings() } as Record<string, unknown>;
    delete stored.linearStatusMapping;
    expect(migrate(stored).linearStatusMapping).toEqual({
      started: null,
      completed: null,
      failed: null,
    });
  });

  it('persists workflow state IDs but repairs malformed values', () => {
    const store = seed(defaultSettings() as unknown as Record<string, unknown>);
    const mapping = { started: 'state-started', completed: 'state-done', failed: 'state-failed' };
    expect(store.patch({ linearStatusMapping: mapping })).toMatchObject({ ok: true });
    expect(store.get().linearStatusMapping).toEqual(mapping);
    expect(
      migrate({
        ...defaultSettings(),
        linearStatusMapping: { started: '', completed: 7, failed: 'state-failed' } as never,
      }).linearStatusMapping,
    ).toEqual({ started: null, completed: null, failed: 'state-failed' });
  });
});

describe('theme', () => {
  it('defaults fresh and legacy installs to dark', () => {
    expect(defaultSettings().theme).toBe('dark');
    const stored = { ...defaultSettings() } as Record<string, unknown>;
    delete stored.theme;
    expect(migrate(stored).theme).toBe('dark');
    expect(seed(stored).get().theme).toBe('dark');
  });

  it('repairs an invalid stored theme to dark', () => {
    expect(migrate({ ...defaultSettings(), theme: 'sepia' as never }).theme).toBe('dark');
  });

  it('persists light and rejects invalid patches without losing it', () => {
    const store = seed(defaultSettings() as unknown as Record<string, unknown>);
    expect(store.patch({ theme: 'light' })).toMatchObject({ ok: true });
    expect(store.get().theme).toBe('light');
    const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(onDisk.theme).toBe('light');
    expect(store.patch({ theme: 'sepia' as never }).ok).toBe(false);
    expect(store.get().theme).toBe('light');
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

describe('the healing model pair', () => {
  it('inherits the default model on a fresh install', () => {
    expect(defaultSettings().healingModel).toBe('inherit');
    expect(defaultSettings().healingReasoningEffort).toBe('medium');
  });

  it('reads the shipped defaults on an install predating the setting', () => {
    const stored = { ...defaultSettings() } as Record<string, unknown>;
    delete stored.healingModel;
    delete stored.healingReasoningEffort;
    expect(migrate(stored).healingModel).toBe('inherit');
    expect(migrate(stored).healingReasoningEffort).toBe('medium');
    expect(seed(stored).get().healingModel).toBe('inherit');
    expect(seed(stored).get().healingReasoningEffort).toBe('medium');
  });

  it('repairs a stored garbage model back to inherit', () => {
    expect(migrate({ ...defaultSettings(), healingModel: '' }).healingModel).toBe('inherit');
    expect(migrate({ ...defaultSettings(), healingModel: 7 as never }).healingModel).toBe(
      'inherit',
    );
  });

  it('repairs a stored effort outside the known levels', () => {
    expect(
      migrate({ ...defaultSettings(), healingReasoningEffort: 'ludicrous' as never })
        .healingReasoningEffort,
    ).toBe('medium');
  });

  it('keeps every known level', () => {
    for (const effort of REASONING_EFFORTS) {
      expect(
        migrate({ ...defaultSettings(), healingReasoningEffort: effort }).healingReasoningEffort,
      ).toBe(effort);
    }
  });

  it('persists an opaque provider/model id and a level via patch', () => {
    const store = seed(defaultSettings() as unknown as Record<string, unknown>);
    expect(
      store.patch({ healingModel: 'bridge-claude/claude-opus-5', healingReasoningEffort: 'high' }),
    ).toMatchObject({ ok: true });
    expect(store.get().healingModel).toBe('bridge-claude/claude-opus-5');
    expect(store.get().healingReasoningEffort).toBe('high');
    const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(onDisk.healingModel).toBe('bridge-claude/claude-opus-5');
  });

  it('refuses an empty model or an unknown level rather than storing it', () => {
    const store = seed(defaultSettings() as unknown as Record<string, unknown>);
    expect(store.patch({ healingModel: '' }).ok).toBe(false);
    expect(store.patch({ healingReasoningEffort: 'turbo' as never }).ok).toBe(false);
    expect(store.get().healingModel).toBe('inherit');
    expect(store.get().healingReasoningEffort).toBe('medium');
  });
});

describe('smithModel', () => {
  it('defaults to inherit on a fresh install', () => {
    expect(defaultSettings().smithModel).toBe('inherit');
  });

  it('reads inherit when the field is missing', () => {
    const stored = { ...defaultSettings() } as Record<string, unknown>;
    delete stored.smithModel;
    expect(migrate(stored).smithModel).toBe('inherit');
    expect(seed(stored).get().smithModel).toBe('inherit');
  });

  it('repairs a stored garbage value back to inherit', () => {
    expect(migrate({ ...defaultSettings(), smithModel: '' }).smithModel).toBe('inherit');
    expect(migrate({ ...defaultSettings(), smithModel: 12 as never }).smithModel).toBe('inherit');
  });

  it('persists an opaque provider/model id via patch', () => {
    const store = seed(defaultSettings() as unknown as Record<string, unknown>);
    expect(store.patch({ smithModel: 'bridge-claude/claude-opus-5' })).toMatchObject({ ok: true });
    expect(store.get().smithModel).toBe('bridge-claude/claude-opus-5');
  });

  it('refuses an empty model rather than storing it', () => {
    const store = seed(defaultSettings() as unknown as Record<string, unknown>);
    expect(store.patch({ smithModel: '' }).ok).toBe(false);
    expect(store.get().smithModel).toBe('inherit');
  });
});

describe('smithReasoningEffort', () => {
  it('defaults to medium on a fresh install', () => {
    expect(defaultSettings().smithReasoningEffort).toBe('medium');
  });

  it('reads medium when the field is missing — an install predating the setting', () => {
    const stored = { ...defaultSettings() } as Record<string, unknown>;
    delete stored.smithReasoningEffort;
    expect(migrate(stored).smithReasoningEffort).toBe('medium');
    expect(seed(stored).get().smithReasoningEffort).toBe('medium');
  });

  it('repairs a stored value outside the known levels', () => {
    expect(
      migrate({ ...defaultSettings(), smithReasoningEffort: 'ludicrous' as never })
        .smithReasoningEffort,
    ).toBe('medium');
    expect(
      migrate({ ...defaultSettings(), smithReasoningEffort: 3 as never }).smithReasoningEffort,
    ).toBe('medium');
  });

  it('keeps every known level, including the ones only some models offer', () => {
    for (const effort of REASONING_EFFORTS) {
      expect(
        migrate({ ...defaultSettings(), smithReasoningEffort: effort }).smithReasoningEffort,
      ).toBe(effort);
    }
  });

  it('persists a level via patch and refuses one it does not know', () => {
    const store = seed(defaultSettings() as unknown as Record<string, unknown>);
    expect(store.patch({ smithReasoningEffort: 'max' })).toMatchObject({ ok: true });
    expect(store.get().smithReasoningEffort).toBe('max');
    expect(store.patch({ smithReasoningEffort: 'turbo' as never }).ok).toBe(false);
    expect(store.get().smithReasoningEffort).toBe('max');
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

describe('removed terminal/coding-agent settings', () => {
  it('drops stored terminalApp and codingAgent keys during self-healing', () => {
    const migrated = migrate({
      ...defaultSettings(),
      terminalApp: 'ghostty',
      codingAgent: 'claude',
    });
    expect('terminalApp' in migrated).toBe(false);
    expect('codingAgent' in migrated).toBe(false);
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
