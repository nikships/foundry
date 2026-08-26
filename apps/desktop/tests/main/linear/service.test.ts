import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../helpers/tmp.js';
import { openDb, projectDbPath, projectRunsDir } from '../../../src/main/trace/db.js';
import { Tracer } from '../../../src/main/trace/tracer.js';
import { LinearClient, type LinearTransport } from '../../../src/main/linear/client.js';
import { LinearService } from '../../../src/main/linear/service.js';
import type { LinearCredentials } from '../../../src/main/linear/credentials.js';
import type {
  LinearRunSource,
  LinearStatusMapping,
  LinearWorkflowState,
  PipelineDef,
} from '../../../src/shared/types.js';

const states: LinearWorkflowState[] = [
  { id: 'todo', name: 'Todo', type: 'unstarted' },
  { id: 'progress', name: 'In Progress', type: 'started' },
  { id: 'done', name: 'Done', type: 'completed' },
  { id: 'failed', name: 'Canceled', type: 'canceled' },
];
const mapping: LinearStatusMapping = {
  started: 'progress',
  completed: 'done',
  failed: 'failed',
};
const source: LinearRunSource = {
  kind: 'linear',
  trigger: 'manual',
  issueId: 'issue-uuid',
  url: 'https://linear.app/foundry/issue/FOU-190',
  revision: '2026-08-25T19:09:16.054Z',
  statusMapping: mapping,
  snapshot: {
    id: 'issue-uuid',
    identifier: 'FOU-190',
    title: 'Add Linear ticket orchestration integration',
    description: 'Use the issue as a run brief.',
    url: 'https://linear.app/foundry/issue/FOU-190',
    updatedAt: '2026-08-25T19:09:16.054Z',
    team: { id: 'team-uuid', name: 'Foundry' },
    state: states[0]!,
  },
};
const pipeline: PipelineDef = {
  id: 'linear',
  name: 'Linear',
  description: 'Lifecycle fixture.',
  phases: [],
  acceptance: { kind: 'all_phases_pass' },
};

function memoryCredentials(initial: string | null): {
  credentials: LinearCredentials;
  current: () => string | null;
} {
  let value = initial;
  return {
    credentials: {
      has: () => value !== null,
      get: () => value,
      set: (next) => {
        value = next;
      },
      clear: () => {
        value = null;
      },
    },
    current: () => value,
  };
}

function json(data: unknown): { status: number; body: string } {
  return { status: 200, body: JSON.stringify(data) };
}

function startTrace(): Tracer {
  const support = tempDir('foundry-linear-lifecycle-');
  const tracer = new Tracer(
    openDb(projectDbPath(support, 'project')),
    projectRunsDir(support, 'project'),
  );
  tracer.startRun({
    runId: 'run-linear',
    projectId: 'project',
    pipeline,
    request: 'Implement FOU-190',
    engineer: 'tester',
    worktreePath: null,
    branch: null,
    baseRef: 'main',
    mode: 'pi',
    source,
  });
  return tracer;
}

describe('LinearService credentials', () => {
  it('validates before save or replacement, tests the saved key, and removes it', async () => {
    const memory = memoryCredentials('old-key');
    const usedKeys: string[] = [];
    const service = new LinearService(memory.credentials, (apiKey) => {
      usedKeys.push(apiKey);
      return new LinearClient({
        apiKey,
        retries: 0,
        transport: async () =>
          apiKey === 'bad-key'
            ? json({
                errors: [
                  { message: 'not authorized', extensions: { code: 'AUTHENTICATION_ERROR' } },
                ],
              })
            : json({ data: { viewer: { id: 'user-1', name: 'Nikhil' } } }),
      });
    });

    await expect(service.setApiKey(' bad-key ')).resolves.toEqual({
      ok: false,
      detail: 'not authorized',
    });
    expect(memory.current()).toBe('old-key');

    await expect(service.setApiKey(' new-key ')).resolves.toEqual({
      ok: true,
      detail: 'Connected to Linear as Nikhil.',
    });
    expect(memory.current()).toBe('new-key');
    await expect(service.test()).resolves.toMatchObject({ ok: true });
    expect(usedKeys).toEqual(['bad-key', 'new-key', 'new-key']);

    expect(service.clearApiKey()).toEqual({ ok: true, detail: 'Linear API key removed.' });
    expect(service.state().keySet).toBe(false);
  });
});

