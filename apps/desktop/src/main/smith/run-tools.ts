import { IPC } from '@shared/ipc-contract.js';
import { splitLinearAssignedIntent } from '@shared/linear.js';
import type { AppSettings, ReasoningEffort, SmithActionRisk } from '@shared/types.js';
import { defineTool, type ToolDefinition } from '../pi/tool-definition.js';
import { defaultSettings } from '../store/settings.js';
import { resolveSmithModel } from './compose/model.js';
import { compactSmithRunEvents } from './event-page.js';
import {
  RUN_AGENT_OPERATIONS,
  runAgentOperation,
  type RunAgentOperation,
} from './run-agent-tools.js';
import {
  booleanField,
  errorMessage,
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
  ...RUN_AGENT_OPERATIONS,
  'list',
  'detail',
  'events',
  'live_tail',
  'context',
  'prompt',
  'artifacts',
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
  'linear_issue',
  'linear_workflow_states',
  'linear_start',
  'orchestrator_plan',
  'orchestrator_message',
  'orchestrator_cancel',
  'orchestrator_list',
  'orchestrator_get',
  'orchestrator_accept',
  'orchestrator_discard',
] as const;

type RunOperation = (typeof SMITH_RUN_OPERATIONS)[number];
type RunReadOperation =
  'detail' | 'events' | 'context' | 'prompt' | 'artifacts' | 'plan' | 'checkpoints';
type LinearRunReadOperation = 'linear_issues' | 'linear_issue' | 'linear_workflow_states';
type OrchestratorReadOperation = 'orchestrator_list' | 'orchestrator_get';
type OrchestratorPlanIdAction =
  'orchestrator_message' | 'orchestrator_cancel' | 'orchestrator_accept' | 'orchestrator_discard';
type RunActionOperation = Exclude<
  RunOperation,
  | 'list'
  | 'live_tail'
  | RunReadOperation
  | LinearRunReadOperation
  | OrchestratorReadOperation
  | RunAgentOperation
>;

/** Reasoning efforts Smith offers for a composition turn. */
const ORCHESTRATOR_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high'];

/** Project-scoped reads keyed by the id they take. */
const READS: Record<RunReadOperation, { channel: string; idField: 'runId' | 'phaseId' }> = {
  detail: { channel: IPC.runsDetail, idField: 'runId' },
  events: { channel: IPC.runsEvents, idField: 'runId' },
  context: { channel: IPC.runsContextBreakdown, idField: 'runId' },
  prompt: { channel: IPC.runsPrompt, idField: 'phaseId' },
  artifacts: { channel: IPC.runsArtifacts, idField: 'phaseId' },
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
  orchestrator_plan: IPC.orchestratorPlan,
  orchestrator_message: IPC.orchestratorMessage,
  orchestrator_cancel: IPC.orchestratorCancel,
  orchestrator_accept: IPC.orchestratorAccept,
  orchestrator_discard: IPC.orchestratorDiscard,
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
  // Planning and follow-ups spend an agent turn on the operator's model;
  // that is a privileged action even though the plan itself writes nothing.
  orchestrator_plan: 'write',
  orchestrator_message: 'write',
  orchestrator_cancel: 'write',
  // Accept creates the run exactly once via proposals.accept, never via
  // runs:start directly, so concurrent accepts share one run.
  orchestrator_accept: 'write',
  orchestrator_discard: 'destructive',
};

