import { describe, expect, it } from 'vitest';
import {
  designTabShortcut,
  isEditableTarget,
  tablistStep,
  viewShortcut,
} from '@renderer/keyboard.js';
import { DESIGN_TABS, NAV_ITEMS } from '@renderer/navigation.js';

const chord = (key: string, mods: Partial<Parameters<typeof viewShortcut>[0]> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('viewShortcut', () => {
  it('maps the menu accelerators for both meta and ctrl', () => {
    expect(viewShortcut(chord('1', { metaKey: true }))).toBe('runs');
    expect(viewShortcut(chord('2', { metaKey: true }))).toBe('inspector');
    expect(viewShortcut(chord('3', { ctrlKey: true }))).toBe('design');
    expect(viewShortcut(chord('4', { ctrlKey: true }))).toBe('prs');
    expect(viewShortcut(chord(',', { metaKey: true }))).toBe('settings');
  });

  // The rail, the native menu, and these chords are three renderings of one
  // table; a digit that scrolls out of step with the sidebar is a silent bug.
  it('agrees with the sidebar on every digit', () => {
    for (const item of NAV_ITEMS) {
      expect(viewShortcut(chord(item.key, { metaKey: true })), item.label).toBe(item.id);
    }
  });

  it('ignores bare keys and chords with extra modifiers', () => {
    expect(viewShortcut(chord('1'))).toBeNull();
    expect(viewShortcut(chord('1', { metaKey: true, shiftKey: true }))).toBeNull();
    expect(viewShortcut(chord('1', { metaKey: true, altKey: true }))).toBeNull();
    expect(viewShortcut(chord('5', { metaKey: true }))).toBeNull();
  });

  it('no longer answers to the retired Pipelines and Roster entries', () => {
    // Both are Design tabs now. Leaving a view chord pointing at them would
    // navigate to a screen the sidebar cannot show.
    const reachable = NAV_ITEMS.map((i) => i.id);
    expect(reachable).not.toContain('pipelines');
    expect(reachable).not.toContain('roster');
  });
});

describe('designTabShortcut', () => {
  it('maps the shifted digits to Design tabs, for meta and ctrl', () => {
    expect(designTabShortcut(chord('1', { metaKey: true, shiftKey: true }))).toBe('pipelines');
    expect(designTabShortcut(chord('2', { metaKey: true, shiftKey: true }))).toBe('agents');
    expect(designTabShortcut(chord('3', { ctrlKey: true, shiftKey: true }))).toBe('envelopes');
  });

  it('agrees with the tab strip on every digit', () => {
    for (const tab of DESIGN_TABS) {
      expect(designTabShortcut(chord(tab.key, { metaKey: true, shiftKey: true })), tab.label).toBe(
        tab.id,
      );
    }
  });

  it('accepts the shifted character a keyboard actually reports', () => {
    // Holding Shift yields `!`/`@`/`#` rather than the digit on US layouts.
    expect(designTabShortcut(chord('!', { metaKey: true, shiftKey: true }))).toBe('pipelines');
    expect(designTabShortcut(chord('@', { metaKey: true, shiftKey: true }))).toBe('agents');
    expect(designTabShortcut(chord('#', { metaKey: true, shiftKey: true }))).toBe('envelopes');
  });

  it('requires Shift, so it never shadows a view chord', () => {
    expect(designTabShortcut(chord('1', { metaKey: true }))).toBeNull();
    expect(designTabShortcut(chord('1', { shiftKey: true }))).toBeNull();
    expect(
      designTabShortcut(chord('1', { metaKey: true, shiftKey: true, altKey: true })),
    ).toBeNull();
    expect(designTabShortcut(chord('4', { metaKey: true, shiftKey: true }))).toBeNull();
  });
});

describe('tablistStep', () => {
  it('wraps in both directions', () => {
    expect(tablistStep('ArrowRight', 0, 3)).toBe(1);
    expect(tablistStep('ArrowRight', 2, 3)).toBe(0);
    expect(tablistStep('ArrowLeft', 0, 3)).toBe(2);
  });

  it('jumps with Home/End and rejects everything else', () => {
    expect(tablistStep('Home', 2, 3)).toBe(0);
    expect(tablistStep('End', 0, 3)).toBe(2);
    expect(tablistStep('Tab', 1, 3)).toBeNull();
    expect(tablistStep('a', 1, 3)).toBeNull();
  });

  it('supports vertical orientation with ArrowUp/ArrowDown', () => {
    expect(tablistStep('ArrowDown', 0, 3, 'vertical')).toBe(1);
    expect(tablistStep('ArrowDown', 2, 3, 'vertical')).toBe(0);
    expect(tablistStep('ArrowUp', 0, 3, 'vertical')).toBe(2);
    expect(tablistStep('ArrowRight', 0, 3, 'vertical')).toBeNull();
  });

  it('rejects empty lists and unknown current tabs', () => {
    expect(tablistStep('ArrowRight', 0, 0)).toBeNull();
    expect(tablistStep('ArrowRight', -1, 3)).toBeNull();
  });
});

describe('isEditableTarget', () => {
  it('flags form fields and contenteditable, not buttons or window', () => {
    expect(isEditableTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isEditableTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isEditableTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget({})).toBe(false);
  });
});
