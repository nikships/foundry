/** Pure view-model helpers for the pipeline workbench. */
import type { Acceptance, PhaseDef, PipelineCanvasPoint, PipelineDef } from '@shared/types.js';

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

/** The starting position for a node that has not been positioned by an operator. */
export function defaultCanvasPosition(index: number): PipelineCanvasPoint {
  return { x: 96 + index * 352, y: 168 };
}
