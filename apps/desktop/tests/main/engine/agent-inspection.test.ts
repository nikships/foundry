import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRunAgentState } from '../../../src/main/engine/agent-inspection.js';
import { readSessionHistory } from '../../../src/main/pi/session-history.js';
import { openDb, projectDbPath, projectRunsDir } from '../../../src/main/trace/db.js';
import { Tracer } from '../../../src/main/trace/tracer.js';
import type { PipelineDef } from '../../../src/shared/types.js';
import { tempDir } from '../../helpers/tmp.js';

const PIPELINE: PipelineDef = {
  id: 'inspect',
  name: 'Inspect',
  description: 'inspection test',
  phases: [],
  acceptance: { kind: 'all_phases_pass' },
};

function harness(): { tracer: Tracer; runId: string } {
  const support = tempDir('foundry-agent-inspection-');
  const repo = tempDir('foundry-agent-inspection-repo-');
  const tracer = new Tracer(openDb(projectDbPath(support, repo)), projectRunsDir(support, repo));
  const runId = 'run_inspect';
  tracer.startRun({
    runId,
    projectId: 'project',
    pipeline: PIPELINE,
    request: 'inspect this',
    engineer: 'test',
    worktreePath: null,
    branch: null,
    baseRef: 'main',
    mode: 'pi',
  });
  return { tracer, runId };
}

describe('run agent inspection', () => {
  it('reports running and queued phases from persisted trace evidence', () => {
    const { tracer, runId } = harness();
    const running = tracer.openPhase({
      runId,
      seq: 0,
      name: 'build',
      kind: 'agent',
      owner: 'builder',
      description: 'build',
    });
    tracer.queuePhase({
      runId,
      seq: 1,
      name: 'review',
      kind: 'agent',
      owner: 'reviewer',
      description: 'review',
    });
    tracer.upsertAgentSession({
      runId,
      agent: 'builder',
      model: 'anthropic/actual-model',
      reasoningEffort: 'high',
      agentSessionId: 'session-one',
      mode: 'pi',
      color: '#fff',
    });
    tracer.event({
      runId,
      phaseId: running,
      type: 'tool_call',
      name: 'bash: npm test',
      payload: { tool: 'bash', args: { command: 'npm test' } },
    });

    const result = readRunAgentState(tracer, runId);
    expect(result?.phases.map((phase) => phase.phaseStatus)).toEqual(['running', 'queued']);
    expect(result?.phases[0]).toMatchObject({
      model: 'anthropic/actual-model',
      agentSessionId: 'session-one',
      pendingApprovals: [],
      fileChanges: { availability: 'unavailable' },
    });
    expect(result?.phases[0]?.activeToolCalls[0]).toMatchObject({ tool: 'bash' });
    expect(readRunAgentState(tracer, 'missing')).toBeNull();
  });

  it('pages the exact persisted JSON and rejects a phase from another run', async () => {
    const { tracer, runId } = harness();
    const phaseId = tracer.openPhase({
      runId,
      seq: 0,
      name: 'build',
      kind: 'agent',
      owner: 'builder',
      description: 'build',
    });
    tracer.upsertAgentSession({
      runId,
      agent: 'builder',
      model: 'provider/model',
      reasoningEffort: 'medium',
      agentSessionId: 'persisted-id',
      mode: 'pi',
      color: '#fff',
    });
    const sessions = join(tracer.runDir(runId), 'sessions');
    mkdirSync(sessions, { recursive: true });
    const entry = {
      type: 'message',
      id: 'message1',
      parentId: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(100) }] },
    };
    writeFileSync(
      join(sessions, 'opaque-name.jsonl'),
      `${JSON.stringify({ type: 'session', version: 3, id: 'persisted-id', cwd: '/ignored' })}\n${JSON.stringify(entry)}\n`,
    );

    let cursor = undefined;
    let rebuilt = '';
    do {
      const page = await readSessionHistory(tracer, runId, phaseId, cursor, 37);
      expect(page).not.toBeNull();
      rebuilt += page?.chunks.map((chunk) => chunk.json).join('') ?? '';
      cursor = page?.nextCursor ?? undefined;
    } while (cursor);
    expect(rebuilt).toBe(JSON.stringify(entry));

    const other = harness();
    expect(
      await readSessionHistory(
        tracer,
        runId,
        other.tracer.openPhase({
          runId: other.runId,
          seq: 0,
          name: 'other',
          kind: 'agent',
          owner: 'builder',
          description: 'other',
        }),
      ),
    ).toBeNull();
  });

  it('keeps historical phase identities when a reused agent opens a new session', () => {
    const { tracer, runId } = harness();
    const first = tracer.openPhase({
      runId,
      seq: 0,
      name: 'plan',
      kind: 'agent',
      owner: 'builder',
      description: '',
    });
    tracer.event({
      runId,
      phaseId: first,
      type: 'log',
      name: 'phase session',
      payload: { model: 'provider/planner', agentSessionId: 'plan-session' },
    });
    tracer.event({
      runId,
      phaseId: first,
      type: 'tool_call',
      name: 'unfinished at crash',
      payload: { tool: 'bash' },
    });
    tracer.closePhase(first, 'fail', 'interrupted');
    const second = tracer.openPhase({
      runId,
      seq: 1,
      name: 'build',
      kind: 'agent',
      owner: 'builder',
      description: '',
    });
    tracer.event({
      runId,
      phaseId: second,
      type: 'log',
      name: 'phase session',
      payload: { model: 'provider/builder', agentSessionId: 'build-session' },
    });
    tracer.upsertAgentSession({
      runId,
      agent: 'builder',
      model: 'provider/builder',
      reasoningEffort: 'medium',
      agentSessionId: 'build-session',
      mode: 'pi',
      color: '#fff',
    });
    tracer.queuePhase({
      runId,
      seq: 2,
      name: 'future',
      kind: 'agent',
      owner: 'builder',
      description: '',
    });
    const phases = readRunAgentState(tracer, runId)!.phases;
    expect(phases[0]).toMatchObject({
      model: 'provider/planner',
      agentSessionId: 'plan-session',
      activeToolCalls: [],
    });
    expect(phases[1]).toMatchObject({ model: 'provider/builder', agentSessionId: 'build-session' });
    expect(phases[2]).toMatchObject({ agentSessionId: null, activeToolCalls: [] });
  });
});
