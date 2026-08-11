/**
 * Pure view-model helpers for the pipeline workbench (Magic Patterns Stage Board).
 *
 * A pipeline in Foundry is an ordered array of PhaseDefs. The Stage Board derives
 * execution stages and checkpoint gates directly from that array on every render.
 *
 * Geometry, wording, and stage grouping live here so they are pure functions
 * and unit-testable without a DOM.
 */
import type { Acceptance, PhaseDef, PipelineDef } from '@shared/types.js';

/** Composition line: "3 agents · 1 command · 1 checkpoint". */
export function phaseComposition(phases: PhaseDef[]): string {
  const agents = phases.filter((p) => p.kind === 'agent').length;
  const commands = phases.filter((p) => p.kind === 'code').length;
  const checkpoints = phases.filter((p) => p.kind === 'engineer').length;
  const parts: string[] = [];
  if (agents) parts.push(`${agents} agent${agents === 1 ? '' : 's'}`);
  if (commands) parts.push(`${commands} command${commands === 1 ? '' : 's'}`);
  if (checkpoints) parts.push(`${checkpoints} checkpoint${checkpoints === 1 ? '' : 's'}`);
  if (!parts.length) return 'Empty';
  return parts.join(' · ');
}

/** The command a code phase runs, as one display string. */
export function commandText(phase: PhaseDef): string {
  const command = phase.command;
  if (!command) return '';
  if ('ref' in command) return command.ref;
  if ('builtin' in command) return command.builtin;
  if ('argv' in command) return command.argv.join(' ');
  return '';
}

/** Extract gate names from a phase definition. */
export function gateNames(phase: PhaseDef): string[] {
  return (phase.gates ?? []).map((g) => (typeof g === 'string' ? g : g.gate));
}

/**
 * The phase index a validation issue belongs to, or null for pipeline-level issues.
 *
 * `validate` labels phase issues `phases[2] build`, while a schema rejection
 * arrives as a zod path (`phases.2.name`). Both are parsed so a reported
 * problem can focus the phase that caused it instead of only naming it.
 */
