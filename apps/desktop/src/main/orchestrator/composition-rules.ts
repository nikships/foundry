/**
 * Composition rails shared by the Orchestrator prompt and Smith.
 *
 * Copied from the Orchestrator standing prompt on this branch. Do not import
 * unmerged `orchestrator/composition.ts` (PR 255): that module is a larger
 * prompt+rail object graph this branch does not have.
 */
import type { PhaseKind } from '@shared/types.js';

/** Shared PhaseKind universe. Engineer/question is not a phase kind. */
export const PHASE_KINDS = ['agent', 'code'] as const satisfies readonly PhaseKind[];

type SharedPhaseKind = (typeof PHASE_KINDS)[number];
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Fails typecheck if `PhaseKind` and `PHASE_KINDS` ever drift. */
const _phaseKindsArePhaseKind: Equal<PhaseKind, SharedPhaseKind> = true;
void _phaseKindsArePhaseKind;

export function isPhaseKind(value: string): value is PhaseKind {
  return (PHASE_KINDS as readonly string[]).includes(value);
}

/**
 * One source for the constitution both composers must teach. Order matches
 * the Orchestrator standing prompt; the last bullet is the PhaseKind lock.
 */
export const COMPOSITION_RULE_BULLETS = [
  'Always rewrite the operator\'s prompt into a full brief first. That brief is "refinedRequest" and becomes the run request; keep every constraint the operator stated.',
  'Every implementation phase using a build envelope, and every write-capable review phase, is proven before any commit. When Project commands are listed, immediately follow the agent with a code phase using one {"ref": ...} and set "feedbackTo" to the phase that owns a failure. When no Project command exists, put a configured "command_passes" gate on the agent instead. A new scaffold with no command yet is the only exception.',
  'Reviewer/verifier agent phases carry the "verdict_consistent" and "disapproval_halts" gates.',
  '**Every agent phase names its own model and reasoning level.** Set "model" to one of the configured cast-pool ids you are shown and set "reasoningEffort" to one of that model\'s listed efforts. Choose both for that phase\'s work: give design, review, and hard implementation the strongest models and reasoning, and hand mechanical or narrowly scoped work a smaller model and lower effort. Never omit "model", write "inherit", or leave the model choice to the agent, roster, or install default — a plan with an unnamed model is rejected.',
  'A proof code phase\'s "feedbackTo" names the earlier agent phase that owns the fix.',
  'Acceptance is {"kind":"envelope_status","phase":<final PR phase>} when the plan ends in a PR phase, otherwise {"kind":"all_phases_pass"}.',
  'Prefer roster agents when the supplied purpose, envelope, write boundary, and tool profile fit. Do not assume capabilities that are not in their summary.',
  'A synthesized agent gets a one-line purpose, a tight "writes" boundary containing only paths its phase must touch, and never the name of a roster agent. A synthesized judge-only reviewer uses "writes":[] and "toolProfile":"read-only". Use the build envelope for implementation agents.',
  'Phase names are lowercase snake_case and unique; pipeline ids are chosen by Foundry, not by you.',
  'Never emit an engineer/checkpoint phase. Shared PhaseKind is agent | code only.',
] as const;

export function compositionRuleBullets(): string {
  return COMPOSITION_RULE_BULLETS.map((rule) => `- ${rule}`).join('\n');
}
