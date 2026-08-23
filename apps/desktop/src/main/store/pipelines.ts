/**
 * Pipelines are data. This store owns the documents and the validation rail the
 * Designer draws from: the rules that used to fire at construction time inside
 * a Python script now fire at edit time, where a human can still fix them.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  BUILTIN_ENVELOPE_KINDS,
  effectivePhaseEnvelope,
  type AgentDef,
  type PhaseDef,
  type PipelineDef,
  type ValidationIssue,
} from '@shared/types.js';
import { JsonStore } from './json-store.js';
import { BUILTIN_PIPELINES } from './builtin-pipelines.js';
import { uniqueCopyName, upsertBy } from './collections.js';
import { GATES } from '../engine/gates.js';

const commandSchema = z.union([
  z.object({ ref: z.string().min(1) }),
  z.object({
    builtin: z.enum(['git_commit', 'git_status', 'noop']),
    messageFrom: z.string().optional(),
  }),
  z.object({ argv: z.array(z.string().min(1)).min(1) }),
]);

const phaseSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, 'lowercase snake_case phase name'),
  kind: z.enum(['agent', 'code', 'engineer']),
  description: z.string().min(1, 'one sentence on what this phase does and why'),
  agent: z.string().optional(),
  // Opaque provider/model id. Absence means inherit the selected agent's model.
  model: z.string().min(1).optional(),
  // Built-in kind or a custom envelope library name.
  envelope: z.string().min(1).optional(),
  gates: z
    .array(
      z.union([
        z.string(),
        z.object({ gate: z.string(), config: z.record(z.string(), z.unknown()).optional() }),
      ]),
    )
    .optional(),
  prompt: z.object({ inputs: z.array(z.string()) }).optional(),
  command: commandSchema.optional(),
  retries: z.number().int().min(0).max(5).optional(),
  feedbackTo: z.string().optional(),
  feedbackRetries: z.number().int().min(0).max(5).optional(),
  question: z.string().optional(),
  optional: z.boolean().optional(),
});

const canvasPointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

const canvasSchema = z.object({
  nodes: z.record(z.string(), canvasPointSchema).optional(),
  viewport: canvasPointSchema.extend({ zoom: z.number().finite().min(0.2).max(2.5) }).optional(),
});

export const pipelineSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'lowercase kebab-case id'),
  name: z.string().min(1),
  description: z.string().min(1),
  acceptance: z.union([
    z.object({
      kind: z.literal('phase_flag'),
      phase: z.string(),
      flag: z.enum(['passed', 'approved']),
    }),
    z.object({ kind: z.literal('all_phases_pass') }),
    z.object({ kind: z.literal('last_phase_pass') }),
    z.object({ kind: z.literal('envelope_status'), phase: z.string() }),
  ]),
  phases: z.array(phaseSchema).min(1, 'a pipeline needs at least one phase'),
  isolation: z.boolean().optional(),
  builtin: z.boolean().optional(),
  canvas: canvasSchema.optional(),
});

/**
 * Phase-level tool knobs that were declared but never consumed. A stored
 * pipeline may still carry them; `staleBuiltins` compares stored against
 * shipped structurally, so leaving them on a builtin would report it as edited
 * forever.
 */
const REMOVED_PHASE_FIELDS = ['toolProfile', 'tools', 'timeoutMs'] as const;

function normalizePipeline(pipeline: PipelineDef): PipelineDef {
  if (!pipeline.phases?.some(hasRemovedField)) return pipeline;
  return { ...pipeline, phases: pipeline.phases.map(stripRemovedFields) };
}

function hasRemovedField(phase: PhaseDef): boolean {
  return REMOVED_PHASE_FIELDS.some((field) => field in phase);
}

function stripRemovedFields(phase: PhaseDef): PhaseDef {
  if (!hasRemovedField(phase)) return phase;
  const next: PhaseDef & Record<string, unknown> = { ...phase };
  for (const field of REMOVED_PHASE_FIELDS) delete next[field];
  return next;
}

