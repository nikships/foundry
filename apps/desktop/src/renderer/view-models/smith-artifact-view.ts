/**
 * Pure derivation for Smith's rich artifact cards and specialized proposal
 * bodies, kept free of React so every rule here is testable without a DOM.
 *
 * This file is the renderer's half of the artifact registry: main validates
 * and emits (`main/smith/present-tools.ts`), this file decides which kinds and
 * versions this build can render and derives the display rows, and
 * `SmithArtifactCard`/`SmithEntityDesign` draw them. Adding a kind touches the
 * shared type, main validation, this registry, a design body, and tests —
 * never a Markdown parser.
 */

import { SMITH_ARTIFACT_VERSION } from '@shared/types.js';
import type {
  Acceptance,
  AgentDef,
  ChecklistDef,
  ChecklistItem,
  ChecklistItemStatus,
  CommandSpec,
  EnvelopeDef,
  GateSpec,
  PhaseDef,
  PipelineDef,
  SmithArtifact,
  WriteBoundary,
} from '@shared/types.js';

/** The kinds this build renders; anything else falls back to a readable note. */
const SUPPORTED_ARTIFACT_KINDS: ReadonlyArray<SmithArtifact['kind']> = [
  'pipeline_design',
  'agent_design',
  'envelope_design',
  'checklist',
  'run_summary',
];

export function isRenderableArtifact(artifact: SmithArtifact): boolean {
  return (
    artifact.version === SMITH_ARTIFACT_VERSION && SUPPORTED_ARTIFACT_KINDS.includes(artifact.kind)
  );
}

export const ARTIFACT_KIND_LABEL: Record<SmithArtifact['kind'], string> = {
  pipeline_design: 'pipeline design',
  agent_design: 'agent design',
  envelope_design: 'report design',
  checklist: 'checklist',
  run_summary: 'run summary',
};

/** The identifying name the card's title shows. */
export function artifactName(artifact: SmithArtifact): string {
  if (artifact.kind === 'pipeline_design') return artifact.pipeline.id;
  if (artifact.kind === 'agent_design') return artifact.agent.name;
  if (artifact.kind === 'envelope_design') return artifact.envelope.name;
  if (artifact.kind === 'checklist') return artifact.checklist.title;
  return artifact.pipelineName || artifact.pipelineId || artifact.runId;
}

export function runStatusLabel(status: string): string {
  switch (status) {
    case 'accepted':
      return 'accepted';
    case 'running':
      return 'running';
    case 'failed':
      return 'failed';
    case 'rejected':
      return 'rejected';
    case 'killed':
      return 'killed';
    default:
      return status;
  }
}

export function isolationLabel(isolation?: boolean, branch?: string | null): string {
  if (isolation === false) return 'direct checkout';
  return branch ? `isolated worktree (${branch})` : 'isolated worktree';
}

// ── Checklist helpers ────────────────────────────────────────────────────────

export interface GroupedChecklistItems {
  fail: ChecklistItem[];
  warn: ChecklistItem[];
  pass: ChecklistItem[];
  info: ChecklistItem[];
}

export function groupChecklistItems(items: ChecklistItem[]): GroupedChecklistItems {
  const groups: GroupedChecklistItems = { fail: [], warn: [], pass: [], info: [] };
  for (const item of items) {
    if (item.status === 'fail') groups.fail.push(item);
    else if (item.status === 'warn') groups.warn.push(item);
    else if (item.status === 'pass') groups.pass.push(item);
    else groups.info.push(item);
  }
  return groups;
}

export function checklistSummary(checklist: ChecklistDef): string {
  if (checklist.summary && checklist.summary.trim()) {
    return checklist.summary.trim();
  }
  const counts = { pass: 0, warn: 0, fail: 0, info: 0 };
  for (const item of checklist.items) {
    if (item.status in counts) {
      counts[item.status] += 1;
    }
  }
  const parts: string[] = [];
  if (counts.fail > 0) parts.push(`${counts.fail} failed`);
  if (counts.warn > 0) parts.push(`${counts.warn} ${counts.warn === 1 ? 'warning' : 'warnings'}`);
  if (counts.pass > 0) parts.push(`${counts.pass} passed`);
  if (counts.info > 0) parts.push(`${counts.info} info`);
  return parts.join(' · ') || 'No checks';
}

