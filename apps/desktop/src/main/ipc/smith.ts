/**
 * The Smith IPC slice: native chat lifecycle and the approval gate. Chat sends
 * return immediately after marking a turn live; cloned transcript snapshots
 * continue over `smith-progress`.
 */

import type {
  AgentDef,
  EnvelopeDef,
  PipelineDef,
  ReasoningEffort,
  SmithEntityProposal,
  SmithProposalAnswer,
} from '@shared/types.js';
import { isReasoningEffort } from '@shared/reasoning-effort.js';
import { IPC, type SmithChatState, type SmithScreenContext } from '@shared/ipc-contract.js';
import type { AppContext } from '../context.js';
import type { Handle } from './shared.js';
import { notifySettings } from './shared.js';

type Ctx = Pick<AppContext, 'smith' | 'broadcast'>;

export function register(ctx: Ctx, handle: Handle): void {
  handle(
    IPC.smithSend,
    (
      projectId: string | undefined,
      text: string,
      screen: SmithScreenContext,
    ): SmithChatState | null => {
      const chat = ctx.smith.chat(projectId);
      if (!chat) return null;
      if (!text.trim()) return chat.snapshot();
      // The invoke acknowledges the turn; transcript progress and completion
      // are pushed. SmithChatSession records failures in its own state before
      // rejecting, so the detached promise cannot hide an error from the UI.
      void chat.send(text, { screen }).catch(() => undefined);
      return chat.snapshot();
    },
  );

  handle(IPC.smithCancel, async (projectId?: string): Promise<SmithChatState | null> => {
    const chat = ctx.smith.chat(projectId);
    if (!chat) return null;
    await chat.cancel();
    return chat.snapshot();
  });

  handle(IPC.smithNewChat, async (projectId?: string): Promise<SmithChatState | null> => {
    const chat = ctx.smith.chat(projectId);
    if (!chat) return null;
    await chat.newChat();
    return chat.snapshot();
  });

  handle(
    IPC.smithState,
    (projectId?: string): SmithChatState | null => ctx.smith.chat(projectId)?.snapshot() ?? null,
  );

  handle(
    IPC.smithSetModel,
    async (projectId: string | undefined, model: string): Promise<SmithChatState | null> => {
      const chat = ctx.smith.chat(projectId);
      if (!chat) return null;
      if (!model.trim()) throw new Error('model is required');
      await chat.setModel(model);
      return chat.snapshot();
    },
  );

  handle(
    IPC.smithSetReasoningEffort,
    async (
      projectId: string | undefined,
      effort: ReasoningEffort,
    ): Promise<SmithChatState | null> => {
      const chat = ctx.smith.chat(projectId);
      if (!chat) return null;
      // The renderer's picker is filtered by the model's capabilities, but the
      // channel is not the picker: an unknown level would reach a provider.
      if (!isReasoningEffort(effort)) throw new Error('a known reasoning effort is required');
      await chat.setReasoningEffort(effort);
      return chat.snapshot();
    },
  );

  handle(IPC.smithProposalsList, () => ctx.smith.proposals.list());
  handle(IPC.smithAnswerProposal, (id: string, answer: SmithProposalAnswer) =>
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
  proposal: SmithEntityProposal,
): { ok: true; entity: unknown } | { ok: false; error: string } {
  const projectId = proposal.targetProjectId ?? proposal.projectId;
  const knownEnvelopes = ctx.envelopes.list().map((e) => e.name);
  const finish = (
    result: { ok: true } | { ok: false; issues: { where: string; message: string }[] },
    entity: unknown,
  ): { ok: true; entity: unknown } | { ok: false; error: string } => {
    if (!result.ok) return { ok: false, error: issueText(result.issues) };
    notifySettings(ctx);
    return { ok: true, entity };
  };

  if (proposal.kind === 'agent') {
    const agent = proposal.spec as AgentDef;
    return finish(ctx.roster.save(agent, ctx.rosterScope(projectId), knownEnvelopes), agent);
  }

  if (proposal.kind === 'pipeline') {
    const pipeline = proposal.spec as PipelineDef;
    return finish(
      ctx.pipelines.save(
        pipeline,
        ctx.rosterFor(projectId),
        ctx.commandNames(projectId),
        ctx.pipelineScope(projectId),
        knownEnvelopes,
      ),
      pipeline,
    );
  }

  const envelope = proposal.spec as EnvelopeDef;
  return finish(ctx.envelopes.save(envelope), envelope);
}

function issueText(issues: { where: string; message: string }[]): string {
  return issues.map((i) => `${i.where}: ${i.message}`).join('; ') || 'save failed';
}
