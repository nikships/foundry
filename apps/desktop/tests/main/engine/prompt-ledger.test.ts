/**
 * The ledger is pessimistic: a miss re-sends the full prompt. Compaction is
 * the exception — a pin survives a compact that dropped other messages.
 */

import { describe, expect, it } from 'vitest';
import { PromptLedger, promptFingerprint } from '../../../src/main/engine/prompt-ledger.js';

const fp = (user: string) => promptFingerprint({ system: 'role', user });

describe('PromptLedger', () => {
  it('matches a noted phase and misses any other fingerprint', () => {
    const ledger = new PromptLedger();
    const session = {};
    const first = fp('build it');
    ledger.note(session, 'build', first, { userPrompt: 'build it', projectCard: '## Stack' });
    expect(ledger.matches(session, 'build', first)).toBe(true);
    expect(ledger.matches(session, 'build', fp('build it differently'))).toBe(false);
    expect(ledger.constitution(session)).toEqual({
      phase: 'build',
      userPrompt: 'build it',
      projectCard: '## Stack',
    });
  });

  it('retainPinned keeps only the constitution phase after a real compact', () => {
    const ledger = new PromptLedger();
    const session = {};
    ledger.note(session, 'plan', fp('plan it'));
    ledger.note(session, 'build', fp('build it'), {
      userPrompt: 'build it',
      projectCard: 'card',
    });
    ledger.retainPinned(session);
    expect(ledger.matches(session, 'build', fp('build it'))).toBe(true);
    expect(ledger.matches(session, 'plan', fp('plan it'))).toBe(false);
    expect(ledger.constitution(session)?.phase).toBe('build');
  });

  it('forget drops every phase, including the pin', () => {
    const ledger = new PromptLedger();
    const session = {};
    ledger.note(session, 'build', fp('build it'), { userPrompt: 'build it', projectCard: '' });
    ledger.forget(session);
    expect(ledger.matches(session, 'build', fp('build it'))).toBe(false);
    expect(ledger.constitution(session)).toBeUndefined();
  });

  it('retainPinned without a pin forgets the session', () => {
    const ledger = new PromptLedger();
    const session = {};
    ledger.note(session, 'build', fp('build it'));
    ledger.retainPinned(session);
    expect(ledger.matches(session, 'build', fp('build it'))).toBe(false);
  });
});
