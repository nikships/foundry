/**
 * `smith_present`: the agent-callable presentation tool. Smith picks a
 * registered artifact kind and supplies the typed entity data; the renderer
 * owns everything visual. The tool validates through the same store rails a
 * propose would — errors come back as data with nothing shown, warnings ride
 * onto the card — then emits the artifact straight into the chat transcript
 * and acknowledges immediately.
 *
 * Artifacts are presentation only. They never touch the one-slot proposal
 * queue, never carry an executor, and never persist a secret: the payload is
 * size-capped and scanned for credential-shaped fields before it reaches the
 * renderer or the persisted chat state.
 */

import { randomUUID } from 'node:crypto';
import type { RunDetail } from '@shared/ipc-contract.js';
import {
  SMITH_ARTIFACT_VERSION,
  type AgentDef,
  type BaseSyncStatus,
  type ChangeReceiptCommand,
  type ChangeReceiptDef,
  type ChangeReceiptStatus,
  type ChangeReceiptTarget,
  type ChecklistDef,
  type DataTableDef,
  type DiagnosticsDef,
  type DoctorCheck,
  type EntityComparisonKind,
  type EnvelopeDef,
  type EnvelopeUsageDef,
  type EvidenceDisclosureDef,
  type GhStatus,
  type PipelineDef,
  type PrCardAction,
  type PrCardDef,
  type ProjectCardDef,
  type ProjectCardDivergence,
  type ProjectCardGithub,
  type ProjectCardHealth,
  type ProjectDef,
  type ProviderStatusDef,
  type PullRequest,
  type ReadinessJourneyDef,
  type ReadinessPhase,
  type SettingsDiffDef,
  type SmithArtifact,
  type SmithPresentableArtifactKind,
  type SmithRunSummaryArtifact,
  type SmithRunSummaryPhase,
  type ValidationIssue,
} from '@shared/types.js';
import { defineTool, type ToolDefinition } from '../pi/tool-definition.js';
import { validate as validateAgent } from '../store/roster.js';
import { validate as validatePipeline } from '../store/pipelines.js';
import { validate as validateEnvelope } from '../store/envelopes.js';
import { changedPaths, diffStat } from '../engine/git.js';
import type { SmithEntityStores } from './entity-tools.js';
import { field, json, resolveProjectId, stringField, type JsonToolResult } from './tool-helpers.js';

export const SMITH_PRESENT_TOOL_NAME = 'smith_present';

/**
 * The kinds the model may present. `action_receipt` is absent by construction:
 * a receipt is evidence an action ran, minted by main from the executor result
 * on the proposal answer path, so Smith cannot fabricate one here.
 */
const ARTIFACT_KINDS = [
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
] as const satisfies readonly SmithPresentableArtifactKind[];

const ENTITY_COMPARISON_KINDS = ['agent', 'pipeline', 'envelope'] as const;

/**
 * Ceiling on the serialized entity payload. Generous for any real design —
 * the shipped pipelines are under 4k — but a hard stop before an oversized
 * card bloats IPC pushes and the persisted chat state.
 */
export const MAX_ARTIFACT_JSON = 32_000;
const MAX_RATIONALE = 2_000;
const MAX_WARNINGS = 20;

const VALID_CHECKLIST_STATUSES = new Set(['pass', 'warn', 'fail', 'info']);
const VALID_RECEIPT_TARGETS = new Set(['direct_checkout', 'isolated_worktree']);
const VALID_RECEIPT_STATUSES = new Set(['success', 'failure']);
const VALID_BASE_SYNC_STATES = new Set([
  'current',
  'behind',
  'ahead',
  'diverged',
  'no_remote',
  'error',
]);
const VALID_PR_CHECKS = new Set(['passing', 'failing', 'pending', 'none']);
const VALID_PR_MERGEABLE = new Set(['mergeable', 'conflicting', 'unknown']);
const VALID_PR_ACTIONS = new Set(['create', 'merge', 'fix_conflicts']);
const VALID_READINESS_PHASES: ReadonlySet<string> = new Set<ReadinessPhase>([
  'idle',
  'inspecting',
  'confirming',
  'evaluating',
  'not_ready',
  'remediating',
  'verifying',
  'needs_continue',
  'pr_ready',
  'awaiting_merge',
  'confirming_merge',
  'finalizing',
  'complete',
  'skipped',
  'failed',
]);
const VALID_CRITERION_STATUSES = new Set(['pass', 'fail', 'n/a']);
const VALID_WORK_KINDS = new Set(['text', 'tool', 'note', 'error']);
const VALID_PROVIDER_CONNECTIONS = new Set([
  'connected',
  'authenticating',
  'disconnected',
  'error',
]);
const MAX_JOURNEY_CRITERIA = 60;
const MAX_JOURNEY_WORK = 200;
const MAX_STATUS_PROVIDERS = 40;
const MAX_STATUS_DEVICES = 40;

/**
 * Field names that read as credentials. An artifact is persisted with the
 * chat and echoed to every window, so a payload smuggling one of these is
 * refused outright rather than redacted.
 */
const SECRET_KEY = /^(api[_-]?key|private[_-]?key|token|secret|password|credential)$/i;
const PROVIDER_FORBIDDEN_FIELD = /(key|token|secret|credential|password|pairing|qr)/i;
const PROVIDER_ALLOWED_FIELD = /^keyPresent$/;
const VALID_MARKER_SOURCES = new Set(['base-ref', 'worktree']);
const VALID_WORK_TOOL_KINDS = new Set(['command', 'read', 'edit', 'search', 'other']);
const VALID_DIAGNOSTIC_CATEGORIES = new Set([
  'doctor',
  'orphans',
  'maintenance',
  'update',
  'lifecycle',
  'general',
]);
const VALID_UPDATE_STAGES = new Set([
  'idle',
  'checking',
  'available',
  'downloading',
  'ready',
  'error',
]);
const VALID_CATALOG_KINDS = new Set([
  'runs',
  'projects',
  'agents',
  'pipelines',
  'envelopes',
  'prs',
  'doctor',
  'models',
  'custom',
]);
const VALID_EVIDENCE_ITEM_KINDS = new Set([
  'prompt',
  'command_output',
  'event_tail',
  'excerpt',
  'diff',
  'json',
  'log',
]);

export interface SmithPresentToolDeps {
  stores: SmithEntityStores;
  /** The conversation scope, read per call like every other Smith tool. */
  projectId: () => string | undefined;
  /** Hands the finished artifact to the chat session's transcript. */
  emit: (artifact: SmithArtifact) => void;
  /** Authoritative run detail lookup from trace, used to derive run_summary snapshots. */
  runLookup?: (projectId: string, runId: string) => RunDetail | null;
}

function parseArtifactKind(raw: unknown): SmithPresentableArtifactKind | null {
  return typeof raw === 'string' && (ARTIFACT_KINDS as readonly string[]).includes(raw)
    ? (raw as SmithPresentableArtifactKind)
    : null;
}

function parseEntityComparisonKind(raw: unknown): EntityComparisonKind | null {
  return typeof raw === 'string' && (ENTITY_COMPARISON_KINDS as readonly string[]).includes(raw)
    ? (raw as EntityComparisonKind)
    : null;
}

function inferEntityComparisonKind(spec: Record<string, unknown>): EntityComparisonKind | null {
  if ('phases' in spec || 'acceptance' in spec) return 'pipeline';
  if ('systemPrompt' in spec || 'writes' in spec || 'userPrompt' in spec || 'purpose' in spec)
    return 'agent';
  if ('fields' in spec) return 'envelope';
  return null;
}

function findKey(value: unknown, path: string, matches: (key: string) => boolean): string | null {
  if (value == null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findKey(value[i], `${path}[${i}]`, matches);
      if (found) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const here = path ? `${path}.${key}` : key;
    if (matches(key)) return here;
    const found = findKey(child, here, matches);
    if (found) return found;
  }
  return null;
}

/** Depth-first scan for credential-shaped keys anywhere in the payload. */
export function findSecretKey(value: unknown, path = ''): string | null {
  return findKey(value, path, (key) => SECRET_KEY.test(key));
}

/**
 * Anything credential-shaped on a provider/Companion payload, beyond the
 * `keyPresent` boolean the card is allowed to know. A masked prefix or a
 * pairing payload is as unwelcome here as the value itself: this artifact is
 * echoed to every window and persisted with the chat, while a key belongs only
 * in the approval card and a QR payload only in a renderer-local display.
 */
export function findProviderSecretField(value: unknown, path = ''): string | null {
  return findKey(
    value,
    path,
    (key) => PROVIDER_FORBIDDEN_FIELD.test(key) && !PROVIDER_ALLOWED_FIELD.test(key),
  );
}

/** A required non-empty string. Narrows so callers can keep reading. */
function requireString(
  issues: ValidationIssue[],
  value: unknown,
  where: string,
  what: string,
): value is string {
  if (typeof value !== 'string' || !value.trim()) {
    issues.push({ level: 'error', where, message: `${what} is required` });
    return false;
  }
  return true;
}

