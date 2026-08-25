import { IPC } from '@shared/ipc-contract.js';
import type { SmithActionRisk } from '@shared/types.js';
import { defineTool, type ToolDefinition } from '../pi/tool-definition.js';
import {
  booleanField,
  field,
  immediate,
  json,
  numberField,
  parseOperation,
  proposeAction,
  requireProjectId,
  stringArrayField,
  stringField,
  type SmithActionToolDeps,
} from './tool-helpers.js';

export const SMITH_RUN_OPERATIONS = [
  'list',
  'detail',
  'events',
  'live_tail',
  'context',
  'prompt',
  'plan',
  'checkpoints',
  'start',
  'resume',
  'kill',
  'archive',
  'merge',
  'fix_merge',
  'discard',
  'open_worktree',
  'reveal_files',
  'export_plan',
  'restore_checkpoint',
  'linear_issues',
  'linear_workflow_states',
  'linear_start',
] as const;

type RunOperation = (typeof SMITH_RUN_OPERATIONS)[number];
type RunReadOperation = 'detail' | 'events' | 'context' | 'prompt' | 'plan' | 'checkpoints';
type LinearRunReadOperation = 'linear_issues' | 'linear_workflow_states';
type RunActionOperation = Exclude<
  RunOperation,
  'list' | 'live_tail' | RunReadOperation | LinearRunReadOperation
>;

/** Project-scoped reads keyed by the id they take. */
const READS: Record<RunReadOperation, { channel: string; idField: 'runId' | 'phaseId' }> = {
  detail: { channel: IPC.runsDetail, idField: 'runId' },
  events: { channel: IPC.runsEvents, idField: 'runId' },
  context: { channel: IPC.runsContextBreakdown, idField: 'runId' },
  prompt: { channel: IPC.runsPrompt, idField: 'phaseId' },
  plan: { channel: IPC.runsPlan, idField: 'runId' },
  checkpoints: { channel: IPC.runsRestorableCheckpoints, idField: 'runId' },
};

const ACTION_CHANNELS: Record<RunActionOperation, string> = {
  start: IPC.runsStart,
  resume: IPC.runsResume,
  kill: IPC.runsKill,
  archive: IPC.runsArchive,
  merge: IPC.runsMergeWorktree,
  fix_merge: IPC.runsFixMerge,
  discard: IPC.runsDiscardWorktree,
  open_worktree: IPC.runsOpenWorktree,
  reveal_files: IPC.runsRevealFiles,
  export_plan: IPC.runsExportPlan,
  restore_checkpoint: IPC.runsRestoreCheckpoint,
  linear_start: IPC.linearStartRun,
};

const RISKS: Partial<Record<RunOperation, SmithActionRisk>> = {
  kill: 'destructive',
  discard: 'destructive',
  merge: 'git',
  fix_merge: 'git',
  open_worktree: 'external',
  reveal_files: 'external',
  // A restore resets the run branch and overwrites the worktree. The commits
  // stay in the reflog, but nothing about that is a plain write.
  restore_checkpoint: 'git',
};

export function smithRunsTool(deps: SmithActionToolDeps): ToolDefinition {
  return defineTool({
    name: 'smith_runs',
    label: 'Smith runs',
    description:
      'Inspect and operate Foundry runs. Operations: list(projectId?,includeArchived?), detail/events/context/plan/checkpoints(projectId?,runId,...), live_tail(phaseId), prompt(projectId?,phaseId), start(projectId?,pipelineId,request), resume/kill/merge/fix_merge/discard/open_worktree/reveal_files(projectId?,runId), archive(projectId?,runId,archived), export_plan(projectId?,runId,pipeline?,agents?), restore_checkpoint(projectId?,runId,checkpointId,acceptPartial?), linear_issues(query?), linear_workflow_states(teamId), linear_start(projectId?,pipelineId,issueId).',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: [...SMITH_RUN_OPERATIONS] },
        projectId: { type: 'string' },
        includeArchived: { type: 'boolean' },
        runId: { type: 'string' },
        phaseId: { type: 'string' },
        afterChangeId: { type: 'number' },
        agent: { type: 'string' },
        pipelineId: { type: 'string' },
        request: { type: 'string' },
        archived: { type: 'boolean' },
        pipeline: { type: 'boolean' },
        agents: { type: 'array', items: { type: 'string' } },
        checkpointId: { type: 'string' },
        acceptPartial: { type: 'boolean' },
        query: { type: 'string' },
        teamId: { type: 'string' },
        issueId: { type: 'string' },
      },
      required: ['operation'],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      const op = parseOperation(params, SMITH_RUN_OPERATIONS);
      if (!op) return json({ ok: false, error: 'unknown operation' });

      if (isLinearRunReadOperation(op)) return linearRunRead(deps, op, params);

      // A live tail is keyed by phase alone; it needs no project scope.
      if (op === 'live_tail') {
        const phaseId = stringField(params, 'phaseId');
        return phaseId
          ? immediate(deps, IPC.runsLiveTail, phaseId)
          : json({ ok: false, error: 'phaseId is required' });
      }

      const scope = requireProjectId(field(params, 'projectId'), deps.projectId());
      if (!scope.ok) return json(scope);
      const projectId = scope.projectId;

      if (op === 'list') {
        const includeArchived = booleanField(params, 'includeArchived') ?? false;
        return immediate(deps, IPC.runsList, projectId, includeArchived);
      }

      const read = op in READS ? READS[op as RunReadOperation] : null;
      if (read) {
        const id = stringField(params, read.idField);
        if (!id) return json({ ok: false, error: `${read.idField} is required` });
        if (op === 'events') {
          const cursor = numberField(params, 'afterChangeId');
          if (cursor === null) return json({ ok: false, error: 'afterChangeId is required' });
          return immediate(deps, read.channel, projectId, id, cursor);
        }
        if (op === 'context') {
          const agent = stringField(params, 'agent');
          if (!agent) return json({ ok: false, error: 'agent is required' });
          return immediate(deps, read.channel, projectId, id, agent);
        }
        return immediate(deps, read.channel, projectId, id);
      }

      const gated = resolveGatedArgs(op as RunActionOperation, params, projectId);
      if (!gated.ok) return json({ ok: false, error: gated.error });
      return proposeAction(deps, {
        operation: op,
        title: `${op.replaceAll('_', ' ')} run`,
        summary: `${op.replaceAll('_', ' ')} the selected run.`,
        args: gated.shownArgs,
        risk: RISKS[op] ?? 'write',
        execute: () => deps.invoke(ACTION_CHANNELS[op as RunActionOperation], ...gated.args),
      });
    },
  });
}

