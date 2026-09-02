/**
 * Pure shaping for the Plan card: what a `GeneratedRunPlan` looks like as an
 * operator-facing confirmation. No React, no IPC — the card renders exactly
 * what these functions return, so the wording is testable without a DOM.
 */

import type {
  CommandSpec,
  GeneratedRunPlan,
  PhaseDef,
  PhaseKind,
  PhaseRow,
  ReasoningEffort,
  ValidationIssue,
  WriteBoundary,
} from '@shared/types.js';
import type { RunPlanExportSelection } from '@shared/ipc-contract.js';
import { modelLabel } from '@shared/model-label.js';
import { exportedPipelineId } from '@shared/plan-export.js';
import { acceptanceSummary, outcomeMarks } from './pipeline-view.js';

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** One row in the card's ordered phase list. */
export interface PlanPhaseView {
  index: number;
  name: string;
  kind: PhaseKind;
  description: string;
  /** Agent phases only: who runs it. */
  agent: string | null;
  /** Whether that agent is synthesized for this run rather than on the roster. */
  synthesized: boolean;
  /** Compact machinery note: the command, the gates, or the checkpoint. */
  note: string;
  /** Whether the acceptance rule reads this phase's outcome. */
  decides: boolean;
  /**
   * Agent phases only: the model this phase is appointed to run on, as the
   * operator may still override it. `inherit` means the Orchestrator declined
   * to appoint one, which its rails refuse — it can only appear on a plan
   * generated before that rule existed.
   */
  model: string | null;
  /** Agent phases only: the reasoning level appointed for this phase. */
  reasoningEffort: ReasoningEffort | null;
}

/** One synthesized agent as the card presents it. */
export interface PlanAgentView {
  name: string;
  purpose: string;
  model: string;
  boundary: string;
  readOnly: boolean;
  color: string;
}

/** Warnings folded by `where`, so five notes about one phase read as one block. */
export interface PlanWarningGroup {
  where: string;
  messages: string[];
}

export interface PlanCardView {
  title: string;
  description: string;
  /** e.g. "4 phases · 2 synthesized agents", the card's one-line inventory. */
  summary: string;
  refinedRequest: string;
  rationale: string;
  phases: PlanPhaseView[];
  agents: PlanAgentView[];
  acceptance: string;
  warnings: PlanWarningGroup[];
  /** The mind that composed it, as the card credits it (model · effort). */
  orchestratorCredit: string;
}

export type PlanExportItem = 'pipeline' | `agent:${string}`;

export interface PlanExportView {
  pipeline: {
    name: string;
    id: string;
    description: string;
  };
  agents: {
    name: string;
    purpose: string;
  }[];
}

/**
 * Re-cast one agent phase onto another model, leaving the rest of the plan
 * identical.
 *
 * The plan is what `startRun` re-validates at the privileged boundary, so an
 * override has to travel as a real edit to the pipeline rather than a
 * side-channel the engine would have to be taught about separately.
 */
function patchAgentPhase(
  plan: GeneratedRunPlan,
  phaseName: string,
  patch: Partial<Pick<PhaseDef, 'model' | 'reasoningEffort'>>,
): GeneratedRunPlan {
  const phases = plan.pipeline.phases.map((phase) =>
    phase.name === phaseName && phase.kind === 'agent' ? { ...phase, ...patch } : phase,
  );
  return { ...plan, pipeline: { ...plan.pipeline, phases } };
}

export function withPhaseModel(
  plan: GeneratedRunPlan,
  phaseName: string,
  model: string,
): GeneratedRunPlan {
  return patchAgentPhase(plan, phaseName, { model });
}

/** Re-appoint one agent phase's reasoning level without changing its model. */
export function withPhaseReasoningEffort(
  plan: GeneratedRunPlan,
  phaseName: string,
  reasoningEffort: ReasoningEffort,
): GeneratedRunPlan {
  return patchAgentPhase(plan, phaseName, { reasoningEffort });
}

/** Which phases the operator re-cast, against the plan as it was generated. */
export function overriddenPhases(
  original: GeneratedRunPlan,
  current: GeneratedRunPlan,
): Set<string> {
  const before = new Map(
    original.pipeline.phases.map((phase) => [
      phase.name,
      { model: phase.model, reasoningEffort: phase.reasoningEffort },
    ]),
  );
  const changed = new Set<string>();
  for (const phase of current.pipeline.phases) {
    const proposed = before.get(phase.name);
    if (
      proposed &&
      (proposed.model !== phase.model || proposed.reasoningEffort !== phase.reasoningEffort)
    ) {
      changed.add(phase.name);
    }
  }
  return changed;
}

/** The operator-facing reading of a `writes` boundary. */
export function boundaryLabel(writes: WriteBoundary): string {
  if (writes === null) return 'writes anywhere (minus protected paths)';
  if (writes.length === 0) return 'read-only';
  const shown = writes.slice(0, 3).join(', ');
  const more = writes.length - 3;
  return more > 0 ? `writes ${shown} +${more} more` : `writes ${shown}`;
}

function commandNote(command: CommandSpec | undefined): string {
  if (!command) return 'command';
  if ('ref' in command) return `runs "${command.ref}"`;
  if ('builtin' in command) return command.builtin.replace(/_/g, ' ');
  return command.argv.join(' ');
}

