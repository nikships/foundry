import { IPC } from '@shared/ipc-contract.js';
import { defineTool, type ToolDefinition } from '../pi/tool-definition.js';
import {
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

export const SMITH_PR_OPERATIONS = ['status', 'list', 'create', 'merge', 'fix_conflicts'] as const;

export function smithPrsTool(deps: SmithActionToolDeps): ToolDefinition {
  return defineTool({
    name: 'smith_prs',
    label: 'Smith pull requests',
    description:
      'Inspect and operate pull requests: status/list(projectId?), create(projectId?,runId,title,body), merge(projectId?,prNumber,method), fix_conflicts(projectId?,prNumber).',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: [...SMITH_PR_OPERATIONS] },
        projectId: { type: 'string' },
        runId: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        prNumber: { type: 'number' },
        method: { type: 'string', enum: ['merge', 'squash'] },
      },
      required: ['operation'],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      const op = parseOperation(params, SMITH_PR_OPERATIONS);
      if (!op) return json({ ok: false, error: 'unknown operation' });
      const scope = requireProjectId(field(params, 'projectId'), deps.projectId());
      if (!scope.ok) return json(scope);
      const projectId = scope.projectId;

      if (op === 'status') return immediate(deps, IPC.prsStatus, projectId);
      if (op === 'list') return immediate(deps, IPC.prsList, projectId);

      const gated =
        op === 'create' ? createArgs(params, projectId) : prNumberArgs(op, params, projectId);
      if (!gated.ok) return json({ ok: false, error: gated.error });
      const label = op.replaceAll('_', ' ');
      return proposeAction(deps, {
        operation: op,
        title: `${label} pull request`,
        summary: `${label} using GitHub.`,
        args: gated.shownArgs,
        risk: op === 'merge' ? 'destructive' : 'git',
        execute: () => deps.invoke(gated.channel, ...gated.args),
      });
    },
  });
}

type GatedCall =
  | { ok: true; channel: string; args: unknown[]; shownArgs: Record<string, unknown> }
  | { ok: false; error: string };

function createArgs(params: unknown, projectId: string): GatedCall {
  const runId = stringField(params, 'runId');
  const title = stringField(params, 'title');
  const body = stringField(params, 'body');
  if (!runId || !title || !body) {
    return { ok: false, error: 'runId, title, and body are required' };
  }
  return {
    ok: true,
    channel: IPC.prsCreate,
    args: [projectId, runId, title, body],
    shownArgs: { projectId, runId, title, body },
  };
}

function prNumberArgs(
  op: 'merge' | 'fix_conflicts',
  params: unknown,
  projectId: string,
): GatedCall {
  const prNumber = numberField(params, 'prNumber');
  if (prNumber === null) return { ok: false, error: 'prNumber is required' };
  if (op === 'fix_conflicts') {
    return {
      ok: true,
      channel: IPC.prsFixConflicts,
      args: [projectId, prNumber],
      shownArgs: { projectId, prNumber },
    };
  }
  const method = stringField(params, 'method');
  if (method !== 'merge' && method !== 'squash') {
    return { ok: false, error: 'method must be merge or squash' };
  }
  return {
    ok: true,
    channel: IPC.prsMerge,
    args: [projectId, prNumber, method],
    shownArgs: { projectId, prNumber, method },
  };
}
