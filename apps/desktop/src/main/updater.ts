/**
 * Encapsulates electron-updater configuration, update state management,
 * app.isPackaged guards, and status broadcasting to the renderer.
 */

import { app } from 'electron';
import pkg from 'electron-updater';
import type { UpdateStatus } from '../shared/types.js';
import { IPC } from '../shared/ipc-contract.js';

export interface UpdaterBroadcaster {
  (channel: string, payload?: unknown): void;
}

export class UpdaterService {
  private status: UpdateStatus = { stage: 'idle' };
  private broadcaster?: UpdaterBroadcaster;
  private updater?: typeof pkg.autoUpdater;
  private isPackaged: boolean;

  constructor(
    broadcaster?: UpdaterBroadcaster,
    customAutoUpdater?: typeof pkg.autoUpdater,
    isPackagedOverride?: boolean
  ) {
    this.broadcaster = broadcaster;
    this.isPackaged = isPackagedOverride ?? (app ? app.isPackaged : false);

    if (customAutoUpdater) {
      this.updater = customAutoUpdater;
    } else if (this.isPackaged) {
      try {
        this.updater = pkg.autoUpdater;
      } catch (err) {
        console.warn('Failed to resolve autoUpdater:', err);
      }
    }

    if (this.isPackaged && this.updater) {
      this.initUpdater();
    }
  }

  public setBroadcaster(broadcaster: UpdaterBroadcaster): void {
    this.broadcaster = broadcaster;
  }

  private setStatus(next: UpdateStatus): void {
    this.status = next;
    if (this.broadcaster) {
      this.broadcaster(IPC.eventUpdaterStatus, this.getStatus());
    }
  }

  public getStatus(): UpdateStatus {
    return { ...this.status };
  }

  private initUpdater(): void {
    if (!this.updater) return;
    try {
      this.updater.autoDownload = true;
      this.updater.autoInstallOnAppQuit = true;

      this.updater.on('checking-for-update', () => {
        this.setStatus({ stage: 'checking' });
      });

      this.updater.on('update-available', (info) => {
        this.setStatus({
          stage: 'available',
          version: info.version,
          releaseDate: typeof info.releaseDate === 'string' ? info.releaseDate : undefined,
        });
      });

      this.updater.on('update-not-available', (info) => {
        this.setStatus({
          stage: 'idle',
          version: info?.version,
          message: 'No update available',
        });
      });

      this.updater.on('download-progress', (progress) => {
        this.setStatus({
          stage: 'downloading',
          percent: Math.round(progress.percent),
        });
      });

      this.updater.on('update-downloaded', (info) => {
        this.setStatus({
          stage: 'ready',
          version: info.version,
          releaseDate: typeof info.releaseDate === 'string' ? info.releaseDate : undefined,
        });
      });

      this.updater.on('error', (err) => {
        this.setStatus({
          stage: 'error',
          message: err?.message || String(err),
        });
      });
    } catch (e) {
      console.warn('Failed to initialize autoUpdater:', e);
    }
  }

  public async check(): Promise<UpdateStatus> {
    if (!this.isPackaged || !this.updater) {
      return { stage: 'idle', message: 'Updates are disabled in unpackaged builds' };
    }
    try {
      this.setStatus({ stage: 'checking' });
      await this.updater.checkForUpdates();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus({ stage: 'error', message: msg });
    }
    return this.getStatus();
  }

  public async download(): Promise<UpdateStatus> {
    if (!this.isPackaged || !this.updater) {
      return { stage: 'idle', message: 'Updates are disabled in unpackaged builds' };
    }
    try {
      this.setStatus({ stage: 'downloading', percent: 0 });
      await this.updater.downloadUpdate();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus({ stage: 'error', message: msg });
    }
    return this.getStatus();
  }

  public async quitAndInstall(): Promise<void> {
    if (!this.isPackaged || !this.updater) {
      return;
    }
    this.updater.quitAndInstall();
  }
}
