/**
 * The Smith IPC slice: the approval gate, and nothing else. Two invoke channels
 * for the renderer's proposal card, plus `saveProposal`, the store write an
 * approve resolves to.
 */

import type {
  AgentDef,
  EnvelopeDef,
  PipelineDef,
  SmithProposal,
  SmithProposalAnswer,
} from '@shared/types.js';
import { IPC } from '@shared/ipc-contract.js';
import type { AppContext } from '../context.js';
import type { Handle } from './shared.js';
import { notifySettings } from './shared.js';

type Ctx = Pick<AppContext, 'smith' | 'broadcast'>;

export function register(ctx: Ctx, handle: Handle): void {
  handle(IPC.smithProposalsList, () => ctx.smith.proposals.list());
  handle(IPC.smithProposalAnswer, (id: string, answer: SmithProposalAnswer) =>
    ctx.smith.proposals.answer(id, answer),
  );
}

/**
 * Persists an approved proposal through the existing store layer, scope-aware,
 * and broadcasts the same settings-changed event a form save would. Returns the
 * saved entity for the CLI, or an error the proposal card can show. Wired into
 * the queue from `context.ts` so the queue never imports a store.
 */
export function saveProposal(
  ctx: Pick<
    AppContext,
    | 'roster'
    | 'pipelines'
    | 'envelopes'
    | 'rosterScope'
    | 'pipelineScope'
    | 'rosterFor'
    | 'commandNames'
    | 'broadcast'
  >,
  proposal: SmithProposal,
): { ok: true; entity: unknown } | { ok: false; error: string } {
  const projectId = proposal.projectId || undefined;
  const knownEnvelopes = ctx.envelopes.list().map((e) => e.name);

  if (proposal.kind === 'agent') {
    const agent = proposal.spec as AgentDef;
    const result = ctx.roster.save(agent, ctx.rosterScope(projectId), knownEnvelopes);
    if (!result.ok) return { ok: false, error: issueText(result.issues) };
    notifySettings(ctx);
    return { ok: true, entity: agent };
  }

  if (proposal.kind === 'pipeline') {
    const pipeline = proposal.spec as PipelineDef;
    const result = ctx.pipelines.save(
      pipeline,
      ctx.rosterFor(projectId),
      ctx.commandNames(projectId),
      ctx.pipelineScope(projectId),
      knownEnvelopes,
    );
    if (!result.ok) return { ok: false, error: issueText(result.issues) };
    notifySettings(ctx);
    return { ok: true, entity: pipeline };
  }

  const envelope = proposal.spec as EnvelopeDef;
  const result = ctx.envelopes.save(envelope);
  if (!result.ok) return { ok: false, error: issueText(result.issues) };
  notifySettings(ctx);
  return { ok: true, entity: envelope };
}

function issueText(issues: { where: string; message: string }[]): string {
  return issues.map((i) => `${i.where}: ${i.message}`).join('; ') || 'save failed';
}
