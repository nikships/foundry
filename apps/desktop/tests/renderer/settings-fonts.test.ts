/**
 * Installed-font setting, renderer side: shared helpers, search wiring, IPC
 * contract, live application, and picker behaviour. Visual layout is not
 * executable under Vitest's node environment, so this suite reads the sources
 * the renderer ships plus the pure shared helpers.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INTERFACE_FONT,
  DEFAULT_MONO_FONT,
  NERD_SYMBOLS_FAMILY,
  fontStack,
  sanitizeFontFamily,
} from '@shared/types.js';
import { IPC } from '@shared/ipc-contract.js';
import { searchSettings } from '@renderer/view-models/settings-search.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(here, '../..', rel), 'utf8');

const pickerSrc = read('src/renderer/components/ui/FontPicker.tsx');
const pickerCss = read('src/renderer/components/ui/FontPicker.module.css');
const settingsSrc = read('src/renderer/screens/SettingsScreen.tsx');
const appSrc = read('src/renderer/stores/app.tsx');
const apiSrc = read('src/renderer/api.ts');
const bridgeSrc = read('src/preload/bridge.ts');
const settingsIpcSrc = read('src/main/ipc/settings.ts');
const searchSrc = read('src/renderer/view-models/settings-search.tsx');
const fontListSrc = read('src/main/system/font-list.ts');

describe('shared font helpers', () => {
  it('names the shipped defaults and the bounded Nerd symbols face', () => {
    expect(DEFAULT_INTERFACE_FONT).toBe('Geist');
    expect(DEFAULT_MONO_FONT).toBe('Geist Mono');
    expect(NERD_SYMBOLS_FAMILY).toBe('Symbols Nerd Font Mono');
  });

  it('sanitizes injection and length while keeping unicode names', () => {
    expect(sanitizeFontFamily('Hoefler Text')).toBe('Hoefler Text');
    expect(sanitizeFontFamily('ヒラギノ角ゴ')).toBe('ヒラギノ角ゴ');
    expect(sanitizeFontFamily('')).toBe(null);
    expect(sanitizeFontFamily('   ')).toBe(null);
    expect(sanitizeFontFamily('"); evil')).toBe(null);
    expect(sanitizeFontFamily('a'.repeat(129))).toBe(null);
  });

  it('orders user face, nerd symbols, default, and system tail', () => {
    const ui = fontStack('Hoefler Text', 'ui');
    expect(ui.startsWith('"Hoefler Text"')).toBe(true);
    expect(ui).toContain(`"${NERD_SYMBOLS_FAMILY}"`);
    expect(ui).toContain(`"${DEFAULT_INTERFACE_FONT}"`);
    const mono = fontStack('SF Mono', 'mono');
    expect(mono.startsWith('"SF Mono"')).toBe(true);
    expect(mono).toContain(`"${NERD_SYMBOLS_FAMILY}"`);
    expect(mono).toContain('ui-monospace');
  });

  it('repairs hostile values to defaults without throwing', () => {
    expect(fontStack('"; bad', 'ui')).not.toContain('bad');
    expect(fontStack(null, 'ui')).toContain(DEFAULT_INTERFACE_FONT);
  });
});

describe('settings search wiring', () => {
  it('finds the Appearance section on font queries', () => {
    for (const query of ['font', 'typeface', 'monospace', 'typography']) {
      expect(
        searchSettings(query).some(
          (hit) => hit.pane === 'preferences' && hit.sectionId === 'appearance',
        ),
        query,
      ).toBe(true);
    }
  });

  it('keeps the Appearance label and note byte-identical', () => {
    expect(searchSrc).toContain("label: 'Appearance'");
    expect(searchSrc).toContain('Choose the palette Foundry uses across the desktop.');
  });
});

describe('IPC contract', () => {
  it('declares a never-reject fonts:list channel', () => {
    expect(IPC.fontsList).toBe('fonts:list');
    expect(settingsIpcSrc).toContain('IPC.fontsList');
    expect(settingsIpcSrc).toContain('listInstalledFonts');
    expect(bridgeSrc).toContain('fonts:');
    expect(bridgeSrc).toContain('IPC.fontsList');
  });

  it('uses a macOS-supported enumeration with cache, timeout, and fallback', () => {
    expect(fontListSrc).toContain('/usr/sbin/system_profiler');
    expect(fontListSrc).toContain('spawnEnv()');
    expect(fontListSrc).toContain('clearFontCacheForTest');
    expect(fontListSrc).toContain('listFromFontDirs');
  });

  it('degrades to an empty list when the namespace is absent (web preview)', () => {
    expect(apiSrc).toContain('guarded.fonts');
    expect(apiSrc).toContain('list: async');
  });
});

describe('renderer application', () => {
  it('applies both faces as CSS vars alongside the theme in app.tsx', () => {
    expect(appSrc).toContain('fontStack');
    expect(appSrc).toContain("setProperty('--font'");
    expect(appSrc).toContain("setProperty('--font-mono'");
    expect(appSrc).toContain('dataset.theme');
  });

  it('mounts the picker inside Appearance without renaming the section', () => {
    expect(settingsSrc).toContain('label="Appearance"');
    expect(settingsSrc).toContain('<FontPicker');
    expect(settingsSrc).toContain('interfaceFont={settings.interfaceFont');
    expect(settingsSrc).toContain('monoFont={settings.monoFont');
  });

  it('keeps the picker inside the renderer privilege boundary', () => {
    expect(pickerSrc).not.toContain('child_process');
    expect(pickerSrc).not.toMatch(/from ['"]electron['"]/);
    expect(pickerSrc).not.toContain('src/main');
    expect(pickerSrc).toContain('api.fonts');
  });

  it('offers Default options, reset paths, and a missing-font hint', () => {
    expect(pickerSrc).toContain('Default (');
    expect(pickerSrc).toContain('settings-font-ui');
    expect(pickerSrc).toContain('settings-font-mono');
    expect(pickerSrc).toContain('settings-font-ui-reset');
    expect(pickerSrc).toContain('settings-font-mono-reset');
    expect(pickerSrc).toContain('isn’t installed');
    expect(pickerSrc).toContain('onChange({ interfaceFont: null })');
    expect(pickerSrc).toContain('onChange({ monoFont: null })');
  });

  it('ships picker styles as a CSS module', () => {
    expect(pickerCss).toContain('.root');
    expect(pickerCss).toContain('.row');
  });
});
