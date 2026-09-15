/**
 * Smith's cube icon wiring: the chat bubble shows the extracted raster cube
 * (launcher + popover header) while the sidebar keeps the tintable linework
 * mark, which picks up the forge glow on hover.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const bubbleSrc = readFileSync(
  resolve(import.meta.dirname, '../../src/renderer/components/smith/SmithBubble.tsx'),
  'utf8',
);
const sidebarSrc = readFileSync(
  resolve(import.meta.dirname, '../../src/renderer/components/layout/Sidebar.tsx'),
  'utf8',
);
const sidebarCss = readFileSync(
  resolve(import.meta.dirname, '../../src/renderer/components/layout/Sidebar.module.css'),
  'utf8',
);
const cubePath = resolve(import.meta.dirname, '../../../../assets/smith/smith-cube.png');

describe('SmithBubble raster cube', () => {
  it('resolves the extracted cube through the branded-asset hook', () => {
    expect(bubbleSrc).toContain("useBrandedAsset('smith/smith-cube.png')");
    expect(bubbleSrc).toContain('styles.launcherMark');
    expect(bubbleSrc).toContain('styles.identityMark');
  });

  it('no longer renders the linework emblem (the sidebar owns that mark)', () => {
    expect(bubbleSrc).not.toContain('SmithEmblem');
  });

  it('ships a transparent PNG cube asset', () => {
    expect(existsSync(cubePath)).toBe(true);
    const png = readFileSync(cubePath);
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(png.readUInt32BE(16)).toBe(208);
    expect(png.readUInt32BE(20)).toBe(256);
    // Color type 6 is truecolor with alpha; the cube must float over UI chrome.
    expect(png[25]).toBe(6);
  });
});

describe('sidebar Smith hover glow', () => {
  it('marks the Smith nav button for its own hover treatment', () => {
    expect(sidebarSrc).toContain("navItemClass(view === 'smith', styles.smithItem)");
  });

  it('glows the cube accent on hover without touching emblem markup', () => {
    expect(sidebarCss).toContain('.smith-item:hover .nav-emblem');
    expect(sidebarCss).toContain('drop-shadow');
    expect(sidebarCss).toContain('var(--accent)');
  });

  it('skips the hover wash and rests in ember glow below full power', () => {
    expect(sidebarCss).toMatch(/\.smith-item:hover:not\(\.active\)[^}]*background:\s*transparent/);
    expect(sidebarCss).toMatch(/\.smith-item \.nav-emblem[^}]*drop-shadow\(0 0 2px/);
  });
});
