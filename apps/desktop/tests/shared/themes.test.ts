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
  });

  it('maps every palette onto a dark or light color-scheme', () => {
    expect(themeAppearance('dark')).toBe('dark');
    expect(themeAppearance('midnight')).toBe('dark');
    expect(themeAppearance('contrast')).toBe('dark');
    expect(themeAppearance('light')).toBe('light');
    expect(themeAppearance('sand')).toBe('light');
    expect(themeAppearance('mist')).toBe('light');
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
});
