import * as fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSessionHistory } from '../../../src/main/pi/session-history.js';
import { openDb, projectDbPath, projectRunsDir } from '../../../src/main/trace/db.js';
import { Tracer } from '../../../src/main/trace/tracer.js';
import type { SessionHistoryCursor } from '../../../src/shared/run-agent-state.js';
import { tempDir } from '../../helpers/tmp.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

describe('persisted pi session history', () => {
  let tracer: Tracer;
  let phaseId: string;
  let path: string;
  const runId = 'history';

  beforeEach(() => {
    const support = tempDir('foundry-session-history-');
    tracer = new Tracer(openDb(projectDbPath(support, 'proj')), projectRunsDir(support, 'proj'));
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
      worktreePath: support,
      branch: null,
      baseRef: 'main',
      mode: 'pi',
    });
    phaseId = tracer.openPhase({
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
      model: 'scripted',
      reasoningEffort: 'off',
      agentSessionId: 'session-1',
      mode: 'pi',
      color: '#abc',
    });
    const dir = join(tracer.runDir(runId), 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    path = join(dir, 'session.jsonl');
  });

  afterEach(() => vi.restoreAllMocks());

  function writeEntries(entries: unknown[]): void {
    fs.writeFileSync(
      path,
      [{ type: 'session', id: 'session-1' }, ...entries]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n',
    );
  }

  it('skips malformed and non-object entries without losing later history', async () => {
    const entry = { type: 'message', id: 'valid', message: { role: 'user', content: 'hello' } };
    writeEntries([null, 42, [], 'bad', entry]);
    fs.appendFileSync(path, '{incomplete');
    const page = await readSessionHistory(tracer, runId, phaseId);
    expect(page?.chunks.map((chunk) => JSON.parse(chunk.json))).toEqual([entry]);
  });

  it('closes the file stream when a page stops before EOF', async () => {
    writeEntries([
      { type: 'message', message: { role: 'toolResult', content: 'x'.repeat(200_000) } },
    ]);
    const read = vi.mocked(fs.createReadStream);
    read.mockClear();
    try {
      const page = await readSessionHistory(tracer, runId, phaseId, undefined, 20);
      expect(page?.nextCursor).not.toBeNull();
      expect(page?.nextCursor?.agentSessionId).toBe('session-1');
      expect(read.mock.results[0]?.value.destroyed).toBe(true);
    } finally {
      for (const result of read.mock.results) result.value.destroy();
    }
  });

  it('reassembles oversized entries losslessly across pages', async () => {
    const entries = [
      { type: 'message', id: 'large', message: { role: 'toolResult', content: '😀'.repeat(200) } },
      { type: 'custom_message', content: 'direction' },
    ];
    writeEntries(entries);
    const parts: string[] = [];
    let cursor: SessionHistoryCursor | null = { line: 1, offset: 0 };
    while (cursor) {
      const page = await readSessionHistory(tracer, runId, phaseId, cursor, 101);
      expect(page).not.toBeNull();
      parts.push(...page!.chunks.map((chunk) => chunk.json));
      cursor = page!.nextCursor;
    }
    expect(parts.join('')).toBe(entries.map((entry) => JSON.stringify(entry)).join(''));
  });

  it('rejects a phase belonging to another run', async () => {
    writeEntries([{ type: 'message' }]);
    expect(await readSessionHistory(tracer, 'other', phaseId)).toBeNull();
  });

  it('pages the phase conversation after the same agent opens a later session', async () => {
    const planned = {
      type: 'message',
      id: 'plan-turn',
      message: { role: 'assistant', content: 'plan' },
    };
    const built = {
      type: 'message',
      id: 'build-turn',
      message: { role: 'assistant', content: 'build' },
    };
    writeEntries([planned]);
    const later = join(tracer.runDir(runId), 'sessions', 'later.jsonl');
    fs.writeFileSync(
      later,
      [{ type: 'session', id: 'session-2' }, built]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n',
    );
    tracer.event({
      runId,
      phaseId,
      type: 'log',
      name: 'phase session',
      payload: { model: 'scripted', agentSessionId: 'session-1' },
    });
    tracer.upsertAgentSession({
      runId,
      agent: 'builder',
      model: 'scripted',
      reasoningEffort: 'off',
      agentSessionId: 'session-2',
      mode: 'pi',
      color: '#abc',
    });

    const first = await readSessionHistory(tracer, runId, phaseId);
    expect(first?.agentSessionId).toBe('session-1');
    expect(first?.chunks.map((chunk) => JSON.parse(chunk.json))).toEqual([planned]);
    expect(first?.nextCursor).toBeNull();

    const pinned = await readSessionHistory(tracer, runId, phaseId, {
      line: 1,
      offset: 0,
      agentSessionId: 'session-1',
    });
    expect(pinned?.chunks.map((chunk) => JSON.parse(chunk.json))).toEqual([planned]);
    expect(pinned?.agentSessionId).toBe('session-1');
  });
});