export function issuePhaseIndex(where: string): number | null {
  const match = /^phases[[.](\d+)/.exec(where);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

/** The four acceptance rules, with the sentence each one means. */
export const ACCEPTANCE_OPTIONS: {
  value: Acceptance['kind'];
  label: string;
  description: string;
}[] = [
  {
    value: 'all_phases_pass',
    label: 'Every phase passed',
    description: 'The run is accepted only when every phase ends in success.',
  },
  {
    value: 'last_phase_pass',
    label: 'The last phase passed',
    description: "Only the final phase's status decides acceptance.",
  },
  {
    value: 'envelope_status',
    label: "A phase's envelope reports success",
    description: "Accepted when a chosen phase's envelope status is success.",
  },
  {
    value: 'phase_flag',
    label: "A phase's envelope sets a flag",
    description: 'Accepted when a chosen phase sets passed or approved.',
  },
];

/** The short label for an acceptance rule, as the option list words it. */
export function acceptanceLabel(acceptance: Acceptance): string {
  return ACCEPTANCE_OPTIONS.find((o) => o.value === acceptance.kind)?.label ?? acceptance.kind;
}

/** The phase name an acceptance rule points at, if it points at one. */
export function acceptanceTarget(acceptance: Acceptance): string | null {
  return 'phase' in acceptance ? acceptance.phase : null;
}

/**
 * Indices of the phases acceptance actually reads, so the UI can mark them.
 */
export function outcomeMarks(acceptance: Acceptance, phases: PhaseDef[]): number[] {
  if (acceptance.kind === 'last_phase_pass') {
    return phases.length ? [phases.length - 1] : [];
  }
  const target = acceptanceTarget(acceptance);
  if (target == null) return [];
  const index = phases.findIndex((p) => p.name === target);
  return index >= 0 ? [index] : [];
}

/** One-sentence plain reading of the acceptance rule. */
export function acceptanceSummary(acceptance: Acceptance, phases: PhaseDef[]): string {
  switch (acceptance.kind) {
    case 'all_phases_pass':
      return phases.length
        ? `Accepted when all ${phases.length} phase${phases.length === 1 ? '' : 's'} pass.`
        : 'Accepted when every phase ends in success. This pipeline has no phases yet.';
    case 'last_phase_pass': {
      const last = phases[phases.length - 1];
      return last
        ? `Accepted when "${last.name}", the last phase, ends in success.`
        : 'Accepted when the last phase ends in success. This pipeline has no phases yet.';
    }
    case 'envelope_status':
      return `Accepted when the envelope returned by "${acceptance.phase}" reports success.`;
    case 'phase_flag':
      return `Accepted when "${acceptance.phase}" returns ${acceptance.flag} in its envelope.`;
  }
}

/** What the acceptance rule actually reads, in the words the screen shows. */
export function acceptanceReads(pipeline: PipelineDef): string {
  const acceptance = pipeline.acceptance;
  const last = pipeline.phases[pipeline.phases.length - 1];
  switch (acceptance.kind) {
    case 'all_phases_pass':
      return `Reads every phase status. ${pipeline.phases.length || 'No'} phase${
        pipeline.phases.length === 1 ? '' : 's'
      } must end in success.`;
    case 'last_phase_pass':
      return last
        ? `Reads the status of the last phase, ${last.name}. Nothing before it decides the run.`
        : 'Reads the status of the last phase. This pipeline has none yet.';
    case 'envelope_status':
      return `Reads ${acceptance.phase}'s envelope and accepts when its status field says success.`;
    case 'phase_flag':
      return `Reads ${acceptance.phase}'s envelope and accepts when it sets ${acceptance.flag}.`;
  }
}

/** Formats a timeout millisecond duration to minutes/seconds string. */
export function formatTimeout(ms: number | undefined): string {
  if (!ms) return 'none';
  if (ms % 60000 === 0) return `${ms / 60000}m`;
  return `${Math.round(ms / 1000)}s`;
}

/** Formats a Date to a 24-hour clock string (HH:MM:SS). */
export function formatClock(date: Date): string {
  return date.toLocaleTimeString('en-GB', { hour12: false });
}

/* ── Stage Board derived views ─────────────────────────────────────────── */

/**
 * A stage: the run of phases that execute without stopping (unattended),
 * and the checkpoint phase that closes it.
 */
export interface Stage {
  /** Position of the stage in the run, from 0. */
  index: number;
  /** Index of this stage's first phase — where a prepend lands. */
  start: number;
  /** Indices into `phases` of the work in this stage, in execution order. */
  members: number[];
  /** Index of the checkpoint closing this stage, or null when nothing gates it. */
  gate: number | null;
  /** Index one past this stage's last phase — where an append lands. */
  end: number;
}

/**
 * Split an ordered phase list into gated stages. The checkpoint that ends a
 * stage is the stage's gate, not one of its members, because it is the
 * boundary rather than work inside it. Phases after the last checkpoint always
 * form a final, ungated stage — a pipeline always has somewhere to add to.
 */
export function stagesOf(phases: PhaseDef[]): Stage[] {
  const stages: Stage[] = [];
  let members: number[] = [];
  let start = 0;
  phases.forEach((phase, i) => {
    if (phase.kind === 'engineer') {
      stages.push({ index: stages.length, start, members, gate: i, end: i + 1 });
      members = [];
      start = i + 1;
      return;
    }
    members.push(i);
  });
  stages.push({
    index: stages.length,
    start,
    members,
    gate: null,
    end: phases.length,
  });
  return stages;
}

/** The stage a phase belongs to — its members' stage, or the stage it gates. */
export function stageOfPhase(stages: Stage[], phase: number): number {
  const found = stages.findIndex((s) => s.gate === phase || s.members.includes(phase));
  return found;
}

/**
 * Where a phase lands when it is pushed one stage later or earlier.
 *
 * Moving across a gate moves the phase past the checkpoint in the
 * underlying array: the board edits order, it does not store a column.
 * Returns null when there is no stage that way.
 */
export function stageMoveTarget(phases: PhaseDef[], phase: number, delta: number): number | null {
  const stages = stagesOf(phases);
  const from = stageOfPhase(stages, phase);
  if (from < 0) return null;
  // A checkpoint IS a boundary; moving it between stages is meaningless.
  if (stages[from]?.gate === phase) return null;
  const to = from + delta;
  const target = stages[to];
  if (!target) return null;
  if (delta > 0) {
    // Land first in the later stage, just past this stage's gate. Splicing the
    // phase out shifts everything after it down one, so the gate's current
    // index is already the insertion point.
    const gate = stages[from]?.gate;
    return gate == null ? null : gate;
  }
  // Land last in the earlier stage's work. Indices before the moved phase are
  // untouched by the splice, so that is one past its final member.
  const last = target.members[target.members.length - 1];
  if (last != null) return last + 1;
  // An empty stage starts where the previous one ended.
  return target.index === 0 ? 0 : stages[target.index - 1]!.end;
}

/**
 * The insertion points a stage column exposes, as indices into `phases`.
 *
 * A stage is a contiguous run, so its slots are every index from its first
 * phase up to and including the index its own append lands on — the gate when
 * one closes the stage, its end when nothing does. An empty stage still has
 * one slot, which is why a column is never a dead drop target.
 */
export function stageSlots(stage: Stage): number[] {
  const last = stage.gate ?? stage.end;
  const slots: number[] = [];
  for (let i = stage.start; i <= last; i += 1) slots.push(i);
  return slots;
}

/**
 * The index `reorderPhase` needs for a drop on the insertion point `insertAt`.
 *
 * A reorder splices the phase out before it splices it back in, so an
 * insertion point after the dragged phase has already shifted down one by the
 * time it is read. Returns null when the drop would not move anything: the
 * slots on either side of a phase are the position it already holds.
 */
export function reorderTarget(from: number, insertAt: number): number | null {
  if (insertAt === from || insertAt === from + 1) return null;
  return insertAt > from ? insertAt - 1 : insertAt;
}

/**
 * How to rebuild the phase list so a dragged phase becomes a stage of its own.
 *
 * `at` is an index into the list with the dragged phase already removed,
 * because that is the order the edit applies in. Only a checkpoint or the edge
 * of the run bounds a stage, so a side that has neither needs a new
 * checkpoint.
 */
export interface NewStagePlan {
  /** Where the insertion starts, as an index into the list without the phase. */
  at: number;
  /** Whether a new checkpoint has to open the stage. */
  before: boolean;
  /** Whether a new checkpoint has to close it. */
  after: boolean;
}

/**
 * Plan the stage a phase dropped at `boundary` gets to itself, or null when the
 * drop would leave the run as it already is.
 *
 * `boundary` is an index into the current phase list where one stage ends and
 * the next begins: 0, the index of a checkpoint, or the length of the list.
 */
export function newStagePlan(
  phases: PhaseDef[],
  from: number,
  boundary: number,
): NewStagePlan | null {
  const phase = phases[from];
  // A checkpoint is a boundary, so it cannot be the contents of a stage.
  if (!phase || phase.kind === 'engineer') return null;

  const stages = stagesOf(phases);
  const stage = stages[stageOfPhase(stages, from)];
  // A phase that already has a stage to itself gains nothing from being
  // dropped on that stage's own boundaries except an empty stage beside it.
  if (stage && stage.members.length === 1) {
    const opening = stage.start === 0 ? 0 : stage.start - 1;
    const closing = stage.gate ?? phases.length;
    if (boundary === opening || boundary === closing) return null;
  }

  const rest = phases.filter((_, i) => i !== from);
  const at = Math.min(Math.max(0, boundary > from ? boundary - 1 : boundary), rest.length);
  return {
    at,
    before: at > 0 && rest[at - 1]!.kind !== 'engineer',
    after: at < rest.length && rest[at]!.kind !== 'engineer',
  };
}

/* ── Stage Board drag identifiers ──────────────────────────────────────── */

/** What a board drop id resolves to: an insertion point, or a new stage. */
export type DropTarget = { kind: 'slot'; at: number } | { kind: 'rail'; boundary: number };

/**
 * A drag id per phase, positionally indexed but stable across a reorder.
 *
 * The id follows the phase rather than the slot it sits in, because the drop
 * animation lands the card on wherever its id ended up: an index-based id would
 * name a different phase the moment the array is rewritten, and the card would
 * fly to a position it was never dropped on. Names are unique in a valid
 * pipeline; a duplicate is a validation error, so the index only breaks the tie
 * to keep the ids distinct while that error stands.
 */
export function phaseDragIds(phases: PhaseDef[]): string[] {
  const counts = new Map<string, number>();
  for (const phase of phases) counts.set(phase.name, (counts.get(phase.name) ?? 0) + 1);
  return phases.map((phase, i) =>
    (counts.get(phase.name) ?? 0) > 1 ? `phase:${phase.name}#${i}` : `phase:${phase.name}`,
  );
}

/** The drop id of the insertion point that lands a phase at `at`. */
export function dropSlotId(at: number): string {
  return `slot:${at}`;
}

/** The drop id of the new-stage rail at `boundary`. */
export function dropRailId(boundary: number): string {
  return `rail:${boundary}`;
}

/** Resolve a board drop id, or null when it names nothing droppable. */
export function parseDropId(id: string | number): DropTarget | null {
  const match = /^(slot|rail):(\d+)$/.exec(String(id));
  if (!match) return null;
  const value = Number(match[2]);
  return match[1] === 'rail' ? { kind: 'rail', boundary: value } : { kind: 'slot', at: value };
}

/** Label for a stage column: stages are numbered for the operator, from 1. */
export function stageLabel(stage: Stage, total: number): string {
  if (total === 1) return 'Whole run';
  return `Stage ${stage.index + 1}`;
}

/** What closes a stage, in words. */
export function stageGateSummary(stage: Stage, phases: PhaseDef[]): string {
  if (stage.gate == null) return 'Runs to the end, then acceptance decides.';
  const gate = phases[stage.gate];
  return gate?.question ? `Pauses here: ${gate.question}` : 'Pauses here until someone answers.';
}
