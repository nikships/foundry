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
  type EnvelopeDef,
  type PipelineDef,
  type SmithArtifact,
  type SmithArtifactKind,
  type SmithRunSummaryArtifact,
  type SmithRunSummaryPhase,
  type ValidationIssue,
} from '@shared/types.js';
import { defineTool, type ToolDefinition } from '../pi/tool-definition.js';
import { validate as validateAgent } from '../store/roster.js';
import { validate as validatePipeline } from '../store/pipelines.js';
import { validate as validateEnvelope } from '../store/envelopes.js';
import type { SmithEntityStores } from './entity-tools.js';
import { field, json, resolveProjectId, stringField } from './tool-helpers.js';

export const SMITH_PRESENT_TOOL_NAME = 'smith_present';

const ARTIFACT_KINDS = [
  'pipeline_design',
  'agent_design',
  'envelope_design',
  'run_summary',
] as const;

/**
 * Ceiling on the serialized entity payload. Generous for any real design —
 * the shipped pipelines are under 4k — but a hard stop before an oversized
 * card bloats IPC pushes and the persisted chat state.
 */
export const MAX_ARTIFACT_JSON = 32_000;
const MAX_RATIONALE = 2_000;
const MAX_WARNINGS = 20;

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
  /** Authoritative run detail lookup from trace, used to derive run_summary snapshots. */
  runLookup?: (projectId: string, runId: string) => RunDetail | null;
}

