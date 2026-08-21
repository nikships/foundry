/**
 * Smith's entity tools: the in-process successors to the socket protocol ops.
 *
 * `smith_list`/`smith_show` answer immediately from the stores, scope-aware.
 * `smith_propose` validates through the store's own `validate()` FIRST — an
 * invalid spec comes straight back as JSON with no card raised — and only a
 * valid spec is enqueued on the one-slot proposal queue, which blocks the tool
 * call until a human answers the inline card. The model naturally waits on the
 * verdict and reads the result.
 *
 * Projects stay read-only and projected: `smith_list` answers `{id, name,
 * path}` only, and every other project op errors. Rejection carries no note —
 * the operator's next chat message is the revision guidance.
 *
 * These are factories with explicit deps so the chat session that registers
 * them owns the wiring; nothing here reaches for `AppContext` or a store
 * import. Tool typing crosses the pi seam through `pi/tool-definition.ts`.
 */

import type { AgentDef, EnvelopeDef, PipelineDef, ValidationIssue } from '@shared/types.js';
import type { Scope } from '../context.js';
import { defineTool, type ToolDefinition } from '../pi/tool-definition.js';
import { validate as validateAgent } from '../store/roster.js';
import { validate as validatePipeline } from '../store/pipelines.js';
import { validate as validateEnvelope } from '../store/envelopes.js';
import type { ProposalQueue } from './proposals.js';

export const SMITH_TOOL_NAMES = ['smith_list', 'smith_show', 'smith_propose'] as const;

/** The entity kinds the tools read. Only the first three are ever written. */
type EntityKind = 'agent' | 'pipeline' | 'envelope' | 'project';

/** The entity kinds Smith may write. `project` is deliberately not among them. */
type WritableKind = 'agent' | 'pipeline' | 'envelope';

/** The only shape of a project the tools ever answer with. */
export interface SmithToolProject {
  id: string;
  name: string;
  path: string;
}

/**
 * What the tools read. A structural slice rather than `AppContext`, so the
 * session wires real stores and a test wires a plain object.
 */
export interface SmithEntityStores {
  roster: { get(name: string, scope: Scope): AgentDef | null };
  pipelines: { get(id: string, scope: Scope): PipelineDef | null };
  envelopes: { list(): EnvelopeDef[]; get(name: string): EnvelopeDef | null };
  projects: { list(): { id: string; name: string; path: string }[] };
  rosterScope(projectId?: string): Scope;
  pipelineScope(projectId?: string): Scope;
  rosterFor(projectId?: string): AgentDef[];
  pipelinesFor(projectId?: string): PipelineDef[];
  commandNames(projectId?: string): string[];
}

/** Everything a factory closes over. The session owns all three. */
export interface SmithEntityToolDeps {
  stores: SmithEntityStores;
  queue: ProposalQueue;
  /**
   * The project the session is scoped to, read per call rather than captured:
   * the chat session outlives any one screen, and absent means global scope.
   */
  projectId: () => string | undefined;
}

/** A tool answer is content plus details; these tools answer JSON text. */
function json(value: unknown): {
  content: [{ type: 'text'; text: string }];
  details: undefined;
} {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], details: undefined };
}

function field(params: unknown, name: string): unknown {
  return params && typeof params === 'object'
    ? (params as Record<string, unknown>)[name]
    : undefined;
}

const KIND_VALUES: readonly EntityKind[] = ['agent', 'pipeline', 'envelope', 'project'];
const WRITABLE_KIND_VALUES: readonly WritableKind[] = ['agent', 'pipeline', 'envelope'];

function parseKind(raw: unknown): EntityKind | null {
  return typeof raw === 'string' && (KIND_VALUES as readonly string[]).includes(raw)
    ? (raw as EntityKind)
    : null;
}

function parseWritableKind(raw: unknown): WritableKind | null {
  return typeof raw === 'string' && (WRITABLE_KIND_VALUES as readonly string[]).includes(raw)
    ? (raw as WritableKind)
    : null;
}

export function smithListTool(deps: SmithEntityToolDeps): ToolDefinition {
  return defineTool({
    name: 'smith_list',
    label: 'Smith list',
    description:
      'List Foundry entities of one kind as JSON. Agents and pipelines resolve against the current project scope. Projects answer id, name, and path only — nothing else about a project is readable.',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: [...KIND_VALUES],
          description: 'Which entity kind to list.',
        },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    execute: (_id, params) => {
      const kind = parseKind(field(params, 'kind'));
      if (!kind) return Promise.resolve(json({ ok: false, error: 'unknown kind' }));
      const projectId = deps.projectId();
      return Promise.resolve(
        json({ ok: true, kind, entities: listEntities(deps.stores, kind, projectId) }),
      );
    },
  });
}

