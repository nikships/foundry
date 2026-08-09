import { join } from 'node:path';
import type { DryRunPrompt, PipelineDef } from '@shared/types.js';
import { IPC, type SaveResult } from '@shared/ipc-contract.js';
import { placeholderEnvelope, type Envelope } from '../engine/envelopes.js';
import { renderPrompt } from '../engine/prompts.js';
import { validate as validatePipeline } from '../store/pipelines.js';
import type { AppContext } from '../context.js';
import type { Handle } from './shared.js';
import { noIssues, notifySettings } from './shared.js';

type Ctx = Pick<
  AppContext,
  | 'pipelines'
  | 'pipelineScope'
  | 'pipelinesFor'
  | 'rosterFor'
  | 'commandNames'
  | 'projects'
  | 'envelopes'
  | 'broadcast'
>;

export function register(ctx: Ctx, handle: Handle): void {
  const projectOf = (projectId: string) => ctx.projects.get(projectId);
  const knownEnvelopeNames = () => ctx.envelopes.list().map((e) => e.name);

  handle(IPC.pipelinesList, (projectId?: string) => ctx.pipelinesFor(projectId));

  handle(
    IPC.pipelinesSave,
    (pipeline: PipelineDef, projectId?: string): SaveResult<PipelineDef[]> => {
      const result = ctx.pipelines.save(
        pipeline,
        ctx.rosterFor(projectId),
        ctx.commandNames(projectId),
        ctx.pipelineScope(projectId),
        knownEnvelopeNames(),
      );
      if (!result.ok) return { ok: false, issues: result.issues };
      notifySettings(ctx);
      return { ok: true, issues: noIssues, value: result.pipelines };
    },
  );

  handle(IPC.pipelinesRemove, (id: string, projectId?: string) => {
    const pipelines = ctx.pipelines.remove(id, ctx.pipelineScope(projectId));
    notifySettings(ctx);
    return pipelines;
  });

  handle(IPC.pipelinesDuplicate, (id: string, projectId?: string) =>
    ctx.pipelines.duplicate(id, ctx.pipelineScope(projectId)),
  );

  handle(IPC.pipelinesValidate, (pipeline: PipelineDef, projectId?: string) =>
    validatePipeline(
      pipeline,
      ctx.rosterFor(projectId),
      ctx.commandNames(projectId),
      knownEnvelopeNames(),
    ),
  );

  /** Renders exactly what a run would send, without spending a token. */
  handle(
    IPC.pipelinesDryRun,
    (pipelineId: string, projectId: string, request: string): DryRunPrompt[] => {
      const project = projectOf(projectId);
      const pipeline = ctx.pipelines.get(pipelineId, ctx.pipelineScope(projectId));
      if (!project || !pipeline) return [];
      const agents = ctx.rosterFor(projectId);
      const envelopeDefs = ctx.envelopes.list();
      const worktree = join(project.path, '.foundry-worktrees', 'run_dryrun');
      const out: DryRunPrompt[] = [];
      const envelopes = new Map<string, Envelope>();
      for (const phase of pipeline.phases) {
        if (phase.kind !== 'agent') continue;
        const agent = agents.find((a) => a.name === phase.agent);
        if (!agent) continue;
        const rendered = renderPrompt(agent, phase, {
          request,
          runId: 'run_dryrun',
          worktree,
          handoffDir: join(worktree, '.foundry-handoff'),
          handoffFiles: [],
          // Earlier phases are stood in for with a placeholder envelope, so a
          // later prompt shows its real shape instead of "(not available)".
          envelopes,
          envelopeDefs,
        });
        out.push({
          phase: phase.name,
          agent: agent.name,
          model: agent.model,
          systemPrompt: rendered.system,
          userPrompt: rendered.user,
        });
        envelopes.set(
          phase.name,
          placeholderEnvelope(
            phase.name,
            phase.envelope ?? agent.envelope,
            agent.customFields,
            envelopeDefs,
          ),
        );
      }
      return out;
    },
  );

  handle(IPC.pipelinesReset, () => {
    const pipelines = ctx.pipelines.resetToBuiltins();
    notifySettings(ctx);
    return pipelines;
  });
}
