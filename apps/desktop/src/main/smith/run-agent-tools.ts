import { z } from 'zod';
import { IPC } from '@shared/ipc-contract.js';
import {
  errorMessage,
  immediate,
  json,
  proposeAction,
  type SmithActionToolDeps,
} from './tool-helpers.js';

export const RUN_AGENT_OPERATIONS = [
  'agents',
  'conversation',
  'messages',
  'message_phase',
  'interrupt_phase',
] as const;
export type RunAgentOperation = (typeof RUN_AGENT_OPERATIONS)[number];

const inputSchema = z.object({
  runId: z.string().min(1),
  phaseId: z.string().min(1).optional(),
  text: z.string().trim().min(1).max(12_000).optional(),
  cursor: z.object({ line: z.number().int().min(1), offset: z.number().int().min(0) }).optional(),
});

export async function runAgentOperation(
  deps: SmithActionToolDeps,
  op: RunAgentOperation,
  projectId: string,
  params: unknown,
) {
  const parsed = inputSchema.safeParse(params);
  if (!parsed.success) return json({ ok: false, error: parsed.error.message });
  const { runId, phaseId, text, cursor } = parsed.data;
  if (op === 'agents') return immediate(deps, IPC.runsAgents, projectId, runId);
  if (op === 'messages') return immediate(deps, IPC.runsMessages, projectId, runId);
  if (!phaseId) return json({ ok: false, error: 'phaseId is required; use agents to find it' });
  if (op === 'conversation')
    return immediate(deps, IPC.runsConversation, projectId, runId, phaseId, cursor);
  if (op === 'message_phase' && !text) return json({ ok: false, error: 'text is required' });
  try {
    return await proposeAction(deps, {
      operation: op,
      title: op === 'message_phase' ? 'Deliver phase direction' : 'Interrupt phase turn',
      summary:
        op === 'message_phase'
          ? 'Queue this exact note for the phase. Completed phases keep it as a note only. Does not resume, restart, or bypass gates.'
          : 'Interrupt the current turn; partial output and tokens may be lost. Keep the worktree. Resume remains a separate action.',
      args: { projectId, runId, phaseId, ...(text ? { text } : {}) },
      risk: op === 'message_phase' ? 'write' : 'destructive',
      execute: () =>
        op === 'message_phase'
          ? deps.invoke(IPC.runsMessagePhase, projectId, runId, phaseId, text)
          : deps.invoke(IPC.runsInterruptPhase, projectId, runId, phaseId),
    });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) });
  }
}