describe('Linear run lifecycle', () => {
  let remoteState: LinearWorkflowState;
  let mutationFailure: string | null;
  let mutationInputs: Record<string, unknown>[];
  let transport: LinearTransport;
  let tracer: Tracer;
  let service: LinearService;

  beforeEach(() => {
    remoteState = states[0]!;
    mutationFailure = null;
    mutationInputs = [];
    transport = vi.fn(async (input) => {
      const request = JSON.parse(input.body) as {
        query: string;
        variables: Record<string, unknown>;
      };
      if (request.query.includes('LinearWorkflowStates')) {
        return json({ data: { workflowStates: { nodes: states } } });
      }
      if (request.query.includes('mutation LinearIssueState')) {
        mutationInputs.push(request.variables);
        if (mutationFailure) {
          return json({
            errors: [{ message: mutationFailure, extensions: { code: 'BAD_USER_INPUT' } }],
          });
        }
        remoteState = states.find((state) => state.id === request.variables.stateId)!;
        return json({ data: { issueUpdate: { success: true, issue: issueWith(remoteState) } } });
      }
      return json({ data: { issue: issueWith(remoteState) } });
    });
    tracer = startTrace();
    service = new LinearService(
      memoryCredentials('saved-key').credentials,
      (apiKey) => new LinearClient({ apiKey, transport, retries: 0 }),
    );
  });

  it('updates only the mapped state and is idempotent when retried', async () => {
    const lifecycle = service.lifecycle({
      source,
      runId: 'run-linear',
      tracer,
    });

    await lifecycle.advance('started');
    await lifecycle.advance('started');

    expect(remoteState.id).toBe('progress');
    expect(mutationInputs).toEqual([{ issueId: 'issue-uuid', stateId: 'progress' }]);
    expect(
      tracer
        .eventsAfter('run-linear', 0)
        .filter((event) => event.name === 'Linear status')
        .map((event) => event.payload.action),
    ).toEqual(['updated', 'already current']);
    expect(tracer.run('run-linear')?.sourceSyncError).toBeNull();
  });

  it('refuses to overwrite an external status change and traces the conflict', async () => {
    const lifecycle = service.lifecycle({
      source,
      runId: 'run-linear',
      tracer,
    });
    await lifecycle.advance('started');
    remoteState = { id: 'external', name: 'Needs review', type: 'started' };

    await expect(lifecycle.advance('completed')).resolves.toBeUndefined();

    expect(mutationInputs).toHaveLength(1);
    expect(tracer.run('run-linear')?.sourceSyncError).toContain('outside Foundry');
    expect(
      tracer
        .eventsAfter('run-linear', 0)
        .some((event) => event.type === 'error' && event.name === 'Linear status'),
    ).toBe(true);
  });

  it('keeps the accepted verdict when a terminal status update fails', async () => {
    const lifecycle = service.lifecycle({
      source,
      runId: 'run-linear',
      tracer,
    });
    await lifecycle.advance('started');
    tracer.finishRun('run-linear', 'accepted', 'all phases passed');
    mutationFailure = 'workflow changed';

    await expect(lifecycle.advance('completed')).resolves.toBeUndefined();

    expect(tracer.run('run-linear')).toMatchObject({
      status: 'accepted',
      outcomeDetail: 'all phases passed',
      sourceSyncError: 'workflow changed',
    });
  });

  it('maps the terminal failure stage to the configured failed state', async () => {
    const lifecycle = service.lifecycle({
      source,
      runId: 'run-linear',
      tracer,
    });

    await lifecycle.advance('failed');

    expect(remoteState.id).toBe('failed');
    expect(mutationInputs).toEqual([{ issueId: 'issue-uuid', stateId: 'failed' }]);
  });
});

function issueWith(state: LinearWorkflowState): LinearRunSource['snapshot'] {
  return { ...source.snapshot, state };
}
