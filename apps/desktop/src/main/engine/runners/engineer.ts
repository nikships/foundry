/**
 * The human interrupt. An engineer phase raises the sheet, records the
 * decision, and synthesises an envelope so later phases can read the human's
 * answer the same way they read an agent's.
 */

import type { PhaseDef } from '@shared/types.js';
import type { PhaseRunner, RunContext, PhaseJump } from '../phase-context.js';

export class EngineerPhaseRunner implements PhaseRunner {
  readonly kind = 'engineer' as const;

  async run(phase: PhaseDef, ctx: RunContext): Promise<PhaseJump> {
    const { tracer, runId } = ctx;
    const phaseId = ctx.phaseId(phase.name);
    tracer.beginQueuedPhase(phaseId);

    const eventId = tracer.event({
      runId,
      phaseId,
      type: 'interrupt',
      name: phase.name,
      payload: { question: phase.question ?? phase.description },
    });
    const answer = await ctx.askHuman({
      runId,
      phaseId,
      kind: 'engineer',
      title: phase.name,
      body: phase.question ?? phase.description,
    });
    tracer.endEvent(eventId, {
      decision: answer.approve ? 'approve' : 'reject',
      text: answer.text ?? '',
    });

    if (!answer.approve) {
      tracer.closePhase(phaseId, 'fail', 'the engineer rejected this phase');
      return { kind: 'abort', detail: 'the engineer rejected this phase' };
    }

    const notes = answer.text?.trim();
    if (notes) {
      // Edited text becomes an envelope so later phases can read it the same
      // way they read an agent's answer.
      ctx.envelopes.set(phase.name, {
        status: 'success',
        summary: notes.slice(0, 400),
        artifacts: [],
        notes_for_next_agent: notes,
      });
    }

    tracer.closePhase(phaseId, 'success');
    return { kind: 'next' };
  }
}
