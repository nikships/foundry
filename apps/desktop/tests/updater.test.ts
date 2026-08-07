import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { UpdaterService } from '../src/main/updater.js';
import type { UpdateStatus } from '../src/shared/types.js';

function plain<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

class MockAutoUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  checkForUpdates = vi.fn().mockResolvedValue(null);
  downloadUpdate = vi.fn().mockResolvedValue(null);
  quitAndInstall = vi.fn();
}

describe('UpdaterService', () => {
  it('short-circuits safely when app is unpackaged', async () => {
    const mockUpdater = new MockAutoUpdater();
    const broadcaster = vi.fn();
    const updaterService = new UpdaterService(broadcaster, mockUpdater as never, false);

    const checkStatus = await updaterService.check();
    expect(checkStatus).toEqual({
      stage: 'idle',
      message: 'Updates are disabled in unpackaged builds',
    });
    expect(mockUpdater.checkForUpdates).not.toHaveBeenCalled();

    const downloadStatus = await updaterService.download();
    expect(downloadStatus).toEqual({
      stage: 'idle',
      message: 'Updates are disabled in unpackaged builds',
    });
    expect(mockUpdater.downloadUpdate).not.toHaveBeenCalled();

    await updaterService.quitAndInstall();
    expect(mockUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('tracks state machine transitions and broadcasts updates in packaged mode', async () => {
    const mockUpdater = new MockAutoUpdater();
    const broadcasts: { channel: string; payload: unknown }[] = [];
    const broadcaster = (channel: string, payload?: unknown) => {
      broadcasts.push({ channel, payload });
    };

    const updaterService = new UpdaterService(broadcaster, mockUpdater as never, true);

    expect(mockUpdater.autoDownload).toBe(false);
    expect(mockUpdater.autoInstallOnAppQuit).toBe(true);
    expect(updaterService.getStatus()).toEqual({ stage: 'idle' });

    // Emitting autoUpdater events
    mockUpdater.emit('checking-for-update');
    expect(updaterService.getStatus()).toEqual({ stage: 'checking' });

    mockUpdater.emit('update-available', { version: '1.2.0', releaseDate: '2026-08-07T00:00:00Z' });
    expect(updaterService.getStatus()).toEqual({
      stage: 'available',
      version: '1.2.0',
      releaseDate: '2026-08-07T00:00:00Z',
    });

    mockUpdater.emit('download-progress', { percent: 42.8 });
    expect(updaterService.getStatus()).toEqual({
      stage: 'downloading',
      percent: 43,
    });

    mockUpdater.emit('update-downloaded', {
      version: '1.2.0',
      releaseDate: '2026-08-07T00:00:00Z',
    });
    expect(updaterService.getStatus()).toEqual({
      stage: 'ready',
      version: '1.2.0',
      releaseDate: '2026-08-07T00:00:00Z',
    });

    mockUpdater.emit('error', new Error('Network connection lost'));
    expect(updaterService.getStatus()).toEqual({
      stage: 'error',
      message: 'Network connection lost',
    });

    expect(broadcasts.length).toBeGreaterThan(0);
    expect(broadcasts[0].channel).toBe('event:updater-status');
  });

  it('invokes autoUpdater.checkForUpdates and quitAndInstall in packaged mode', async () => {
    const mockUpdater = new MockAutoUpdater();
    const updaterService = new UpdaterService(undefined, mockUpdater as never, true);

    await updaterService.check();
    expect(mockUpdater.checkForUpdates).toHaveBeenCalled();

    await updaterService.download();
    expect(mockUpdater.downloadUpdate).toHaveBeenCalled();

    await updaterService.quitAndInstall();
    expect(mockUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('ensures UpdateStatus payloads survive structured-clone across IPC', () => {
    const statuses: UpdateStatus[] = [
      { stage: 'idle' },
      { stage: 'checking' },
      { stage: 'available', version: '0.2.0', releaseDate: '2026-08-07' },
      { stage: 'downloading', percent: 75 },
      { stage: 'ready', version: '0.2.0' },
      { stage: 'error', message: 'Failed to download' },
    ];

    for (const status of statuses) {
      const cloned = plain(status);
      expect(() => structuredClone(cloned)).not.toThrow();
      expect(cloned).toEqual(status);
    }
  });

  it('triggers interactive dialog when check({ interactive: true }) is called', async () => {
    const mockUpdater = new MockAutoUpdater();
    mockUpdater.checkForUpdates.mockImplementation(async () => {
      mockUpdater.emit('update-not-available', { version: '0.1.0' });
    });
    const updaterService = new UpdaterService(undefined, mockUpdater as never, true);

    const status = await updaterService.check({ interactive: true });
    expect(status.stage).toBe('idle');
    expect(mockUpdater.checkForUpdates).toHaveBeenCalled();
  });
});
