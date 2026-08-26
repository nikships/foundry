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
  ChangeReceiptDef,
  ChangeReceiptStatus,
  ChangeReceiptTarget,
  ChecklistDef,
  ChecklistItem,
  ChecklistItemStatus,
  CommandSpec,
  DataTableDef,
  DiagnosticsDef,
  EnvelopeDef,
  EvidenceDisclosureDef,
  GateSpec,
  PhaseDef,
  PipelineDef,
  PrCardDef,
  PrChecks,
  ProjectCardDef,
  ProjectCardDivergence,
  ProjectCardHealth,
  ProjectCardScopes,
  ProviderStatusConnection,
  ProviderStatusDef,
  ReadinessCriterionStatus,
  ReadinessJourneyCriterion,
  ReadinessJourneyDef,
  ReadinessPhase,
  SettingsDiffDef,
  SmithActionReceipt,
  SmithArtifact,
  SmithReceiptLink,
  TableCellStatus,
  TableCellValue,
  WriteBoundary,
} from '@shared/types.js';

/** The kinds this build renders; anything else falls back to a readable note. */
const SUPPORTED_ARTIFACT_KINDS: ReadonlyArray<SmithArtifact['kind']> = [
  'pipeline_design',
  'agent_design',
  'envelope_design',
  'checklist',
  'run_summary',
  'entity_comparison',
  'change_receipt',
  'project_card',
  'pr_card',
  'settings_diff',
  'diagnostics',
  'data_table',
  'evidence_disclosure',
  'readiness_journey',
  'provider_status',
  'action_receipt',
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
  entity_comparison: 'entity comparison',
  change_receipt: 'change receipt',
  project_card: 'project card',
  pr_card: 'pull request',
  settings_diff: 'settings diff',
  diagnostics: 'diagnostics',
  data_table: 'data catalog',
  evidence_disclosure: 'context & evidence',
  readiness_journey: 'readiness journey',
  provider_status: 'provider status',
  action_receipt: 'action receipt',
};

