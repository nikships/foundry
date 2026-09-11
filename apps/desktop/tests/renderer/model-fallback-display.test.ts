/**
 * Model fallback must be visible without opening tool calls: every agent
 * display that lists the model names the active replacement in bright red
 * with a warning icon, while displays without a fallback keep their existing
 * presentation. Visual layout is not executable under Vitest's node
 * environment, so this file reads the sources the renderer ships.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const laneTsx = readFileSync(
  resolve(import.meta.dirname, '../../src/renderer/components/inspector/TranscriptLane.tsx'),
  'utf8',
);
const laneCss = readFileSync(
  resolve(import.meta.dirname, '../../src/renderer/components/inspector/TranscriptLane.module.css'),
  'utf8',
);
const drawerTsx = readFileSync(
  resolve(import.meta.dirname, '../../src/renderer/components/pipeline/PhaseDrawer.tsx'),
  'utf8',
);
const drawerCss = readFileSync(
  resolve(import.meta.dirname, '../../src/renderer/components/pipeline/PhaseDrawer.module.css'),
  'utf8',
);
const derive = readFileSync(
  resolve(import.meta.dirname, '../../src/renderer/utils/derive.ts'),
  'utf8',
);

describe('agent model fallback displays', () => {
  it('derives the active fallback from phase events without changing modelFor', () => {
    expect(derive).toContain('modelFallbackFor');
    expect(derive).toContain('modelFallbackForEvents');
    expect(derive).toContain('export function modelFor');
  });

  it('shows the active fallback in the inspector lane header', () => {
    expect(laneTsx).toContain('modelFallbackFor(events)');
    expect(laneTsx).toContain('fallback.fallbackModel');
    expect(laneTsx).toContain('fallback.message');
    expect(laneTsx).toContain('AlertTriangle');
    expect(laneTsx).toContain('laneModelFallback');
  });

  it('paints the lane fallback bright red with a warning icon', () => {
    expect(laneCss).toContain('.laneModelFallback');
    expect(laneCss).toMatch(/\.laneModelFallback[\s\S]*?color:\s*var\(--red\)/);
    expect(laneCss).toContain('.laneFallbackIcon');
  });

  it('keeps the lane presentation unchanged when there is no fallback', () => {
    expect(laneTsx).toContain('<span className={styles.laneModel} title={model}>');
  });

  it('shows the active fallback in the phase drawer header', () => {
    expect(drawerTsx).toContain('modelFallbackFor(events)');
    expect(drawerTsx).toContain('fallback.fallbackModel');
    expect(drawerTsx).toContain('fallback.message');
    expect(drawerTsx).toContain('AlertTriangle');
    expect(drawerTsx).toContain('subFallback');
  });

  it('paints the drawer fallback bright red with a warning icon', () => {
    expect(drawerCss).toContain('.subFallback');
    expect(drawerCss).toMatch(/\.subFallback[\s\S]*?color:\s*var\(--red\)/);
    expect(drawerCss).toContain('.subFallbackIcon');
  });

  it('keeps the drawer presentation unchanged when there is no fallback', () => {
    expect(drawerTsx).toContain('` · ${modelLabel(model)}`');
  });

  it('preserves the emitted failed and replacement ids in tooltips', () => {
    expect(laneTsx).toContain('title={modelTitle}');
    expect(laneTsx).toContain('fallback.message');
    expect(drawerTsx).toContain('title={fallback.message}');
  });
});
