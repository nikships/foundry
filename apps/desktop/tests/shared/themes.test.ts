import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  APP_THEME_IDS,
  APP_THEMES,
  isAppTheme,
  themeAppearance,
  themeBackgroundColor,
  themeDef,
  themeLabel,
} from '../../src/shared/themes.js';

const tokensPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../src/renderer/design/tokens-factory.css',
);

describe('theme catalog', () => {
  it('exposes a non-empty id tuple the store schema can consume', () => {
    expect(APP_THEME_IDS.length).toBe(APP_THEMES.length);
    expect(APP_THEME_IDS[0]).toBe('dark');
    expect(new Set(APP_THEME_IDS).size).toBe(APP_THEMES.length);
  });

  it('accepts every catalog id and nothing else', () => {
    for (const theme of APP_THEMES) expect(isAppTheme(theme.id)).toBe(true);
    for (const value of ['', 'sepia', 'DARK', 'light ', 3, null, undefined, {}]) {
      expect(isAppTheme(value)).toBe(false);
    }
  });

  it('keeps native chrome colors aligned with the catalog', () => {
    expect(themeBackgroundColor('dark')).toBe('#020202');
    expect(themeBackgroundColor('light')).toBe('#f7f7f5');
    expect(themeBackgroundColor('midnight')).toBe('#070b14');
    expect(themeBackgroundColor('forest')).toBe('#0b100c');
    expect(themeBackgroundColor('ember')).toBe('#140c08');
    expect(themeBackgroundColor('contrast')).toBe('#000000');
    expect(themeBackgroundColor('sand')).toBe('#f4efe4');
    expect(themeBackgroundColor('mist')).toBe('#eef1f6');
    expect(themeBackgroundColor('plum')).toBe('#150d1e');
    expect(themeBackgroundColor('abyss')).toBe('#07181e');
    expect(themeBackgroundColor('sage')).toBe('#eef2eb');
    expect(themeBackgroundColor('blush')).toBe('#f7ecea');
  });

  it('maps every palette onto a dark or light color-scheme', () => {
    expect(themeAppearance('dark')).toBe('dark');
    expect(themeAppearance('midnight')).toBe('dark');
    expect(themeAppearance('contrast')).toBe('dark');
    expect(themeAppearance('plum')).toBe('dark');
    expect(themeAppearance('abyss')).toBe('dark');
    expect(themeAppearance('light')).toBe('light');
    expect(themeAppearance('sand')).toBe('light');
    expect(themeAppearance('mist')).toBe('light');
    expect(themeAppearance('sage')).toBe('light');
    expect(themeAppearance('blush')).toBe('light');
  });

  it('labels the original palettes Dark and Light', () => {
    expect(themeLabel('dark')).toBe('Dark');
    expect(themeLabel('light')).toBe('Light');
    expect(themeDef('contrast').label).toBe('High Contrast');
  });

  it('keeps every catalog id’s CSS --bg-base in sync with native chrome', () => {
    const css = readFileSync(tokensPath, 'utf8');
    for (const theme of APP_THEMES) {
      const match = css.match(
        new RegExp(`\\[data-theme='${theme.id}'\\][^{]*\\{([\\s\\S]*?)\\n\\}`),
      );
      expect(match, `${theme.id} is missing a token block`).toBeTruthy();
      const bg = match?.[1]?.match(/--bg-base:\s*(#[0-9a-fA-F]+)/)?.[1];
      expect(bg?.toLowerCase(), `${theme.id} --bg-base`).toBe(theme.background.toLowerCase());
    }
  });

  it('groups the new palettes under Dark and Light', () => {
    expect(themeDef('plum').group).toBe('Dark');
    expect(themeDef('abyss').group).toBe('Dark');
    expect(themeDef('sage').group).toBe('Light');
    expect(themeDef('blush').group).toBe('Light');
    expect(themeLabel('plum')).toBe('Plum');
    expect(themeLabel('abyss')).toBe('Abyss');
    expect(themeLabel('sage')).toBe('Sage');
    expect(themeLabel('blush')).toBe('Blush');
  });

  it('keeps every new preview in sync with its tokens', () => {
    const css = readFileSync(tokensPath, 'utf8');
    for (const id of ['plum', 'abyss', 'sage', 'blush'] as const) {
      const def = themeDef(id);
      const match = css.match(new RegExp(`\\[data-theme='${id}'\\][^{]*\\{([\\s\\S]*?)\\n\\}`));
      expect(match, `${id} is missing a token block`).toBeTruthy();
      const block = match?.[1] ?? '';
      const token = (name: string): string | undefined =>
        block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1]?.toLowerCase();
      expect(def.preview.base.toLowerCase()).toBe(def.background.toLowerCase());
      expect(def.preview.base.toLowerCase()).toBe(token('--bg-base'));
      expect(def.preview.panel.toLowerCase()).toBe(token('--bg-panel'));
      expect(def.preview.accent.toLowerCase()).toBe(token('--accent'));
      expect(def.preview.text.toLowerCase()).toBe(token('--text'));
    }
  });

  it('defines the same token set for every palette', () => {
    const css = readFileSync(tokensPath, 'utf8');
    const blocks = new Map<string, Set<string>>();
    for (const theme of APP_THEMES) {
      const match = css.match(
        new RegExp(`\\[data-theme='${theme.id}'\\][^{]*\\{([\\s\\S]*?)\\n\\}`),
      );
      expect(match, `${theme.id} is missing a token block`).toBeTruthy();
      const names = new Set<string>();
      for (const line of (match?.[1] ?? '').split('\n')) {
        const name = line.match(/^\s*(--[a-z0-9-]+)\s*:/)?.[1];
        if (name) names.add(name);
      }
      blocks.set(theme.id, names);
    }
    const baseline = blocks.get('dark');
    expect(baseline?.size).toBeGreaterThan(30);
    for (const theme of APP_THEMES) {
      expect([...(blocks.get(theme.id) ?? [])].sort(), `${theme.id} token set`).toEqual(
        [...(baseline ?? [])].sort(),
      );
    }
  });

  it('meets WCAG AA text contrast for the new palettes', () => {
    const css = readFileSync(tokensPath, 'utf8');
    const luminance = (hex: string): number => {
      const rgb = [0, 2, 4].map((i) => {
        const channel = Number.parseInt(hex.slice(i + 1, i + 3), 16) / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * (rgb[0] ?? 0) + 0.7152 * (rgb[1] ?? 0) + 0.0722 * (rgb[2] ?? 0);
    };
    const ratio = (a: string, b: string): number => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    for (const id of ['plum', 'abyss', 'sage', 'blush'] as const) {
      const match = css.match(new RegExp(`\\[data-theme='${id}'\\][^{]*\\{([\\s\\S]*?)\\n\\}`));
      const block = match?.[1] ?? '';
      const token = (name: string): string => {
        const value = block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
        expect(value, `${id} ${name}`).toBeTruthy();
        return (value as string).toLowerCase();
      };
      const base = token('--bg-base');
      // Body text, secondary text, and accents all clear WCAG AA (4.5:1).
      expect(ratio(token('--text'), base), `${id} text`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(token('--text-dim'), base), `${id} text-dim`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(token('--accent'), base), `${id} accent`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
