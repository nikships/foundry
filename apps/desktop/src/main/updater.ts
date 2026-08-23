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
  private updater?: typeof pkg.autoUpdater;
  private readonly isPackaged: boolean;
  private checkInFlight?: Promise<UpdateStatus>;
  private downloadInFlight?: Promise<UpdateStatus>;

  constructor(
    private readonly broadcaster?: UpdaterBroadcaster,
    customAutoUpdater?: typeof pkg.autoUpdater,
    isPackagedOverride?: boolean,
  ) {
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

  private setStatus(next: UpdateStatus): void {
    this.status = next;
    this.broadcaster?.(IPC.eventUpdaterStatus, this.getStatus());
  }

  public getStatus(): UpdateStatus {
    return { ...this.status };
  }

  private initUpdater(): void {
    if (!this.updater) return;
    try {
      // The renderer owns the explicit download action, so an available
      // update cannot disappear into a background transfer before the user
      // sees how to install it.
      this.updater.autoDownload = false;
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
        // Preserve version from the available/ready state so the banner and
        // Settings can keep showing "Foundry vX.Y.Z is downloading".
        const prev = this.status as UpdateStatus & { version?: string };
        this.setStatus({
          stage: 'downloading',
          version: prev.version,
          releaseDate: prev.releaseDate,
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

  private disabledStatus(): UpdateStatus {
    const status: UpdateStatus = {
      stage: 'idle',
      message: 'Updates are disabled in unpackaged builds',
    };
    this.setStatus(status);
    return status;
  }

  public async check(_options?: { interactive?: boolean }): Promise<UpdateStatus> {
    if (!this.isPackaged || !this.updater) return this.disabledStatus();
    if (this.status.stage === 'downloading' || this.status.stage === 'ready') {
      return this.getStatus();
    }

    const operation = this.checkInFlight ?? this.performCheck();
    this.checkInFlight = operation;
    try {
      await operation;
      return this.getStatus();
    } finally {
      this.checkInFlight = undefined;
    }
  }

  private async performCheck(): Promise<UpdateStatus> {
    try {
      this.setStatus({ stage: 'checking' });
      await this.updater?.checkForUpdates();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus({ stage: 'error', message: msg });
    }
    return this.getStatus();
  }

  public async download(): Promise<UpdateStatus> {
    if (!this.isPackaged || !this.updater) return this.disabledStatus();
    if (this.status.stage === 'ready') return this.getStatus();
    if (this.downloadInFlight) return this.downloadInFlight;

    const operation = this.performDownload();
    this.downloadInFlight = operation;
    try {
      return await operation;
    } finally {
      this.downloadInFlight = undefined;
    }
  }

  private async performDownload(): Promise<UpdateStatus> {
    try {
      this.setStatus({ stage: 'downloading', percent: 0 });
      await this.updater?.downloadUpdate();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus({ stage: 'error', message: msg });
    }
    return this.getStatus();
  }

  public async quitAndInstall(): Promise<void> {
    if (!this.isPackaged || !this.updater) return;
    this.updater.quitAndInstall(false, true);
  }
}
