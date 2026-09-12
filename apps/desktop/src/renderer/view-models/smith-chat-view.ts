/**
 * Pure derivation for the Smith chat surface, kept free of React so the
 * grouping and the screen-context descriptor are testable without a DOM.
 *
 * The transcript arrives as a flat array of folded rows (`SmithTranscriptEntry`
 * is a `PanelEntry` stamped with who produced it). The screen renders it as
 * runs of same-source entries: operator turns read as chat bubbles, Smith's
 * work as inspector-style tool rows, and readiness sub-agent turns as a
 * visually distinct block — like run phases in the Inspector.
 */

import type { SmithScreenContext, SmithTranscriptEntry } from '@shared/ipc-contract.js';
import { MODEL_UNSET } from '@shared/model-choice.js';
import { modelLabel } from '@shared/model-label.js';
import type { ModelInfo } from '@shared/types.js';
import { isHiddenVendorText } from '@shared/vendor-text.js';
import type { DesignTab, View } from '../utils/navigation.js';

/** One run of consecutive same-source entries, keyed by its first entry. */
export interface SmithTranscriptGroup {
  id: string;
  source: SmithTranscriptEntry['source'];
  entries: SmithTranscriptEntry[];
}

function isHiddenSmithText(entry: SmithTranscriptEntry): boolean {
  return entry.kind === 'text' && isHiddenVendorText(entry.text);
}

export function groupTranscript(entries: SmithTranscriptEntry[]): SmithTranscriptGroup[] {
  const groups: SmithTranscriptGroup[] = [];
  for (const entry of entries) {
    if (isHiddenSmithText(entry)) continue;
    const last = groups[groups.length - 1];
    if (last && last.source === entry.source) {
      last.entries.push(entry);
    } else {
      groups.push({ id: entry.id, source: entry.source, entries: [entry] });
    }
  }
  return groups;
}

/**
 * Tool-row icons, same vocabulary as the detection and readiness panels so
 * the transcripts cannot drift apart visually.
 */
export const SMITH_TOOL_ICON: Record<string, string> = {
  command: '⚙',
  read: '◇',
  edit: '✎',
  search: '⌕',
  other: '·',
};

/**
 * Closed-face copy for the Smith header's model picker when nothing is chosen.
 *
 * Deliberately an instruction rather than a value. The old copy named a
 * fallback ("first reachable model"), which reads like a setting but is really
 * an unanswered question — the operator could not tell you which model it
 * meant, and neither could the app until a session opened. Smith now refuses
 * to run on an unchosen model, so this option is a prompt, not a choice.
 */
export const SMITH_MODEL_UNSET_LABEL = 'Select a model…';

/**
 * How the header names the model, given what the chat resolved.
 *
 * Prefers the catalog's display name, falls back to the bare id so an unknown
 * model still reads as itself rather than as a fallback.
 */
export function smithModelLabel(chosen: string | null | undefined, models: ModelInfo[]): string {
  if (!chosen || chosen === MODEL_UNSET) return SMITH_MODEL_UNSET_LABEL;
  const info = models.find((model) => model.id === chosen);
  return info?.displayName || modelLabel(chosen);
}

/** What the app shell knows about the operator's position, for `describeScreen`. */
export interface ScreenPosition {
  openRunId: string;
  inspectorRunId: string;
  designTab: DesignTab;
  settingsPane: string;
}

/**
 * The compact descriptor sent with each `smith:send`, so "why did this run
 * fail?" resolves without the user naming the run. The shell computes it from
 * whatever screen the operator was on before opening Smith — never from the
 * Smith screen itself, which would describe nothing.
 */
export function describeScreen(view: View, position: ScreenPosition): SmithScreenContext {
  switch (view) {
    case 'runs':
      return position.openRunId
        ? { route: 'run-detail', entity: { kind: 'run', id: position.openRunId } }
        : { route: view };
    case 'inspector':
      return position.inspectorRunId
        ? { route: 'inspector', entity: { kind: 'run', id: position.inspectorRunId } }
        : { route: view };
    case 'design':
      return { route: `design/${position.designTab}` };
    case 'settings':
      return { route: 'settings', entity: { kind: 'settings', id: position.settingsPane } };
    default:
      return { route: view };
  }
}

// ── Full user-level access: quick prompts, confirmations, receipts ─────────
//
// The model-facing tools for these capabilities live in main
// (`smith_runs` orchestrator_*/linear_*/start, `smith_projects`
// refresh_context, `smith_providers` gemini_live_*). This file is the
// renderer half: the exact operator phrasing that triggers each tool, the
// confirmation note shown before a privileged step runs, and the plan-id
// plumbing for the async orchestrator round-trip. Voice reuses the same
// prompts through `smith_work`, so text and voice stay one conversation.

/** Stable ids for the user-level capabilities Smith now offers. */
export type SmithCapabilityId =
  | 'assigned-work'
  | 'ticket-status'
  | 'orchestrator-plan'
  | 'orchestrator-list'
  | 'pipeline-run'
  | 'linear-pipeline-run'
  | 'refresh-context'
  | 'voice-key-state';

/** One composer chip: what the operator sees and what Smith receives. */
export interface SmithQuickPrompt {
  id: SmithCapabilityId;
  /** Short chip label. */
  label: string;
  /** Prefilled composer text; the operator confirms or edits before sending. */
  prompt: string;
  /** One-line hint for the chip title. */
  hint: string;
}

/**
 * Prefilled prompts for every named user-level capability. Prefill, never
 * auto-send: privileged actions (plans, pipeline runs, key changes) must
 * wait on the inline proposal approval, and the prefill is the operator's
 * chance to correct the prompt before Smith proposes anything.
 */
