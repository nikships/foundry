/**
 * The rule that decides whether Smith may open a session at all.
 *
 * Both sides of the IPC seam read it: the renderer to disable the composer,
 * main to refuse at session open. Pinned here so the two cannot drift into
 * disagreeing about what counts as a chosen model.
 */

import { describe, expect, it } from 'vitest';
import { MODEL_UNSET, modelChoiceBlock } from '@shared/model-choice.js';

const CATALOG = ['anthropic/claude-sonnet-4', 'openai/gpt-5'];

describe('modelChoiceBlock', () => {
  it('allows a model the install can reach', () => {
    expect(modelChoiceBlock('anthropic/claude-sonnet-4', CATALOG)).toBeNull();
  });

  it('blocks the unset sentinel rather than treating it as a default', () => {
    // The whole point: `inherit` is an unanswered question, not a choice.
    expect(modelChoiceBlock(MODEL_UNSET, CATALOG)).toMatch(/no model is selected/i);
    expect(modelChoiceBlock('', CATALOG)).toMatch(/no model is selected/i);
    expect(modelChoiceBlock(null, CATALOG)).toMatch(/no model is selected/i);
  });

  it('blocks a chosen model the catalog no longer offers, naming it', () => {
    expect(modelChoiceBlock('anthropic/claude-opus-99', CATALOG)).toBe(
      'anthropic/claude-opus-99 is not available to this install. Choose a model that is.',
    );
  });

  it('does not call a set model unreachable while the catalog is empty', () => {
    // An empty list means "no provider connected yet", which the connect-a-
    // provider copy already explains. Calling the stored model missing here
    // would blame the operator's choice for a state it had nothing to do with.
    expect(modelChoiceBlock('anthropic/claude-sonnet-4', [])).toBeNull();
    // Unset is still unset, catalog or no catalog.
    expect(modelChoiceBlock(MODEL_UNSET, [])).toMatch(/no model is selected/i);
  });

  it('matches a custom model id by its suffix, as the picker does', () => {
    expect(modelChoiceBlock('my-model', ['custom:local:my-model'])).toBeNull();
  });
});