export function smithShowTool(deps: SmithEntityToolDeps): ToolDefinition {
  return defineTool({
    name: 'smith_show',
    label: 'Smith show',
    description:
      'Show one Foundry entity by name (agents, envelopes) or id (pipelines) as JSON. Projects are list-only and cannot be shown.',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: [...KIND_VALUES],
          description: 'Which entity kind the name belongs to.',
        },
        name: {
          type: 'string',
          description: 'The entity name (agents, envelopes) or id (pipelines).',
        },
      },
      required: ['kind', 'name'],
      additionalProperties: false,
    },
    execute: (_id, params) => {
      const kind = parseKind(field(params, 'kind'));
      if (!kind) return Promise.resolve(json({ ok: false, error: 'unknown kind' }));
      // Projects are discoverable but never inspectable: `list` already hands
      // out everything Smith may know about one.
      if (kind === 'project') {
        return Promise.resolve(
          json({ ok: false, error: 'projects are read-only: "show" is not allowed' }),
        );
      }
      const rawName = field(params, 'name');
      const name = typeof rawName === 'string' ? rawName : '';
      if (!name) return Promise.resolve(json({ ok: false, error: 'show needs a name' }));
      const entity = showEntity(deps.stores, kind, name, deps.projectId());
      if (!entity) {
        return Promise.resolve(json({ ok: false, error: `no ${kind} named "${name}"` }));
      }
      return Promise.resolve(json({ ok: true, kind, entity }));
    },
  });
}

export function smithProposeTool(deps: SmithEntityToolDeps): ToolDefinition {
  return defineTool({
    name: 'smith_propose',
    label: 'Smith propose',
    description:
      'Propose creating or editing a Foundry entity (agent, pipeline, or envelope). The spec validates first — errors return as JSON with no approval raised. A valid spec blocks until the operator approves or rejects it inline; one proposal may be pending at a time. Projects cannot be written.',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: [...WRITABLE_KIND_VALUES],
          description: 'Which entity kind the spec is. Projects are not writable.',
        },
        mode: {
          type: 'string',
          enum: ['create', 'edit'],
          description: 'Whether this is a new entity or a revision of an existing one.',
        },
        spec: {
          type: 'object',
          description: 'The full entity JSON, exactly as the store would save it.',
        },
      },
      required: ['kind', 'mode', 'spec'],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      // The schema already refuses `project`, but the parse here is the second
      // gate, mirroring the socket server where neither side was the only one.
      const kind = parseWritableKind(field(params, 'kind'));
      if (!kind) {
        return json({ ok: false, error: 'projects are read-only: writes are not allowed' });
      }
      const rawMode = field(params, 'mode');
      const mode = rawMode === 'create' || rawMode === 'edit' ? rawMode : null;
      if (!mode) return json({ ok: false, error: 'mode must be "create" or "edit"' });
      const spec = field(params, 'spec');
      if (spec == null || typeof spec !== 'object') {
        return json({ ok: false, error: 'propose needs a spec object' });
      }

      const projectId = deps.projectId();
      const { name, issues, overwrites } = prepare(deps.stores, kind, spec, projectId);
      if (!name) return json({ ok: false, error: `${kind} spec is missing its name` });

      // Validation is the gate before any card. Warnings pass through onto the
      // card; only errors refuse here, matching the store's own save contract.
      const errors = issues.filter((i) => i.level === 'error');
      if (errors.length) return json({ ok: false, validation: errors });

      const warnings = issues.filter((i) => i.level === 'warning');
      let outcome;
      try {
        outcome = await deps.queue.propose({
          kind,
          mode,
          name,
          spec,
          validation: warnings,
          overwrites,
          projectId: projectId ?? '',
        });
      } catch (e) {
        // The one race the model is told to expect: another proposal is pending.
        return json({ ok: false, error: (e as Error).message });
      }

      if (outcome.approved) return json({ ok: true, entity: outcome.entity });
      return json({ ok: false, rejected: true, note: outcome.note });
    },
  });
}

function listEntities(stores: SmithEntityStores, kind: EntityKind, projectId?: string): unknown[] {
  if (kind === 'agent') return stores.rosterFor(projectId);
  if (kind === 'pipeline') return stores.pipelinesFor(projectId);
  if (kind === 'project') {
    // Projected down to the three fields Smith may know about a project.
    return stores.projects.list().map((p): SmithToolProject => ({
      id: p.id,
      name: p.name,
      path: p.path,
    }));
  }
  return stores.envelopes.list();
}

function showEntity(
  stores: SmithEntityStores,
  kind: WritableKind,
  name: string,
  projectId?: string,
): unknown {
  if (kind === 'agent') return stores.roster.get(name, stores.rosterScope(projectId));
  if (kind === 'pipeline') return stores.pipelines.get(name, stores.pipelineScope(projectId));
  return stores.envelopes.get(name);
}

/**
 * Resolves the spec's identifying name, validates it, and decides whether an
 * approve would overwrite an existing entity (stores upsert by name/id).
 */
function prepare(
  stores: SmithEntityStores,
  kind: WritableKind,
  spec: object,
  projectId?: string,
): { name: string; issues: ValidationIssue[]; overwrites: boolean } {
  if (kind === 'agent') {
    const agent = spec as AgentDef;
    const known = stores.envelopes.list().map((e) => e.name);
    return {
      name: agent.name ?? '',
      issues: validateAgent(agent, known),
      overwrites: !!stores.roster.get(agent.name, stores.rosterScope(projectId)),
    };
  }
  if (kind === 'pipeline') {
    const pipeline = spec as PipelineDef;
    const agents = stores.rosterFor(projectId);
    const commandNames = stores.commandNames(projectId);
    const known = stores.envelopes.list().map((e) => e.name);
    return {
      name: pipeline.id ?? '',
      issues: validatePipeline(pipeline, agents, commandNames, known),
      overwrites: !!stores.pipelines.get(pipeline.id, stores.pipelineScope(projectId)),
    };
  }
  const envelope = spec as EnvelopeDef;
  return {
    name: envelope.name ?? '',
    issues: validateEnvelope(envelope),
    overwrites: !!stores.envelopes.get(envelope.name),
  };
}