/** An optional string: a wrong type is an error, an over-long one a warning. */
function optionalString(
  issues: ValidationIssue[],
  value: unknown,
  where: string,
  max: number,
): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') {
    issues.push({ level: 'error', where, message: `${where} must be a string` });
    return;
  }
  if (value.length > max) {
    issues.push({ level: 'warning', where, message: `${where} exceeds ${max} characters` });
  }
}

function optionalBoolean(issues: ValidationIssue[], value: unknown, where: string): void {
  if (value !== undefined && typeof value !== 'boolean') {
    issues.push({ level: 'error', where, message: `${where} must be a boolean` });
  }
}

function optionalNumber(issues: ValidationIssue[], value: unknown, where: string): void {
  if (value !== undefined && typeof value !== 'number') {
    issues.push({ level: 'error', where, message: `${where} must be a number` });
  }
}

function requireEnum(
  issues: ValidationIssue[],
  value: unknown,
  where: string,
  allowed: ReadonlySet<string>,
): void {
  if (typeof value !== 'string' || !allowed.has(value)) {
    issues.push({
      level: 'error',
      where,
      message: `invalid ${where} "${String(value)}" (must be ${[...allowed].join(', ')})`,
    });
  }
}

function optionalEnum(
  issues: ValidationIssue[],
  value: unknown,
  where: string,
  allowed: ReadonlySet<string>,
): void {
  if (value === undefined) return;
  requireEnum(issues, value, where, allowed);
}

/** The value as a plain object, or null with the error already recorded. */
function objectAt(
  issues: ValidationIssue[],
  value: unknown,
  where: string,
): Record<string, unknown> | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ level: 'error', where, message: `${where} must be an object` });
    return null;
  }
  return value as Record<string, unknown>;
}

/** An optional array, capped so an oversized card never reaches the renderer. */
function arrayAt(
  issues: ValidationIssue[],
  value: unknown,
  where: string,
  max: number,
): unknown[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) {
    issues.push({ level: 'error', where, message: `${where} must be an array` });
    return null;
  }
  if (value.length > max) {
    issues.push({
      level: 'error',
      where,
      message: `${where} cannot exceed ${max} entries (${value.length} supplied)`,
    });
    return null;
  }
  return value;
}

function specObject(
  spec: unknown,
  message: string,
): { issues: ValidationIssue[]; raw: Record<string, unknown> | null } {
  if (spec == null || typeof spec !== 'object' || Array.isArray(spec)) {
    return { issues: [{ level: 'error', where: 'spec', message }], raw: null };
  }
  return { issues: [], raw: spec as Record<string, unknown> };
}

function optionalTitleAndSummary(issues: ValidationIssue[], raw: Record<string, unknown>): void {
  optionalString(issues, raw.title, 'title', 200);
  optionalString(issues, raw.summary, 'summary', 500);
}

function requiredTitle(
  issues: ValidationIssue[],
  raw: Record<string, unknown>,
  what: string,
): void {
  if (requireString(issues, raw.title, 'title', what)) {
    optionalString(issues, raw.title, 'title', 200);
  }
}

export function validateReadinessJourney(spec: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const raw = objectAt(issues, spec, 'spec');
  if (!raw) return issues;

  requireEnum(issues, raw.phase, 'phase', VALID_READINESS_PHASES);
  optionalString(issues, raw.projectId, 'projectId', 200);
  optionalString(issues, raw.projectName, 'projectName', 200);
  optionalString(issues, raw.detail, 'detail', 500);
  optionalString(issues, raw.checklistSummary, 'checklistSummary', 500);

  const marker = objectAt(issues, raw.marker, 'marker');
  if (marker) {
    if (typeof marker.valid !== 'boolean') {
      issues.push({
        level: 'error',
        where: 'marker.valid',
        message: 'marker validity is required and must be a boolean',
      });
    }
    requireString(issues, marker.detail, 'marker.detail', 'marker detail');
    optionalString(issues, marker.detail, 'marker.detail', 500);
    optionalString(issues, marker.summary, 'marker.summary', 500);
    optionalString(issues, marker.ref, 'marker.ref', 200);
    optionalString(issues, marker.commit, 'marker.commit', 200);
    optionalString(issues, marker.generatedAt, 'marker.generatedAt', 100);
    optionalEnum(issues, marker.source, 'marker.source', VALID_MARKER_SOURCES);
  }

  if (!Array.isArray(raw.criteria)) {
    issues.push({ level: 'error', where: 'criteria', message: 'criteria must be an array' });
  } else {
    const criteria = arrayAt(issues, raw.criteria, 'criteria', MAX_JOURNEY_CRITERIA);
    for (const [index, entry] of (criteria ?? []).entries()) {
      const where = `criteria[${index}]`;
      const criterion = objectAt(issues, entry, where);
      if (!criterion) continue;
      requireString(issues, criterion.id, `${where}.id`, 'criterion id');
      requireEnum(issues, criterion.status, `${where}.status`, VALID_CRITERION_STATUSES);
      optionalString(issues, criterion.notes, `${where}.notes`, 500);
    }
  }

  if (raw.stack !== undefined) {
    const stack = objectAt(issues, raw.stack, 'stack');
    if (stack) {
      optionalBoolean(issues, stack.monorepo, 'stack.monorepo');
      for (const key of ['languages', 'packages'] as const) {
        if (stack[key] === undefined) continue;
        const list = arrayAt(issues, stack[key], `stack.${key}`, 60);
        for (const [index, value] of (list ?? []).entries()) {
          if (typeof value !== 'string') {
            issues.push({
              level: 'error',
              where: `stack.${key}[${index}]`,
              message: `stack.${key} entries must be strings`,
            });
          }
        }
      }
    }
  }

  const work = arrayAt(issues, raw.work, 'work', MAX_JOURNEY_WORK);
  for (const [index, entry] of (work ?? []).entries()) {
    const where = `work[${index}]`;
    const row = objectAt(issues, entry, where);
    if (!row) continue;
    requireString(issues, row.id, `${where}.id`, 'work entry id');
    requireEnum(issues, row.kind, `${where}.kind`, VALID_WORK_KINDS);
    requireString(issues, row.text, `${where}.text`, 'work entry text');
    optionalString(issues, row.text, `${where}.text`, 2_000);
    optionalEnum(issues, row.toolKind, `${where}.toolKind`, VALID_WORK_TOOL_KINDS);
    optionalBoolean(issues, row.done, `${where}.done`);
    optionalBoolean(issues, row.failed, `${where}.failed`);
  }

  if (raw.pr !== undefined) {
    const pr = objectAt(issues, raw.pr, 'pr');
    if (pr) {
      if (typeof pr.number !== 'number') {
        issues.push({ level: 'error', where: 'pr.number', message: 'pr number must be a number' });
      }
      requireString(issues, pr.url, 'pr.url', 'pr url');
      if (typeof pr.merged !== 'boolean') {
        issues.push({
          level: 'error',
          where: 'pr.merged',
          message: 'pr merged must be a boolean',
        });
      }
      optionalString(issues, pr.mergeDetail, 'pr.mergeDetail', 500);
    }
  }

  const actions = arrayAt(issues, raw.actions, 'actions', 8);
  for (const [index, action] of (actions ?? []).entries()) {
    if (typeof action !== 'string' || !action.trim()) {
      issues.push({
        level: 'error',
        where: `actions[${index}]`,
        message: 'action label must be a non-empty string',
      });
    } else {
      optionalString(issues, action, `actions[${index}]`, 60);
    }
  }

  return issues;
}