/** The identifying name the card's title shows. */
export function artifactName(artifact: SmithArtifact): string {
  if (artifact.kind === 'pipeline_design') return artifact.pipeline.id;
  if (artifact.kind === 'agent_design') return artifact.agent.name;
  if (artifact.kind === 'envelope_design') return artifact.envelope.name;
  if (artifact.kind === 'checklist') return artifact.checklist.title;
  if (artifact.kind === 'run_summary') {
    return artifact.pipelineName || artifact.pipelineId || artifact.runId;
  }
  if (artifact.kind === 'readiness_journey') {
    return artifact.journey.projectName ?? artifact.journey.projectId ?? 'Agent readiness';
  }
  if (artifact.kind === 'provider_status') {
    return artifact.status.title ?? 'Providers and Companion';
  }
  if (artifact.kind === 'action_receipt') return artifact.receipt.title;
  if (artifact.kind === 'change_receipt') {
    return (
      artifact.receipt.title ??
      (artifact.receipt.command
        ? artifact.receipt.command.command
        : artifact.receipt.target === 'isolated_worktree'
          ? 'Worktree changes'
          : 'Checkout changes')
    );
  }
  if (artifact.kind === 'project_card') {
    return artifact.project.name ?? artifact.project.title ?? artifact.project.path;
  }
  if (artifact.kind === 'pr_card') {
    return `#${artifact.pr.number} ${artifact.pr.title}`;
  }
  if (artifact.kind === 'settings_diff') {
    return artifact.diff.title ?? 'Settings changes';
  }
  if (artifact.kind === 'diagnostics') {
    return artifact.diagnostics.title ?? 'Diagnostics report';
  }
  if (artifact.kind === 'data_table') {
    return artifact.table.title;
  }
  if (artifact.kind === 'evidence_disclosure') {
    return artifact.evidence.title;
  }
  return artifact.name;
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

// ── Project card helpers ─────────────────────────────────────────────────────

export function projectCardHealthLabel(health?: ProjectCardHealth): string {
  if (!health) return 'Unknown health';
  if (health.ok) return 'Healthy';
  const count = health.failedCount ?? 1;
  return `${count} issue${count === 1 ? '' : 's'}`;
}

export function projectCardDivergenceLabel(divergence?: ProjectCardDivergence): string {
  if (!divergence) return 'Up to date';
  switch (divergence.state) {
    case 'current':
      return 'Up to date';
    case 'ahead':
      return `${divergence.ahead} ahead`;
    case 'behind':
      return `${divergence.behind} behind`;
    case 'diverged':
      return `${divergence.ahead} ahead, ${divergence.behind} behind`;
    case 'no_remote':
      return 'No remote';
    case 'error':
      return 'Sync error';
  }
}

export function projectCardScopesLabel(scopes?: ProjectCardScopes): string {
  if (!scopes) return 'Global defaults';
  if (scopes.roster && scopes.pipelines) return 'Custom roster & pipelines';
  if (scopes.roster) return 'Custom roster';
  if (scopes.pipelines) return 'Custom pipelines';
  return 'Global defaults';
}

export function projectCardSummary(project: ProjectCardDef): string {
  if (project.summary && project.summary.trim()) {
    return project.summary.trim();
  }
  const parts: string[] = [project.baseRef];
  if (project.commands && project.commands.length > 0) {
    parts.push(`${project.commands.length} command${project.commands.length === 1 ? '' : 's'}`);
  } else if (project.scaffold) {
    parts.push('scaffold');
  }
  if (project.health) {
    parts.push(projectCardHealthLabel(project.health));
  }
  if (project.divergence) {
    parts.push(projectCardDivergenceLabel(project.divergence));
  }
  return parts.join(' · ');
}

// ── PR card helpers ──────────────────────────────────────────────────────────

export function prChecksLabel(checks?: PrChecks): string {
  switch (checks) {
    case 'passing':
      return 'Checks passed';
    case 'failing':
      return 'Checks failed';
    case 'pending':
      return 'Checks pending';
    case 'none':
    case undefined:
      return 'No checks';
  }
}

export function prChecksGlyph(checks?: PrChecks): string {
  switch (checks) {
    case 'passing':
      return '✓';
    case 'failing':
      return '✕';
    case 'pending':
      return '◌';
    case 'none':
    case undefined:
      return '—';
  }
}

export function prMergeableLabel(mergeable?: 'mergeable' | 'conflicting' | 'unknown'): string {
  switch (mergeable) {
    case 'mergeable':
      return 'Mergeable';
    case 'conflicting':
      return 'Conflicts';
    case 'unknown':
    case undefined:
      return 'Merge status unknown';
  }
}

export function prSummary(pr: PrCardDef): string {
  const parts: string[] = [];
  parts.push(`${pr.headRefName} → ${pr.baseRefName ?? 'base'}`);
  if (pr.checks && pr.checks !== 'none') {
    parts.push(prChecksLabel(pr.checks));
  }
  if (pr.mergeable) {
    parts.push(prMergeableLabel(pr.mergeable));
  }
  return parts.join(' · ');
}

// ── Change receipt helpers ───────────────────────────────────────────────────

export function changeReceiptTargetLabel(target: ChangeReceiptTarget): string {
  return target === 'isolated_worktree' ? 'Isolated worktree' : 'Direct checkout';
}

export function changeReceiptStatusLabel(status: ChangeReceiptStatus): string {
  return status === 'success' ? 'Success' : 'Failed';
}

export function changeReceiptSummary(receipt: ChangeReceiptDef): string {
  if (receipt.summary && receipt.summary.trim()) {
    return receipt.summary.trim();
  }
  const parts: string[] = [];
  if (receipt.filesChanged && receipt.filesChanged.length > 0) {
    parts.push(
      `${receipt.filesChanged.length} ${receipt.filesChanged.length === 1 ? 'file' : 'files'} changed`,
    );
  }
  if (receipt.command) {
    const exitText =
      receipt.command.exitCode !== null ? `exit ${receipt.command.exitCode}` : 'running';
    const durText =
      receipt.command.durationMs !== undefined ? ` in ${receipt.command.durationMs}ms` : '';
    parts.push(`\`${receipt.command.command}\` (${exitText}${durText})`);
  }
  return (
    parts.join(' · ') || (receipt.status === 'success' ? 'Changes applied' : 'Operation failed')
  );
}

// ── Readiness journey helpers ────────────────────────────────────────────────

const READINESS_PHASE_LABEL: Record<ReadinessPhase, string> = {
  idle: 'Not started',
  inspecting: 'Inspecting the repository',
  confirming: 'Awaiting confirmation',
  evaluating: 'Evaluating the checklist',
  not_ready: 'Not ready',
  remediating: 'Remediating on the readiness worktree',
  verifying: 'Re-verifying the checklist',
  needs_continue: 'Paused — needs Continue',
  pr_ready: 'Pull request open',
  awaiting_merge: 'Awaiting merge',
  confirming_merge: 'Confirming the merge',
  finalizing: 'Finalizing',
  complete: 'Agent-ready',
  skipped: 'Skipped',
  failed: 'Failed',
};

export function readinessPhaseLabel(phase: ReadinessPhase): string {
  return READINESS_PHASE_LABEL[phase] ?? phase;
}

/** Phases where remediation or verification is actually moving. */
const JOURNEY_LIVE_PHASES: ReadonlySet<ReadinessPhase> = new Set<ReadinessPhase>([
  'inspecting',
  'evaluating',
  'remediating',
  'verifying',
  'confirming_merge',
  'finalizing',
]);

export function isJourneyPhaseLive(phase: ReadinessPhase): boolean {
  return JOURNEY_LIVE_PHASES.has(phase);
}

/**
 * Whether the card offers the `needs_continue` affordances. The phase decides,
 * not the action list: a spec that forgot to name them should still not imply
 * a paused onboarding has nothing left to do.
 */
export function journeyNeedsContinue(journey: ReadinessJourneyDef): boolean {
  return journey.phase === 'needs_continue';
}

const DEFAULT_NEEDS_CONTINUE_ACTIONS = ['Continue', 'Start over', 'Skip'];

export function journeyActions(journey: ReadinessJourneyDef): string[] {
  if (journey.actions && journey.actions.length > 0) return journey.actions;
  return journeyNeedsContinue(journey) ? [...DEFAULT_NEEDS_CONTINUE_ACTIONS] : [];
}

export interface GroupedJourneyCriteria {
  fail: ReadinessJourneyCriterion[];
  pass: ReadinessJourneyCriterion[];
  na: ReadinessJourneyCriterion[];
}

export function groupJourneyCriteria(
  criteria: ReadinessJourneyCriterion[],
): GroupedJourneyCriteria {
  const groups: GroupedJourneyCriteria = { fail: [], pass: [], na: [] };
  for (const criterion of criteria) {
    if (criterion.status === 'fail') groups.fail.push(criterion);
    else if (criterion.status === 'pass') groups.pass.push(criterion);
    else groups.na.push(criterion);
  }
  return groups;
}

export function criterionStatusLabel(status: ReadinessCriterionStatus): string {
  if (status === 'pass') return 'Passed';
  if (status === 'fail') return 'Failed';
  return 'Not applicable';
}

/** `lint_format` reads as "lint format" in a card, not as an identifier. */
export function criterionLabel(id: string): string {
  return id.replaceAll('_', ' ');
}

/**
 * The verdict line. The marker committed on the base ref is the only readiness
 * truth, so the criteria and even a merged PR are explanation, never the
 * answer — the summary has to say which one it is reporting.
 */
export function journeyMarkerVerdict(journey: ReadinessJourneyDef): string {
  if (journey.marker.valid) {
    return journey.marker.summary?.trim() || 'The committed marker says this repository is ready.';
  }
  return journey.marker.detail?.trim() || 'No valid marker on the base ref.';
}

export function journeySummary(journey: ReadinessJourneyDef): string {
  if (journey.detail && journey.detail.trim()) return journey.detail.trim();
  const groups = groupJourneyCriteria(journey.criteria);
  const parts: string[] = [];
  if (groups.fail.length > 0) parts.push(`${groups.fail.length} failing`);
  if (groups.pass.length > 0) parts.push(`${groups.pass.length} passing`);
  if (groups.na.length > 0) parts.push(`${groups.na.length} n/a`);
  return parts.join(' · ') || readinessPhaseLabel(journey.phase);
}

// ── Provider / Companion status helpers ──────────────────────────────────────

export function providerConnectionLabel(connection: ProviderStatusConnection): string {
  switch (connection) {
    case 'connected':
      return 'Connected';
    case 'authenticating':
      return 'Signing in';
    case 'disconnected':
      return 'Not connected';
    case 'error':
      return 'Error';
  }
}

/**
 * What the card may say about a direct API key: that one exists, or that none
 * does. Never a value and never a masked prefix — a key lives only in the
 * approval card, which is not part of the transcript.
 */
export function providerKeyLabel(keyPresent: boolean | undefined): string {
  return keyPresent ? 'API key stored' : 'No API key';
}

export function providerStatusSummary(status: ProviderStatusDef): string {
  if (status.summary && status.summary.trim()) return status.summary.trim();
  const parts: string[] = [];
  const providers = status.providers ?? [];
  if (providers.length > 0) {
    const connected = providers.filter((provider) => provider.connection === 'connected').length;
    parts.push(`${connected}/${providers.length} providers connected`);
  }
  const failing = providers.filter((provider) => provider.connection === 'error').length;
  if (failing > 0) parts.push(`${failing} in error`);
  if (status.bridge) parts.push(status.bridge.running ? 'Bridge serving' : 'Bridge stopped');
  if (status.companion) {
    const devices = status.companion.devices?.length ?? 0;
    parts.push(
      status.companion.running
        ? `Companion on (${devices} ${devices === 1 ? 'device' : 'devices'})`
        : 'Companion off',
    );
  }
  return parts.join(' · ') || 'No provider or Companion state reported';
}

/** The Bridge line: serving on its port, or the reason it is not. */
export function bridgeStatusLine(status: ProviderStatusDef): string {
  const bridge = status.bridge;
  if (!bridge) return '';
  if (bridge.running) {
    return bridge.baseUrl
      ? `Serving on ${bridge.baseUrl}`
      : bridge.port
        ? `Serving on port ${bridge.port}`
        : 'Serving';
  }
  return bridge.detail?.trim() || bridge.reason?.trim() || 'Not running';
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

// ── Settings diff helpers ───────────────────────────────────────────────────

export function settingsDiffSummary(diff: SettingsDiffDef): string {
  if (diff.summary && diff.summary.trim()) {
    return diff.summary.trim();
  }
  const totalChanges = diff.sections.reduce((acc, sec) => acc + sec.changes.length, 0);
  const sectionCount = diff.sections.length;
  return `${totalChanges} ${totalChanges === 1 ? 'change' : 'changes'} across ${sectionCount} ${
    sectionCount === 1 ? 'section' : 'sections'
  }`;
}

export function formatSettingValue(value: unknown): string {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'boolean') return value ? 'Enabled' : 'Disabled';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// ── Diagnostics helpers ─────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
  const idx = Math.min(i, sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, idx)).toFixed(1))} ${sizes[idx]}`;
}

export function diagnosticsSummary(diagnostics: DiagnosticsDef): string {
  if (diagnostics.summary && diagnostics.summary.trim()) {
    return diagnostics.summary.trim();
  }
  const parts: string[] = [];
  if (diagnostics.doctor && diagnostics.doctor.length > 0) {
    const failed = diagnostics.doctor.filter((d) => !d.ok).length;
    const passed = diagnostics.doctor.length - failed;
    if (failed > 0) parts.push(`${failed} doctor ${failed === 1 ? 'check' : 'checks'} failed`);
    else parts.push(`${passed} doctor ${passed === 1 ? 'check' : 'checks'} passed`);
  }
  if (diagnostics.orphans && diagnostics.orphans.length > 0) {
    parts.push(
      `${diagnostics.orphans.length} orphan ${diagnostics.orphans.length === 1 ? 'worktree' : 'worktrees'}`,
    );
  }
  if (diagnostics.maintenance) {
    const { runsDeleted, bytesReclaimed, worktreesRemoved } = diagnostics.maintenance;
    parts.push(`${runsDeleted} runs cleared, ${formatBytes(bytesReclaimed)} reclaimed`);
    if (worktreesRemoved > 0) {
      parts.push(
        `${worktreesRemoved} ${worktreesRemoved === 1 ? 'worktree' : 'worktrees'} removed`,
      );
    }
  }
  if (diagnostics.update) {
    parts.push(`Update: ${diagnostics.update.stage}`);
  }
  if (diagnostics.lifecycleWarning) {
    parts.push('Lifecycle warning');
  }
  if (diagnostics.items && diagnostics.items.length > 0) {
    parts.push(checklistSummary({ title: 'Diagnostics', items: diagnostics.items }));
  }
  return parts.join(' · ') || 'Diagnostics completed';
}

// ── Data table helpers ──────────────────────────────────────────────────────

export function dataTableSummary(table: DataTableDef): string {
  if (table.summary && table.summary.trim()) {
    return table.summary.trim();
  }
  const total = table.totalCount ?? table.rows.length;
  const kindLabel = table.catalogKind ? `${table.catalogKind} · ` : '';
  return `${kindLabel}${total} ${total === 1 ? 'item' : 'items'}`;
}

export function formatCellValue(value: TableCellValue): { text: string; status?: TableCellStatus } {
  if (value === undefined || value === null) return { text: '—' };
  if (typeof value === 'object' && 'variant' in value && 'label' in value) {
    return { text: value.label, status: value };
  }
  if (typeof value === 'boolean') return { text: value ? 'Yes' : 'No' };
  return { text: String(value) };
}

// ── Evidence disclosure helpers ─────────────────────────────────────────────

export function evidenceSummary(evidence: EvidenceDisclosureDef): string {
  if (evidence.summary && evidence.summary.trim()) {
    return evidence.summary.trim();
  }
  const parts: string[] = [];
  if (evidence.occupancy && evidence.occupancy.percent !== undefined) {
    parts.push(`${Math.round(evidence.occupancy.percent)}% context`);
  }
  if (evidence.phaseName) {
    parts.push(`Phase: ${evidence.phaseName}`);
  }
  if (evidence.items.length > 0) {
    parts.push(`${evidence.items.length} ${evidence.items.length === 1 ? 'item' : 'items'}`);
  }
  return parts.join(' · ') || 'Context & evidence';
}

export function occupancyStatus(
  percent: number,
  compactionThreshold = 80,
): 'ok' | 'warn' | 'critical' {
  if (percent >= 90) return 'critical';
  if (percent >= compactionThreshold) return 'warn';
  return 'ok';
}

// ── Action receipts ──────────────────────────────────────────────────────────

/**
 * How a settled action reads at a glance. Deliberately unambiguous about
 * failure: an approved action that did not work must never look like one that
 * did, so the two share no wording and no color.
 */
export interface ReceiptOutcomeView {
  label: string;
  /** A token name, so the card never hard-codes a hex value. */
  color: string;
}

export function receiptOutcomeView(receipt: SmithActionReceipt): ReceiptOutcomeView {
  return receipt.outcome === 'succeeded'
    ? { label: 'Done', color: 'var(--status-success)' }
    : { label: 'Failed', color: 'var(--status-fail)' };
}

/** The receipt's detail rows, in reading order, skipping what it does not carry. */
export function receiptRows(receipt: SmithActionReceipt): { label: string; value: string }[] {
  return [
    { label: 'Operation', value: receipt.operation },
    { label: 'Target', value: receipt.target },
    { label: 'Consequences', value: receipt.consequences },
    { label: 'Risk', value: receipt.risk },
    { label: 'Took', value: receiptDuration(receipt.durationMs) },
    ...(receipt.failure ? [{ label: 'Failure', value: receipt.failure }] : []),
  ];
}

/** Executor wall time, bounded to two units so it never reads as a stopwatch. */
export function receiptDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)
    .toString()
    .padStart(2, '0')}s`;
}

/** The link kinds this build knows how to follow. */
const RECEIPT_LINK_KINDS: ReadonlyArray<SmithReceiptLink['kind']> = ['url', 'run', 'entity'];

/**
 * Whether this build can act on a receipt's link. A persisted receipt outlives
 * the build that wrote it, so a link kind from a newer Foundry renders as inert
 * text rather than as a control that would do nothing.
 */
export function isActionableLink(link: SmithReceiptLink | undefined): link is SmithReceiptLink {
  return !!link && RECEIPT_LINK_KINDS.includes(link.kind);
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

/** How a phase names what does the work: an agent or a command. */
export function phaseWorkLabel(phase: PhaseDef): string {
  if (phase.kind === 'agent') return phase.agent ?? '';
  return commandLabel(phase.command);
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
  { key: 'optional', label: 'optional' },
  { key: 'heal', label: 'healing' },
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
