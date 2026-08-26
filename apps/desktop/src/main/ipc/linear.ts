import { z } from 'zod';
import {
  IPC,
  type LinearActionResult,
  type LinearConnectionState,
  type LinearStartRunInput,
} from '@shared/ipc-contract.js';
import type { GeneratedRunPlan, LinearIssueSnapshot, LinearWorkflowState } from '@shared/types.js';
import type { AppContext } from '../context.js';
import { startLinearIssueRun } from '../linear/orchestration.js';
import type { Handle } from './shared.js';
import { runStartDeps, type RunStartContext } from './runs.js';

type Ctx = RunStartContext & Pick<AppContext, 'linear'>;

const shortString = z.string().trim().min(1).max(128);
const startSchema = z.object({
  projectId: shortString,
  pipelineId: shortString,
  issueId: shortString,
  plan: z
    .custom<GeneratedRunPlan>((value) => Boolean(value && typeof value === 'object'))
    .optional(),
});

export function register(ctx: Ctx, handle: Handle): void {
  handle(IPC.linearState, (): LinearConnectionState => ctx.linear.state());
  handle(IPC.linearSetApiKey, (apiKey: string): Promise<LinearActionResult> => {
    const parsed = z.string().trim().min(1).max(4096).safeParse(apiKey);
    if (!parsed.success)
      return Promise.resolve({ ok: false, detail: 'Enter a valid Linear API key.' });
    return ctx.linear.setApiKey(parsed.data);
  });
  handle(IPC.linearTest, (): Promise<LinearActionResult> => ctx.linear.test());
  handle(IPC.linearClearApiKey, (): LinearActionResult => ctx.linear.clearApiKey());
  handle(IPC.linearIssues, (query: string): Promise<LinearIssueSnapshot[]> => {
    const parsed = z.string().trim().max(200).safeParse(query);
    if (!parsed.success) throw new Error('Linear issue search must be 200 characters or fewer');
    return ctx.linear.issues(parsed.data);
  });
  handle(IPC.linearWorkflowStates, (teamId: string): Promise<LinearWorkflowState[]> => {
    const parsed = shortString.safeParse(teamId);
    if (!parsed.success) throw new Error('A valid Linear team ID is required');
    return ctx.linear.workflowStates(parsed.data);
  });
  handle(IPC.linearStartRun, async (input: LinearStartRunInput) => {
    const parsed = startSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        issues: [{ level: 'error' as const, where: 'linear', message: 'Invalid run source.' }],
      };
    }
    try {
      return await startLinearIssueRun(
        runStartDeps(ctx),
        ctx.linear,
        ctx.settings.get().linearStatusMapping,
        parsed.data,
      );
    } catch (error) {
      return {
        ok: false,
        issues: [
          {
            level: 'error' as const,
            where: 'linear',
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  });
}
