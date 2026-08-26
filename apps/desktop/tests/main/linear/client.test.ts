import { describe, expect, it, vi } from 'vitest';
import { LinearClient, type LinearTransport } from '../../../src/main/linear/client.js';

const rawIssue = {
  id: 'issue-uuid',
  identifier: 'FOU-190',
  title: 'Add Linear integration',
  description: 'Start a pipeline from this issue.',
  url: 'https://linear.app/foundry/issue/FOU-190',
  updatedAt: '2026-08-25T19:09:16.054Z',
  team: { id: 'team-uuid', name: 'Foundry' },
  state: { id: 'todo-state', name: 'Todo', type: 'unstarted' },
};

function response(data: unknown, status = 200): { status: number; body: string } {
  return { status, body: JSON.stringify(data) };
}

describe('LinearClient', () => {
  it('authenticates personal API keys without adding the OAuth Bearer prefix', async () => {
    const transport = vi.fn<LinearTransport>(async () =>
      response({ data: { viewer: { id: 'user-1', name: 'Nikhil' } } }),
    );
    const client = new LinearClient({ apiKey: 'lin_api_secret', transport, retries: 0 });

    await expect(client.test()).resolves.toEqual({ id: 'user-1', name: 'Nikhil' });
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.linear.app/graphql',
        headers: expect.objectContaining({ Authorization: 'lin_api_secret' }),
      }),
    );
  });

  it('treats GraphQL errors on HTTP 200 as failures', async () => {
    const client = new LinearClient({
      apiKey: 'secret',
      retries: 0,
      transport: async () =>
        response({
          data: { issue: rawIssue },
          errors: [{ message: 'not authorized', extensions: { code: 'AUTHENTICATION_ERROR' } }],
        }),
    });

    await expect(client.issue('FOU-190')).rejects.toMatchObject({
      kind: 'auth',
      message: 'not authorized',
    });
  });

  it('retries rate limits and temporary server failures, then parses the issue', async () => {
    const sleep = vi.fn(async () => undefined);
    const transport = vi
      .fn<LinearTransport>()
      .mockResolvedValueOnce({ status: 429, body: '', retryAfterMs: 10 })
      .mockResolvedValueOnce({ status: 503, body: '' })
      .mockResolvedValueOnce(response({ data: { issue: rawIssue } }));
    const client = new LinearClient({ apiKey: 'secret', transport, sleep, retries: 2 });

    await expect(client.issue('FOU-190')).resolves.toMatchObject({
      id: 'issue-uuid',
      identifier: 'FOU-190',
      team: { id: 'team-uuid' },
      state: { id: 'todo-state' },
    });
    expect(transport).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 10);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('retries network errors without leaking the API key in the final message', async () => {
    const transport = vi.fn<LinearTransport>(async () => {
      throw new Error('socket closed');
    });
    const client = new LinearClient({
      apiKey: 'lin_api_do_not_print',
      transport,
      sleep: async () => undefined,
      retries: 1,
    });

    await expect(client.test()).rejects.toThrow('Could not reach Linear: socket closed');
    await client.test().catch((error: Error) => {
      expect(error.message).not.toContain('lin_api_do_not_print');
    });
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it('updates only stateId and returns the updated issue snapshot', async () => {
    const transport = vi.fn<LinearTransport>(async (input) => {
      const request = JSON.parse(input.body) as {
        query: string;
        variables: Record<string, unknown>;
      };
      expect(request.query).toContain('issueUpdate');
      expect(request.variables).toEqual({ issueId: 'issue-uuid', stateId: 'done-state' });
      return response({
        data: {
          issueUpdate: {
            success: true,
            issue: { ...rawIssue, state: { id: 'done-state', name: 'Done', type: 'completed' } },
          },
        },
      });
    });
    const client = new LinearClient({ apiKey: 'secret', transport, retries: 0 });

    await expect(client.updateIssueState('issue-uuid', 'done-state')).resolves.toMatchObject({
      state: { id: 'done-state', name: 'Done' },
      title: rawIssue.title,
      description: rawIssue.description,
    });
  });
});
