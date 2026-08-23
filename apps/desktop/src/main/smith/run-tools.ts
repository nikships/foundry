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
  'start',
  'resume',
  'kill',
  'archive',
  'merge',
  'fix_merge',
  'discard',
  'open_worktree',
  'reveal_files',
] as const;

type RunOperation = (typeof SMITH_RUN_OPERATIONS)[number];
type RunReadOperation = 'detail' | 'events' | 'context' | 'prompt';
type RunActionOperation = Exclude<RunOperation, 'list' | 'live_tail' | RunReadOperation>;

/** Project-scoped reads keyed by the id they take. */
const READS: Record<RunReadOperation, { channel: string; idField: 'runId' | 'phaseId' }> = {
  detail: { channel: IPC.runsDetail, idField: 'runId' },
  events: { channel: IPC.runsEvents, idField: 'runId' },
  context: { channel: IPC.runsContextBreakdown, idField: 'runId' },
  prompt: { channel: IPC.runsPrompt, idField: 'phaseId' },
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
};

const RISKS: Partial<Record<RunOperation, SmithActionRisk>> = {
  kill: 'destructive',
  discard: 'destructive',
  merge: 'git',
  fix_merge: 'git',
  open_worktree: 'external',
  reveal_files: 'external',
};

export function smithRunsTool(deps: SmithActionToolDeps): ToolDefinition {
  return defineTool({
    name: 'smith_runs',
    label: 'Smith runs',
    description:
      'Inspect and operate Foundry runs. Operations: list(projectId?,includeArchived?), detail/events/context(projectId?,runId,...), live_tail(phaseId), prompt(projectId?,phaseId), start(projectId?,pipelineId,request), resume/kill/merge/fix_merge/discard/open_worktree/reveal_files(projectId?,runId), archive(projectId?,runId,archived).',
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
      },
      required: ['operation'],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      const op = parseOperation(params, SMITH_RUN_OPERATIONS);
      if (!op) return json({ ok: false, error: 'unknown operation' });

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
  return { ok: true, args: [projectId, runId], shownArgs: { projectId, runId } };
}
