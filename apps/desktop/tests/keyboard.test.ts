import { describe, expect, it } from 'vitest';
import { isEditableTarget, tablistStep, viewShortcut } from '@renderer/keyboard.js';

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
    expect(viewShortcut(chord('2', { metaKey: true }))).toBe('pipelines');
    expect(viewShortcut(chord('3', { ctrlKey: true }))).toBe('roster');
    expect(viewShortcut(chord('4', { ctrlKey: true }))).toBe('inspector');
    expect(viewShortcut(chord(',', { metaKey: true }))).toBe('settings');
  });

  it('ignores bare keys and chords with extra modifiers', () => {
    expect(viewShortcut(chord('1'))).toBeNull();
    expect(viewShortcut(chord('1', { metaKey: true, shiftKey: true }))).toBeNull();
    expect(viewShortcut(chord('1', { metaKey: true, altKey: true }))).toBeNull();
    expect(viewShortcut(chord('5', { metaKey: true }))).toBeNull();
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

  it('rejects empty lists and unknown current tabs', () => {
    expect(tablistStep('ArrowRight', 0, 0)).toBeNull();
    expect(tablistStep('ArrowRight', -1, 3)).toBeNull();
  });

  it('wraps on up/down for a vertical tablist like the phase ladder', () => {
    expect(tablistStep('ArrowDown', 0, 3, 'vertical')).toBe(1);
    expect(tablistStep('ArrowDown', 2, 3, 'vertical')).toBe(0);
    expect(tablistStep('ArrowUp', 0, 3, 'vertical')).toBe(2);
    expect(tablistStep('Home', 2, 3, 'vertical')).toBe(0);
    expect(tablistStep('End', 0, 3, 'vertical')).toBe(2);
  });

  it('leaves the cross-axis arrows alone, so each list only claims its own', () => {
    // The ladder sits beside text fields; stealing Left/Right would move the
    // selection instead of the caret. Horizontal strips stay Left/Right only.
    expect(tablistStep('ArrowLeft', 1, 3, 'vertical')).toBeNull();
    expect(tablistStep('ArrowRight', 1, 3, 'vertical')).toBeNull();
    expect(tablistStep('ArrowDown', 1, 3)).toBeNull();
    expect(tablistStep('ArrowUp', 1, 3)).toBeNull();
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
