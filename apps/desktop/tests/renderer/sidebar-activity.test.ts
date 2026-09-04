/**
 * Live Activity rows in the sidebar must read as still working at a glance.
 * Finished rows stay a filled 6px dot. The live treatment is a compact
 * indeterminate ring, not the global opacity pulse used by Waterfall.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(here, '../..', rel), 'utf8');

const sidebarSrc = read('src/renderer/components/layout/Sidebar.tsx');
const sidebarCss = read('src/renderer/components/layout/Sidebar.module.css');
const badgeSrc = read('src/renderer/components/common/StatusBadge.tsx');
const badgeCss = read('src/renderer/components/common/StatusBadge.module.css');
const tokensBase = read('src/renderer/design/tokens-base.css');

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function liveCoreRuleset(css: string): string {
  const stripped = stripCssComments(css);
  const match = stripped.match(/\.run-dot-live(?!::?after)[^{]*\{([^}]*)\}/);
  if (!match) throw new Error('missing .run-dot-live core ruleset');
  return match[1];
}

function spinningRuleset(css: string): string {
  const stripped = stripCssComments(css);
  const match = stripped.match(/\.dot\.spinning[^{]*\{([^}]*)\}/);
  if (!match) throw new Error('missing .dot.spinning ruleset');
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

describe('Activity live animation is a spinning ring, not a pulse or ping', () => {
  it('does not use the shared opacity pulse or the old ping halo', () => {
    expect(sidebarCss).not.toMatch(/animation:\s*pulse\b/);
    expect(sidebarCss).not.toContain('@keyframes run-dot-ping');
    expect(sidebarCss).not.toMatch(/\.run-dot-live::?after/);
    expect(sidebarCss).toContain('animation: spin 900ms linear infinite');
  });

  it('draws a hollow ring with a gap on the live mark', () => {
    const core = liveCoreRuleset(sidebarCss);
    expect(core).toContain('border: 1.5px solid currentColor');
    expect(core).toContain('border-right-color: transparent');
    expect(core).toContain('animation: spin 900ms linear infinite');
    expect(core).not.toMatch(/background\s*:/);
    expect(core).not.toMatch(/box-shadow\s*:/);
  });

  it('leaves the global pulse keyframes untouched', () => {
    expect(tokensBase).toMatch(/@keyframes\s+pulse[\s\S]*opacity:\s*0\.35/);
    expect(tokensBase).toMatch(/@keyframes\s+spin/);
  });
});

describe('reduced motion keeps a static live vs finished distinction', () => {
  it('stops the spin without filling the ring', () => {
    expect(sidebarCss).toContain('@media (prefers-reduced-motion: reduce)');
    const reduced = reducedMotionBlock(sidebarCss);
    expect(reduced).toMatch(/\.run-dot-live/);
    expect(reduced).toMatch(/animation:\s*none/);
    expect(reduced).not.toMatch(/box-shadow\s*:/);

    const core = liveCoreRuleset(sidebarCss);
    expect(core).toContain('border-right-color: transparent');
  });
});

describe('StatusBadge running mark matches Activity', () => {
  it('spins a hollow ring only while status is running', () => {
    expect(badgeSrc).toContain("status === 'running' && styles.spinning");
    expect(badgeSrc).toContain("status === 'running' ? undefined : { background: color }");
    const spinning = spinningRuleset(badgeCss);
    expect(spinning).toContain('border: 1.5px solid currentColor');
    expect(spinning).toContain('border-right-color: transparent');
    expect(spinning).toContain('animation: spin 900ms linear infinite');
    expect(spinning).not.toMatch(/background\s*:/);
  });

  it('stops the badge spin under reduced motion', () => {
    const reduced = reducedMotionBlock(badgeCss);
    expect(reduced).toMatch(/\.dot\.spinning/);
    expect(reduced).toMatch(/animation:\s*none/);
  });
});
