/**
 * Bounded Nerd Font coverage, renderer side: the SymbolsOnly @font-face, the
 * CSS stacks that fall back through it, and the main.tsx import order. Visual
 * glyph rasterization is not executable under Vitest's node environment, so
 * this suite reads the sources the renderer ships.
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
} from '@shared/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, '../..');
const read = (rel: string): string => readFileSync(join(desktopRoot, rel), 'utf8');

const css = read('src/renderer/design/nerd-fonts.css');
const mainSrc = read('src/renderer/main.tsx');
const woff2Path = 'src/renderer/design/fonts/SymbolsNerdFontMono-Regular.woff2';

describe('nerd-fonts @font-face', () => {
  it('declares the SymbolsOnly family that fontStack() names', () => {
    expect(NERD_SYMBOLS_FAMILY).toBe('Symbols Nerd Font Mono');
    expect(css).toContain(`font-family: '${NERD_SYMBOLS_FAMILY}'`);
    expect(css).toContain("url('./fonts/SymbolsNerdFontMono-Regular.woff2')");
    expect(css).toContain("format('woff2')");
  });

  it('loads lazily and only for symbol/PUA codepoints', () => {
    expect(css).toContain('font-display: swap');
    expect(css).toContain('unicode-range:');
    expect(css).toContain('U+E000-EFFF');
    expect(css).toContain('U+F000-F8FF');
    expect(css).toContain('U+F0000-F1AFF');
    expect(css).toContain('U+23FB-23FE');
    expect(css).toContain('U+2B58');
    // Basic Latin must stay out so Geist/system faces keep shaping text.
    expect(css).not.toMatch(/U\+00[0-7][0-9A-F]/i);
    expect(css).not.toMatch(/U\+0020-007E/i);
  });

  it('points at a committed woff2 next to the other vendored faces', () => {
    const bytes = readFileSync(join(desktopRoot, woff2Path));
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('wOF2');
    expect(bytes.byteLength).toBeGreaterThan(200 * 1024);
    expect(bytes.byteLength).toBeLessThanOrEqual(5 * 1024 * 1024);
  });
});

describe('fallback stacks', () => {
  it('appends the Nerd face after Geist in :root, before system tails', () => {
    expect(css).toMatch(/--font:\s*'Geist',\s*'Symbols Nerd Font Mono',\s*-apple-system/);
    expect(css).toMatch(/--font-mono:\s*'Geist Mono',\s*'Symbols Nerd Font Mono',\s*ui-monospace/);
  });

  it('matches the default fontStack() used after settings hydrate', () => {
    const ui = fontStack(null, 'ui');
    const mono = fontStack(null, 'mono');
    expect(ui).toContain(`"${DEFAULT_INTERFACE_FONT}"`);
    expect(ui).toContain(`"${NERD_SYMBOLS_FAMILY}"`);
    expect(ui.indexOf(`"${DEFAULT_INTERFACE_FONT}"`)).toBeLessThan(
      ui.indexOf(`"${NERD_SYMBOLS_FAMILY}"`),
    );
    expect(mono).toContain(`"${DEFAULT_MONO_FONT}"`);
    expect(mono).toContain(`"${NERD_SYMBOLS_FAMILY}"`);
    expect(mono.indexOf(`"${DEFAULT_MONO_FONT}"`)).toBeLessThan(
      mono.indexOf(`"${NERD_SYMBOLS_FAMILY}"`),
    );
  });

  it('keeps the Nerd face as a fallback when a user font is chosen', () => {
    const ui = fontStack('Hoefler Text', 'ui');
    expect(ui.startsWith('"Hoefler Text"')).toBe(true);
    expect(ui).toContain(`"${NERD_SYMBOLS_FAMILY}"`);
    expect(ui).toContain(`"${DEFAULT_INTERFACE_FONT}"`);
  });
});

describe('boot wiring', () => {
  it('imports nerd-fonts.css after tokens-base.css so the stacks override', () => {
    const base = mainSrc.indexOf("import './design/tokens-base.css'");
    const nerd = mainSrc.indexOf("import './design/nerd-fonts.css'");
    expect(base).toBeGreaterThanOrEqual(0);
    expect(nerd).toBeGreaterThan(base);
  });
});