/** The compact machinery note under one phase row. */
export function phaseNote(phase: PhaseDef): string {
  const parts: string[] = [];
  if (phase.kind === 'code') {
    parts.push(commandNote(phase.command));
  }
  if (phase.gates?.length) {
    const names = phase.gates.map((g) => (typeof g === 'string' ? g : g.gate));
    parts.push(`gates: ${names.join(', ')}`);
  }
  if (phase.feedbackTo) parts.push(`fails back to ${phase.feedbackTo}`);
  return parts.join(' · ');
}

/** Folds warnings by `where`, keeping first-seen order on both axes. */
export function groupPlanWarnings(warnings: ValidationIssue[]): PlanWarningGroup[] {
  const groups = new Map<string, string[]>();
  for (const warning of warnings) {
    const list = groups.get(warning.where) ?? [];
    if (!list.includes(warning.message)) list.push(warning.message);
    groups.set(warning.where, list);
  }
  return [...groups.entries()].map(([where, messages]) => ({ where, messages }));
}

/** Everything the Plan card renders, shaped once. */
export function planCardView(plan: GeneratedRunPlan): PlanCardView {
  const synthesized = new Set(plan.agents.map((a) => a.name));
  const agentEfforts = new Map(plan.agents.map((agent) => [agent.name, agent.reasoningEffort]));
  const marks = new Set(outcomeMarks(plan.pipeline.acceptance, plan.pipeline.phases));
  const phases: PlanPhaseView[] = plan.pipeline.phases.map((phase, index) => ({
    index,
    name: phase.name,
    kind: phase.kind,
    description: phase.description,
    agent: phase.agent ?? null,
    synthesized: Boolean(phase.agent && synthesized.has(phase.agent)),
    note: phaseNote(phase),
    decides: marks.has(index),
    model: phase.kind === 'agent' ? (phase.model ?? 'inherit') : null,
    reasoningEffort:
      phase.kind === 'agent'
        ? (phase.reasoningEffort ?? agentEfforts.get(phase.agent ?? '') ?? 'medium')
        : null,
  }));

  const inventory = [plural(plan.pipeline.phases.length, 'phase')];
  if (plan.agents.length) inventory.push(plural(plan.agents.length, 'synthesized agent'));

  return {
    title: plan.pipeline.name,
    description: plan.pipeline.description,
    summary: inventory.join(' · '),
    refinedRequest: plan.refinedRequest,
    rationale: plan.rationale,
    phases,
    agents: plan.agents.map((agent) => ({
      name: agent.name,
      purpose: agent.purpose,
      // A synthesized agent no longer picks a model: the phase it runs in
      // names one, and the card lets the operator re-cast that appointment.
      model: agent.model === 'inherit' ? 'model set per phase' : modelLabel(agent.model),
      boundary: boundaryLabel(agent.writes),
      readOnly: agent.toolProfile === 'read-only' || agent.writes?.length === 0,
      color: agent.color,
    })),
    acceptance: acceptanceSummary(plan.pipeline.acceptance, plan.pipeline.phases),
    warnings: groupPlanWarnings(plan.warnings),
    orchestratorCredit:
      plan.model === 'inherit'
        ? `the default model · ${plan.reasoningEffort}`
        : `${modelLabel(plan.model)} · ${plan.reasoningEffort}`,
  };
}

/** The ordinary identities the sheet asks the operator to confirm. */
export function planExportView(plan: GeneratedRunPlan): PlanExportView {
  return {
    pipeline: {
      name: plan.pipeline.name,
      id: exportedPipelineId(plan.pipeline.name),
      description: plan.pipeline.description,
    },
    agents: plan.agents.map((agent) => ({ name: agent.name, purpose: agent.purpose })),
  };
}

export function allPlanExportSelection(plan: GeneratedRunPlan): RunPlanExportSelection {
  return { pipeline: true, agents: plan.agents.map((agent) => agent.name) };
}

/** One checkbox transition, preserving the plan's agent order. */
export function togglePlanExportSelection(
  selection: RunPlanExportSelection,
  item: PlanExportItem,
  checked: boolean,
): RunPlanExportSelection {
  if (item === 'pipeline') return { ...selection, pipeline: checked };
  const name = item.slice('agent:'.length);
  const agents = checked
    ? selection.agents.includes(name)
      ? selection.agents
      : [...selection.agents, name]
    : selection.agents.filter((agent) => agent !== name);
  return { ...selection, agents };
}

export function planExportSelectionCount(selection: RunPlanExportSelection): number {
  return Number(selection.pipeline) + selection.agents.length;
}

/** Issues scoped by main to an exported entity, including nested validation fields. */
export function planExportItemIssues(
  issues: ValidationIssue[],
  item: PlanExportItem,
): ValidationIssue[] {
  return issues.filter((issue) => issue.where === item || issue.where.startsWith(`${item}.`));
}

/** Whether the final persisted plan still has a failed active phase to continue. */
export function planHasActiveFailure(plan: GeneratedRunPlan, history: PhaseRow[]): boolean {
  const latestByName = new Map<string, PhaseRow>();
  for (const row of history) latestByName.set(row.name, row);
  return plan.pipeline.phases.some((phase) => latestByName.get(phase.name)?.status === 'fail');
}
