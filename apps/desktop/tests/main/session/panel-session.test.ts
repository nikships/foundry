/**
 * Shared panel session and registry: the machinery detect, setup, and
 * readiness used to copy. Feature suites keep prompt/parse; this one owns
 * cap, clone, cancel/abort, transcript fold, sweep, and keep-limits.
 */

import { describe, expect, it } from 'vitest';
import type { PanelStateCore } from '../../../src/shared/types.js';
import {
  PanelSession,
  SessionRegistry,
  createPanelRegistry,
  PANEL_MAX_ENTRIES,
} from '../../../src/main/session/index.js';
import { say, scriptedOneShots, toolCall } from '../../helpers/scripted-oneshot.js';

interface TestState extends PanelStateCore {
  id: string;
  status: 'running' | 'done' | 'cancelled' | 'failed';
}

function panel(opts?: {
  onChange?: (state: TestState) => void;
  now?: () => number;
}): PanelSession<TestState> {
  return new PanelSession<TestState>(
    {
      id: 's1',
      status: 'running',
      model: 'inherit',
      entries: [],
      detail: 'starting',
      startedAt: 0,
    },
    {
      now: opts?.now ?? (() => 1),
      onChange: opts?.onChange ?? (() => {}),
      clone: (state) => ({ ...state }),
      isTerminal: (state) => state.status === 'done' || state.status === 'failed',
      applyCancel: (state) => {
        state.status = 'cancelled';
        state.detail = 'cancelled';
      },
      applyFail: (state, message) => {
        state.status = 'failed';
        state.detail = message;
      },
    },
  );
}

describe('PanelSession', () => {
  it('caps the transcript at the tail', () => {
    const session = panel();
    for (let i = 0; i < PANEL_MAX_ENTRIES + 5; i++) {
      session.push({ kind: 'note', text: `n${i}` });
    }
    const snap = session.snapshot();
    expect(snap.entries).toHaveLength(PANEL_MAX_ENTRIES);
    expect(snap.entries[0]?.text).toBe('n5');
    expect(snap.entries[snap.entries.length - 1]?.text).toBe(`n${PANEL_MAX_ENTRIES + 4}`);
  });

  it('clones the snapshot so the renderer cannot mutate the live list', () => {
    const session = panel();
    session.push({ kind: 'note', text: 'live' });
    const snap = session.snapshot();
    snap.entries[0]!.text = 'mutated';
    snap.detail = 'nope';
    expect(session.state.entries[0]?.text).toBe('live');
    expect(session.snapshot().entries[0]?.text).toBe('live');
    expect(session.state.detail).toBe('starting');
  });

  it('folds text deltas onto one line and closes a tool row', async () => {
    const oneShots = scriptedOneShots([
      {
        events: [
          ...say('Reading the manifests.'),
          ...toolCall({
            callId: 'c1',
            tool: 'read',
            args: { path: '/repo/package.json' },
            result: '{}',
          }),
        ],
        text: 'done',
      },
    ]);
    const session = panel();
    const turn = await session.ask({
      oneShot: oneShots.factory,
      cwd: '/repo',
      access: 'read',
      model: 'inherit',
      reasoningEffort: 'off',
      prompt: 'look',
    });
    expect(turn?.text).toBe('done');
    const entries = session.snapshot().entries;
    expect(entries.some((e) => e.kind === 'text' && e.text.includes('Reading the manifests'))).toBe(
      true,
    );
    const tool = entries.find((e) => e.kind === 'tool');
    expect(tool?.done).toBe(true);
    expect(tool?.failed).toBe(false);
  });

  it('reports a model substitution as a note', async () => {
    const oneShots = scriptedOneShots([
      { warning: 'gpt-9 is not available; this session runs on sonnet', text: 'ok' },
    ]);
    const session = panel();
    await session.ask({
      oneShot: oneShots.factory,
      cwd: '/repo',
      access: 'read',
      model: 'inherit',
      reasoningEffort: 'off',
      prompt: 'look',
    });
    expect(session.snapshot().entries.some((e) => e.text.includes('is not available'))).toBe(true);
  });

  it('forwards ask images to the scripted one-shot', async () => {
    const oneShots = scriptedOneShots([{ text: 'ok' }]);
    const session = panel();
    const images = [{ mediaType: 'image/png' as const, data: 'aaaa', name: 'shot.png' }];
    await session.ask({
      oneShot: oneShots.factory,
      cwd: '/repo',
      access: 'read',
      model: 'inherit',
      reasoningEffort: 'off',
      prompt: 'look',
      images,
    });
    expect(oneShots.prompts).toEqual(['look']);
    expect(oneShots.images).toEqual([images]);
  });

  it('cancels an in-flight turn and aborts the child', async () => {
    const oneShots = scriptedOneShots([{ hangUntilAbort: true }]);
    const session = panel();
    const running = session.ask({
      oneShot: oneShots.factory,
      cwd: '/repo',
      access: 'read',
      model: 'inherit',
      reasoningEffort: 'off',
      prompt: 'look',
    });
    await waitFor(() => oneShots.calls.length === 1);
    session.cancel();
    expect(await running).toBeNull();
    const snap = session.snapshot();
    expect(snap.status).toBe('cancelled');
    expect(snap.endedAt).toBeDefined();
    expect(snap.entries.some((e) => e.text === 'Cancelled.')).toBe(true);
  });

  it('does not cancel a terminal session', () => {
    const session = panel();
    session.state.status = 'done';
    session.cancel();
    expect(session.cancelled).toBe(false);
    expect(session.state.status).toBe('done');
    expect(session.state.entries).toEqual([]);
  });

  it('turns a thrown ask into a failed state with a reason', () => {
    const session = panel();
    session.fail('blocked by organization policy');
    const snap = session.snapshot();
    expect(snap.status).toBe('failed');
    expect(snap.detail).toContain('blocked by organization policy');
    expect(snap.entries.some((e) => e.kind === 'error')).toBe(true);
  });

  it('does not overwrite a cancel with a later fail', () => {
    const session = panel();
    session.cancel();
    session.fail('should not land');
    expect(session.snapshot().status).toBe('cancelled');
    expect(session.snapshot().entries.some((e) => e.kind === 'error')).toBe(false);
  });
});

