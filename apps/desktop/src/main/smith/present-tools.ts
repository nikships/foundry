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
  type EnvelopeDef,
  type PipelineDef,
  type SmithArtifact,
  type SmithArtifactKind,
  type ValidationIssue,
} from '@shared/types.js';
import { defineTool, type ToolDefinition } from '../pi/tool-definition.js';
import { validate as validateAgent } from '../store/roster.js';
import { validate as validatePipeline } from '../store/pipelines.js';
import { validate as validateEnvelope } from '../store/envelopes.js';
import type { SmithEntityStores } from './entity-tools.js';
import { field, json, resolveProjectId } from './tool-helpers.js';

export const SMITH_PRESENT_TOOL_NAME = 'smith_present';

const ARTIFACT_KINDS = ['pipeline_design', 'agent_design', 'envelope_design'] as const;

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
  return { ...base, kind, pipeline: spec as PipelineDef };
}

export function smithPresentTool(deps: SmithPresentToolDeps): ToolDefinition {
  return defineTool({
    name: SMITH_PRESENT_TOOL_NAME,
    label: 'Smith present',
    description:
      'Show the operator a rich inline design card in the chat. Use it before proposing a ' +
      'non-trivial pipeline, agent, or envelope, and whenever the operator asks for a design: ' +
      'the card renders the structured definition far better than prose or JSON. It is ' +
      'presentation only — it saves nothing, needs no approval, and is not evidence any action ' +
      'succeeded. Do not repeat the card content in prose; add only rationale, uncertainty, or ' +
      'a recommendation.',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: [...ARTIFACT_KINDS],
          description: 'Which design card to show.',
        },
        spec: {
          type: 'object',
          description:
            'The full entity JSON, exactly as the store would save it — the same shape ' +
            'smith_propose takes.',
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

      // Same gate as smith_propose: errors are the model's to fix and never
      // reach the operator; warnings become part of the card.
      const issues = validateSpec(deps.stores, kind, spec, scope.projectId);
      const errors = issues.filter((issue) => issue.level === 'error');
      if (errors.length) return Promise.resolve(json({ ok: false, validation: errors }));

      const rawRationale = field(params, 'rationale');
      const rationale =
        typeof rawRationale === 'string' && rawRationale.trim()
          ? rawRationale.slice(0, MAX_RATIONALE)
          : undefined;

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