export function validateProviderStatus(spec: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const raw = objectAt(issues, spec, 'spec');
  if (!raw) return issues;

  optionalString(issues, raw.title, 'title', 200);
  optionalString(issues, raw.summary, 'summary', 500);

  const providers = arrayAt(issues, raw.providers, 'providers', MAX_STATUS_PROVIDERS);
  for (const [index, entry] of (providers ?? []).entries()) {
    const where = `providers[${index}]`;
    const provider = objectAt(issues, entry, where);
    if (!provider) continue;
    requireString(issues, provider.id, `${where}.id`, 'provider id');
    requireString(issues, provider.label, `${where}.label`, 'provider label');
    requireEnum(issues, provider.connection, `${where}.connection`, VALID_PROVIDER_CONNECTIONS);
    if (typeof provider.authenticated !== 'boolean') {
      issues.push({
        level: 'error',
        where: `${where}.authenticated`,
        message: 'provider authenticated is required and must be a boolean',
      });
    }
    optionalBoolean(issues, provider.keyPresent, `${where}.keyPresent`);
    optionalBoolean(issues, provider.loginInFlight, `${where}.loginInFlight`);
    optionalString(issues, provider.error, `${where}.error`, 500);

    const accounts = arrayAt(issues, provider.accounts, `${where}.accounts`, 20);
    for (const [accountIndex, accountEntry] of (accounts ?? []).entries()) {
      const accountWhere = `${where}.accounts[${accountIndex}]`;
      const account = objectAt(issues, accountEntry, accountWhere);
      if (!account) continue;
      requireString(issues, account.label, `${accountWhere}.label`, 'account label');
      optionalString(issues, account.label, `${accountWhere}.label`, 200);
      optionalBoolean(issues, account.expired, `${accountWhere}.expired`);
      optionalBoolean(issues, account.disabled, `${accountWhere}.disabled`);
      optionalString(issues, account.expiresAt, `${accountWhere}.expiresAt`, 100);
    }
  }

  if (raw.bridge !== undefined) {
    const bridge = objectAt(issues, raw.bridge, 'bridge');
    if (bridge) {
      if (typeof bridge.running !== 'boolean') {
        issues.push({
          level: 'error',
          where: 'bridge.running',
          message: 'bridge running is required and must be a boolean',
        });
      }
      optionalNumber(issues, bridge.port, 'bridge.port');
      optionalString(issues, bridge.baseUrl, 'bridge.baseUrl', 500);
      optionalString(issues, bridge.reason, 'bridge.reason', 200);
      optionalString(issues, bridge.detail, 'bridge.detail', 500);
    }
  }

  if (raw.companion !== undefined) {
    const companion = objectAt(issues, raw.companion, 'companion');
    if (companion) {
      if (typeof companion.running !== 'boolean') {
        issues.push({
          level: 'error',
          where: 'companion.running',
          message: 'companion running is required and must be a boolean',
        });
      }
      optionalString(issues, companion.origin, 'companion.origin', 500);
      optionalNumber(issues, companion.protocolVersion, 'companion.protocolVersion');
      optionalString(issues, companion.detail, 'companion.detail', 500);

      const devices = arrayAt(issues, companion.devices, 'companion.devices', MAX_STATUS_DEVICES);
      for (const [index, entry] of (devices ?? []).entries()) {
        const where = `companion.devices[${index}]`;
        const device = objectAt(issues, entry, where);
        if (!device) continue;
        requireString(issues, device.deviceId, `${where}.deviceId`, 'device id');
        requireString(issues, device.name, `${where}.name`, 'device name');
        optionalString(issues, device.pairedAt, `${where}.pairedAt`, 100);
        optionalString(issues, device.lastSeenAt, `${where}.lastSeenAt`, 100);
      }
    }
  }

  const forbidden = findProviderSecretField(raw);
  if (forbidden) {
    issues.push({
      level: 'error',
      where: forbidden,
      message:
        'provider status must not carry a key, token, or pairing field — a key belongs only in ' +
        'the masked approval card and a pairing payload only in the renderer-local display',
    });
  }

  return issues;
}

export function validateChecklist(spec: unknown): ValidationIssue[] {
  const { issues, raw } = specObject(spec, 'checklist must be an object');
  if (!raw) return issues;

  if (requireString(issues, raw.title, 'title', 'checklist title')) {
    if (raw.title.length > 200) {
      issues.push({
        level: 'warning',
        where: 'title',
        message: 'title exceeds 200 characters and may be truncated',
      });
    }
  }
  optionalString(issues, raw.summary, 'summary', 500);

  if (!Array.isArray(raw.items)) {
    issues.push({ level: 'error', where: 'items', message: 'checklist items must be an array' });
  } else if (raw.items.length === 0) {
    issues.push({
      level: 'error',
      where: 'items',
      message: 'checklist must contain at least one item',
    });
  } else if (raw.items.length > 100) {
    issues.push({
      level: 'error',
      where: 'items',
      message: `checklist cannot exceed 100 items (${raw.items.length} supplied)`,
    });
  } else {
    for (let i = 0; i < raw.items.length; i += 1) {
      const item = raw.items[i];
      const where = `items[${i}]`;
      if (item == null || typeof item !== 'object' || Array.isArray(item)) {
        issues.push({ level: 'error', where, message: 'item must be an object' });
        continue;
      }

      const itemObj = item as Record<string, unknown>;

      if (typeof itemObj.label !== 'string' || !itemObj.label.trim()) {
        issues.push({
          level: 'error',
          where: `${where}.label`,
          message: 'item label is required',
        });
      } else if (itemObj.label.length > 200) {
        issues.push({
          level: 'warning',
          where: `${where}.label`,
          message: 'item label exceeds 200 characters',
        });
      }

      if (typeof itemObj.status !== 'string' || !VALID_CHECKLIST_STATUSES.has(itemObj.status)) {
        issues.push({
          level: 'error',
          where: `${where}.status`,
          message: `invalid item status "${String(itemObj.status)}" (must be pass, warn, fail, or info)`,
        });
      }

      if (itemObj.id !== undefined && typeof itemObj.id !== 'string') {
        issues.push({ level: 'error', where: `${where}.id`, message: 'id must be a string' });
      }

      if (itemObj.detail !== undefined) {
        if (typeof itemObj.detail !== 'string') {
          issues.push({
            level: 'error',
            where: `${where}.detail`,
            message: 'detail must be a string',
          });
        } else if (itemObj.detail.length > 500) {
          issues.push({
            level: 'warning',
            where: `${where}.detail`,
            message: 'item detail exceeds 500 characters',
          });
        }
      }

      if (itemObj.evidence !== undefined) {
        if (typeof itemObj.evidence !== 'string') {
          issues.push({
            level: 'error',
            where: `${where}.evidence`,
            message: 'evidence must be a string',
          });
        } else if (itemObj.evidence.length > 4000) {
          issues.push({
            level: 'warning',
            where: `${where}.evidence`,
            message: 'evidence exceeds 4000 characters',
          });
        }
      }

      if (itemObj.fix !== undefined) {
        if (typeof itemObj.fix !== 'string') {
          issues.push({
            level: 'error',
            where: `${where}.fix`,
            message: 'fix must be a string',
          });
        } else if (itemObj.fix.length > 500) {
          issues.push({
            level: 'warning',
            where: `${where}.fix`,
            message: 'fix guidance exceeds 500 characters',
          });
        }
      }
    }
  }

  return issues;
}

export function validateChangeReceipt(spec: unknown): ValidationIssue[] {
  const { issues, raw } = specObject(spec, 'change receipt must be an object');
  if (!raw) return issues;

  if (typeof raw.target !== 'string' || !VALID_RECEIPT_TARGETS.has(raw.target)) {
    issues.push({
      level: 'error',
      where: 'target',
      message: `invalid target "${String(raw.target)}" (must be direct_checkout or isolated_worktree)`,
    });
  }

  if (typeof raw.status !== 'string' || !VALID_RECEIPT_STATUSES.has(raw.status)) {
    issues.push({
      level: 'error',
      where: 'status',
      message: `invalid status "${String(raw.status)}" (must be success or failure)`,
    });
  }

  optionalTitleAndSummary(issues, raw);

  if (raw.filesChanged !== undefined) {
    if (!Array.isArray(raw.filesChanged)) {
      issues.push({
        level: 'error',
        where: 'filesChanged',
        message: 'filesChanged must be an array',
      });
    } else if (raw.filesChanged.length > 100) {
      issues.push({
        level: 'warning',
        where: 'filesChanged',
        message: 'filesChanged exceeds 100 items and may be truncated',
      });
    } else {
      for (let i = 0; i < raw.filesChanged.length; i += 1) {
        const file = raw.filesChanged[i];
        if (typeof file !== 'string' || !file.trim()) {
          issues.push({
            level: 'error',
            where: `filesChanged[${i}]`,
            message: 'changed file path must be a non-empty string',
          });
        } else if (file.length > 500) {
          issues.push({
            level: 'warning',
            where: `filesChanged[${i}]`,
            message: 'changed file path exceeds 500 characters',
          });
        }
      }
    }
  }

  if (raw.diffstat !== undefined) {
    if (typeof raw.diffstat !== 'string') {
      issues.push({ level: 'error', where: 'diffstat', message: 'diffstat must be a string' });
    } else if (raw.diffstat.length > 4000) {
      issues.push({
        level: 'warning',
        where: 'diffstat',
        message: 'diffstat exceeds 4000 characters',
      });
    }
  }

  if (raw.command !== undefined) {
    if (raw.command == null || typeof raw.command !== 'object' || Array.isArray(raw.command)) {
      issues.push({ level: 'error', where: 'command', message: 'command must be an object' });
    } else {
      const cmd = raw.command as Record<string, unknown>;
      if (typeof cmd.command !== 'string' || !cmd.command.trim()) {
        issues.push({
          level: 'error',
          where: 'command.command',
          message: 'command text is required',
        });
      }
      if (cmd.exitCode !== null && typeof cmd.exitCode !== 'number') {
        issues.push({
          level: 'error',
          where: 'command.exitCode',
          message: 'exitCode must be a number or null',
        });
      }
      if (typeof cmd.passed !== 'boolean') {
        issues.push({
          level: 'error',
          where: 'command.passed',
          message: 'command passed must be a boolean',
        });
      }
      if (cmd.durationMs !== undefined && typeof cmd.durationMs !== 'number') {
        issues.push({
          level: 'error',
          where: 'command.durationMs',
          message: 'durationMs must be a number',
        });
      }
      if (cmd.timedOut !== undefined && typeof cmd.timedOut !== 'boolean') {
        issues.push({
          level: 'error',
          where: 'command.timedOut',
          message: 'timedOut must be a boolean',
        });
      }
    }
  }

  if (raw.outputExcerpt !== undefined) {
    if (typeof raw.outputExcerpt !== 'string') {
      issues.push({
        level: 'error',
        where: 'outputExcerpt',
        message: 'outputExcerpt must be a string',
      });
    } else if (raw.outputExcerpt.length > 4000) {
      issues.push({
        level: 'warning',
        where: 'outputExcerpt',
        message: 'outputExcerpt exceeds 4000 characters',
      });
    }
  }

  return issues;
}