export class PipelineStore {
  private readonly appStore: JsonStore<PipelineDef[]>;
  private readonly projectStores = new Map<string, JsonStore<PipelineDef[]>>();

  constructor(private readonly appSupportDir: string) {
    this.appStore = new JsonStore<PipelineDef[]>(
      join(appSupportDir, 'pipelines.json'),
      () => BUILTIN_PIPELINES.map((p) => ({ ...p })),
      (raw) => {
        const list = Array.isArray(raw) ? (raw as PipelineDef[]) : [];
        // The flag says where a pipeline came from, so an id this build does
        // not ship cannot legitimately carry it. A leftover builtin becomes
        // an ordinary deletable pipeline rather than one a restore of missing
        // shipped ids would fight over; its content is user state and stays.
        const shipped = new Set(BUILTIN_PIPELINES.map((p) => p.id));
        const byId = new Map(
          list
            .map(normalizePipeline)
            .map((p) => [p.id, shipped.has(p.id) ? p : { ...p, builtin: false }] as const),
        );
        for (const builtin of BUILTIN_PIPELINES) {
          if (!byId.has(builtin.id)) byId.set(builtin.id, { ...builtin });
        }
        return [...byId.values()];
      },
    );
  }

  private projectStore(projectId: string): JsonStore<PipelineDef[]> {
    let store = this.projectStores.get(projectId);
    if (!store) {
      store = new JsonStore<PipelineDef[]>(
        join(this.appSupportDir, 'project-overrides', projectId, 'pipelines.json'),
        () => this.appStore.read().map((p) => ({ ...p })),
        // A project copy gets the same normalization as the app file; a project
        // that opted in must not be the one place a removed field survives.
        (raw) =>
          Array.isArray(raw)
            ? (raw as PipelineDef[]).map(normalizePipeline)
            : this.appStore.read().map((p) => ({ ...p })),
      );
      this.projectStores.set(projectId, store);
    }
    return store;
  }

  private storeFor(
    opts: { projectId?: string; ownPipelines?: boolean } = {},
  ): JsonStore<PipelineDef[]> {
    return opts.projectId && opts.ownPipelines ? this.projectStore(opts.projectId) : this.appStore;
  }

  /**
   * Whether this project already has a pipelines file on disk. Turning
   * `ownPipelines` off leaves the copy in place, so re-enabling restores that
   * older copy rather than seeding a fresh one; the UI must say which.
   */
  hasProjectCopy(projectId: string): boolean {
    return existsSync(this.projectStore(projectId).filePath);
  }

  list(opts: { projectId?: string; ownPipelines?: boolean } = {}): PipelineDef[] {
    return this.storeFor(opts).read();
  }

  staleBuiltins(opts: { projectId?: string; ownPipelines?: boolean } = {}): string[] {
    const current = new Map(this.list(opts).map((pipeline) => [pipeline.id, pipeline]));
    return BUILTIN_PIPELINES.filter((shipped) => {
      const stored = current.get(shipped.id);
      if (!stored) return true;
      const { canvas: _storedCanvas, ...storedDefinition } = stored;
      const { canvas: _shippedCanvas, ...shippedDefinition } = shipped;
      return !isDeepStrictEqual(storedDefinition, shippedDefinition);
    }).map((shipped) => shipped.id);
  }

  get(id: string, opts: { projectId?: string; ownPipelines?: boolean } = {}): PipelineDef | null {
    return this.list(opts).find((p) => p.id === id) ?? null;
  }