type GatedArgs =
  { ok: true; args: unknown[]; shownArgs: Record<string, unknown> } | { ok: false; error: string };

/** `start` names a pipeline; everything else names an existing run. */
function resolveGatedArgs(op: RunActionOperation, params: unknown, projectId: string): GatedArgs {
  if (op === 'linear_start') {
    const pipelineId = stringField(params, 'pipelineId');
    const issueId = stringField(params, 'issueId');
    if (!pipelineId || !issueId) {
      return { ok: false, error: 'pipelineId and issueId are required' };
    }
    const input = { projectId, pipelineId, issueId };
    return { ok: true, args: [input], shownArgs: input };
  }
  if (op === 'start') {
    const pipelineId = stringField(params, 'pipelineId');
    const request = stringField(params, 'request');
    if (!pipelineId || !request) {
      return { ok: false, error: 'pipelineId and request are required' };
    }
    const input = { projectId, pipelineId, request };
    return { ok: true, args: [input], shownArgs: input };
  }
  const runId = stringField(params, 'runId');
  if (!runId) return { ok: false, error: 'runId is required' };
  if (op === 'archive') {
    const archived = booleanField(params, 'archived');
    if (archived === undefined) return { ok: false, error: 'archived is required' };
    return {
      ok: true,
      args: [projectId, runId, archived],
      shownArgs: { projectId, runId, archived },
    };
  }
  if (op === 'restore_checkpoint') {
    const checkpointId = stringField(params, 'checkpointId');
    if (!checkpointId) return { ok: false, error: 'checkpointId is required' };
    // A truncated checkpoint refuses without this, so it has to be an explicit
    // argument here too rather than a default the model never states.
    const acceptPartial = booleanField(params, 'acceptPartial') ?? false;
    const input = { runId, checkpointId, acceptPartial };
    return { ok: true, args: [projectId, input], shownArgs: { projectId, ...input } };
  }
  if (op === 'export_plan') {
    const pipeline = booleanField(params, 'pipeline') ?? false;
    const agents = field(params, 'agents') === undefined ? [] : stringArrayField(params, 'agents');
    if (!agents) return { ok: false, error: 'agents must be an array of strings' };
    if (!pipeline && agents.length === 0) {
      return { ok: false, error: 'pipeline or at least one agent is required' };
    }
    const selection = { pipeline, agents };
    return {
      ok: true,
      args: [projectId, runId, selection],
      shownArgs: { projectId, runId, ...selection },
    };
  }
  return { ok: true, args: [projectId, runId], shownArgs: { projectId, runId } };
}

function isLinearRunReadOperation(op: RunOperation): op is LinearRunReadOperation {
  return op === 'linear_issues' || op === 'linear_workflow_states';
}

function linearRunRead(
  deps: SmithActionToolDeps,
  op: LinearRunReadOperation,
  params: unknown,
): ReturnType<typeof immediate> {
  if (op === 'linear_issues') {
    const query = field(params, 'query');
    if (query !== undefined && typeof query !== 'string') {
      return Promise.resolve(json({ ok: false, error: 'query must be a string' }));
    }
    return immediate(deps, IPC.linearIssues, query ?? '');
  }
  const teamId = stringField(params, 'teamId');
  return teamId
    ? immediate(deps, IPC.linearWorkflowStates, teamId)
    : Promise.resolve(json({ ok: false, error: 'teamId is required' }));
}