export function validateSettingsDiff(spec: unknown): ValidationIssue[] {
  const { issues, raw } = specObject(spec, 'settings diff must be an object');
  if (!raw) return issues;

  optionalTitleAndSummary(issues, raw);

  if (raw.scope !== undefined && typeof raw.scope !== 'string') {
    issues.push({ level: 'error', where: 'scope', message: 'scope must be a string' });
  }

  if (raw.targetProjectId !== undefined && typeof raw.targetProjectId !== 'string') {
    issues.push({
      level: 'error',
      where: 'targetProjectId',
      message: 'targetProjectId must be a string',
    });
  }

  if (!Array.isArray(raw.sections)) {
    issues.push({
      level: 'error',
      where: 'sections',
      message: 'settings diff sections must be an array',
    });
  } else if (raw.sections.length === 0) {
    issues.push({
      level: 'error',
      where: 'sections',
      message: 'settings diff must contain at least one section',
    });
  } else if (raw.sections.length > 50) {
    issues.push({
      level: 'error',
      where: 'sections',
      message: `sections cannot exceed 50 (${raw.sections.length} supplied)`,
    });
  } else {
    let totalChanges = 0;
    for (let i = 0; i < raw.sections.length; i += 1) {
      const section = raw.sections[i];
      const where = `sections[${i}]`;
      if (section == null || typeof section !== 'object' || Array.isArray(section)) {
        issues.push({ level: 'error', where, message: 'section must be an object' });
        continue;
      }
      const secObj = section as Record<string, unknown>;
      if (typeof secObj.section !== 'string' || !secObj.section.trim()) {
        issues.push({
          level: 'error',
          where: `${where}.section`,
          message: 'section identifier is required',
        });
      }
      if (secObj.label !== undefined && typeof secObj.label !== 'string') {
        issues.push({
          level: 'error',
          where: `${where}.label`,
          message: 'section label must be a string',
        });
      }
      if (!Array.isArray(secObj.changes)) {
        issues.push({
          level: 'error',
          where: `${where}.changes`,
          message: 'section changes must be an array',
        });
      } else if (secObj.changes.length === 0) {
        issues.push({
          level: 'error',
          where: `${where}.changes`,
          message: 'section must contain at least one change',
        });
      } else {
        totalChanges += secObj.changes.length;
        for (let j = 0; j < secObj.changes.length; j += 1) {
          const change = secObj.changes[j];
          const changeWhere = `${where}.changes[${j}]`;
          if (change == null || typeof change !== 'object' || Array.isArray(change)) {
            issues.push({
              level: 'error',
              where: changeWhere,
              message: 'change must be an object',
            });
            continue;
          }
          const chObj = change as Record<string, unknown>;
          if (typeof chObj.key !== 'string' || !chObj.key.trim()) {
            issues.push({
              level: 'error',
              where: `${changeWhere}.key`,
              message: 'change key is required',
            });
          }
          if (typeof chObj.label !== 'string' || !chObj.label.trim()) {
            issues.push({
              level: 'error',
              where: `${changeWhere}.label`,
              message: 'change label is required',
            });
          }
        }
      }
    }
    if (totalChanges > 100) {
      issues.push({
        level: 'warning',
        where: 'sections',
        message: `total changes exceed 100 (${totalChanges} changes)`,
      });
    }
  }

  if (raw.openSettingsTarget !== undefined) {
    if (
      raw.openSettingsTarget == null ||
      typeof raw.openSettingsTarget !== 'object' ||
      Array.isArray(raw.openSettingsTarget)
    ) {
      issues.push({
        level: 'error',
        where: 'openSettingsTarget',
        message: 'openSettingsTarget must be an object',
      });
    }
  }

  return issues;
}

function validateDoctorChecks(issues: ValidationIssue[], value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issues.push({ level: 'error', where: 'doctor', message: 'doctor checks must be an array' });
    return;
  }
  for (const [index, check] of value.entries()) {
    const where = `doctor[${index}]`;
    if (check == null || typeof check !== 'object' || Array.isArray(check)) {
      issues.push({ level: 'error', where, message: 'doctor check must be an object' });
      continue;
    }
    const checkObject = check as Record<string, unknown>;
    if (typeof checkObject.id !== 'string' || !checkObject.id.trim()) {
      issues.push({ level: 'error', where: `${where}.id`, message: 'check id is required' });
    }
    if (typeof checkObject.label !== 'string' || !checkObject.label.trim()) {
      issues.push({
        level: 'error',
        where: `${where}.label`,
        message: 'check label is required',
      });
    }
    if (typeof checkObject.ok !== 'boolean') {
      issues.push({
        level: 'error',
        where: `${where}.ok`,
        message: 'check ok must be a boolean',
      });
    }
    if (typeof checkObject.detail !== 'string') {
      issues.push({
        level: 'error',
        where: `${where}.detail`,
        message: 'check detail must be a string',
      });
    }
  }
}

function validateOrphanWorktrees(issues: ValidationIssue[], value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issues.push({ level: 'error', where: 'orphans', message: 'orphans must be an array' });
    return;
  }
  for (const [index, orphan] of value.entries()) {
    const where = `orphans[${index}]`;
    if (orphan == null || typeof orphan !== 'object' || Array.isArray(orphan)) {
      issues.push({ level: 'error', where, message: 'orphan must be an object' });
      continue;
    }
    const orphanObject = orphan as Record<string, unknown>;
    if (typeof orphanObject.path !== 'string' || !orphanObject.path.trim()) {
      issues.push({
        level: 'error',
        where: `${where}.path`,
        message: 'orphan path is required',
      });
    }
    if (typeof orphanObject.branch !== 'string' || !orphanObject.branch.trim()) {
      issues.push({
        level: 'error',
        where: `${where}.branch`,
        message: 'orphan branch is required',
      });
    }
    if (typeof orphanObject.projectId !== 'string') {
      issues.push({
        level: 'error',
        where: `${where}.projectId`,
        message: 'orphan projectId is required',
      });
    }
  }
}

export function validateDiagnostics(spec: unknown): ValidationIssue[] {
  const { issues, raw } = specObject(spec, 'diagnostics must be an object');
  if (!raw) return issues;

  optionalTitleAndSummary(issues, raw);

  if (
    raw.category !== undefined &&
    (typeof raw.category !== 'string' || !VALID_DIAGNOSTIC_CATEGORIES.has(raw.category))
  ) {
    issues.push({
      level: 'error',
      where: 'category',
      message: `invalid category "${String(raw.category)}"`,
    });
  }

  const hasContent =
    raw.doctor !== undefined ||
    raw.orphans !== undefined ||
    raw.maintenance !== undefined ||
    raw.update !== undefined ||
    raw.lifecycleWarning !== undefined ||
    raw.items !== undefined;

  if (!hasContent) {
    issues.push({
      level: 'error',
      where: 'spec',
      message:
        'diagnostics must contain at least one of: doctor, orphans, maintenance, update, lifecycleWarning, or items',
    });
  }

  validateDoctorChecks(issues, raw.doctor);
  validateOrphanWorktrees(issues, raw.orphans);

  if (raw.maintenance !== undefined) {
    if (
      raw.maintenance == null ||
      typeof raw.maintenance !== 'object' ||
      Array.isArray(raw.maintenance)
    ) {
      issues.push({
        level: 'error',
        where: 'maintenance',
        message: 'maintenance report must be an object',
      });
    } else {
      const mObj = raw.maintenance as Record<string, unknown>;
      if (typeof mObj.runsDeleted !== 'number') {
        issues.push({
          level: 'error',
          where: 'maintenance.runsDeleted',
          message: 'runsDeleted must be a number',
        });
      }
      if (typeof mObj.bytesReclaimed !== 'number') {
        issues.push({
          level: 'error',
          where: 'maintenance.bytesReclaimed',
          message: 'bytesReclaimed must be a number',
        });
      }
      if (typeof mObj.worktreesRemoved !== 'number') {
        issues.push({
          level: 'error',
          where: 'maintenance.worktreesRemoved',
          message: 'worktreesRemoved must be a number',
        });
      }
    }
  }

  if (raw.update !== undefined) {
    if (raw.update == null || typeof raw.update !== 'object' || Array.isArray(raw.update)) {
      issues.push({ level: 'error', where: 'update', message: 'update status must be an object' });
    } else {
      const uObj = raw.update as Record<string, unknown>;
      if (typeof uObj.stage !== 'string' || !VALID_UPDATE_STAGES.has(uObj.stage)) {
        issues.push({
          level: 'error',
          where: 'update.stage',
          message: `invalid update stage "${String(uObj.stage)}"`,
        });
      }
    }
  }

  optionalString(issues, raw.lifecycleWarning, 'lifecycleWarning', 2000);

  if (raw.items !== undefined) {
    if (!Array.isArray(raw.items)) {
      issues.push({ level: 'error', where: 'items', message: 'items must be an array' });
    } else {
      issues.push(
        ...validateChecklist({ title: 'Diagnostics', items: raw.items }).filter(
          (i) => i.where !== 'title',
        ),
      );
    }
  }

  return issues;
}