export function checklistStatusLabel(status: ChecklistItemStatus): string {
  switch (status) {
    case 'pass':
      return 'Passed';
    case 'warn':
      return 'Warning';
    case 'fail':
      return 'Failed';
    case 'info':
      return 'Info';
  }
}

export function checklistStatusGlyph(status: ChecklistItemStatus): string {
  switch (status) {
    case 'pass':
      return '✓';
    case 'warn':
      return '⚠';
    case 'fail':
      return '✕';
    case 'info':
      return 'ℹ';
  }
}

// ── Display labels ───────────────────────────────────────────────────────────

export function acceptanceLabel(acceptance: Acceptance): string {
  switch (acceptance.kind) {
    case 'all_phases_pass':
      return 'every phase must pass';
    case 'last_phase_pass':
      return 'the last phase must pass';
    case 'phase_flag':
      return `phase ${acceptance.phase} must report ${acceptance.flag}`;
    case 'envelope_status':
      return `phase ${acceptance.phase}'s envelope status decides`;
  }
}

export function commandLabel(command: CommandSpec | undefined): string {
  if (!command) return '';
  if ('ref' in command) return command.ref;
  if ('builtin' in command) return command.builtin;
  return command.argv.join(' ');
}

export function gateLabel(gate: string | GateSpec): string {
  return typeof gate === 'string' ? gate : gate.gate;
}

export function writesLabel(writes: WriteBoundary): string {
  if (writes === null) return 'unrestricted (minus protected paths)';
  if (writes.length === 0) return 'read-only';
  return writes.join(', ');
}

/** How a phase names what does the work: an agent, a command, or the human. */
export function phaseWorkLabel(phase: PhaseDef): string {
  if (phase.kind === 'agent') return phase.agent ?? '';
  if (phase.kind === 'code') return commandLabel(phase.command);
  return phase.question ?? '';
}

// ── Semantic before/after comparison ─────────────────────────────────────────

export interface SemanticChange {
  /** What changed, in domain language: `purpose`, `phase build`, `field severity`. */
  where: string;
  kind: 'added' | 'removed' | 'changed' | 'reordered';
  before?: string;
  after?: string;
}

const MAX_VALUE_PREVIEW = 160;

function preview(value: unknown): string {
  if (value === undefined) return '—';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > MAX_VALUE_PREVIEW ? `${text.slice(0, MAX_VALUE_PREVIEW)}…` : text;
}

function changed(where: string, before: unknown, after: unknown): SemanticChange | null {
  if (JSON.stringify(before) === JSON.stringify(after)) return null;
  return { where, kind: 'changed', before: preview(before), after: preview(after) };
}

function fieldChanges<T extends object>(
  before: T,
  after: T,
  fields: ReadonlyArray<{ key: keyof T; label: string }>,
): SemanticChange[] {
  const out: SemanticChange[] = [];
  for (const { key, label } of fields) {
    const change = changed(label, before[key], after[key]);
    if (change) out.push(change);
  }
  return out;
}

const AGENT_FIELDS: ReadonlyArray<{ key: keyof AgentDef; label: string }> = [
  { key: 'purpose', label: 'purpose' },
  { key: 'model', label: 'model' },
  { key: 'reasoningEffort', label: 'reasoning effort' },
  { key: 'inheritDefaults', label: 'inherit defaults' },
  { key: 'systemPrompt', label: 'system prompt' },
  { key: 'userPrompt', label: 'user prompt' },
  { key: 'writes', label: 'write boundary' },
  { key: 'envelope', label: 'envelope' },
  { key: 'toolProfile', label: 'tool profile' },
  { key: 'customFields', label: 'custom fields' },
  { key: 'color', label: 'color' },
  { key: 'emblem', label: 'emblem' },
];

