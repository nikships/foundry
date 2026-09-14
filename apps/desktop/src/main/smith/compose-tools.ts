import type { GeneratedRunPlan, ProposalSnapshot, ReasoningEffort } from '@shared/types.js';
import { smithRunPlanArtifact } from '@shared/smith-run-plan.js';
import { defineTool, type ToolDefinition } from '../pi/tool-definition.js';
import { startComposeWithPrep, type ComposeContext } from './compose/after-start.js';
import type { AppContext } from '../context.js';
import {
  booleanField,
  errorMessage,
  field,
  json,
  objectField,
  parseOperation,
  proposeAction,
  requireProjectId,
  resolveProjectId,
  stringField,
  type SmithActionToolDeps,
} from './tool-helpers.js';

const OPERATIONS = ['compose', 'revise', 'get', 'list', 'accept', 'discard', 'cancel'] as const;
type ComposeDeps = Pick<SmithActionToolDeps, 'queue' | 'projectId'> & {
  ctx: ComposeContext & Pick<AppContext, 'plans'>;
};
const CARD_NOTE =
  'The card arrives in this chat when ready. Stop; do not poll or start the same work again.';
const CAP_REFUSAL =
  'This chat already has 3 generating plans. Wait for one to finish, or request cancellation before composing another.';

/** Registered only in persistent Smith chats; never invokes an IPC handler. */
export function smithComposeTool(deps: ComposeDeps): ToolDefinition {
  return defineTool({
    name: 'smith_compose',
    label: 'Smith compose',
    description: [
      'Compose and discuss run plans. compose(prompt,model?,reasoningEffort?,projectId?) and revise(planId,note) run immediately, read-only. Global compose requires projectId.',
      'get(planId) and list(projectId?,includeAccepted?) return bounded summaries, not plan JSON. list defaults to the chat scope (all projects in global chat).',
      'Approval: accept(planId,plan?) starts exactly one run; plan is an optional full recast, never a patch. Omit it to accept the stored plan. discard(planId) tombstones; cancel(planId) stops a live composition.',
      'An expired session refuses revision; explain the refusal. Never silently replace it.',
      CARD_NOTE,
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: [...OPERATIONS] },
        projectId: { type: 'string' },
        prompt: { type: 'string', minLength: 1 },
        model: { type: 'string' },
        reasoningEffort: { type: 'string', enum: ['low', 'medium', 'high'] },
        planId: { type: 'string' },
        note: { type: 'string', minLength: 1, maxLength: 12000 },
        includeAccepted: { type: 'boolean' },
        plan: { type: 'object', description: 'Optional full recast for accept, never a patch.' },
      },
      required: ['operation'],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      try {
        return await composeOperation(deps, params);
      } catch (error) {
        return json({ ok: false, error: errorMessage(error) });
      }
    },
  });
}

function composeOperation(deps: ComposeDeps, params: unknown) {
  const op = parseOperation(params, OPERATIONS);
  if (!op) return json({ ok: false, error: 'unknown operation' });
  if (op === 'compose') return compose(deps, params);
  if (op === 'list') return list(deps, params);
  const planId = stringField(params, 'planId');
  if (!planId) return json({ ok: false, error: 'planId is required' });
  if (op === 'get') return json({ ok: true, result: projection(deps.ctx.proposals.get(planId)) });
  if (op === 'revise') return revise(deps, planId, params);
  const plan = field(params, 'plan');
  if (op === 'accept' && plan !== undefined && !objectField(params, 'plan')) {
    return json({ ok: false, error: 'plan must be an object' });
  }
  return proposeAction(deps, {
    operation: `compose_${op}`,
    title: `${op} run plan`,
    summary:
      op === 'accept'
        ? `Create the run for plan ${planId} exactly once using the stored plan or full recast.`
        : `${op === 'discard' ? 'Tombstone' : 'Stop generation for'} plan ${planId}.`,
    args: { planId, ...(op === 'accept' && plan !== undefined ? { plan } : {}) },
    risk: op === 'discard' ? 'destructive' : 'write',
    execute: async () =>
      op === 'accept'
        ? deps.ctx.proposals.accept(planId, plan as GeneratedRunPlan | undefined)
        : deps.ctx.proposals[op](planId),
  });
}