export function validateDataTable(spec: unknown): ValidationIssue[] {
  const { issues, raw } = specObject(spec, 'data table must be an object');
  if (!raw) return issues;

  requiredTitle(issues, raw, 'table title');
  optionalString(issues, raw.summary, 'summary', 500);

  if (
    raw.catalogKind !== undefined &&
    (typeof raw.catalogKind !== 'string' || !VALID_CATALOG_KINDS.has(raw.catalogKind))
  ) {
    issues.push({
      level: 'error',
      where: 'catalogKind',
      message: `invalid catalogKind "${String(raw.catalogKind)}"`,
    });
  }

  if (!Array.isArray(raw.columns)) {
    issues.push({ level: 'error', where: 'columns', message: 'table columns must be an array' });
  } else if (raw.columns.length === 0) {
    issues.push({
      level: 'error',
      where: 'columns',
      message: 'table must contain at least one column',
    });
  } else if (raw.columns.length > 20) {
    issues.push({
      level: 'error',
      where: 'columns',
      message: `columns cannot exceed 20 (${raw.columns.length} supplied)`,
    });
  } else {
    for (let i = 0; i < raw.columns.length; i += 1) {
      const col = raw.columns[i];
      const where = `columns[${i}]`;
      if (col == null || typeof col !== 'object' || Array.isArray(col)) {
        issues.push({ level: 'error', where, message: 'column must be an object' });
        continue;
      }
      const colObj = col as Record<string, unknown>;
      if (typeof colObj.key !== 'string' || !colObj.key.trim()) {
        issues.push({ level: 'error', where: `${where}.key`, message: 'column key is required' });
      }
      if (typeof colObj.label !== 'string' || !colObj.label.trim()) {
        issues.push({
          level: 'error',
          where: `${where}.label`,
          message: 'column label is required',
        });
      }
    }
  }

  if (!Array.isArray(raw.rows)) {
    issues.push({ level: 'error', where: 'rows', message: 'table rows must be an array' });
  } else if (raw.rows.length > 100) {
    issues.push({
      level: 'error',
      where: 'rows',
      message: `rows cannot exceed 100 (${raw.rows.length} supplied)`,
    });
  } else {
    for (let i = 0; i < raw.rows.length; i += 1) {
      const row = raw.rows[i];
      const where = `rows[${i}]`;
      if (row == null || typeof row !== 'object' || Array.isArray(row)) {
        issues.push({ level: 'error', where, message: 'row must be an object' });
        continue;
      }
      const rowObj = row as Record<string, unknown>;
      if (rowObj.id !== undefined && typeof rowObj.id !== 'string') {
        issues.push({ level: 'error', where: `${where}.id`, message: 'row id must be a string' });
      }
      if (rowObj.cells == null || typeof rowObj.cells !== 'object' || Array.isArray(rowObj.cells)) {
        issues.push({
          level: 'error',
          where: `${where}.cells`,
          message: 'row cells must be an object',
        });
      }
    }
  }

  return issues;
}

export function validateEvidenceDisclosure(spec: unknown): ValidationIssue[] {
  const { issues, raw } = specObject(spec, 'evidence disclosure must be an object');
  if (!raw) return issues;

  requiredTitle(issues, raw, 'title');
  optionalString(issues, raw.summary, 'summary', 500);

  if (raw.occupancy !== undefined) {
    if (
      raw.occupancy == null ||
      typeof raw.occupancy !== 'object' ||
      Array.isArray(raw.occupancy)
    ) {
      issues.push({ level: 'error', where: 'occupancy', message: 'occupancy must be an object' });
    } else {
      const occ = raw.occupancy as Record<string, unknown>;
      if (
        occ.percent !== undefined &&
        (typeof occ.percent !== 'number' || occ.percent < 0 || occ.percent > 100)
      ) {
        issues.push({
          level: 'error',
          where: 'occupancy.percent',
          message: 'occupancy percent must be between 0 and 100',
        });
      }
      if (occ.usedTokens !== undefined && typeof occ.usedTokens !== 'number') {
        issues.push({
          level: 'error',
          where: 'occupancy.usedTokens',
          message: 'usedTokens must be a number',
        });
      }
      if (occ.maxTokens !== undefined && typeof occ.maxTokens !== 'number') {
        issues.push({
          level: 'error',
          where: 'occupancy.maxTokens',
          message: 'maxTokens must be a number',
        });
      }
    }
  }

  if (raw.phasePrompt !== undefined) {
    if (
      raw.phasePrompt == null ||
      typeof raw.phasePrompt !== 'object' ||
      Array.isArray(raw.phasePrompt)
    ) {
      issues.push({
        level: 'error',
        where: 'phasePrompt',
        message: 'phasePrompt must be an object',
      });
    }
  }

  if (!Array.isArray(raw.items)) {
    issues.push({ level: 'error', where: 'items', message: 'evidence items must be an array' });
  } else if (
    raw.items.length === 0 &&
    raw.occupancy === undefined &&
    raw.phasePrompt === undefined
  ) {
    issues.push({
      level: 'error',
      where: 'items',
      message: 'disclosure must contain at least one evidence item, prompt, or occupancy',
    });
  } else if (raw.items.length > 50) {
    issues.push({
      level: 'error',
      where: 'items',
      message: `items cannot exceed 50 (${raw.items.length} supplied)`,
    });
  } else {
    for (let i = 0; i < raw.items.length; i += 1) {
      const item = raw.items[i];
      const where = `items[${i}]`;
      if (item == null || typeof item !== 'object' || Array.isArray(item)) {
        issues.push({ level: 'error', where, message: 'evidence item must be an object' });
        continue;
      }
      const itemObj = item as Record<string, unknown>;
      if (typeof itemObj.label !== 'string' || !itemObj.label.trim()) {
        issues.push({
          level: 'error',
          where: `${where}.label`,
          message: 'item label is required',
        });
      }
      if (typeof itemObj.kind !== 'string' || !VALID_EVIDENCE_ITEM_KINDS.has(itemObj.kind)) {
        issues.push({
          level: 'error',
          where: `${where}.kind`,
          message: `invalid evidence item kind "${String(itemObj.kind)}"`,
        });
      }
      if (typeof itemObj.content !== 'string') {
        issues.push({
          level: 'error',
          where: `${where}.content`,
          message: 'item content must be a string',
        });
      } else if (itemObj.content.length > 8000) {
        issues.push({
          level: 'warning',
          where: `${where}.content`,
          message: 'item content exceeds 8000 characters and may be truncated',
        });
      }
    }
  }

  return issues;
}

export function validateEnvelopeUsage(usage: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (usage == null || typeof usage !== 'object' || Array.isArray(usage)) {
    return [{ level: 'error', where: 'usage', message: 'usage must be an object' }];
  }
  const raw = usage as Record<string, unknown>;
  if (raw.agents !== undefined && !Array.isArray(raw.agents)) {
    issues.push({
      level: 'error',
      where: 'usage.agents',
      message: 'usage agents must be an array',
    });
  }
  if (raw.phases !== undefined && !Array.isArray(raw.phases)) {
    issues.push({
      level: 'error',
      where: 'usage.phases',
      message: 'usage phases must be an array',
    });
  }
  if (raw.pipelines !== undefined && !Array.isArray(raw.pipelines)) {
    issues.push({
      level: 'error',
      where: 'usage.pipelines',
      message: 'usage pipelines must be an array',
    });
  }
  return issues;
}

function validateEnvelopeExtras(
  issues: ValidationIssue[],
  usage: unknown,
  sampleOutput: unknown,
): void {
  if (usage !== undefined) issues.push(...validateEnvelopeUsage(usage));
  if (
    sampleOutput !== undefined &&
    (sampleOutput == null || typeof sampleOutput !== 'object' || Array.isArray(sampleOutput))
  ) {
    issues.push({
      level: 'error',
      where: 'sampleOutput',
      message: 'sampleOutput must be an object',
    });
  }
}

