/**
 * Pure view-model helpers for the pipeline workbench (Magic Patterns Stage Board).
 *
 * A pipeline in Foundry is an ordered array of PhaseDefs. The Stage Board derives
 * execution stages and checkpoint gates directly from that array on every render.
 *
 * Geometry, wording, and stage grouping live here so they are pure functions
 * and unit-testable without a DOM.
 */
import type { Acceptance, PhaseDef, PipelineDef, ValidationIssue } from '@shared/types.js';

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

export type StatusTone = 'ok' | 'warning' | 'error';

export interface ValidationSummary {
  tone: StatusTone;
  /** Short status word for the pill. */
  label: string;
  /** Sentence explaining what that status means right now. */
  detail: string;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/**
 * Status-bar reading of the live validation result. A pipeline with warnings
 * still saves and still runs, so warnings never read as a failure.
 */
export function validationSummary(
  issues: ValidationIssue[],
  opts: { hasProject: boolean } = { hasProject: true },
): ValidationSummary {
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');
  if (errors.length) {
    return {
      tone: 'error',
      label: `${errors.length} error${errors.length === 1 ? '' : 's'}`,
      detail: 'Changes stop saving until these are fixed.',
      errors,
      warnings,
    };
  }
  if (warnings.length) {
    return {
      tone: 'warning',
      label: `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`,
      detail: 'Saved and runnable, but worth a look.',
      errors,
      warnings,
    };
  }
  return {
    tone: 'ok',
    label: 'Ready',
    detail: opts.hasProject
      ? 'This pipeline is ready to run.'
      : 'Select a project to run this pipeline.',
    errors,
    warnings,
  };
}

/* ── Stage Board derived views ─────────────────────────────────────────── */

/**
 * A stage: the run of phases that execute without stopping (unattended),
 * and the checkpoint phase that closes it.
 */
export interface Stage {
  /** Position of the stage in the run, from 0. */
  index: number;
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
  phases.forEach((phase, i) => {
    if (phase.kind === 'engineer') {
      stages.push({ index: stages.length, members, gate: i, end: i + 1 });
      members = [];
      return;
    }
    members.push(i);
  });
  stages.push({
    index: stages.length,
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
