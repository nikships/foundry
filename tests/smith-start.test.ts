/**
 * The sidebar's one-click start.
 *
 * The decision this makes is the whole feature: a click either finishes the job
 * or hands the launcher a reason. Getting it wrong is invisible in the good case
 * and infuriating in the bad one — a modal in front of a session that already
 * started, or a silent no-op when nothing did. So the branch is pinned here
 * against a stub context, with the terminal spawn faked: a real one would open
 * windows on the machine running the suite.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TerminalModule from '../src/main/system/terminal.js';
import type { SmithStartResult } from '../src/shared/types.js';

const opened: { appName: string; directoryPath: string; command: string[] }[] = [];
let failWith: string | null = null;

vi.mock('../src/main/system/terminal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof TerminalModule>();
  return {
    ...actual,
    // Only the spawn is faked. `terminalFor` and `terminalInstalled` stay real,
    // so the catalog's `prepared` flag is still what decides the branch.
    runCommandInTerminal: async (input: (typeof opened)[number]) => {
      if (failWith) throw new Error(failWith);
      opened.push(input);
    },
    terminalInstalled: () => true,
  };
});

const { registerLaunch } = await import('../src/main/ipc/smith.js');
const { IPC } = await import('../src/shared/ipc-contract.js');
const { __setResolvedEnvForTest } = await import('../src/main/system/env.js');

const dirs: string[] = [];
const makeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'smith-start-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  __setResolvedEnvForTest(null);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A PATH holding a droid binary, or an empty one.
 *
 * Smith runs on the user's own agent, so the router looks the binary up on the
 * resolved PATH rather than reading a setting. Pinning that PATH is what keeps
 * the branch hermetic: the suite must not depend on whether the machine running
 * it happens to have droid installed.
 */
function pinAgentOnPath(present: boolean): void {
  const dir = makeDir();
  if (present) writeFileSync(join(dir, 'droid'), '#!/bin/sh\n', { mode: 0o755 });
  __setResolvedEnvForTest({ path: dir, via: 'login-shell' });
}

interface StubOptions {
  terminalApp?: string;
  agentOnPath?: boolean;
  projectPath?: string | null;
}

/** Registers the real router against a stub ctx and returns the start handler. */
function startHandler(options: StubOptions = {}): (projectId: string) => Promise<SmithStartResult> {
  const supportDir = makeDir();
  const project =
    options.projectPath === null
      ? null
      : { id: 'proj_1', name: 'foundry', path: options.projectPath ?? makeDir() };

  pinAgentOnPath(options.agentOnPath ?? true);

  const ctx = {
    supportDir,
    projects: { get: (id: string) => (project && id === project.id ? project : null) },
    settings: {
      get: () => ({ terminalApp: options.terminalApp ?? 'ghostty' }),
    },
    smith: { socket: { path: () => join(supportDir, 'smith', 'foundry.sock') } },
  } as never;

  const handlers = new Map<string, (...args: never[]) => unknown>();
  registerLaunch(ctx, ((channel: string, fn: (...args: never[]) => unknown) => {
    handlers.set(channel, fn);
  }) as never);
  return handlers.get(IPC.smithStart) as (projectId: string) => Promise<SmithStartResult>;
}

describe('smith:start', () => {
  beforeEach(() => {
    opened.length = 0;
    failWith = null;
  });

  it('starts the session outright with a prepared terminal, so the click is the whole flow', async () => {
    const result = await startHandler()('proj_1');
    expect(result).toEqual({ status: 'started' });
    expect(opened).toHaveLength(1);
    expect(opened[0]?.appName).toBe('Ghostty');
  });

  it('hands the terminal a script it wrote, not an inline command line', async () => {
    await startHandler()('proj_1');
    expect(opened[0]?.command[0]).toBe('/bin/sh');
    expect(opened[0]?.command[1]).toMatch(/smith\/session\.sh$/);
  });

  it('defers to the launcher for a terminal that takes no command, without opening anything', async () => {
    const result = await startHandler({ terminalApp: 'terminal' })('proj_1');
    expect(result).toEqual({ status: 'needs-launcher', reason: 'terminal' });
    expect(opened).toEqual([]);
  });

  it('refuses rather than opening a window that dies when the agent CLI is unresolvable', async () => {
    // With nothing on PATH the lookup falls back to the bare name, and a script
    // with its own PATH cannot be trusted to resolve one, so this must not
    // reach the terminal.
    const result = await startHandler({ agentOnPath: false })('proj_1');
    expect(result).toEqual({ status: 'needs-launcher', reason: 'agent-cli' });
    expect(opened).toEqual([]);
  });

  it('defers with the project reason when nothing is selected', async () => {
    const result = await startHandler({ projectPath: null })('');
    expect(result).toEqual({ status: 'needs-launcher', reason: 'project' });
  });

  it('defers when the project path is gone, rather than cd-ing into nothing', async () => {
    const result = await startHandler({ projectPath: '/tmp/not-here-4b19' })('proj_1');
    expect(result).toEqual({ status: 'needs-launcher', reason: 'project' });
    expect(opened).toEqual([]);
  });

  it('reports a failed launch as an error the launcher can show, not as silence', async () => {
    failWith = 'Unable to find application named "Ghostty"';
    const result = await startHandler()('proj_1');
    expect(result).toEqual({
      status: 'error',
      error: 'Unable to find application named "Ghostty"',
    });
  });
});
