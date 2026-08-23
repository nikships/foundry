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
import {
  SMITH_ARTIFACT_VERSION,
  type AgentDef,
  type ChangeReceiptCommand,
  type ChangeReceiptDef,
  type ChangeReceiptStatus,
  type ChangeReceiptTarget,
  type ChecklistDef,
  type EntityComparisonKind,
  type EnvelopeDef,
  type PipelineDef,
  type SmithArtifact,
  type SmithPresentableArtifactKind,
  type ValidationIssue,
} from '@shared/types.js';
import { defineTool, type ToolDefinition } from '../pi/tool-definition.js';
import { validate as validateAgent } from '../store/roster.js';
import { validate as validatePipeline } from '../store/pipelines.js';
import { validate as validateEnvelope } from '../store/envelopes.js';
import { changedPaths, diffStat } from '../engine/git.js';
import type { SmithEntityStores } from './entity-tools.js';
import { field, json, resolveProjectId } from './tool-helpers.js';

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
  'entity_comparison',
  'change_receipt',
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

/**
 * Field names that read as credentials. An artifact is persisted with the
 * chat and echoed to every window, so a payload smuggling one of these is
 * refused outright rather than redacted.
 */
const SECRET_KEY = /^(api[_-]?key|key|token|secret|password|credential)$/i;