describe('SessionRegistry', () => {
  class Fake {
    cancelled = false;
    cancel(): void {
      this.cancelled = true;
    }
  }

  it('drops a finished session after KEEP_MS', () => {
    let now = 1_000;
    const registry = new SessionRegistry<Fake>({ now: () => now, keepMs: 100, maxKept: 10 });
    const session = new Fake();
    registry.add('a', session);
    registry.markEnded('a');
    now = 1_099;
    registry.sweep();
    expect(registry.get('a')).toBe(session);
    now = 1_100;
    registry.sweep();
    expect(registry.get('a')).toBeUndefined();
  });

  it('evicts the oldest finished session first and never a live one', () => {
    let now = 0;
    const registry = new SessionRegistry<Fake>({ now: () => now, keepMs: 10_000, maxKept: 2 });
    const live = new Fake();
    const old = new Fake();
    const mid = new Fake();
    const fresh = new Fake();
    registry.add('live', live);
    registry.add('old', old);
    registry.markEnded('old');
    now = 1;
    registry.add('mid', mid);
    registry.markEnded('mid');
    now = 2;
    registry.add('fresh', fresh);
    registry.markEnded('fresh');
    // add() already swept: oldest finished is gone, the live one stays.
    expect(registry.get('live')).toBe(live);
    expect(registry.get('old')).toBeUndefined();
    expect(registry.get('mid')).toBe(mid);
    expect(registry.get('fresh')).toBe(fresh);
  });

  it('does not evict a replacement that reused a finished id', () => {
    let now = 0;
    const registry = new SessionRegistry<Fake>({ now: () => now, keepMs: 10, maxKept: 10 });
    const first = new Fake();
    registry.add('p', first);
    registry.markEnded('p');
    const second = new Fake();
    registry.add('p', second);
    now = 100;
    registry.sweep();
    expect(registry.get('p')).toBe(second);
  });

  it('cancelAll aborts every session and clears the cache', () => {
    const registry = new SessionRegistry<Fake>();
    const a = new Fake();
    const b = new Fake();
    registry.add('a', a);
    registry.add('b', b);
    registry.cancelAll();
    expect(a.cancelled).toBe(true);
    expect(b.cancelled).toBe(true);
    expect(registry.get('a')).toBeUndefined();
    expect(registry.size).toBe(0);
  });
});

describe('createPanelRegistry', () => {
  it('exposes start → id, get, and cancel', async () => {
    const states: TestState[] = [];
    const registry = createPanelRegistry<PanelSession<TestState>, Record<string, never>, TestState>(
      {
        create: (_deps, onChange) => panel({ onChange }),
        idOf: (session) => session.state.id,
        snapshot: (session) => session.snapshot(),
        isLive: (state) => state.status === 'running',
        run: async (session) => {
          session.state.status = 'done';
          session.state.detail = 'ok';
          session.finish();
        },
        onProgress: (state) => states.push(state),
      },
    );

    const id = registry.start({});
    expect(id).toBe('s1');
    await waitFor(() => registry.get(id)?.status === 'done');
    expect(registry.get(id)?.detail).toBe('ok');
    expect(states.some((s) => s.status === 'done')).toBe(true);
    expect(registry.cancel('missing')).toBe(false);
  });

  it('cancels by id', async () => {
    const oneShots = scriptedOneShots([{ hangUntilAbort: true }]);
    const registry = createPanelRegistry<PanelSession<TestState>, { prompt: string }, TestState>({
      create: (_deps, onChange) => panel({ onChange }),
      idOf: (session) => session.state.id,
      snapshot: (session) => session.snapshot(),
      isLive: (state) => state.status === 'running',
      run: async (session) => {
        await session.ask({
          oneShot: oneShots.factory,
          cwd: '/repo',
          access: 'read',
          model: 'inherit',
          reasoningEffort: 'off',
          prompt: 'look',
        });
        session.finish();
      },
      onProgress: () => {},
    });

    const id = registry.start({ prompt: 'look' });
    await waitFor(() => oneShots.calls.length === 1);
    expect(registry.cancel(id)).toBe(true);
    await waitFor(() => registry.get(id)?.status === 'cancelled');
    expect(registry.get(id)?.entries.some((e) => e.text === 'Cancelled.')).toBe(true);
  });
});

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for the session');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