function compose(deps: ComposeDeps, params: unknown) {
  const scope = requireProjectId(field(params, 'projectId'), deps.projectId());
  if (!scope.ok) return json(scope);
  const prompt = stringField(params, 'prompt');
  if (!prompt) return json({ ok: false, error: 'prompt is required' });
  const effort = field(params, 'reasoningEffort');
  if (effort !== undefined && !['low', 'medium', 'high'].includes(String(effort))) {
    return json({ ok: false, error: 'reasoningEffort must be low, medium, or high' });
  }
  if (deps.ctx.proposals.generatingForScope(deps.projectId()) >= 3) {
    return json({ ok: false, error: CAP_REFUSAL });
  }
  const started = startComposeWithPrep(deps.ctx, scope.projectId, {
    prompt,
    model: stringField(params, 'model') ?? undefined,
    reasoningEffort: effort as ReasoningEffort | undefined,
  });
  if ('error' in started) return json({ ok: false, error: started.error });
  deps.ctx.proposals.recordIssuingScope(started.planId, deps.projectId());
  return json({ ok: true, result: { ...started, status: 'generating' }, note: CARD_NOTE });
}

function revise(deps: ComposeDeps, planId: string, params: unknown) {
  const note = stringField(params, 'note');
  if (!note) return json({ ok: false, error: 'note is required' });
  const row = deps.ctx.proposals.get(planId);
  if (!row) return json({ ok: false, error: 'Proposal unavailable.' });
  if (row.status !== 'ready')
    return json({ ok: false, error: `Cannot revise a ${row.status} proposal.` });
  if (deps.ctx.proposals.generatingForScope(deps.projectId()) >= 3) {
    return json({ ok: false, error: CAP_REFUSAL });
  }
  const refused = deps.ctx.plans.message(planId, note);
  if (refused) return json({ ok: false, error: refused });
  deps.ctx.proposals.recordIssuingScope(planId, deps.projectId());
  return json({ ok: true, result: projection(deps.ctx.proposals.get(planId)), note: CARD_NOTE });
}

function list(deps: ComposeDeps, params: unknown) {
  const scope = resolveProjectId(field(params, 'projectId'), deps.projectId());
  if (!scope.ok) return json(scope);
  const ids = scope.projectId ? [scope.projectId] : deps.ctx.projects.list().map((p) => p.id);
  const active = new Set(['ready', 'generating', 'failed']);
  const rows = ids
    .flatMap((id) => deps.ctx.proposals.list(id))
    .filter((row) => booleanField(params, 'includeAccepted') || row.status !== 'accepted')
    .sort(
      (a, b) =>
        Number(active.has(b.status)) - Number(active.has(a.status)) || b.updatedAt - a.updatedAt,
    );
  return json({ ok: true, result: rows.map(projection) });
}

function projection(row: ProposalSnapshot | null) {
  if (!row) return null;
  const card = smithRunPlanArtifact(row);
  return {
    planId: card.planId,
    projectId: card.projectId,
    status: card.status,
    detail: row.detail.slice(0, 1000),
    revision: card.revision,
    refinedRequest: card.refinedRequest,
    rationale: card.rationale,
    phases: card.phases,
    warnings: card.warnings,
    synthesizedAgents:
      (row.acceptedPlan ?? row.plan)?.agents.slice(0, 50).map((agent) => ({
        name: agent.name.slice(0, 200),
        purpose: agent.purpose.slice(0, 1000),
      })) ?? [],
    ...(card.acceptedRunId ? { acceptedRunId: card.acceptedRunId } : {}),
  };
}
