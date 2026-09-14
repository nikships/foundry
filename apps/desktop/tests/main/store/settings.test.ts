/**
 * Installed-font setting: persistence, sanitization, migration, and theme
 * coexistence. Extends the settings-store contract without duplicating it.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../helpers/tmp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsStore, defaultSettings, migrate } from '../../../src/main/store/settings.js';
import {
  DEFAULT_INTERFACE_FONT,
  DEFAULT_MONO_FONT,
  NERD_SYMBOLS_FAMILY,
  fontStack,
  sanitizeFontFamily,
} from '../../../src/shared/types.js';
import {
  parseSystemProfiler,
  clearFontCacheForTest,
  listInstalledFonts,
} from '../../../src/main/system/font-list.js';

let dir: string;

beforeEach(() => {
  dir = tempDir('foundry-font-settings-');
  clearFontCacheForTest();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearFontCacheForTest();
});

function seed(raw: Record<string, unknown>): SettingsStore {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), `${JSON.stringify(raw, null, 2)}\n`);
  return new SettingsStore(dir);
}

describe('font defaults and sanitizer', () => {
  it('defaults both faces to null (shipped Geist faces)', () => {
    expect(defaultSettings().interfaceFont).toBe(null);
    expect(defaultSettings().monoFont).toBe(null);
  });

  it('accepts normal family names and trims them', () => {
    expect(sanitizeFontFamily('Hoefler Text')).toBe('Hoefler Text');
    expect(sanitizeFontFamily('  SF Mono  ')).toBe('SF Mono');
    expect(sanitizeFontFamily('ヒラギノ角ゴ')).toBe('ヒラギノ角ゴ');
  });

  it('normalizes empty and whitespace to null', () => {
    expect(sanitizeFontFamily('')).toBe(null);
    expect(sanitizeFontFamily('   ')).toBe(null);
    expect(sanitizeFontFamily(null)).toBe(null);
    expect(sanitizeFontFamily(undefined)).toBe(null);
    expect(sanitizeFontFamily(12)).toBe(null);
  });

  it('rejects CSS-injection strings and overlong values', () => {
    expect(sanitizeFontFamily('"); evil')).toBe(null);
    expect(sanitizeFontFamily("'; color: red; '")).toBe(null);
    expect(sanitizeFontFamily('Family"Name')).toBe(null);
    expect(sanitizeFontFamily('a'.repeat(129))).toBe(null);
    expect(sanitizeFontFamily('a'.repeat(128))).toBe('a'.repeat(128));
  });
});

describe('font stacks', () => {
  it('puts the user face first, nerd symbols second, and keeps the system tail', () => {
    const ui = fontStack('Hoefler Text', 'ui');
    expect(ui.indexOf('"Hoefler Text"')).toBe(0);
    expect(ui).toContain(`"${NERD_SYMBOLS_FAMILY}"`);
    expect(ui).toContain(`"${DEFAULT_INTERFACE_FONT}"`);
    expect(ui.indexOf('"Hoefler Text"')).toBeLessThan(ui.indexOf(`"${NERD_SYMBOLS_FAMILY}"`));
    expect(ui.indexOf(`"${NERD_SYMBOLS_FAMILY}"`)).toBeLessThan(
      ui.indexOf(`"${DEFAULT_INTERFACE_FONT}"`),
    );
    expect(ui).toContain('system-ui');
  });

  it('covers mono with ui-monospace tail', () => {
    const mono = fontStack('SF Mono', 'mono');
    expect(mono.indexOf('"SF Mono"')).toBe(0);
    expect(mono).toContain(`"${NERD_SYMBOLS_FAMILY}"`);
    expect(mono).toContain(`"${DEFAULT_MONO_FONT}"`);
    expect(mono).toContain('ui-monospace');
  });

  it('falls back to shipped defaults on null and hostile input without throwing', () => {
    expect(fontStack(null, 'ui')).toContain(`"${DEFAULT_INTERFACE_FONT}"`);
    expect(fontStack(null, 'mono')).toContain(`"${DEFAULT_MONO_FONT}"`);
    expect(fontStack('"); evil', 'ui')).toContain(`"${DEFAULT_INTERFACE_FONT}"`);
    expect(fontStack('"); evil', 'ui')).not.toContain('evil');
    expect(() => fontStack(undefined, 'ui')).not.toThrow();
  });
});

describe('font persistence', () => {
  it('persists a normal family for both faces', () => {
    const store = seed(defaultSettings() as unknown as Record<string, unknown>);
    expect(store.patch({ interfaceFont: 'Hoefler Text', monoFont: 'SF Mono' })).toMatchObject({
      ok: true,
    });
    expect(store.get().interfaceFont).toBe('Hoefler Text');
    expect(store.get().monoFont).toBe('SF Mono');
    const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(onDisk.interfaceFont).toBe('Hoefler Text');
    expect(onDisk.monoFont).toBe('SF Mono');
  });

  it('normalizes empty and hostile patches to null with ok:true', () => {
    const store = seed(defaultSettings() as unknown as Record<string, unknown>);
    expect(store.patch({ interfaceFont: '' as unknown as string })).toMatchObject({ ok: true });
    expect(store.get().interfaceFont).toBe(null);
    expect(store.patch({ monoFont: '   ' as unknown as string })).toMatchObject({ ok: true });
    expect(store.get().monoFont).toBe(null);
    expect(store.patch({ interfaceFont: '"); evil' })).toMatchObject({ ok: true });
    expect(store.get().interfaceFont).toBe(null);
  });

  it('migrates legacy files without the keys to null', () => {
    const stored = { ...defaultSettings() } as Record<string, unknown>;
    delete stored.interfaceFont;
    delete stored.monoFont;
    const migrated = migrate(stored);
    expect(migrated.interfaceFont).toBe(null);
    expect(migrated.monoFont).toBe(null);
    expect(seed(stored).get().interfaceFont).toBe(null);
  });

  it('migrates garbage values to null', () => {
    expect(migrate({ ...defaultSettings(), interfaceFont: '"; x' as never }).interfaceFont).toBe(
      null,
    );
    expect(migrate({ ...defaultSettings(), monoFont: 7 as never }).monoFont).toBe(null);
  });

  it('coexists with the theme picker in both directions', () => {
    const store = seed(defaultSettings() as unknown as Record<string, unknown>);
    expect(store.patch({ theme: 'light', interfaceFont: 'Hoefler Text' })).toMatchObject({
      ok: true,
    });
    expect(store.get().theme).toBe('light');
    expect(store.get().interfaceFont).toBe('Hoefler Text');
    // Switching themes preserves the font choice.
    expect(store.patch({ theme: 'dark' })).toMatchObject({ ok: true });
    expect(store.get().theme).toBe('dark');
    expect(store.get().interfaceFont).toBe('Hoefler Text');
    // Switching fonts preserves the theme.
    expect(store.patch({ monoFont: 'SF Mono' })).toMatchObject({ ok: true });
    expect(store.get().theme).toBe('dark');
    expect(store.get().monoFont).toBe('SF Mono');
  });
});

describe('fonts:list IPC handler', () => {
  it('registers fonts:list and returns the enumerated families', async () => {
    const fontList = await import('../../../src/main/system/font-list.js');
    const spy = vi.spyOn(fontList, 'listInstalledFonts').mockResolvedValueOnce(['Helvetica']);
    try {
      const { register } = await import('../../../src/main/ipc/settings.js');
      const { IPC } = await import('../../../src/shared/ipc-contract.js');
      const handlers = new Map<string, (...args: never[]) => unknown>();
      const store = seed(defaultSettings() as unknown as Record<string, unknown>);
      register(
        {
          settings: store,
          projects: { list: () => [] },
          roster: { hasProjectCopy: () => false, resetHiddenModelPins: () => {} },
          applyTheme: () => {},
          broadcast: () => {},
        } as never,
        ((channel: string, fn: (...args: never[]) => unknown) => {
          handlers.set(channel, fn);
        }) as never,
      );
      const list = handlers.get(IPC.fontsList) as () => Promise<string[]>;
      expect(typeof list).toBe('function');
      await expect(list()).resolves.toEqual(['Helvetica']);
    } finally {
      spy.mockRestore();
      clearFontCacheForTest();
    }
  });

  it('answers [] when enumeration throws', async () => {
    const fontList = await import('../../../src/main/system/font-list.js');
    const spy = vi.spyOn(fontList, 'listInstalledFonts').mockRejectedValueOnce(new Error('boom'));
    try {
      const { register } = await import('../../../src/main/ipc/settings.js');
      const { IPC } = await import('../../../src/shared/ipc-contract.js');
      const handlers = new Map<string, (...args: never[]) => unknown>();
      const store = seed(defaultSettings() as unknown as Record<string, unknown>);
      register(
        {
          settings: store,
          projects: { list: () => [] },
          roster: { hasProjectCopy: () => false, resetHiddenModelPins: () => {} },
          applyTheme: () => {},
          broadcast: () => {},
        } as never,
        ((channel: string, fn: (...args: never[]) => unknown) => {
          handlers.set(channel, fn);
        }) as never,
      );
      const list = handlers.get(IPC.fontsList) as () => Promise<string[]>;
      await expect(list()).resolves.toEqual([]);
    } finally {
      spy.mockRestore();
      clearFontCacheForTest();
    }
  });
});

describe('font enumeration parser', () => {
  it('parses families, dedupes case-insensitively, and sorts', () => {
    const json = JSON.stringify({
      SPFontsDataType: [
        {
          _items: [
            { _name: 'Helvetica' },
            { _name: 'helvetica' },
            { _name: '  Hoefler Text  ' },
            { _name: '' },
            { family: 'SF Mono' },
          ],
        },
      ],
    });
    expect(parseSystemProfiler(json)).toEqual(['Helvetica', 'Hoefler Text', 'SF Mono']);
  });

  it('returns [] on garbage, missing keys, and shape drift', () => {
    expect(parseSystemProfiler('not json')).toEqual([]);
    expect(parseSystemProfiler('{}')).toEqual([]);
    expect(parseSystemProfiler(JSON.stringify({ other: 1 }))).toEqual([]);
  });

  it('strips font-file extensions from raw names', () => {
    const json = JSON.stringify({ SPFontsDataType: [{ _items: [{ _name: 'SomeFont.ttc' }] }] });
    expect(parseSystemProfiler(json)).toEqual(['SomeFont']);
  });

  it('never rejects the async list, even without a profiler binary', async () => {
    await expect(listInstalledFonts()).resolves.toEqual(expect.any(Array));
  });
});
