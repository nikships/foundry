/**
 * Inspector lane headers used to keep dense, non-wrapping stats at `flex: none`.
 * At 3–5 visible lanes that clipped the CLI pill mid-glyph and overflowed the
 * bordered header. These assertions pin the CSS contract that replaced that
 * accidental clip with wrapping, ellipsis, and whole-item hiding.
 *
 * Visual layout is not executable under Vitest's node environment, so this
 * file reads the source the renderer ships rather than painting pixels.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  resolve(import.meta.dirname, '../../src/renderer/components/inspector/TranscriptLane.module.css'),
  'utf8',
);
const tsx = readFileSync(
  resolve(import.meta.dirname, '../../src/renderer/components/inspector/TranscriptLane.tsx'),
  'utf8',
);

function rule(selector: string): string {
  const match = css.match(new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]+)\\}`));
  expect(match, `missing ${selector} rule`).toBeTruthy();
  return match![1]!;
}

function containerQuery(maxWidth: number): string {
  const match = css.match(
    new RegExp(`@container\\s+lane\\s*\\(max-width:\\s*${maxWidth}px\\)\\s*\\{([\\s\\S]*?)\\n\\}`),
  );
  expect(match, `missing @container lane (max-width: ${maxWidth}px)`).toBeTruthy();
  return match![1]!;
}

/** Approximate column width the Inspector grid gives each unfocused lane. */
function laneWidth(contentWidth: number, lanes: number, gap = 12): number {
  return (contentWidth - gap * (lanes - 1)) / lanes;
}

describe('inspector lane header overflow', () => {
  it('sizes each lane as a container so hiding follows column width, not the window', () => {
    const lane = rule('.lane');
    expect(lane).toMatch(/container-type:\s*inline-size/);
    expect(lane).toMatch(/container-name:\s*lane/);
  });

  it('lets the header wrap instead of overflowing the bordered column', () => {
    const head = rule('.laneHead');
    expect(head).toMatch(/flex-wrap:\s*wrap/);
    expect(head).toMatch(/min-width:\s*0/);
  });

  it('lets stats shrink and wrap rather than pinning them at flex: none', () => {
    const stats = rule('.laneStats');
    expect(stats).toMatch(/min-width:\s*0/);
    expect(stats).toMatch(/flex-wrap:\s*wrap/);
    expect(stats).not.toMatch(/flex:\s*none/);
  });

  it('truncates the phase name with ellipsis and keeps a full-name tooltip', () => {
    const phase = rule('.lanePhase');
    expect(phase).toMatch(/overflow:\s*hidden/);
    expect(phase).toMatch(/text-overflow:\s*ellipsis/);
    expect(tsx).toMatch(/title=\{phase\.name\}/);
  });

  it('labels the context meter as tokens used, not remaining', () => {
    expect(tsx).toMatch(/Tokens used so far in this step/);
    expect(tsx).toMatch(/\{pct\}% used/);
    expect(tsx).toMatch(/styles\.laneContextName\}>Context/);
    expect(tsx).not.toMatch(/remaining/);
  });

  it('names the transport that answered', () => {
    expect(tsx).toMatch(/session\?\.mode \?\? 'pi'/);
    expect(tsx).toMatch(/styles\.laneCli\}>\{transport\}/);
    // The class name is what the breakpoints below hide by, so renaming it
    // here would silently unhide the pill.
    expect(css).toMatch(/\.laneCli/);
  });

  it('does not clip the bordered transport pill mid-glyph', () => {
    const agent = rule('.laneAgent');
    expect(agent).not.toMatch(/overflow:\s*hidden/);
    const cli = rule('.laneCli');
    expect(cli).toMatch(/flex:\s*none/);
    expect(cli).toMatch(/white-space:\s*nowrap/);
  });

  it('hides secondary metadata as whole items at 3–5-lane widths', () => {
    const at340 = containerQuery(340);
    expect(at340).toMatch(/\.laneTokens/);
    expect(at340).toMatch(/\.laneContext/);
    expect(at340).toMatch(/\.laneModel/);
    expect(at340).toMatch(/display:\s*none/);

    const at280 = containerQuery(280);
    expect(at280).toMatch(/\.laneElapsed/);
    expect(at280).toMatch(/display:\s*none/);

    const at240 = containerQuery(240);
    expect(at240).toMatch(/\.laneCli/);
    expect(at240).toMatch(/display:\s*none/);
  });

  it('keeps the CTX disclosure and status cluster from shrinking', () => {
    expect(css).toMatch(/\.laneCtx,\s*\n\.laneStatus/);
    expect(rule('.laneStatus')).toMatch(/flex:\s*none/);
    expect(tsx).toMatch(/styles\.laneCtx/);
    expect(tsx).toMatch(/ContextBreakdownDisclosure/);
    expect(tsx).toMatch(/styles\.laneStatus/);
  });

  it('maps typical 3–5 lane columns onto those hide breakpoints', () => {
    // A ~1280px Inspector grid is the common packaged width after sidebar.
    expect(laneWidth(1280, 3)).toBeGreaterThan(340);
    expect(laneWidth(1280, 4)).toBeGreaterThan(280);
    expect(laneWidth(1280, 4)).toBeLessThan(340);
    expect(laneWidth(1280, 5)).toBeGreaterThan(240);
    expect(laneWidth(1280, 5)).toBeLessThan(280);
  });
});
