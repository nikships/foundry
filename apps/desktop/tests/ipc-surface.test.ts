/**
 * A router split must not change what the renderer can reach. These tests pin the
 * registered channel set against the contract, and pin that `ipcMain` is reachable
 * from exactly one file, which is what makes "the surface is the contract" a
 * property you can check rather than a claim.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const registered: string[] = [];

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string) => registered.push(channel) },
  app: { getVersion: () => '0.0.0', quit: vi.fn(), relaunch: vi.fn() },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { registerIpc } = (await import('../src/main/ipc/index.js')) as any;
const { IPC } = await import('../src/shared/ipc-contract.js');

/** Registration only closes over ctx; nothing is read until a handler fires. */
const stubCtx = {} as never;

const invokeChannels = Object.entries(IPC)
  .filter(([key]) => !key.startsWith('event'))
  .map(([, channel]) => channel);

describe('the IPC surface', () => {
  beforeEach(() => {
    registered.length = 0;
    registerIpc(stubCtx);
  });

  it('registers exactly the invoke channels the contract declares', () => {
    expect([...registered].sort()).toEqual([...invokeChannels].sort());
  });

  it('registers each channel once, so no router shadows another', () => {
    expect(new Set(registered).size).toBe(registered.length);
  });

  it('registers 78 channels, so a deleted handler is not a silent capability loss', () => {
    expect(registered).toHaveLength(78);
  });

  it('registers the context-breakdown channel, which the Inspector lane reads', () => {
    expect(registered).toContain(IPC.runsContextBreakdown);
  });

  it('never registers a push event channel as an invoke handler', () => {
    for (const channel of registered) expect(channel.startsWith('event:')).toBe(false);
  });

  it('reaches ipcMain from exactly one file', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(import.meta.dirname, '../src/main/ipc');
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
      .filter((f) => readFileSync(join(dir, f), 'utf8').includes('ipcMain'));
    expect(offenders).toEqual([]);
  });
});