export const SMITH_QUICK_PROMPTS: ReadonlyArray<SmithQuickPrompt> = [
  {
    id: 'assigned-work',
    label: 'My tickets',
    prompt: "What's assigned to me in Linear? Show my current tickets with their status.",
    hint: 'Assigned Linear work + status',
  },
  {
    id: 'ticket-status',
    label: 'Ticket status',
    prompt: 'Check Linear ticket <id, e.g. FOU-123> and report its status.',
    hint: 'One ticket: state, team, and what it means',
  },
  {
    id: 'orchestrator-plan',
    label: 'Plan a change',
    prompt: 'Start an orchestrator plan for: <describe the change>.',
    hint: 'Draft a run plan; returns a plan ID immediately',
  },
  {
    id: 'orchestrator-list',
    label: 'My plans',
    prompt: 'List my orchestrator plans and their status.',
    hint: 'Browse planning proposals for this project',
  },
  {
    id: 'pipeline-run',
    label: 'Run pipeline',
    prompt: 'Run saved pipeline <pipeline id> with request: <what to do>.',
    hint: 'Start a saved pipeline (approval required)',
  },
  {
    id: 'linear-pipeline-run',
    label: 'Ticket → pipeline',
    prompt: 'Start saved pipeline <pipeline id> for Linear ticket <ticket id>.',
    hint: 'Run a saved pipeline against a Linear issue',
  },
  {
    id: 'refresh-context',
    label: 'Refresh context',
    prompt: "Refresh this project's context card.",
    hint: 'Rebuild the repository fact card agents receive',
  },
  {
    id: 'voice-key-state',
    label: 'Voice key',
    prompt: 'Check the Live Voice key state.',
    hint: 'Whether a Gemini key is stored for voice',
  },
];

/** "What's assigned to me", optionally narrowed to a key/title filter. */
export function smithAssignedWorkPrompt(filter?: string): string {
  const base = "What's assigned to me in Linear? Show my current tickets with their status.";
  const trimmed = filter?.trim();
  return trimmed ? `${base} Filter: ${trimmed}.` : base;
}

/** "What is the status of ticket X" with the id filled in. */
export function smithTicketStatusPrompt(issueId: string): string {
  return `Check Linear ticket ${issueId.trim()} and report its status (state, team, and what it means).`;
}

/** "Start planning X" with the goal filled in. */
export function smithOrchestratorPlanPrompt(goal: string): string {
  return `Start an orchestrator plan for: ${goal.trim()}`;
}

/** "Run saved pipeline Y" with the pipeline and request filled in. */
export function smithPipelineRunPrompt(pipelineId: string, request: string): string {
  return `Run saved pipeline ${pipelineId.trim()} with request: ${request.trim()}.`;
}

/** "Run pipeline Y for ticket X" with both ids filled in. */
export function smithLinearPipelineRunPrompt(pipelineId: string, issueId: string): string {
  return `Start saved pipeline ${pipelineId.trim()} for Linear ticket ${issueId.trim()}.`;
}

/** Follow-up about a known plan: keeps the plan id attached to the message. */
export function smithOrchestratorFollowUpPrompt(planId: string, text: string): string {
  return `For orchestrator plan ${planId.trim()}: ${text.trim()}`;
}

const PLAN_ID_PATTERN = /plan-[0-9a-f]{6,}/i;

/**
 * Pulls the orchestrator plan id out of Smith's reply text, if it names one.
 * Plan ids read `plan-<hex>`; the match is the handle for every follow-up
 * (`orchestrator_get` polls, `orchestrator_message` revises,
 * `orchestrator_accept` creates the run exactly once).
 */
export function extractOrchestratorPlanId(text: string): string | null {
  return PLAN_ID_PATTERN.exec(text)?.[0] ?? null;
}

/** Whether Smith's reply names an orchestrator plan the operator can follow up on. */
export function hasOrchestratorPlanId(text: string): boolean {
  return extractOrchestratorPlanId(text) !== null;
}

/**
 * Confirmation note for a privileged user-level operation, shown next to the
 * chip so the operator knows what approving will do. Mirrors main's risk
 * classes: plans and messages spend an agent turn, accept creates the run
 * exactly once, discard is destructive, and key values arrive only via the
 * masked approval card.
 */
export function smithConfirmationHint(operation: string): string {
  if (operation === 'orchestrator_plan')
    return 'Planning spends an agent turn. Confirm the prompt text before Smith proposes.';
  if (operation === 'orchestrator_message')
    return 'Follow-ups spend an agent turn. The revised plan arrives as progress.';
  if (operation === 'orchestrator_accept')
    return 'Accept creates the run exactly once — a repeat accept returns the same run.';
  if (operation === 'orchestrator_discard')
    return 'Discarding is destructive. Discarding an accepted plan refuses — that is final.';
  if (operation === 'orchestrator_cancel')
    return 'Cancel stops generation. The proposal row remains for review or discard.';
  if (operation === 'refresh_context')
    return 'Refresh rebuilds the repository fact card run agents receive as context.';
  if (needsMaskedSecret(operation))
    return 'The key value is entered only in the masked approval card — never typed in chat.';
  if (operation === 'start' || operation === 'linear_start')
    return 'Starting a pipeline needs approval here in the chat before anything runs.';
  return 'This action needs approval here in the chat before anything runs.';
}

/** True when the operation's secret arrives only via the masked approval card. */
export function needsMaskedSecret(operation: string): boolean {
  return operation === 'set_api_key' || operation.endsWith('_set_api_key');
}
