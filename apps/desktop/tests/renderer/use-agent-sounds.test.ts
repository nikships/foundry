import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  effects: [] as { deps?: readonly unknown[]; cleanup?: () => void }[],
  refs: [] as { current: unknown }[],
  effectCursor: 0,
  refCursor: 0,
  pending: [] as { index: number; effect: () => void | (() => void); deps?: readonly unknown[] }[],
  listeners: new Map<string, (data?: unknown) => void>(),
  list: vi.fn(),
  proposalsList: vi.fn(),
  play: vi.fn(),
  unlock: vi.fn(),
}));

vi.mock('react', () => ({
  useMemo: (factory: () => unknown): unknown => factory(),
  useRef: (initial: unknown): { current: unknown } => {
    const index = mocks.refCursor++;
    return (mocks.refs[index] ??= { current: initial });
  },
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]): void => {
    const index = mocks.effectCursor++;
    const previous = mocks.effects[index]?.deps;
    if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous[i]))) {
      mocks.pending.push({ index, effect, deps });
    }
  },
}));

vi.mock('@renderer/api.js', () => ({
  api: {
    runs: { list: mocks.list },
    smith: { proposalsList: mocks.proposalsList },
    on: vi.fn((event: string, listener: (data?: unknown) => void) => {
      mocks.listeners.set(event, listener);
      return (): void => {
        if (mocks.listeners.get(event) === listener) mocks.listeners.delete(event);
      };
    }),
  },
}));

vi.mock('@renderer/utils/agent-sounds.js', () => ({
  playAgentSound: mocks.play,
  unlockAgentSounds: mocks.unlock,
}));

import type { ProjectDef, RunRow } from '@shared/types.js';
import { useAgentSounds } from '@renderer/hooks/useAgentSounds.js';

const project = { id: 'project-1' } as ProjectDef;

function HookHarness(enabled: boolean, projects: ProjectDef[] = [project]): void {
  mocks.effectCursor = 0;
  mocks.refCursor = 0;
  useAgentSounds(enabled, projects);
  for (const pending of mocks.pending.splice(0)) {
    mocks.effects[pending.index]?.cleanup?.();
    mocks.effects[pending.index] = { deps: pending.deps, cleanup: pending.effect() ?? undefined };
  }
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function run(status: RunRow['status']): RunRow {
  return { runId: 'run-1', status, phaseSummary: [] } as unknown as RunRow;
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const effect of mocks.effects) effect.cleanup?.();
  mocks.effects.length = 0;
  mocks.refs.length = 0;
  mocks.pending.length = 0;
  mocks.listeners.clear();
  mocks.list.mockReset().mockResolvedValue([]);
  mocks.proposalsList.mockReset().mockResolvedValue([]);
  mocks.play.mockReset();
  mocks.unlock.mockReset();
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setTimeout,
    clearTimeout,
  });
});

afterEach(() => {
  for (const effect of mocks.effects) effect.cleanup?.();
  mocks.effects.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useAgentSounds', () => {
  it('installs no sound resources while disabled and tears them down when toggled off', async () => {
    HookHarness(false);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.proposalsList).not.toHaveBeenCalled();
    expect(mocks.listeners.size).toBe(0);
    expect(window.addEventListener).not.toHaveBeenCalled();

    HookHarness(true);
    await settle();
    expect(mocks.listeners.size).toBe(3);
    expect(window.addEventListener).toHaveBeenCalledTimes(2);

    HookHarness(false);
    expect(mocks.listeners.size).toBe(0);
    expect(window.removeEventListener).toHaveBeenCalledTimes(2);
  });

  it('uses a silent baseline after enabling, then plays a real transition', async () => {
    mocks.list.mockResolvedValueOnce([run('running')]).mockResolvedValueOnce([run('accepted')]);
    HookHarness(false);
    HookHarness(true);
    await settle();
    expect(mocks.play).not.toHaveBeenCalled();

    mocks.listeners.get('runs-changed')?.();
    await settle();
    expect(mocks.play).toHaveBeenCalledWith('run-accepted');
  });

  it('keeps enabled notification polling in the background but stops immediately when muted', async () => {
    vi.stubGlobal('document', { hidden: true });
    mocks.list.mockResolvedValue([run('running')]);
    HookHarness(true);
    await vi.advanceTimersByTimeAsync(800);
    expect(mocks.list).toHaveBeenCalledTimes(2);
    HookHarness(false);
    await vi.advanceTimersByTimeAsync(2400);
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores an old flight and starts re-enabled polling independently', async () => {
    let finishOld!: (rows: RunRow[]) => void;
    mocks.list
      .mockReturnValueOnce(new Promise<RunRow[]>((resolve) => (finishOld = resolve)))
      .mockResolvedValueOnce([run('accepted')]);

    HookHarness(true);
    HookHarness(false);
    HookHarness(true);
    await settle();
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(mocks.play).not.toHaveBeenCalled();

    finishOld([run('running')]);
    await settle();
    expect(mocks.play).not.toHaveBeenCalled();
  });

  it('ignores a flight from an obsolete project list', async () => {
    let finishOld!: (rows: RunRow[]) => void;
    mocks.list
      .mockReturnValueOnce(new Promise<RunRow[]>((resolve) => (finishOld = resolve)))
      .mockResolvedValueOnce([run('running')]);

    HookHarness(true);
    HookHarness(true, [{ id: 'project-2' } as ProjectDef]);
    await settle();
    finishOld([run('accepted')]);
    await settle();

    expect(mocks.list).toHaveBeenNthCalledWith(2, 'project-2', false);
    expect(mocks.play).not.toHaveBeenCalled();
  });
});