  save(
    pipeline: PipelineDef,
    agents: AgentDef[],
    commandNames: string[],
    opts: { projectId?: string; ownPipelines?: boolean } = {},
    knownEnvelopes: string[] = [],
  ): { ok: true; pipelines: PipelineDef[] } | { ok: false; issues: ValidationIssue[] } {
    const issues = validate(pipeline, agents, commandNames, knownEnvelopes);
    if (issues.some((i) => i.level === 'error')) return { ok: false, issues };
    const next = this.storeFor(opts).update((current) =>
      upsertBy(current, (p) => p.id === pipeline.id, pipeline),
    );
    return { ok: true, pipelines: next };
  }

  /**
   * Phases name their agent by string, so an agent renamed out from under them
   * fails validation with "no agent named X in the roster". Repointing here
   * keeps the roster edit from breaking pipelines the user never touched.
   */
  renameAgentRefs(
    from: string,
    to: string,
    opts: { projectId?: string; ownPipelines?: boolean } = {},
  ): PipelineDef[] {
    return this.storeFor(opts).update((current) =>
      current.map((pipeline) =>
        pipeline.phases.some((p) => p.agent === from)
          ? {
              ...pipeline,
              phases: pipeline.phases.map((p) => (p.agent === from ? { ...p, agent: to } : p)),
            }
          : pipeline,
      ),
    );
  }

  remove(id: string, opts: { projectId?: string; ownPipelines?: boolean } = {}): PipelineDef[] {
    return this.storeFor(opts).update((current) => current.filter((p) => p.id !== id));
  }

  duplicate(
    id: string,
    opts: { projectId?: string; ownPipelines?: boolean } = {},
  ): PipelineDef | null {
    const source = this.get(id, opts);
    if (!source) return null;
    const existing = new Set(this.list(opts).map((p) => p.id));
    const copy: PipelineDef = {
      ...source,
      id: uniqueCopyName(id, existing),
      name: `${source.name} (copy)`,
      builtin: false,
    };
    this.storeFor(opts).update((current) => [...current, copy]);
    return copy;
  }

  resetToBuiltins(): PipelineDef[] {
    return this.appStore.write(BUILTIN_PIPELINES.map((p) => ({ ...p })));
  }

  resetBuiltin(
    id: string,
    opts: { projectId?: string; ownPipelines?: boolean } = {},
  ): PipelineDef[] {
    const shipped = BUILTIN_PIPELINES.find((pipeline) => pipeline.id === id);
    if (!shipped) return this.list(opts);
    return this.storeFor(opts).update((current) =>
      upsertBy(current, (pipeline) => pipeline.id === id, structuredClone(shipped)),
    );
  }
}

/**
 * The validation rail. Errors block a save; warnings are shown and allowed,
 * because a project command that does not exist yet is a real intermediate
 * state while someone builds a pipeline.
 */
export function validate(
  pipeline: PipelineDef,
  agents: AgentDef[],
  commandNames: string[],
  knownEnvelopes: string[] = [],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const parsed = pipelineSchema.safeParse(pipeline);
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      issues.push({ level: 'error', where: i.path.join('.') || pipeline.id, message: i.message });
    }
    return issues;
  }

  const shared = {
    pipeline,
    agentNames: new Set(agents.map((a) => a.name)),
    commandNames,
    knownEnvelopes: new Set([...BUILTIN_ENVELOPE_KINDS, ...knownEnvelopes]),
  };
  const seen = new Set<string>();
  pipeline.phases.forEach((phase, index) => {
    const where = `phases[${index}] ${phase.name}`;
    const ctx: PhaseContext = {
      ...shared,
      index,
      error: (message) => issues.push({ level: 'error', where, message }),
      warn: (message) => issues.push({ level: 'warning', where, message }),
    };
    if (seen.has(phase.name)) ctx.error(`duplicate phase name "${phase.name}"`);
    seen.add(phase.name);

    // A description that only restates the name tells a reader nothing they
    // could not already see, so it is rejected the same way a blank one is.
    const flat = phase.description.trim().replace(/\.$/, '').toLowerCase();
    if (flat === phase.name.replace(/_/g, ' ').toLowerCase()) {
      ctx.error('description only restates the phase name — say what it does and why');
    }

    if (phase.kind === 'agent') validateAgentPhase(phase, ctx);
    if (phase.kind === 'code') validateCodePhase(phase, ctx);
    if (phase.kind === 'engineer' && !phase.question) {
      ctx.warn('an engineer phase with no question shows an empty sheet');
    }
  });

  const acceptance = pipeline.acceptance;
  if (acceptance.kind !== 'phase_flag' && acceptance.kind !== 'envelope_status') return issues;
  const target = pipeline.phases.find((p) => p.name === acceptance.phase);
  if (!target) {
    issues.push({
      level: 'error',
      where: 'acceptance',
      message: `acceptance names phase "${acceptance.phase}", which does not exist`,
    });
    return issues;
  }
  if (acceptance.kind === 'phase_flag' && acceptance.flag === 'approved') {
    const declared = effectivePhaseEnvelope(target, agents);
    if (declared !== 'review') {
      issues.push({
        level: 'warning',
        where: 'acceptance',
        message: `"approved" comes from a review envelope; "${target.name}" declares ${declared ?? 'none'}`,
      });
    }
  }
  return issues;
}

