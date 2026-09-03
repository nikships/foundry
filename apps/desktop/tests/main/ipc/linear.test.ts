import { describe, expect, it, vi } from 'vitest';
import { register } from '../../../src/main/ipc/linear.js';
import type { Handle } from '../../../src/main/ipc/shared.js';
import { IPC, type LinearActionResult } from '../../../src/shared/ipc-contract.js';
import type { LinearIssueSnapshot, LinearWorkflowState } from '../../../src/shared/types.js';

type Handler = (...args: never[]) => unknown;

function setup(): {
  handlers: Map<string, Handler>;
  setApiKey: ReturnType<typeof vi.fn>;
  issues: ReturnType<typeof vi.fn>;
  issue: ReturnType<typeof vi.fn>;
  workflowStates: ReturnType<typeof vi.fn>;
} {
  const handlers = new Map<string, Handler>();
  const handle: Handle = (channel, handler) => handlers.set(channel, handler);
  const setApiKey = vi.fn(async (): Promise<LinearActionResult> => ({
    ok: true,
    detail: 'connected',
  }));
  const issues = vi.fn(async (): Promise<LinearIssueSnapshot[]> => []);
  const issue = vi.fn(async (): Promise<LinearIssueSnapshot> => {
    throw new Error('not used');
  });
  const workflowStates = vi.fn(async (): Promise<LinearWorkflowState[]> => []);
  register(
    {
      linear: {
        state: () => ({ keySet: true, detail: 'stored' }),
        setApiKey,
        test: async () => ({ ok: true, detail: 'connected' }),
        clearApiKey: () => ({ ok: true, detail: 'removed' }),
        issues,
        issue,
        workflowStates,
      },
    } as never,
    handle,
  );
  return { handlers, setApiKey, issues, issue, workflowStates };
}

describe('Linear IPC validation', () => {
  it('trims and delegates a valid key but rejects an invalid one at the privileged boundary', async () => {
    const { handlers, setApiKey } = setup();
    const save = handlers.get(IPC.linearSetApiKey) as (
      apiKey: string,
    ) => Promise<LinearActionResult>;

    await expect(save('  lin_api_candidate  ')).resolves.toEqual({
      ok: true,
      detail: 'connected',
    });
    expect(setApiKey).toHaveBeenCalledWith('lin_api_candidate');
    await expect(save('   ')).resolves.toMatchObject({ ok: false });
    expect(setApiKey).toHaveBeenCalledTimes(1);
  });

  it('bounds issue lookups and requires a team id', async () => {
    const { handlers, issues, issue, workflowStates } = setup();
    const browse = handlers.get(IPC.linearIssues) as (
      query: string,
    ) => Promise<LinearIssueSnapshot[]>;
    const detail = handlers.get(IPC.linearIssue) as (
      issueId: string,
    ) => Promise<LinearIssueSnapshot>;
    const states = handlers.get(IPC.linearWorkflowStates) as (
      teamId: string,
    ) => Promise<LinearWorkflowState[]>;

    await browse('  FOU-190  ');
    expect(issues).toHaveBeenCalledWith('FOU-190');
    expect(() => browse('x'.repeat(201))).toThrow('200 characters or fewer');
    await expect(detail('  issue-id  ')).rejects.toThrow('not used');
    expect(issue).toHaveBeenCalledWith('issue-id');
    expect(() => detail('')).toThrow('valid Linear issue ID');
    await states('  team-id  ');
    expect(workflowStates).toHaveBeenCalledWith('team-id');
    expect(() => states('')).toThrow('valid Linear team ID');
  });

  it('rejects malformed start input without touching run dependencies', async () => {
    const { handlers } = setup();
    const start = handlers.get(IPC.linearStartRun) as (input: unknown) => Promise<{
      ok: boolean;
      issues: { where: string; message: string }[];
    }>;

    await expect(start({ projectId: '', pipelineId: 'ship', issueId: 'FOU-190' })).resolves.toEqual(
      {
        ok: false,
        issues: [{ level: 'error', where: 'linear', message: 'Invalid run source.' }],
      },
    );
    await expect(
      start({ projectId: 'project', pipelineId: 'ship', issueId: 'FOU-190', plan: 'not-a-plan' }),
    ).resolves.toMatchObject({
      ok: false,
      issues: [{ where: 'linear', message: 'Invalid run source.' }],
    });
  });
});