export function smithRunsTool(deps: SmithActionToolDeps): ToolDefinition {
  return defineTool({
    name: 'smith_runs',
    label: 'Smith runs',
    description: [
      'Inspect runs, direct phase agents, or propose run actions. Names in parentheses are arguments; ? means optional.',
      'Scope: projectId defaults to the current project; supply it in All projects scope. Linear reads, live_tail, and planId operations need no projectId.',
      'Read now: list(includeArchived?), detail(runId), plan(runId), checkpoints(runId), agents(runId), messages(runId). Use detail first for failures.',
      'Read evidence: events(runId,afterChangeId) starts at 0; pass result.cursor as afterChangeId for the next page. conversation(runId,phaseId,cursor?) starts without cursor; pass result.nextCursor unchanged as cursor until null. Read only needed pages.',
      'Read phase data: prompt(phaseId), artifacts(phaseId), live_tail(phaseId). context(runId,agent) requires the agent name, not phaseId.',
      'Approval: message_phase(runId,phaseId,text) sends an exact note; interrupt_phase(runId,phaseId) stops a live turn. Neither resumes a run. Inspect agents before either action.',
      'Approval: resume(runId) retries the first failed phase in its existing worktree/conversation, without re-running successful earlier phases; kill(runId), archive(runId,archived), discard(runId).',
      'Approval: merge(runId) merges the run worktree into the local base; fix_merge(runId) repairs that merge. For GitHub PRs use smith_prs. open_worktree(runId), reveal_files(runId).',
      'Approval: export_plan(runId,pipeline?,agents?) needs pipeline:true or at least one agent name. restore_checkpoint(runId,checkpointId,acceptPartial?) resets the run worktree; inspect checkpoints first and explain any partial restore.',
      'New run (default): orchestrator_plan(prompt,model?,reasoningEffort?) requires approval and returns a planId while planning continues. Return that handle promptly; do not poll in a tight loop.',
      'Read plans: orchestrator_list(), orchestrator_get(planId). Approval: orchestrator_message(planId,text), orchestrator_cancel(planId), orchestrator_discard(planId), orchestrator_accept(planId,plan?). Accept starts the run exactly once; plan is an optional full revised plan, not a patch.',
      'Manual pipelines only: start(pipelineId,request) or linear_start(pipelineId,issueId), both with approval.',
      'Read Linear: linear_issues(query?,assigned?), linear_issue(issueId), linear_workflow_states(teamId). For my tickets use assigned:true; query filters key/title. Use issue detail and workflow state.type to report status.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: [...SMITH_RUN_OPERATIONS] },
        projectId: {
          type: 'string',
          description:
            'Target project; required in All projects scope for project-scoped operations.',
        },
        includeArchived: { type: 'boolean' },
        runId: { type: 'string' },
        phaseId: { type: 'string' },
        text: { type: 'string', minLength: 1, maxLength: 12000 },
        cursor: {
          type: 'object',
          description:
            'Conversation paging only. Omit on the first call; reuse result.nextCursor unchanged. A null nextCursor means no more pages.',
          properties: {
            line: { type: 'integer', minimum: 1 },
            offset: { type: 'integer', minimum: 0 },
            agentSessionId: { type: 'string', minLength: 1 },
          },
          required: ['line', 'offset'],
          additionalProperties: false,
        },
        afterChangeId: {
          type: 'number',
          description:
            'Required for events. Use 0 for the first page, then result.cursor. Not a conversation cursor.',
        },
        agent: {
          type: 'string',
          description: 'Required for context: agent name from agents, not a phase ID.',
        },
        pipelineId: { type: 'string' },
        request: { type: 'string' },
        archived: { type: 'boolean' },
        pipeline: { type: 'boolean' },
        agents: { type: 'array', items: { type: 'string' } },
        checkpointId: { type: 'string' },
        acceptPartial: { type: 'boolean' },
        query: { type: 'string' },
        assigned: { type: 'boolean' },
        teamId: { type: 'string' },
        issueId: { type: 'string' },
        prompt: { type: 'string' },
        model: { type: 'string' },
        reasoningEffort: { type: 'string', enum: ['low', 'medium', 'high'] },
        planId: { type: 'string' },
        plan: {
          type: 'object',
          description:
            'For orchestrator_accept only: full revised plan from orchestrator_get. Omit to accept the stored plan.',
        },
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

      // Orchestrator proposal reads and plan-keyed actions are scoped by the
      // plan itself; only plan and list take a project, resolved inside.
      if (isOrchestratorReadOperation(op)) return orchestratorRead(deps, op, params);
      if (isOrchestratorPlanIdAction(op)) return orchestratorPlanIdAction(deps, op, params);

      const scope = requireProjectId(field(params, 'projectId'), deps.projectId());
      if (!scope.ok) return json(scope);
      const projectId = scope.projectId;

      if ((RUN_AGENT_OPERATIONS as readonly string[]).includes(op)) {
        return runAgentOperation(deps, op as RunAgentOperation, projectId, params);
      }

      if (op === 'list') {
        const includeArchived = booleanField(params, 'includeArchived') ?? false;
        return immediate(deps, IPC.runsList, projectId, includeArchived);
      }

      const read = op in READS ? READS[op as RunReadOperation] : null;
      if (read) return runRead(deps, op, read, projectId, params);

      // Planning spends an agent turn: approval-gated, with the model and
      // effort defaulted from Settings when Smith leaves them unstated.
      if (op === 'orchestrator_plan') return orchestratorPlanAction(deps, params, projectId);

      const gated = resolveGatedArgs(op as RunActionOperation, params, projectId);
      if (!gated.ok) return json({ ok: false, error: gated.error });
      const label = op.replaceAll('_', ' ');
      return proposeAction(deps, {
        operation: op,
        title: `${label} run`,
        summary: `${label} the selected run.`,
        args: gated.shownArgs,
        risk: RISKS[op] ?? 'write',
        execute: () => deps.invoke(ACTION_CHANNELS[op as RunActionOperation], ...gated.args),
      });
    },
  });
}

