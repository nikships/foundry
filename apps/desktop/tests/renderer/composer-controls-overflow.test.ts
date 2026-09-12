/**
 * At ~700px the Orchestrator picker used to shrink under Plan run
 * (`flex: 1` → basis 0%) while its effort select stayed `flex: none`, so the
 * High control painted over the primary CTA. Visual layout is not executable
 * under Vitest's node environment; this file pins the CSS contract that makes
 * the row wrap from content width and lets the picker shrink without overflow.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const runsCss = readFileSync(
  resolve(import.meta.dirname, '../../src/renderer/screens/RunsScreen.module.css'),
  'utf8',
);
const pickerCss = readFileSync(
  resolve(import.meta.dirname, '../../src/renderer/components/run/OrchestratorPicker.module.css'),
  'utf8',
);

function rule(css: string, selector: string, label = selector): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  expect(match, `missing ${label} rule`).toBeTruthy();
  return match![1]!;
}

/** Composer inner width after sidebar, column inset, and card padding. */
function composerInner(
  windowWidth: number,
  sidebar = 264,
  s12 = 48,
  s8 = 32,
  cardPad = 32,
): number {
  const content = windowWidth - sidebar;
  const column = windowWidth <= 760 ? content - s8 : Math.min(1040, content - s12);
  return column - cardPad;
}

describe('orchestrator composer control overflow', () => {
  it('wraps the composer row and sizes the picker from content, not 0%', () => {
    const row = rule(runsCss, '.composer-controls');
    expect(row).toMatch(/flex-wrap:\s*wrap/);
    expect(row).toMatch(/min-width:\s*0/);

    const pickerSlot = rule(runsCss, '.composer-controls > :first-child');
    expect(pickerSlot).toMatch(/flex:\s*1 1 auto/);
    expect(pickerSlot).not.toMatch(/flex:\s*1\s*;/);
    expect(pickerSlot).toMatch(/min-width:\s*0/);
  });

  it('keeps Plan run from shrinking so wrap can take it onto its own line', () => {
    const button = rule(runsCss, '.plan-button');
    expect(button).toMatch(/flex:\s*none/);
    expect(button).toMatch(/margin-left:\s*auto/);
  });

  it('lets the picker and its effort row wrap instead of overflowing Plan run', () => {
    const picker = rule(pickerCss, '.picker');
    expect(picker).toMatch(/flex-wrap:\s*wrap/);
    expect(picker).toMatch(/min-width:\s*0/);
    expect(picker).toMatch(/max-width:\s*100%/);

    const controls = rule(pickerCss, '.controls');
    expect(controls).toMatch(/flex-wrap:\s*wrap/);
    expect(controls).toMatch(/min-width:\s*0/);
    expect(controls).not.toMatch(/flex:\s*none/);
  });

  it('does not pin model/effort above the picker width at 700px', () => {
    expect(rule(pickerCss, '.model')).toMatch(/min-width:\s*min\(180px,\s*100%\)/);
    expect(rule(pickerCss, '.effort')).toMatch(/min-width:\s*min\(96px,\s*100%\)/);
  });

  it('maps a 700px window onto a composer narrower than picker + Plan run', () => {
    // Ceremony + model + effort min-content is well above 400px; Plan run is
    // ~122px. The 700px CDP repro had ~372px inside the card — they must wrap.
    const inner = composerInner(700);
    expect(inner).toBeLessThan(400);
    expect(inner).toBeGreaterThan(300);
    expect(inner + 122).toBeLessThan(660);
  });
});
