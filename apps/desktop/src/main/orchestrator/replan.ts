/** A fresh, read-only Orchestrator turn that may replace a failed run's tail. */

import { z } from 'zod';
import type { GeneratedRunPlan, PhaseDef, PipelineAmendment } from '@shared/types.js';
import type { Envelope } from '../engine/envelopes.js';
import type { OneShotFactory, OneShotSession } from '../pi/oneshot.js';
import { hydrateSynthesizedAgents, synthesizedAgentSchema } from './plan.js';
import { pipelineSchema } from '../store/pipelines.js';

export interface ReplanProposalInput {
  plan: GeneratedRunPlan;
  failedPhase: PhaseDef;
  completed: { phase: PhaseDef; envelope?: Envelope }[];
  remaining: PhaseDef[];
  evidence: string;
  attempt: number;
}

export interface Replanner {
  propose(input: ReplanProposalInput): Promise<PipelineAmendment | null>;
  /** Interrupts the proposal currently in flight, if there is one. */
  abort?(): void;
}

const amendmentSchema = z.object({
  reason: z.string().min(1),
  phases: pipelineSchema.shape.phases,
  agents: z.array(synthesizedAgentSchema),
});

const REPLAN_SYSTEM_PROMPT = `You are the Orchestrator revising an orchestrated run after its existing recovery paths were exhausted.

Propose the smallest valid replacement for the not-yet-completed pipeline tail. Completed phases are immutable. You may re-include the failed phase, insert a repair phase, reorder the remaining work, or extend it. Prefer existing agents; synthesize an agent only when the current roster cannot own a required phase. A code phase's feedbackTo may target only an earlier phase in your replacement tail, never a completed phase.

Every agent phase in your replacement tail names its own "model", copied verbatim from a model id that already appears on a phase of the confirmed plan. Never omit it, never write "inherit", and never leave the choice to the agent or the install default — an amendment with an unnamed model is rejected. A phase that failed on a weak model is a reason to name a stronger one from that same list.

Reply with one JSON object and nothing else:
{"reason":"why this amendment should recover the run","phases":[<replacement phases>],"agents":[<new synthesized agents only>]}

Each synthesized agent has {"name","purpose","systemPrompt","userPrompt","writes","envelope"} plus optional "reasoningEffort" and "toolProfile" ("read-only" for reviewers). Omit "model" on an agent — the phase names it. Omit engine-owned ids and colors.`;

function buildReplanPrompt(input: ReplanProposalInput): string {
  return [
    `This is amendment attempt ${input.attempt}.`,
    '',
    '## Confirmed plan',
    JSON.stringify(input.plan),
    '',
    '## Completed phases (immutable)',
    JSON.stringify(input.completed),
    '',
    '## Failed phase',
    JSON.stringify(input.failedPhase),
    '',
    '## Remaining queued phases being replaced',
    JSON.stringify(input.remaining),
    '',
    '## Failure evidence',
    input.evidence || '(no additional evidence was recorded)',
  ].join('\n');
}

function parseAmendment(text: string, colorOffset = 0): PipelineAmendment | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = amendmentSchema.safeParse(JSON.parse(text.slice(start, end + 1)));
    if (!parsed.success) return null;
    return {
      reason: parsed.data.reason,
      phases: parsed.data.phases,
      agents: hydrateSynthesizedAgents(parsed.data.agents, colorOffset),
    };
  } catch {
    return null;
  }
}

/**
 * Each proposal opens and disposes its own one-shot in the run's current cwd.
 * The callback is late-bound because an isolated worktree does not exist when
 * the registry constructs the executor.
 */
export function replanningSupport(
  oneShot: OneShotFactory,
  choice: { model: string; reasoningEffort: GeneratedRunPlan['reasoningEffort'] },
  cwd: () => string,
): Replanner {
  let active: OneShotSession | null = null;
  return {
    abort: () => active?.abort(),
    async propose(input): Promise<PipelineAmendment | null> {
      const session = oneShot({
        cwd: cwd(),
        access: 'read',
        model: choice.model,
        reasoningEffort: choice.reasoningEffort,
        systemPrompt: REPLAN_SYSTEM_PROMPT,
      });
      active = session;
      try {
        const turn = await session.send(buildReplanPrompt(input));
        if (turn.interrupted) return null;
        return parseAmendment(turn.text, input.plan.agents.length);
      } finally {
        if (active === session) active = null;
        session.abort();
      }
    },
  };
}