export async function deriveChangeReceiptFromGit(
  cwd: string,
  options: {
    target?: ChangeReceiptTarget;
    command?: ChangeReceiptCommand;
    outputExcerpt?: string;
    title?: string;
    summary?: string;
    baseRef?: string;
  } = {},
): Promise<ChangeReceiptDef> {
  const stat = await diffStat(cwd, options.baseRef || 'HEAD');
  const changed = await changedPaths(cwd);
  const status: ChangeReceiptStatus = options.command
    ? options.command.passed
      ? 'success'
      : 'failure'
    : 'success';
  return {
    title: options.title,
    target: options.target ?? 'direct_checkout',
    status,
    summary: options.summary,
    filesChanged: changed,
    diffstat: stat.trim() || undefined,
    command: options.command,
    outputExcerpt: options.outputExcerpt?.slice(0, 4000),
  };
}

function validateProjectGithub(issues: ValidationIssue[], value: unknown): void {
  if (value === undefined) return;
  const github = objectAt(issues, value, 'github');
  if (!github) return;
  if (typeof github.available !== 'boolean') {
    issues.push({
      level: 'error',
      where: 'github.available',
      message: 'github.available must be a boolean',
    });
  }
  if (github.repo !== undefined && typeof github.repo !== 'string') {
    issues.push({ level: 'error', where: 'github.repo', message: 'github.repo must be a string' });
  }
}

function validateProjectCommands(issues: ValidationIssue[], value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issues.push({ level: 'error', where: 'commands', message: 'commands must be an array' });
    return;
  }
  for (const [index, entry] of value.entries()) {
    const where = `commands[${index}]`;
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
      issues.push({ level: 'error', where, message: 'command must be an object' });
      continue;
    }
    const command = entry as Record<string, unknown>;
    requireString(issues, command.name, `${where}.name`, 'command name');
    if (!Array.isArray(command.argv) || command.argv.some((arg) => typeof arg !== 'string')) {
      issues.push({
        level: 'error',
        where: `${where}.argv`,
        message: 'command argv must be a string array',
      });
    }
  }
}

function validateProjectDivergence(issues: ValidationIssue[], value: unknown): void {
  if (value === undefined) return;
  const divergence = objectAt(issues, value, 'divergence');
  if (!divergence) return;
  if (typeof divergence.ahead !== 'number' || typeof divergence.behind !== 'number') {
    issues.push({
      level: 'error',
      where: 'divergence',
      message: 'divergence ahead and behind must be numbers',
    });
  }
  if (typeof divergence.state !== 'string' || !VALID_BASE_SYNC_STATES.has(divergence.state)) {
    issues.push({
      level: 'error',
      where: 'divergence.state',
      message: `invalid divergence state "${String(divergence.state)}"`,
    });
  }
}

function validateProjectScopes(issues: ValidationIssue[], value: unknown): void {
  if (value === undefined) return;
  const scopes = objectAt(issues, value, 'scopes');
  if (!scopes) return;
  if (typeof scopes.roster !== 'boolean' || typeof scopes.pipelines !== 'boolean') {
    issues.push({
      level: 'error',
      where: 'scopes',
      message: 'scopes roster and pipelines must be booleans',
    });
  }
}

function validateProjectHealth(issues: ValidationIssue[], value: unknown): void {
  if (value === undefined) return;
  const health = objectAt(issues, value, 'health');
  if (health && typeof health.ok !== 'boolean') {
    issues.push({ level: 'error', where: 'health.ok', message: 'health.ok must be a boolean' });
  }
}

function validateProjectStrings(issues: ValidationIssue[], raw: Record<string, unknown>): void {
  const fields = [
    ['name', raw.name, 200],
    ['title', raw.title, 200],
    ['summary', raw.summary, 500],
    ['setupScript', raw.setupScript, 8_000],
    ['contextSummary', raw.contextSummary, 4_000],
  ] as const;
  for (const [where, value, max] of fields) {
    if (value === null) {
      issues.push({ level: 'error', where, message: `${where} must be a string` });
    } else {
      optionalString(issues, value, where, max);
    }
  }
}

export function validateProjectCard(spec: unknown): ValidationIssue[] {
  const { issues, raw } = specObject(spec, 'project card must be an object');
  if (!raw) return issues;

  if (requireString(issues, raw.path, 'path', 'project path')) {
    optionalString(issues, raw.path, 'path', 500);
  }
  if (requireString(issues, raw.baseRef, 'baseRef', 'baseRef')) {
    optionalString(issues, raw.baseRef, 'baseRef', 100);
  }

  validateProjectStrings(issues, raw);
  validateProjectGithub(issues, raw.github);
  validateProjectCommands(issues, raw.commands);
  validateProjectDivergence(issues, raw.divergence);
  validateProjectScopes(issues, raw.scopes);
  validateProjectHealth(issues, raw.health);

  return issues;
}

export function validatePrCard(spec: unknown): ValidationIssue[] {
  const { issues, raw } = specObject(spec, 'PR card must be an object');
  if (!raw) return issues;

  if (typeof raw.number !== 'number' || raw.number < 1) {
    issues.push({
      level: 'error',
      where: 'number',
      message: 'PR number must be a positive number',
    });
  }

  if (typeof raw.title !== 'string' || !raw.title.trim()) {
    issues.push({ level: 'error', where: 'title', message: 'PR title is required' });
  } else if (raw.title.length > 200) {
    issues.push({ level: 'warning', where: 'title', message: 'PR title exceeds 200 characters' });
  }

  requireString(issues, raw.url, 'url', 'PR url');
  requireString(issues, raw.headRefName, 'headRefName', 'headRefName');
  if (raw.baseRefName !== undefined && typeof raw.baseRefName !== 'string') {
    issues.push({ level: 'error', where: 'baseRefName', message: 'baseRefName must be a string' });
  }
  optionalString(issues, raw.body, 'body', 8000);

  if (
    raw.checks !== undefined &&
    (typeof raw.checks !== 'string' || !VALID_PR_CHECKS.has(raw.checks))
  ) {
    issues.push({
      level: 'error',
      where: 'checks',
      message: `invalid checks "${String(raw.checks)}" (must be passing, failing, pending, or none)`,
    });
  }

  if (
    raw.mergeable !== undefined &&
    (typeof raw.mergeable !== 'string' || !VALID_PR_MERGEABLE.has(raw.mergeable))
  ) {
    issues.push({
      level: 'error',
      where: 'mergeable',
      message: `invalid mergeable "${String(raw.mergeable)}" (must be mergeable, conflicting, or unknown)`,
    });
  }

  if (raw.action !== undefined) {
    if (typeof raw.action !== 'object' || raw.action == null || Array.isArray(raw.action)) {
      issues.push({ level: 'error', where: 'action', message: 'action must be an object' });
    } else {
      const act = raw.action as Record<string, unknown>;
      if (typeof act.operation !== 'string' || !VALID_PR_ACTIONS.has(act.operation)) {
        issues.push({
          level: 'error',
          where: 'action.operation',
          message: `invalid action operation "${String(act.operation)}"`,
        });
      }
      if (
        typeof act.status !== 'string' ||
        (act.status !== 'success' && act.status !== 'failure')
      ) {
        issues.push({
          level: 'error',
          where: 'action.status',
          message: `invalid action status "${String(act.status)}"`,
        });
      }
    }
  }

  return issues;
}

export function deriveProjectCard(params: {
  project: ProjectDef;
  github?: GhStatus;
  divergence?: BaseSyncStatus;
  scopes?: { roster: boolean; pipelines: boolean };
  doctorChecks?: DoctorCheck[];
  title?: string;
  summary?: string;
}): ProjectCardDef {
  const failedChecks = params.doctorChecks?.filter((c) => !c.ok) ?? [];
  const health: ProjectCardHealth | undefined = params.doctorChecks
    ? {
        ok: failedChecks.length === 0,
        summary:
          failedChecks.length === 0
            ? 'All checks passing'
            : `${failedChecks.length} failed check${failedChecks.length === 1 ? '' : 's'}`,
        failedCount: failedChecks.length,
        totalCount: params.doctorChecks.length,
        issues: failedChecks.map((c) => c.label),
      }
    : undefined;

  const divergence: ProjectCardDivergence | undefined = params.divergence
    ? {
        ahead: params.divergence.ahead,
        behind: params.divergence.behind,
        state: params.divergence.state,
        detail: params.divergence.detail,
      }
    : undefined;

  const github: ProjectCardGithub | undefined = params.github
    ? {
        available: params.github.available,
        repo: params.github.repo,
        detail: params.github.detail,
      }
    : undefined;

  return {
    id: params.project.id,
    name: params.project.name,
    path: params.project.path,
    baseRef: params.project.baseRef,
    title: params.title,
    summary: params.summary,
    isGit: true,
    github,
    commands: params.project.commands,
    setupScript: params.project.setupScript,
    readinessValidated: params.project.readinessValidated,
    readinessSkipped: params.project.readinessSkipped,
    scaffold: params.project.scaffold,
    divergence,
    scopes: params.scopes,
    health,
    contextSummary: params.project.contextSummary?.slice(0, 4000),
  };
}

