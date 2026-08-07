/**
 * Encapsulates electron-updater configuration, update state management,
 * app.isPackaged guards, and status broadcasting to the renderer.
 */

import { app, BrowserWindow, dialog } from 'electron';
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
  private checkInFlight?: Promise<UpdateStatus>;
  private downloadInFlight?: Promise<UpdateStatus>;

  constructor(
    broadcaster?: UpdaterBroadcaster,
    customAutoUpdater?: typeof pkg.autoUpdater,
    isPackagedOverride?: boolean,
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

  public async check(options?: { interactive?: boolean }): Promise<UpdateStatus> {
    const isInteractive = options?.interactive ?? false;
    if (!this.isPackaged || !this.updater) {
      const status: UpdateStatus = {
        stage: 'idle',
        message: 'Updates are disabled in unpackaged builds',
      };
      this.setStatus(status);
      if (isInteractive) {
        await this.showDialogForStatus(status);
      }
      return status;
    }
    if (this.status.stage === 'downloading' || this.status.stage === 'ready') {
      const status = this.getStatus();
      if (isInteractive) await this.showDialogForStatus(status);
      return status;
    }

    if (!this.checkInFlight) {
      const operation = this.performCheck();
      this.checkInFlight = operation;
      void operation.finally(() => {
        if (this.checkInFlight === operation) this.checkInFlight = undefined;
      });
    }

    await this.checkInFlight;
    const finalStatus = this.getStatus();
    if (isInteractive) {
      await this.showDialogForStatus(finalStatus);
    }
    return finalStatus;
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

  private async showDialogForStatus(status: UpdateStatus): Promise<void> {
    if (typeof dialog?.showMessageBox !== 'function') return;
    const window =
      (typeof BrowserWindow?.getFocusedWindow === 'function' && BrowserWindow.getFocusedWindow()) ||
      (typeof BrowserWindow?.getAllWindows === 'function' && BrowserWindow.getAllWindows()[0]) ||
      undefined;

    if (status.stage === 'idle') {
      const isUnpackagedMsg = status.message === 'Updates are disabled in unpackaged builds';
      const currentVer = typeof app?.getVersion === 'function' ? app.getVersion() : '';
      const versionStr = status.version || currentVer;
      const detailMsg =
        status.message && status.message !== 'No update available'
          ? status.message
          : `Foundry ${versionStr ? `v${versionStr}` : ''}`.trim() +
            ' is currently the newest version available.';

      await dialog.showMessageBox(window!, {
        type: 'info',
        title: 'Check for Updates',
        message: isUnpackagedMsg ? 'Check for Updates' : "You're up to date!",
        detail: detailMsg,
        buttons: ['OK'],
      });
    } else if (status.stage === 'available' || status.stage === 'downloading') {
      await dialog.showMessageBox(window!, {
        type: 'info',
        title: 'Update Available',
        message: status.version
          ? `Foundry v${status.version} is available!`
          : 'An update is available!',
        detail:
          status.stage === 'available'
            ? 'Open Settings to download and install it.'
            : 'The update is downloading in the background.',
        buttons: ['OK'],
      });
    } else if (status.stage === 'ready') {
      const res = await dialog.showMessageBox(window!, {
        type: 'info',
        title: 'Update Ready',
        message: status.version
          ? `Foundry v${status.version} is ready to install.`
          : 'An update is ready to install.',
        detail: 'Would you like to restart Foundry now to apply the update?',
        buttons: ['Restart and Install', 'Later'],
        defaultId: 0,
        cancelId: 1,
      });
      if (res.response === 0) {
        await this.quitAndInstall();
      }
    } else if (status.stage === 'error') {
      await dialog.showMessageBox(window!, {
        type: 'warning',
        title: 'Check for Updates',
        message: 'Update Check Failed',
        detail: status.message || 'An error occurred while checking for updates.',
        buttons: ['OK'],
      });
    }
  }

  public async download(): Promise<UpdateStatus> {
    if (!this.isPackaged || !this.updater) {
      const status: UpdateStatus = {
        stage: 'idle',
        message: 'Updates are disabled in unpackaged builds',
      };
      this.setStatus(status);
      return status;
    }
    if (this.status.stage === 'ready') return this.getStatus();
    if (this.downloadInFlight) return this.downloadInFlight;

    const operation = this.performDownload();
    this.downloadInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.downloadInFlight === operation) this.downloadInFlight = undefined;
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
    if (!this.isPackaged || !this.updater) {
      return;
    }
    this.updater.quitAndInstall(false, true);
  }
}