type GatedArgs =
  { ok: true; args: unknown[]; shownArgs: Record<string, unknown> } | { ok: false; error: string };

/** Project-scoped run reads, including the bounded events page. */
async function runRead(
  deps: SmithActionToolDeps,
  op: RunOperation,
  read: { channel: string; idField: 'runId' | 'phaseId' },
  projectId: string,
  params: unknown,
): Promise<ReturnType<typeof json>> {
  const id = stringField(params, read.idField);
  if (!id) return json({ ok: false, error: `${read.idField} is required` });
  if (op === 'events') return runEventsPage(deps, read.channel, projectId, id, params);
  if (op === 'context') {
    const agent = stringField(params, 'agent');
    if (!agent) return json({ ok: false, error: 'agent is required' });
    return immediate(deps, read.channel, projectId, id, agent);
  }
  return immediate(deps, read.channel, projectId, id);
}

/** One bounded events page, compacted before it reaches the model. */
async function runEventsPage(
  deps: SmithActionToolDeps,
  channel: string,
  projectId: string,
  runId: string,
  params: unknown,
): Promise<ReturnType<typeof json>> {
  const cursor = numberField(params, 'afterChangeId');
  if (cursor === null) return json({ ok: false, error: 'afterChangeId is required' });
  try {
    const result = await deps.invoke(channel, projectId, runId, cursor);
    return json({ ok: true, result: compactSmithRunEvents(result ?? null) });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) });
  }
}

/** `start` names a pipeline; plan-keyed orchestrator actions name a plan; the rest name a run. */
function resolveGatedArgs(
  op: RunActionOperation,
  params: unknown,
  projectId: string | undefined,
): GatedArgs {
  if (isOrchestratorPlanIdAction(op)) return resolveOrchestratorGatedArgs(op, params);
  // `orchestrator_plan` resolves its model/effort at execute time and never
  // reaches the generic tail; `start`/`linear_start` always carry a project.
  if (!projectId) return { ok: false, error: 'projectId is required in All projects scope' };
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
  if (op === 'export_plan') return resolveExportPlanArgs(params, projectId, runId);
  return { ok: true, args: [projectId, runId], shownArgs: { projectId, runId } };
}

