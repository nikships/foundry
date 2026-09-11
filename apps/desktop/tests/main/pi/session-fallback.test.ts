/**
 * A mid-turn failover moves the live turn onto its replacement while the
 * roster value stays put for session identity. The persisted row and the log
 * payload carry both ids, so agent displays can name the active fallback
 * without losing what failed.
 */

import { describe, expect, it } from 'vitest';
import { tempDir } from '../../helpers/tmp.js';
import { AgentSession } from '../../../src/main/pi/session.js';
import type { TransportRequest } from '../../../src/main/pi/session.js';
import type { AgentTransport } from '../../../src/main/pi/transport.js';
import { openDb, projectDbPath, projectRunsDir } from '../../../src/main/trace/db.js';
import { Tracer } from '../../../src/main/trace/tracer.js';
import type { AgentDef } from '../../../src/shared/types.js';

const WARNING =
  'anthropic/claude-sonnet-4 failed after 5 retries; continuing this turn on openai/gpt-5';

const agent: AgentDef = {
  name: 'scout',
  purpose: 'look around',
  model: 'anthropic/claude-sonnet-4',
  reasoningEffort: 'off',
  systemPrompt: 'You scout.',
  userPrompt: '{{request}}',
  writes: null,
  envelope: 'none',
  color: '#abc',
};

function setup(): { tracer: Tracer; runId: string; phaseId: string; worktree: string } {
  const support = tempDir('foundry-session-fallback-');
  const worktree = tempDir('foundry-session-fallback-wt-');
  const db = openDb(projectDbPath(support, 'proj'));
  const tracer = new Tracer(db, projectRunsDir(support, 'proj'));
  const runId = `run_${Math.random().toString(36).slice(2, 8)}`;
  tracer.startRun({
    runId,
    projectId: 'proj',
    pipeline: {
      id: 'p',
      name: 'p',
      description: '',
      acceptance: { kind: 'all_phases_pass' },
      phases: [],
    },
    request: 'go',
    engineer: 'test',
    worktreePath: worktree,
    branch: null,
    baseRef: 'main',
    mode: 'pi',
  });
  const phaseId = tracer.openPhase({
    runId,
    seq: 0,
    name: 'scout',
    kind: 'agent',
    owner: agent.name,
    description: 'look around',
  });
  return { tracer, runId, phaseId, worktree };
}

function transportWithWarning(warning: string): (req: TransportRequest) => AgentTransport {
  return (req) =>
    ({
      id: 'sess1',
      alive: true,
      pid: undefined,
      lastUserMessageId: null,
      packageTools: [],
      availableModels: [],
      activeModel: 'openai/gpt-5',
      activeReasoningEffort: 'off',
      start: async () => {
        req.onModelWarning?.(warning);
      },
      send: async () => ({
        text: 'ok',
        usage: null,
        reason: 'stop',
        interrupted: false,
        structuredOutput: null,
      }),
      applySettings: async () => ({ model: 'openai/gpt-5' }),
      contextStats: async () => null,
      contextBreakdown: async () => null,
      compact: async () => null,
      getRewindInfo: async () => null,
      rewind: async () => null,
      interrupt: async () => {},
      close: async () => {},
      kill: () => {},
    }) as unknown as AgentTransport;
}

describe('AgentSession model fallback', () => {
  it('keeps the roster model for identity while reporting the active fallback', async () => {
    const { tracer, runId, phaseId, worktree } = setup();
    const session = new AgentSession(agent, {
      runId,
      worktree,
      tracer,
      protectedPaths: [],
      transport: transportWithWarning(WARNING),
    });

    await session.send('go', { phaseId });
    await session.close();

    expect(session.model).toBe('anthropic/claude-sonnet-4');
    expect(session.activeModel).toBe('openai/gpt-5');
  });

  it('persists the replacement model while preserving failed and fallback ids', async () => {
    const { tracer, runId, phaseId, worktree } = setup();
    const session = new AgentSession(agent, {
      runId,
      worktree,
      tracer,
      protectedPaths: [],
      transport: transportWithWarning(WARNING),
    });

    await session.send('go', { phaseId });
    await session.close();

    expect(tracer.agentSessions(runId)[0]?.model).toBe('openai/gpt-5');
    const warning = tracer
      .eventsAfter(runId, 0)
      .find((event) => event.type === 'log' && event.name === 'scout: model');
    expect(warning?.payload.message).toBe(WARNING);
    expect(warning?.payload.failedModel).toBe('anthropic/claude-sonnet-4');
    expect(warning?.payload.fallbackModel).toBe('openai/gpt-5');
  });

  it('leaves non-fallback sessions on the roster model with a plain warning', async () => {
    const { tracer, runId, phaseId, worktree } = setup();
    const session = new AgentSession(agent, {
      runId,
      worktree,
      tracer,
      protectedPaths: [],
      transport: transportWithWarning('extension error (x): boom'),
    });

    await session.send('go', { phaseId });
    await session.close();

    expect(session.model).toBe('anthropic/claude-sonnet-4');
    expect(session.activeModel).toBe('anthropic/claude-sonnet-4');
    expect(tracer.agentSessions(runId)[0]?.model).toBe('anthropic/claude-sonnet-4');
  });
});
