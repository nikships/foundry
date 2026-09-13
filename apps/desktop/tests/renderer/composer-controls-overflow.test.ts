/**
 * The model picker and thinking-level control stay on one row. Wrapping
 * used to drop effort under a full-width model (`min-width: 100%`) and
 * grow the picker height. Plan run can still wrap onto its own line.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const runsCss = readFileSync(
  resolve(import.meta.dirname, '../../src/renderer/screens/RunsScreen.module.css'),
  'utf8',
);
const pickerCss = readFileSync(
  resolve(import.meta.dirname, '../../src/renderer/components/run/ComposePicker.module.css'),
  'utf8',
);
const smithCss = readFileSync(
  resolve(import.meta.dirname, '../../src/renderer/screens/SmithScreen.module.css'),
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

describe('compose composer control overflow', () => {
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

  it('keeps model and thinking level on one row and lets the model name shrink', () => {
    const picker = rule(pickerCss, '.picker');
    expect(picker).toMatch(/min-width:\s*0/);
    expect(picker).toMatch(/max-width:\s*100%/);

    const controls = rule(pickerCss, '.controls');
    expect(controls).toMatch(/flex-wrap:\s*nowrap/);
    expect(controls).toMatch(/min-width:\s*0/);

    const model = rule(pickerCss, '.model');
    expect(model).toMatch(/min-width:\s*0/);
    expect(model).toMatch(/flex:\s*1 1 auto/);
    expect(model).not.toMatch(/100%/);

    const effort = rule(pickerCss, '.effort');
    expect(effort).toMatch(/flex:\s*none/);
    expect(effort).not.toMatch(/flex-wrap/);
  });

  it('keeps Smith header model and thinking level on one row', () => {
    const headControls = rule(smithCss, '.headControls');
    expect(headControls).toMatch(/flex-wrap:\s*nowrap/);
    expect(headControls).toMatch(/min-width:\s*0/);

    const model = rule(smithCss, '.modelPicker');
    expect(model).toMatch(/min-width:\s*0/);
    expect(model).not.toMatch(/min-width:\s*240px/);

    expect(rule(smithCss, '.effortPicker')).toMatch(/flex:\s*none/);
  });

  it('maps a 700px window onto a composer narrower than picker + Plan run', () => {
    // Ceremony + model + effort min-content is well above 400px; Plan run is
    // ~122px. The 700px CDP repro had ~372px inside the card — Plan run wraps,
    // model and thinking stay on one line.
    const inner = composerInner(700);
    expect(inner).toBeLessThan(400);
    expect(inner).toBeGreaterThan(300);
    expect(inner + 122).toBeLessThan(660);
  });
});