/** What one phase is checked against, plus where its issues are recorded. */
interface PhaseContext {
  pipeline: PipelineDef;
  index: number;
  agentNames: Set<string>;
  commandNames: string[];
  knownEnvelopes: Set<string>;
  error(message: string): void;
  warn(message: string): void;
}

function validateAgentPhase(phase: PhaseDef, ctx: PhaseContext): void {
  if (!phase.agent) {
    ctx.error('an agent phase needs an agent');
  } else if (!ctx.agentNames.has(phase.agent)) {
    ctx.error(`no agent named "${phase.agent}" in the roster`);
  }
  if (!phase.prompt) ctx.error('an agent phase needs a prompt spec');
  if (phase.envelope && !ctx.knownEnvelopes.has(phase.envelope)) {
    ctx.warn(`envelope "${phase.envelope}" is not in the library — runs will fall back to generic`);
  }

  for (const spec of phase.gates ?? []) {
    const gate = typeof spec === 'string' ? spec : spec.gate;
    if (!GATES[gate]) ctx.error(`unknown gate "${gate}"`);
    if (gate !== 'command_passes') continue;
    const argv = typeof spec === 'string' ? undefined : (spec.config?.argv as string[] | undefined);
    if (!argv?.length) ctx.error('command_passes needs a configured command');
  }

  const earlier = ctx.pipeline.phases.slice(0, ctx.index);
  for (const input of phase.prompt?.inputs ?? []) {
    if (!input.startsWith('envelope:')) continue;
    const target = input.slice('envelope:'.length).split('.')[0]!;
    if (!earlier.some((p) => p.name === target)) {
      ctx.error(`input "${input}" names a phase that does not run before this one`);
    }
  }
}

function validateCodePhase(phase: PhaseDef, ctx: PhaseContext): void {
  if (!phase.command) {
    ctx.error('a code phase needs a command');
  } else if ('ref' in phase.command && !ctx.commandNames.includes(phase.command.ref)) {
    ctx.warn(`project command "${phase.command.ref}" is not configured for this project yet`);
  }
  if (!phase.feedbackTo) return;

  const targetIndex = ctx.pipeline.phases.findIndex((p) => p.name === phase.feedbackTo);
  const target = ctx.pipeline.phases[targetIndex];
  if (!target) {
    ctx.error(`feedback_to names "${phase.feedbackTo}", which is not a phase in this pipeline`);
  } else if (targetIndex >= ctx.index) {
    ctx.error(`feedback_to must point at an earlier phase; "${phase.feedbackTo}" runs later`);
  } else if (target.kind !== 'agent') {
    ctx.error(
      `feedback_to must point at an agent phase; "${phase.feedbackTo}" is a ${target.kind} phase`,
    );
  }
}
