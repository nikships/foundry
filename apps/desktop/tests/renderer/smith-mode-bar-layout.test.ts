/**
 * YOLO used to sit in its own padded, wrapping header above Text/Voice.
 * That extra chrome row is gone: the toggle lives on the mode bar.
 *
 * Visual layout is not executable under Vitest's node environment, so this
 * file reads the source the renderer ships rather than painting pixels.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const barCss = readFileSync(
  resolve(import.meta.dirname, '../../src/renderer/components/smith/SmithModeBar.module.css'),
  'utf8',
);
const permissionCss = readFileSync(
  resolve(
    import.meta.dirname,
    '../../src/renderer/components/smith/SmithPermissionControl.module.css',
  ),
  'utf8',
);
const screen = readFileSync(
  resolve(import.meta.dirname, '../../src/renderer/screens/SmithScreen.tsx'),
  'utf8',
);
const bubble = readFileSync(
  resolve(import.meta.dirname, '../../src/renderer/components/smith/SmithBubble.tsx'),
  'utf8',
);

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  expect(match, `missing ${selector} rule`).toBeTruthy();
  return match![1]!;
}

function hostsPermissionOnModeBar(src: string, label: string): void {
  const mode = src.indexOf('<SmithModeBar');
  const permission = src.indexOf('<SmithPermissionControl');
  expect(mode, `${label} is missing SmithModeBar`).toBeGreaterThan(-1);
  expect(permission, `${label} is missing SmithPermissionControl`).toBeGreaterThan(-1);
  expect(permission, `${label} must render YOLO inside the mode bar`).toBeGreaterThan(mode);
  expect(src).toMatch(/<SmithModeBar[\s\S]*?trailing=\{[\s\S]*?<SmithPermissionControl/);
}

describe('Smith mode bar YOLO placement', () => {
  it('keeps Text, Voice, and YOLO on one non-wrapping row', () => {
    const bar = rule(barCss, '.bar');
    expect(bar).toMatch(/flex-wrap:\s*nowrap/);
    expect(bar).toMatch(/min-width:\s*0/);
    expect(bar).not.toMatch(/flex-wrap:\s*wrap/);

    const trailing = rule(barCss, '.trailing');
    expect(trailing).toMatch(/flex:\s*1 1 auto/);
    expect(trailing).toMatch(/min-width:\s*0/);

    expect(rule(barCss, '.modes')).toMatch(/flex:\s*none/);
    expect(rule(barCss, '.connection')).toMatch(/flex:\s*none/);
  });

  it('keeps YOLO as a compact control without wrapping chrome', () => {
    const control = rule(permissionCss, '.control');
    expect(control).toMatch(/flex:\s*none/);
    expect(control).toMatch(/min-width:\s*0/);
    expect(control).not.toMatch(/padding:/);
    expect(permissionCss).not.toMatch(/\.detail/);
    expect(permissionCss).not.toMatch(/\.warning/);
  });

  it('places the permission control on the mode bar in both Smith surfaces', () => {
    hostsPermissionOnModeBar(screen, 'SmithScreen');
    hostsPermissionOnModeBar(bubble, 'SmithBubble');
  });
});