function parseArtifactKind(raw: unknown): SmithArtifactKind | null {
  return typeof raw === 'string' && (ARTIFACT_KINDS as readonly string[]).includes(raw)
    ? (raw as SmithArtifactKind)
    : null;
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

function validateSpec(
  stores: SmithEntityStores,
  kind: SmithArtifactKind,
  spec: object,
  projectId?: string,
): ValidationIssue[] {
  const envelopeNames = stores.envelopes.list().map((envelope) => envelope.name);
  if (kind === 'agent_design') return validateAgent(spec as AgentDef, envelopeNames);
  if (kind === 'envelope_design') return validateEnvelope(spec as EnvelopeDef);
  return validatePipeline(
    spec as PipelineDef,
    stores.rosterFor(projectId),
    stores.commandNames(projectId),
    envelopeNames,
  );
}

function buildArtifact(
  kind: SmithArtifactKind,
  spec: object,
  base: Omit<SmithArtifact, 'kind' | 'pipeline' | 'agent' | 'envelope'>,
): SmithArtifact {
  if (kind === 'agent_design') return { ...base, kind, agent: spec as AgentDef };
  if (kind === 'envelope_design') return { ...base, kind, envelope: spec as EnvelopeDef };
  return { ...base, kind: 'pipeline_design', pipeline: spec as PipelineDef };
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
  const startedTime = run.startedAt ? new Date(run.startedAt).getTime() : 0;
  const endedTime = run.endedAt ? new Date(run.endedAt).getTime() : 0;
  const durationMs =
    startedTime > 0 && endedTime > 0
      ? Math.max(0, endedTime - startedTime)
      : startedTime > 0
        ? Math.max(0, Date.now() - startedTime)
        : undefined;

  const phases: SmithRunSummaryPhase[] = detail.phases.map((p) => {
    const pStart = p.startedAt ? new Date(p.startedAt).getTime() : 0;
    const pEnd = p.endedAt ? new Date(p.endedAt).getTime() : 0;
    const pDuration =
      pStart > 0 && pEnd > 0
        ? Math.max(0, pEnd - pStart)
        : pStart > 0
          ? Math.max(0, Date.now() - pStart)
          : undefined;
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

export function smithPresentTool(deps: SmithPresentToolDeps): ToolDefinition {
  return defineTool({
    name: SMITH_PRESENT_TOOL_NAME,
    label: 'Smith present',
    description:
      'Show the operator a rich inline card in the chat. Use it for designs (pipeline, agent, ' +
      'envelope) before proposing changes, and for run summaries (run_summary) when reporting ' +
      'on run status, progress, or outcomes. It is presentation only — it saves nothing, needs ' +
      'no approval, and is not evidence any action succeeded. Do not repeat the card content ' +
      'in prose; add only rationale, uncertainty, or a recommendation.',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: [...ARTIFACT_KINDS],
          description:
            'Which card to show: pipeline_design, agent_design, envelope_design, or run_summary.',
        },
        spec: {
          type: 'object',
          description:
            'The full entity JSON for design cards (pipeline, agent, envelope), or an object containing runId for run_summary.',
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
    execute: (_id, params) => {
      const kind = parseArtifactKind(field(params, 'kind'));
      if (!kind) return Promise.resolve(json({ ok: false, error: 'unknown artifact kind' }));

      const secretPath = findSecretKey(params);
      if (secretPath) {
        return Promise.resolve(
          json({ ok: false, error: `spec must not carry a credential field (${secretPath})` }),
        );
      }

      const rawRationale = field(params, 'rationale');
      const rationale =
        typeof rawRationale === 'string' && rawRationale.trim()
          ? rawRationale.slice(0, MAX_RATIONALE)
          : undefined;

      const scope = resolveProjectId(field(params, 'projectId'), deps.projectId());
      if (!scope.ok) return Promise.resolve(json(scope));

      if (kind === 'run_summary') {
        const spec = field(params, 'spec');
        const runId =
          stringField(params, 'runId') ||
          (spec && typeof spec === 'object' && !Array.isArray(spec)
            ? stringField(spec, 'runId')
            : null);
        if (!runId) return Promise.resolve(json({ ok: false, error: 'run_summary needs a runId' }));

        let detail: RunDetail | null = null;
        let targetProjectId = scope.projectId;

        if (scope.projectId && deps.runLookup) {
          detail = deps.runLookup(scope.projectId, runId);
        } else if (!scope.projectId && deps.runLookup) {
          for (const project of deps.stores.projects.list()) {
            const d = deps.runLookup(project.id, runId);
            if (d && d.run) {
              detail = d;
              targetProjectId = project.id;
              break;
            }
          }
        }

        if (!detail || !detail.run) {
          return Promise.resolve(json({ ok: false, error: `run not found: ${runId}` }));
        }

        const sessionProject = deps.projectId();
        const artifact = buildRunSummaryArtifact(detail, {
          id: randomUUID(),
          version: SMITH_ARTIFACT_VERSION,
          createdAt: Date.now(),
          ...(targetProjectId || sessionProject
            ? { projectId: targetProjectId ?? sessionProject }
            : {}),
          ...(rationale ? { rationale } : {}),
          warnings: [],
        });
        deps.emit(artifact);
        return Promise.resolve(json({ ok: true, artifactId: artifact.id }));
      }

      const spec = field(params, 'spec');
      if (spec == null || typeof spec !== 'object' || Array.isArray(spec)) {
        return Promise.resolve(json({ ok: false, error: 'present needs a spec object' }));
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

      // Same gate as smith_propose: errors are the model's to fix and never
      // reach the operator; warnings become part of the card.
      const issues = validateSpec(deps.stores, kind, spec, scope.projectId);
      const errors = issues.filter((issue) => issue.level === 'error');
      if (errors.length) return Promise.resolve(json({ ok: false, validation: errors }));

      const sessionProject = deps.projectId();
      const artifact = buildArtifact(kind, JSON.parse(serialized) as object, {
        id: randomUUID(),
        version: SMITH_ARTIFACT_VERSION,
        createdAt: Date.now(),
        ...(sessionProject ? { projectId: sessionProject } : {}),
        ...(rationale ? { rationale } : {}),
        warnings: issues.filter((issue) => issue.level === 'warning').slice(0, MAX_WARNINGS),
      });
      deps.emit(artifact);
      return Promise.resolve(json({ ok: true, artifactId: artifact.id }));
    },
  });
}