export function derivePrCard(params: {
  pr: PullRequest;
  body?: string;
  action?: PrCardAction;
}): PrCardDef {
  return {
    number: params.pr.number,
    title: params.pr.title,
    url: params.pr.url,
    headRefName: params.pr.headRefName,
    baseRefName: params.pr.baseRefName,
    body: params.body?.slice(0, 8000),
    author: params.pr.author,
    isDraft: params.pr.isDraft,
    checks: params.pr.checks,
    mergeable: params.pr.mergeable,
    reviewDecision: params.pr.reviewDecision || undefined,
    additions: params.pr.additions,
    deletions: params.pr.deletions,
    createdAt: params.pr.createdAt,
    action: params.action,
  };
}

function validateSpec(
  stores: SmithEntityStores,
  kind: SmithPresentableArtifactKind,
  spec: object,
  projectId?: string,
  comparisonKind?: EntityComparisonKind,
): ValidationIssue[] {
  if (kind === 'checklist') return validateChecklist(spec);
  if (kind === 'change_receipt') return validateChangeReceipt(spec);
  if (kind === 'project_card') return validateProjectCard(spec);
  if (kind === 'pr_card') return validatePrCard(spec);
  if (kind === 'settings_diff') return validateSettingsDiff(spec);
  if (kind === 'diagnostics') return validateDiagnostics(spec);
  if (kind === 'data_table') return validateDataTable(spec);
  if (kind === 'evidence_disclosure') return validateEvidenceDisclosure(spec);
  if (kind === 'readiness_journey') return validateReadinessJourney(spec);
  if (kind === 'provider_status') return validateProviderStatus(spec);
  const comparisonDesign = {
    agent: 'agent_design',
    pipeline: 'pipeline_design',
    envelope: 'envelope_design',
  } as const;
  const targetKind =
    kind === 'entity_comparison' ? comparisonDesign[comparisonKind ?? 'envelope'] : kind;
  const envelopeNames = stores.envelopes.list().map((envelope) => envelope.name);
  if (targetKind === 'agent_design') return validateAgent(spec as AgentDef, envelopeNames);
  if (targetKind === 'envelope_design') {
    const rawEnvelope = spec as EnvelopeDef & { usage?: unknown; sampleOutput?: unknown };
    const issues = validateEnvelope(spec as EnvelopeDef);
    validateEnvelopeExtras(issues, rawEnvelope.usage, rawEnvelope.sampleOutput);
    return issues;
  }
  return validatePipeline(
    spec as PipelineDef,
    stores.rosterFor(projectId),
    stores.commandNames(projectId),
    envelopeNames,
  );
}

function buildArtifact(
  kind: SmithPresentableArtifactKind,
  spec: object,
  // `keyof` a union is the intersection of its members' keys, so this is
  // exactly the shared artifact base — every kind's own payload is supplied
  // by the branch that builds it.
  base: Omit<SmithArtifact, 'kind'>,
  extra?: {
    entityKind?: EntityComparisonKind;
    name?: string;
    before?: unknown;
    targetProjectId?: string;
    usage?: EnvelopeUsageDef;
    sampleOutput?: Record<string, unknown>;
  },
): SmithArtifact {
  if (kind === 'agent_design') return { ...base, kind, agent: spec as AgentDef };
  if (kind === 'envelope_design') {
    const rawEnvelope = spec as EnvelopeDef & {
      usage?: EnvelopeUsageDef;
      sampleOutput?: Record<string, unknown>;
    };
    const usage = extra?.usage ?? rawEnvelope.usage;
    const sampleOutput = extra?.sampleOutput ?? rawEnvelope.sampleOutput;
    return {
      ...base,
      kind,
      envelope: spec as EnvelopeDef,
      ...(usage ? { usage } : {}),
      ...(sampleOutput ? { sampleOutput } : {}),
    };
  }
  if (kind === 'checklist') return { ...base, kind, checklist: spec as ChecklistDef };
  if (kind === 'change_receipt') return { ...base, kind, receipt: spec as ChangeReceiptDef };
  if (kind === 'project_card') return { ...base, kind, project: spec as ProjectCardDef };
  if (kind === 'pr_card') return { ...base, kind, pr: spec as PrCardDef };
  if (kind === 'settings_diff') return { ...base, kind, diff: spec as SettingsDiffDef };
  if (kind === 'diagnostics') return { ...base, kind, diagnostics: spec as DiagnosticsDef };
  if (kind === 'data_table') return { ...base, kind, table: spec as DataTableDef };
  if (kind === 'evidence_disclosure') {
    return { ...base, kind, evidence: spec as EvidenceDisclosureDef };
  }
  if (kind === 'readiness_journey') {
    return { ...base, kind, journey: spec as ReadinessJourneyDef };
  }
  if (kind === 'provider_status') return { ...base, kind, status: spec as ProviderStatusDef };
  if (kind === 'entity_comparison') {
    return {
      ...base,
      kind,
      entityKind: extra!.entityKind!,
      name: extra!.name!,
      before: extra!.before as AgentDef | PipelineDef | EnvelopeDef,
      after: spec as AgentDef | PipelineDef | EnvelopeDef,
      ...(extra?.targetProjectId ? { targetProjectId: extra.targetProjectId } : {}),
    };
  }
  return { ...base, kind: 'pipeline_design', pipeline: spec as PipelineDef };
}

function elapsedMs(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined,
): number | undefined {
  const start = startedAt ? new Date(startedAt).getTime() : 0;
  if (!(start > 0)) return undefined;
  const end = endedAt ? new Date(endedAt).getTime() : 0;
  return Math.max(0, (end > 0 ? end : Date.now()) - start);
}

function buildRunSummaryArtifact(
  detail: RunDetail,
  base: Omit<
    SmithRunSummaryArtifact,
    | 'kind'
    | 'runId'
    | 'pipelineId'
    | 'pipelineName'
    | 'request'
    | 'status'
    | 'startedAt'
    | 'endedAt'
    | 'durationMs'
    | 'totalTokens'
    | 'isolation'
    | 'worktreePath'
    | 'branch'
    | 'baseRef'
    | 'outcomeDetail'
    | 'activePhase'
    | 'failedPhase'
    | 'phases'
    | 'prNumber'
    | 'prUrl'
    | 'issueNumber'
    | 'issueUrl'
    | 'live'
  >,
): SmithRunSummaryArtifact {
  const run = detail.run!;
  const durationMs = elapsedMs(run.startedAt, run.endedAt);

  const phases: SmithRunSummaryPhase[] = detail.phases.map((p) => {
    const pDuration = elapsedMs(p.startedAt, p.endedAt);
    const env = detail.envelopes.find((e) => e.phaseId === p.phaseId);
    const envSummary = typeof env?.payload?.summary === 'string' ? env.payload.summary : null;

    return {
      phaseId: p.phaseId,
      name: p.name,
      kind: p.kind,
      status: p.status,
      owner: p.owner || undefined,
      startedAt: p.startedAt,
      endedAt: p.endedAt,
      durationMs: pDuration,
      error: p.error,
      envelopeSummary: envSummary,
    };
  });

  const activePhase = phases.find((p) => p.status === 'running')?.name ?? null;
  const failedPhase = phases.find((p) => p.status === 'fail')?.name ?? null;

  return {
    ...base,
    kind: 'run_summary',
    runId: run.runId,
    pipelineId: run.pipelineId,
    pipelineName: run.pipelineName,
    request: run.request,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs,
    totalTokens: run.totalTokens,
    isolation: run.worktreePath !== null,
    worktreePath: run.worktreePath,
    branch: run.branch,
    baseRef: run.baseRef,
    outcomeDetail: run.outcomeDetail,
    activePhase,
    failedPhase,
    phases,
    prNumber: run.prNumber,
    prUrl: run.prUrl,
    issueNumber: run.issueNumber,
    issueUrl: run.issueUrl,
    live: detail.live,
  };
}

function presentRunSummary(
  deps: SmithPresentToolDeps,
  params: unknown,
  scopeProjectId: string | undefined,
  rationale: string | undefined,
): JsonToolResult {
  const spec = field(params, 'spec');
  const runId =
    stringField(params, 'runId') ||
    (spec && typeof spec === 'object' && !Array.isArray(spec) ? stringField(spec, 'runId') : null);
  if (!runId) return json({ ok: false, error: 'run_summary needs a runId' });

  let detail: RunDetail | null = null;
  let targetProjectId = scopeProjectId;
  if (scopeProjectId && deps.runLookup) {
    detail = deps.runLookup(scopeProjectId, runId);
  } else if (deps.runLookup) {
    for (const project of deps.stores.projects.list()) {
      const candidate = deps.runLookup(project.id, runId);
      if (!candidate?.run) continue;
      detail = candidate;
      targetProjectId = project.id;
      break;
    }
  }
  if (!detail?.run) return json({ ok: false, error: `run not found: ${runId}` });

  const sessionProject = deps.projectId();
  const artifact = buildRunSummaryArtifact(detail, {
    id: randomUUID(),
    version: SMITH_ARTIFACT_VERSION,
    createdAt: Date.now(),
    ...(targetProjectId || sessionProject ? { projectId: targetProjectId ?? sessionProject } : {}),
    ...(rationale ? { rationale } : {}),
    warnings: [],
  });
  deps.emit(artifact);
  return json({ ok: true, artifactId: artifact.id });
}