/** Which ephemeral plan entities become ordinary definitions. */
function resolveExportPlanArgs(params: unknown, projectId: string, runId: string): GatedArgs {
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

/** Plan-keyed orchestrator actions: no project scope, one fixed handler each. */
function resolveOrchestratorGatedArgs(op: OrchestratorPlanIdAction, params: unknown): GatedArgs {
  if (op === 'orchestrator_message') {
    const planId = stringField(params, 'planId');
    const text = stringField(params, 'text');
    if (!planId || !text) {
      return { ok: false, error: 'planId and text are required' };
    }
    return { ok: true, args: [planId, text], shownArgs: { planId, text } };
  }
  if (op === 'orchestrator_accept') {
    const planId = stringField(params, 'planId');
    if (!planId) return { ok: false, error: 'planId is required' };
    const plan = field(params, 'plan');
    if (plan !== undefined && (typeof plan !== 'object' || plan === null)) {
      return { ok: false, error: 'plan must be an object' };
    }
    const input = plan === undefined ? { planId } : { planId, plan };
    return {
      ok: true,
      args: plan === undefined ? [planId] : [planId, plan],
      shownArgs: input as Record<string, unknown>,
    };
  }
  const planId = stringField(params, 'planId');
  if (!planId) return { ok: false, error: 'planId is required' };
  return { ok: true, args: [planId], shownArgs: { planId } };
}

function isLinearRunReadOperation(op: RunOperation): op is LinearRunReadOperation {
  return op === 'linear_issues' || op === 'linear_issue' || op === 'linear_workflow_states';
}

function isOrchestratorReadOperation(op: RunOperation): op is OrchestratorReadOperation {
  return op === 'orchestrator_list' || op === 'orchestrator_get';
}

function isOrchestratorPlanIdAction(op: RunOperation): op is OrchestratorPlanIdAction {
  return (
    op === 'orchestrator_message' ||
    op === 'orchestrator_cancel' ||
    op === 'orchestrator_accept' ||
    op === 'orchestrator_discard'
  );
}

/**
 * Project-scoped proposal browse vs. plan-keyed fetch. `get` needs no
 * project — polling a known plan from All-projects scope must just work.
 */
function orchestratorRead(
  deps: SmithActionToolDeps,
  op: OrchestratorReadOperation,
  params: unknown,
): ReturnType<typeof immediate> {
  if (op === 'orchestrator_get') {
    const planId = stringField(params, 'planId');
    return planId
      ? immediate(deps, IPC.orchestratorGet, planId)
      : Promise.resolve(json({ ok: false, error: 'planId is required' }));
  }
  const scope = requireProjectId(field(params, 'projectId'), deps.projectId());
  if (!scope.ok) return Promise.resolve(json(scope));
  return immediate(deps, IPC.orchestratorList, scope.projectId);
}

const ORCHESTRATOR_PLAN_ID_SUMMARIES: Record<OrchestratorPlanIdAction, (planId: string) => string> =
  {
    orchestrator_message: (planId) =>
      `Send a follow-up message about plan ${planId}. The reply arrives as composition progress and may carry a revised plan.`,
    orchestrator_cancel: (planId) =>
      `Stop generation for plan ${planId}. The row remains for review or discard.`,
    // Accept must go through proposals.accept, never runs:start directly, so
    // concurrent or repeated accepts of one planId share exactly one run.
    orchestrator_accept: (planId) =>
      `Create the run for plan ${planId} exactly once. A repeat accept returns the same run.`,
    // Discarding an accepted row refuses with false; surface that, never retry.
    orchestrator_discard: (planId) => `Tombstone plan ${planId}.`,
  };

function orchestratorPlanIdAction(
  deps: SmithActionToolDeps,
  op: OrchestratorPlanIdAction,
  params: unknown,
): ReturnType<typeof immediate> {
  const gated = resolveGatedArgs(op, params, undefined);
  if (!gated.ok) return Promise.resolve(json({ ok: false, error: gated.error }));
  const label = op.replaceAll('_', ' ');
  const planId = stringField(params, 'planId') ?? '';
  return proposeAction(deps, {
    operation: op,
    title: `${label} proposal`,
    summary: ORCHESTRATOR_PLAN_ID_SUMMARIES[op](planId),
    args: gated.shownArgs,
    risk: RISKS[op] ?? 'write',
    execute: () => deps.invoke(ACTION_CHANNELS[op], ...gated.args),
  });
}

function orchestratorPlanAction(
  deps: SmithActionToolDeps,
  params: unknown,
  projectId: string,
): ReturnType<typeof immediate> {
  const prompt =
    stringField(params, 'prompt') ?? stringField(params, 'request') ?? stringField(params, 'text');
  if (!prompt) return Promise.resolve(json({ ok: false, error: 'prompt is required' }));
  const model = stringField(params, 'model');
  const reasoningEffort = stringField(params, 'reasoningEffort');
  if (reasoningEffort && !ORCHESTRATOR_EFFORTS.includes(reasoningEffort as ReasoningEffort)) {
    return Promise.resolve(
      json({ ok: false, error: 'reasoningEffort must be low, medium, or high' }),
    );
  }
  const shownArgs: Record<string, unknown> = { projectId, prompt };
  if (model) shownArgs.model = model;
  if (reasoningEffort) shownArgs.reasoningEffort = reasoningEffort;
  return proposeAction(deps, {
    operation: 'orchestrator_plan',
    title: 'Ask Smith to compose a run plan',
    summary:
      'Ask Smith to compose a run plan for this prompt. Returns a planId immediately; the plan (or the failure) arrives as composition progress. Confirm the prompt text before proposing.',
    args: shownArgs,
    risk: RISKS.orchestrator_plan ?? 'write',
    execute: async () => {
      const settings = await deps
        .invoke<AppSettings>(IPC.settingsGet)
        .catch(() => defaultSettings());
      const resolved = resolveSmithModel(settings, 'compose', {
        model: model ?? undefined,
        reasoningEffort: (reasoningEffort as ReasoningEffort | null) ?? undefined,
      });
      return deps.invoke(
        IPC.orchestratorPlan,
        projectId,
        prompt,
        resolved.model,
        resolved.reasoningEffort,
      );
    },
  });
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
    const assigned = field(params, 'assigned');
    if (assigned !== undefined && typeof assigned !== 'boolean') {
      return Promise.resolve(json({ ok: false, error: 'assigned must be a boolean' }));
    }
    // A voice transcript ("what's assigned to me") reads as assigned intent
    // with no usable text filter; an explicit flag always wins.
    const intent = splitLinearAssignedIntent(query ?? '', assigned);
    return intent.assigned
      ? immediate(deps, IPC.linearIssues, intent.query, { assigned: true })
      : immediate(deps, IPC.linearIssues, intent.query);
  }
  if (op === 'linear_issue') {
    const issueId = stringField(params, 'issueId');
    return issueId
      ? immediate(deps, IPC.linearIssue, issueId)
      : Promise.resolve(json({ ok: false, error: 'issueId is required' }));
  }
  const teamId = stringField(params, 'teamId');
  return teamId
    ? immediate(deps, IPC.linearWorkflowStates, teamId)
    : Promise.resolve(json({ ok: false, error: 'teamId is required' }));
}
