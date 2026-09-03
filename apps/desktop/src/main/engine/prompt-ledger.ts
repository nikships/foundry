/**
 * Which phase prompts a live session already holds.
 *
 * A `feedbackTo` jump re-enters a phase whose session usually still contains
 * that phase's rendered prompt, so the re-entry can be a short delta instead of
 * the whole prompt again. Getting that wrong is a correctness bug — an agent
 * asked to "continue" a conversation that no longer describes the task — so the
 * ledger is deliberately pessimistic:
 *
 *   - it keys on the session **object**, so a replaced or closed session starts
 *     empty with no bookkeeping — those two cases need no explicit `forget`;
 *   - it stores a fingerprint of the prompt as it renders *without* feedback,
 *     so a phase whose inputs changed since the first entry no longer matches;
 *   - rewind and a closed/replaced session still `forget`, because the same
 *     object is there with a shorter history that no longer holds the prompt;
 *   - compaction is different: Foundry pins the current phase prompt (minus
 *     Report) and the project card, so a compact that actually dropped messages
 *     only `retainPinned`s that constitution. A failed compact leaves the
 *     ledger untouched.
 *
 * A miss only costs tokens, so every uncertainty resolves to a full prompt.
 */

import { createHash } from 'node:crypto';

/** The prompt as it renders with no feedback: the part re-entry may reuse. */
export function promptFingerprint(input: { system: string; user: string }): string {
  return createHash('sha256')
    .update(input.system)
    .update('\u0000')
    .update(input.user)
    .digest('hex');
}

/** Constitution a compact must keep verbatim for this session. */
export interface ConstitutionPin {
  phase: string;
  userPrompt: string;
  projectCard: string;
}

export class PromptLedger {
  private readonly bySession = new WeakMap<object, Map<string, string>>();
  private readonly pins = new WeakMap<object, ConstitutionPin>();

  /** True when this session already holds exactly this phase prompt. */
  matches(session: object, phase: string, fingerprint: string): boolean {
    return this.bySession.get(session)?.get(phase) === fingerprint;
  }

  note(
    session: object,
    phase: string,
    fingerprint: string,
    pin?: Omit<ConstitutionPin, 'phase'>,
  ): void {
    const known = this.bySession.get(session);
    if (known) known.set(phase, fingerprint);
    else this.bySession.set(session, new Map([[phase, fingerprint]]));
    if (pin) this.pins.set(session, { phase, ...pin });
  }

  constitution(session: object): ConstitutionPin | undefined {
    return this.pins.get(session);
  }

  /**
   * After a compact that dropped messages: keep only the pinned phase, whose
   * prompt is still in context. Every earlier phase may have been summarised.
   */
  retainPinned(session: object): void {
    const pin = this.pins.get(session);
    const fingerprint = pin ? this.bySession.get(session)?.get(pin.phase) : undefined;
    if (!pin || !fingerprint) {
      this.forget(session);
      return;
    }
    this.bySession.set(session, new Map([[pin.phase, fingerprint]]));
  }

  /** Drops every phase this session was holding. */
  forget(session: object): void {
    this.bySession.delete(session);
    this.pins.delete(session);
  }
}