const PHASE_FIELDS: ReadonlyArray<{ key: keyof PhaseDef; label: string }> = [
  { key: 'kind', label: 'kind' },
  { key: 'description', label: 'description' },
  { key: 'agent', label: 'agent' },
  { key: 'model', label: 'model' },
  { key: 'envelope', label: 'envelope' },
  { key: 'gates', label: 'gates' },
  { key: 'prompt', label: 'prompt inputs' },
  { key: 'command', label: 'command' },
  { key: 'retries', label: 'retries' },
  { key: 'feedbackTo', label: 'feedback target' },
  { key: 'feedbackRetries', label: 'feedback retries' },
  { key: 'question', label: 'question' },
  { key: 'optional', label: 'optional' },
];

function comparePipelines(before: PipelineDef, after: PipelineDef): SemanticChange[] {
  const out: SemanticChange[] = fieldChanges(before, after, [
    { key: 'name', label: 'name' },
    { key: 'description', label: 'description' },
    { key: 'acceptance', label: 'acceptance' },
    { key: 'isolation', label: 'isolation' },
  ]);
  const beforeNames = before.phases.map((phase) => phase.name);
  const afterNames = after.phases.map((phase) => phase.name);
  for (const phase of after.phases) {
    if (!beforeNames.includes(phase.name)) {
      out.push({ where: `phase ${phase.name}`, kind: 'added', after: phase.kind });
    }
  }
  for (const phase of before.phases) {
    if (!afterNames.includes(phase.name)) {
      out.push({ where: `phase ${phase.name}`, kind: 'removed', before: phase.kind });
    }
  }
  const shared = afterNames.filter((name) => beforeNames.includes(name));
  const beforeOrder = beforeNames.filter((name) => shared.includes(name));
  if (JSON.stringify(beforeOrder) !== JSON.stringify(shared)) {
    out.push({
      where: 'phase order',
      kind: 'reordered',
      before: beforeOrder.join(' → '),
      after: shared.join(' → '),
    });
  }
  for (const name of shared) {
    const prev = before.phases.find((phase) => phase.name === name)!;
    const next = after.phases.find((phase) => phase.name === name)!;
    for (const change of fieldChanges(prev, next, PHASE_FIELDS)) {
      out.push({ ...change, where: `phase ${name} ${change.where}` });
    }
  }
  return out;
}

function compareEnvelopes(before: EnvelopeDef, after: EnvelopeDef): SemanticChange[] {
  const out: SemanticChange[] = fieldChanges(before, after, [
    { key: 'description', label: 'description' },
  ]);
  const beforeFields = new Map(before.fields.map((field) => [field.name, field]));
  const afterFields = new Map(after.fields.map((field) => [field.name, field]));
  for (const [name, field] of afterFields) {
    if (!beforeFields.has(name)) {
      out.push({ where: `field ${name}`, kind: 'added', after: field.type });
    }
  }
  for (const [name, field] of beforeFields) {
    if (!afterFields.has(name)) {
      out.push({ where: `field ${name}`, kind: 'removed', before: field.type });
    }
  }
  for (const [name, field] of afterFields) {
    const prev = beforeFields.get(name);
    if (!prev) continue;
    const change = changed(`field ${name}`, prev, field);
    if (change) out.push(change);
  }
  return out;
}

/**
 * The semantic before/after an edit proposal shows, derived from the stored
 * definition main captured at propose time — never from the model's account
 * of what the entity used to be. Returns [] when there is nothing to compare.
 */
export function compareEntities(
  kind: 'agent' | 'pipeline' | 'envelope',
  previous: unknown,
  next: unknown,
): SemanticChange[] {
  if (previous == null || next == null) return [];
  if (typeof previous !== 'object' || typeof next !== 'object') return [];
  if (kind === 'agent') {
    return fieldChanges(previous as AgentDef, next as AgentDef, AGENT_FIELDS);
  }
  if (kind === 'pipeline') return comparePipelines(previous as PipelineDef, next as PipelineDef);
  return compareEnvelopes(previous as EnvelopeDef, next as EnvelopeDef);
}