type ComparisonResolution =
  | {
      ok: true;
      entityKind: EntityComparisonKind;
      entityName: string;
      beforeEntity: unknown;
    }
  | { ok: false; error: string };

function resolveComparison(
  deps: SmithPresentToolDeps,
  params: unknown,
  spec: Record<string, unknown>,
  projectId: string | undefined,
): ComparisonResolution {
  const entityKind =
    parseEntityComparisonKind(field(params, 'entityKind')) ?? inferEntityComparisonKind(spec);
  if (!entityKind) {
    return {
      ok: false,
      error: 'entity_comparison requires entityKind ("agent", "pipeline", or "envelope")',
    };
  }
  const rawName = field(params, 'name');
  const entityName = [rawName, spec.name, spec.id]
    .find((candidate): candidate is string => typeof candidate === 'string' && !!candidate.trim())
    ?.trim();
  if (!entityName) return { ok: false, error: 'entity_comparison requires an entity name or id' };

  let beforeEntity: unknown;
  if (entityKind === 'agent') {
    beforeEntity = deps.stores.roster.get(entityName, deps.stores.rosterScope(projectId));
  } else if (entityKind === 'pipeline') {
    beforeEntity = deps.stores.pipelines.get(entityName, deps.stores.pipelineScope(projectId));
  } else {
    beforeEntity = deps.stores.envelopes.get(entityName);
  }
  return beforeEntity == null
    ? {
        ok: false,
        error: `cannot compare "${entityName}": ${entityKind} does not exist in the store`,
      }
    : { ok: true, entityKind, entityName, beforeEntity };
}

export function smithPresentTool(deps: SmithPresentToolDeps): ToolDefinition {
  return defineTool({
    name: SMITH_PRESENT_TOOL_NAME,
    label: 'Smith present',
    description:
      'Show the operator a rich inline card in the chat: an entity design, a checklist report, ' +
      'a run summary, an entity comparison, a change receipt, a project card, a pull request ' +
      'card, a settings diff, a diagnostics report, a data catalog table, a context/evidence ' +
      'disclosure, the readiness journey, or provider/Companion status. ' +
      'Use it before proposing a non-trivial pipeline, agent, or envelope, to compare a proposed ' +
      'edit against the stored definition, to record a change/command receipt after direct ' +
      'checkout work, to present a checklist/doctor/readiness/validation report, for run ' +
      'summaries (run_summary) when reporting on run status, progress, or outcomes, to show ' +
      'project state/divergence/health, to present a PR preview/result, to display settings ' +
      'changes with human labels and old/new values, to present doctor/orphan/update ' +
      'diagnostics, to present bounded catalogs of entities/runs/projects, to disclose context ' +
      'occupancy and capped evidence, to show the whole readiness journey (marker, criteria, ' +
      'remediation, PR), or to report provider connection and paired Companion devices. It is ' +
      'presentation only — it saves nothing, needs no approval, and is not evidence any action ' +
      'succeeded: changing readiness still goes through the approval card. Never put an API ' +
      'key, token, masked key prefix, or Companion pairing payload in a spec. Do not repeat ' +
      'the card content in prose; add only rationale, uncertainty, or a recommendation.',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: [...ARTIFACT_KINDS],
          description:
            'Which card to show: a design, checklist, run summary, comparison, change receipt, ' +
            'project card, PR card, settings diff, diagnostics, data table, evidence ' +
            'disclosure, readiness journey, or provider/Companion status.',
        },
        entityKind: {
          type: 'string',
          enum: [...ENTITY_COMPARISON_KINDS],
          description:
            'When kind is entity_comparison, which entity kind is being compared (agent, pipeline, or envelope).',
        },
        name: {
          type: 'string',
          description:
            'When kind is entity_comparison, the name or id of the existing entity being compared.',
        },
        spec: {
          type: 'object',
          description:
            'The card payload. Entity JSON for a design or comparison edit; a checklist ' +
            'definition; a run_summary spec object; a change receipt (target, status, ' +
            'filesChanged, diffstat, command, outputExcerpt); a project card or PR card ' +
            'definition; a settings diff, diagnostics report, data table definition, or ' +
            'context/evidence disclosure definition; a readiness journey (phase, marker, ' +
            'criteria, work, pr, actions); or provider status (providers with ' +
            'connection/authenticated/keyPresent, bridge, companion with paired devices). Never ' +
            'a key, token, or pairing payload.',
        },
        usage: {
          type: 'object',
          description:
            'When kind is envelope_design, optional usage breakdown by agents, pipelines, and phases.',
        },
        sampleOutput: {
          type: 'object',
          description:
            'When kind is envelope_design, optional sample JSON output for the envelope.',
        },
        runId: {
          type: 'string',
          description: 'The run ID to summarize (for run_summary artifacts).',
        },
        rationale: {
          type: 'string',
          description: 'Optional short design rationale, context, or notes, shown on the card.',
        },
        projectId: {
          type: 'string',
          description: 'Optional project scope.',
        },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      const kind = parseArtifactKind(field(params, 'kind'));
      if (!kind) return json({ ok: false, error: 'unknown artifact kind' });

      const secretPath = findSecretKey(params);
      if (secretPath) {
        return json({ ok: false, error: `spec must not carry a credential field (${secretPath})` });
      }

      // `params` is scanned whole above, so a credential hidden in `usage` or
      // `sampleOutput` is already refused before either is read here.
      const paramUsage = field(params, 'usage');
      const paramSampleOutput = field(params, 'sampleOutput');

      const rawRationale = field(params, 'rationale');
      const rationale =
        typeof rawRationale === 'string' && rawRationale.trim()
          ? rawRationale.slice(0, MAX_RATIONALE)
          : undefined;

      const scope = resolveProjectId(field(params, 'projectId'), deps.projectId());
      if (!scope.ok) return json(scope);

      if (kind === 'run_summary') {
        return presentRunSummary(deps, params, scope.projectId, rationale);
      }

      const spec = field(params, 'spec');
      if (spec == null || typeof spec !== 'object' || Array.isArray(spec)) {
        return json({ ok: false, error: 'present needs a spec object' });
      }

      let serialized: string;
      try {
        serialized = JSON.stringify(spec);
      } catch {
        return json({ ok: false, error: 'spec must be plain JSON data' });
      }
      if (serialized.length > MAX_ARTIFACT_JSON) {
        return json({
          ok: false,
          error: `spec is too large to present (${serialized.length} > ${MAX_ARTIFACT_JSON} chars)`,
        });
      }

      let entityKind: EntityComparisonKind | undefined;
      let entityName: string | undefined;
      let beforeEntity: unknown;

      if (kind === 'entity_comparison') {
        const comparison = resolveComparison(
          deps,
          params,
          spec as Record<string, unknown>,
          scope.projectId,
        );
        if (!comparison.ok) return json(comparison);
        ({ entityKind, entityName, beforeEntity } = comparison);
      }

      // Same gate as smith_propose: errors are the model's to fix and never
      // reach the operator; warnings become part of the card.
      const issues = validateSpec(deps.stores, kind, spec, scope.projectId, entityKind);
      if (kind === 'envelope_design') {
        validateEnvelopeExtras(issues, paramUsage, paramSampleOutput);
      }

      const errors = issues.filter((issue) => issue.level === 'error');
      if (errors.length) return json({ ok: false, validation: errors });

      const sessionProject = deps.projectId();
      const targetProject = scope.projectId;
      const artifact = buildArtifact(
        kind,
        JSON.parse(serialized) as object,
        {
          id: randomUUID(),
          version: SMITH_ARTIFACT_VERSION,
          createdAt: Date.now(),
          ...(sessionProject ? { projectId: sessionProject } : {}),
          ...(rationale ? { rationale } : {}),
          warnings: issues.filter((issue) => issue.level === 'warning').slice(0, MAX_WARNINGS),
        },
        kind === 'entity_comparison'
          ? {
              entityKind,
              name: entityName,
              before: JSON.parse(JSON.stringify(beforeEntity)),
              ...(targetProject && targetProject !== sessionProject
                ? { targetProjectId: targetProject }
                : {}),
            }
          : kind === 'envelope_design'
            ? {
                usage: (paramUsage as EnvelopeUsageDef | undefined) ?? undefined,
                sampleOutput:
                  (paramSampleOutput as Record<string, unknown> | undefined) ?? undefined,
              }
            : undefined,
      );
      deps.emit(artifact);
      return json({ ok: true, artifactId: artifact.id });
    },
  });
}
