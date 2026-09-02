/**
 * Live Activity rows in the sidebar must read as still working at a glance.
 * Finished rows stay static. The live treatment is a local persistent-core
 * ping, not the global opacity pulse used by StatusBadge and Waterfall.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(here, '../..', rel), 'utf8');

const sidebarSrc = read('src/renderer/components/layout/Sidebar.tsx');
const sidebarCss = read('src/renderer/components/layout/Sidebar.module.css');
const tokensBase = read('src/renderer/design/tokens-base.css');

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** First `.run-dot-live` ruleset that is not a `::after` / `:after` selector. */
function liveCoreRuleset(css: string): string {
  const stripped = stripCssComments(css);
  const match = stripped.match(/\.run-dot-live(?!::?after)[^{]*\{([^}]*)\}/);
  if (!match) throw new Error('missing .run-dot-live core ruleset');
  return match[1];
}

function reducedMotionBlock(css: string): string {
  const stripped = stripCssComments(css);
  const match = stripped.match(
    /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{([\s\S]*)\}\s*$/,
  );
  if (!match) {
    const fallback = stripped.match(
      /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{([\s\S]*?)\n\}/,
    );
    if (!fallback) throw new Error('missing prefers-reduced-motion block');
    return fallback[1];
  }
  return match[1];
}

describe('Activity live mark gating', () => {
  it('applies the live treatment only while status is running', () => {
    expect(sidebarSrc).toContain("const running = run.status === 'running';");
    expect(sidebarSrc).toContain('running && styles.runDotLive');
    expect(sidebarSrc.split('runDotLive').length - 1).toBe(1);
    expect(sidebarSrc).toContain('statusColor(run.status)');
    expect(sidebarSrc).toContain('statusWord(run.status)');
  });

  it('keeps the existing Activity contract', () => {
    expect(sidebarSrc).toContain('data-testid={`sidebar-run-${run.runId}`}');
    expect(sidebarSrc).toContain('useActivityRuns(projectId)');
    expect(sidebarSrc).toContain('onOpenInspector?.(run.runId)');
    expect(sidebarSrc).toMatch(/!collapsed && pipelineRuns\.length > 0/);
  });
});

describe('Activity live animation is local, not the global pulse', () => {
  it('does not use the shared opacity pulse on the Activity mark', () => {
    expect(sidebarCss).not.toMatch(/animation:\s*pulse\b/);
    expect(sidebarCss).toContain('@keyframes run-dot-ping');
    expect(sidebarCss).toContain('animation: run-dot-ping');
    expect(sidebarCss).toMatch(/\.run-dot-live::?after/);
  });

  it('animates only the ping copy, never the 6px core', () => {
    const core = liveCoreRuleset(sidebarCss);
    expect(core).not.toMatch(/animation\s*:/);
    expect(core).toContain('box-shadow:');

    const stripped = stripCssComments(sidebarCss);
    const animationDecls = [...stripped.matchAll(/animation\s*:/g)];
    expect(animationDecls.length).toBeGreaterThanOrEqual(2);
    expect(stripped).toMatch(/\.run-dot-live::?after[^{]*\{[^}]*animation:\s*run-dot-ping/);
    expect(stripped).toMatch(
      /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)[\s\S]*\.run-dot-live::?after[^{]*\{[^}]*animation:\s*none/,
    );
  });

  it('leaves the global pulse keyframes untouched', () => {
    expect(tokensBase).toMatch(/@keyframes\s+pulse[\s\S]*opacity:\s*0\.35/);
  });
});

describe('reduced motion keeps a static live vs finished distinction', () => {
  it('stops the looping ping without dropping the halo', () => {
    expect(sidebarCss).toContain('@media (prefers-reduced-motion: reduce)');
    const reduced = reducedMotionBlock(sidebarCss);
    expect(reduced).toMatch(/\.run-dot-live::?after/);
    expect(reduced).toMatch(/animation:\s*none/);
    expect(reduced).not.toMatch(/box-shadow\s*:/);

    const core = liveCoreRuleset(sidebarCss);
    expect(core).toContain('box-shadow:');
    expect(core).toMatch(/0 0 0 1px currentColor/);
  });
});