export interface SmithPresentToolDeps {
  stores: SmithEntityStores;
  /** The conversation scope, read per call like every other Smith tool. */
  projectId: () => string | undefined;
  /** Hands the finished artifact to the chat session's transcript. */
  emit: (artifact: SmithArtifact) => void;
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

/** Depth-first scan for credential-shaped keys anywhere in the payload. */
export function findSecretKey(value: unknown, path = ''): string | null {
  if (value == null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findSecretKey(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const here = path ? `${path}.${key}` : key;
    if (SECRET_KEY.test(key)) return here;
    const found = findSecretKey(child, here);
    if (found) return found;
  }
  return null;
}

export function validateChecklist(spec: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (spec == null || typeof spec !== 'object' || Array.isArray(spec)) {
    return [{ level: 'error', where: 'spec', message: 'checklist must be an object' }];
  }

  const raw = spec as Record<string, unknown>;

  if (typeof raw.title !== 'string' || !raw.title.trim()) {
    issues.push({ level: 'error', where: 'title', message: 'checklist title is required' });
  } else if (raw.title.length > 200) {
    issues.push({
      level: 'warning',
      where: 'title',
      message: 'title exceeds 200 characters and may be truncated',
    });
  }

  if (raw.summary !== undefined) {
    if (typeof raw.summary !== 'string') {
      issues.push({ level: 'error', where: 'summary', message: 'summary must be a string' });
    } else if (raw.summary.length > 500) {
      issues.push({
        level: 'warning',
        where: 'summary',
        message: 'summary exceeds 500 characters',
      });
    }
  }

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
  const issues: ValidationIssue[] = [];
  if (spec == null || typeof spec !== 'object' || Array.isArray(spec)) {
    return [{ level: 'error', where: 'spec', message: 'change receipt must be an object' }];
  }

  const raw = spec as Record<string, unknown>;

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

  if (raw.title !== undefined) {
    if (typeof raw.title !== 'string') {
      issues.push({ level: 'error', where: 'title', message: 'title must be a string' });
    } else if (raw.title.length > 200) {
      issues.push({ level: 'warning', where: 'title', message: 'title exceeds 200 characters' });
    }
  }

  if (raw.summary !== undefined) {
    if (typeof raw.summary !== 'string') {
      issues.push({ level: 'error', where: 'summary', message: 'summary must be a string' });
    } else if (raw.summary.length > 500) {
      issues.push({
        level: 'warning',
        where: 'summary',
        message: 'summary exceeds 500 characters',
      });
    }
  }

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

function validateSpec(
  stores: SmithEntityStores,
  kind: SmithPresentableArtifactKind,
  spec: object,
  projectId?: string,
  comparisonKind?: EntityComparisonKind,
): ValidationIssue[] {
  if (kind === 'checklist') return validateChecklist(spec);
  if (kind === 'change_receipt') return validateChangeReceipt(spec);
  const targetKind =
    kind === 'entity_comparison'
      ? comparisonKind === 'agent'
        ? 'agent_design'
        : comparisonKind === 'pipeline'
          ? 'pipeline_design'
          : 'envelope_design'
      : kind;
  const envelopeNames = stores.envelopes.list().map((envelope) => envelope.name);
  if (targetKind === 'agent_design') return validateAgent(spec as AgentDef, envelopeNames);
  if (targetKind === 'envelope_design') return validateEnvelope(spec as EnvelopeDef);
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
  },
): SmithArtifact {
  if (kind === 'agent_design') return { ...base, kind, agent: spec as AgentDef };
  if (kind === 'envelope_design') return { ...base, kind, envelope: spec as EnvelopeDef };
  if (kind === 'checklist') return { ...base, kind, checklist: spec as ChecklistDef };
  if (kind === 'change_receipt') return { ...base, kind, receipt: spec as ChangeReceiptDef };
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
  return { ...base, kind, pipeline: spec as PipelineDef };
}

export function smithPresentTool(deps: SmithPresentToolDeps): ToolDefinition {
  return defineTool({
    name: SMITH_PRESENT_TOOL_NAME,
    label: 'Smith present',
    description:
      'Show the operator a rich inline design, checklist report, entity comparison, or change receipt card in the chat. Use it before ' +
      'proposing a non-trivial pipeline, agent, or envelope, to compare a proposed edit against the stored definition, ' +
      'to record a change/command receipt after direct checkout work, or to present a checklist/doctor/readiness/validation report: ' +
      'the card renders structured definitions and receipts far better than prose or JSON. It is ' +
      'presentation only — it saves nothing, needs no approval, and is not evidence any action ' +
      'succeeded. Do not repeat the card content in prose; add only rationale, uncertainty, or ' +
      'a recommendation.',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: [...ARTIFACT_KINDS],
          description: 'Which design, checklist, comparison, or change receipt card to show.',
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
            'The full entity JSON, checklist definition, comparison edit, or change receipt definition (target, status, filesChanged, diffstat, command, outputExcerpt).',
        },
        rationale: {
          type: 'string',
          description: 'Optional short design rationale or tradeoffs, shown on the card.',
        },
        projectId: {
          type: 'string',
          description: 'Optional project whose roster/commands the design is validated against.',
        },
      },
      required: ['kind', 'spec'],
      additionalProperties: false,
    },
    execute: (_id, params) => {
      const kind = parseArtifactKind(field(params, 'kind'));
      if (!kind) return Promise.resolve(json({ ok: false, error: 'unknown artifact kind' }));
      const spec = field(params, 'spec');
      if (spec == null || typeof spec !== 'object' || Array.isArray(spec)) {
        return Promise.resolve(json({ ok: false, error: 'present needs a spec object' }));
      }
      const scope = resolveProjectId(field(params, 'projectId'), deps.projectId());
      if (!scope.ok) return Promise.resolve(json(scope));

      const secretPath = findSecretKey(spec);
      if (secretPath) {
        return Promise.resolve(
          json({ ok: false, error: `spec must not carry a credential field (${secretPath})` }),
        );
      }

      let serialized: string;
      try {
        serialized = JSON.stringify(spec);
      } catch {
        return Promise.resolve(json({ ok: false, error: 'spec must be plain JSON data' }));
      }
      if (serialized.length > MAX_ARTIFACT_JSON) {
        return Promise.resolve(
          json({
            ok: false,
            error: `spec is too large to present (${serialized.length} > ${MAX_ARTIFACT_JSON} chars)`,
          }),
        );
      }

      let entityKind: EntityComparisonKind | undefined;
      let entityName: string | undefined;
      let beforeEntity: unknown;

      if (kind === 'entity_comparison') {
        const specRecord = spec as Record<string, unknown>;
        entityKind =
          parseEntityComparisonKind(field(params, 'entityKind')) ??
          inferEntityComparisonKind(specRecord) ??
          undefined;
        if (!entityKind) {
          return Promise.resolve(
            json({
              ok: false,
              error: 'entity_comparison requires entityKind ("agent", "pipeline", or "envelope")',
            }),
          );
        }

        const rawName = field(params, 'name');
        entityName =
          typeof rawName === 'string' && rawName.trim()
            ? rawName.trim()
            : typeof specRecord.name === 'string' && specRecord.name.trim()
              ? specRecord.name.trim()
              : typeof specRecord.id === 'string' && specRecord.id.trim()
                ? specRecord.id.trim()
                : undefined;

        if (!entityName) {
          return Promise.resolve(
            json({ ok: false, error: 'entity_comparison requires an entity name or id' }),
          );
        }

        if (entityKind === 'agent') {
          beforeEntity = deps.stores.roster.get(
            entityName,
            deps.stores.rosterScope(scope.projectId),
          );
        } else if (entityKind === 'pipeline') {
          beforeEntity = deps.stores.pipelines.get(
            entityName,
            deps.stores.pipelineScope(scope.projectId),
          );
        } else if (entityKind === 'envelope') {
          beforeEntity = deps.stores.envelopes.get(entityName);
        }

        if (beforeEntity == null) {
          return Promise.resolve(
            json({
              ok: false,
              error: `cannot compare "${entityName}": ${entityKind} does not exist in the store`,
            }),
          );
        }
      }

      // Same gate as smith_propose: errors are the model's to fix and never
      // reach the operator; warnings become part of the card.
      const issues = validateSpec(deps.stores, kind, spec, scope.projectId, entityKind);
      const errors = issues.filter((issue) => issue.level === 'error');
      if (errors.length) return Promise.resolve(json({ ok: false, validation: errors }));

      const rawRationale = field(params, 'rationale');
      const rationale =
        typeof rawRationale === 'string' && rawRationale.trim()
          ? rawRationale.slice(0, MAX_RATIONALE)
          : undefined;

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
          : undefined,
      );
      deps.emit(artifact);
      return Promise.resolve(json({ ok: true, artifactId: artifact.id }));
    },
  });
}
