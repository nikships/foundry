import { BrowserWindow, app, shell } from 'electron';
import { IPC } from '@shared/ipc-contract.js';
import type { AppContext } from '../context.js';
import type { Handle } from './shared.js';

type Ctx = Pick<AppContext, 'assetUrl' | 'version' | 'updater'>;

function focusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
}

export function register(ctx: Ctx, handle: Handle): void {
  handle(IPC.appOpenExternal, (url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });
  handle(IPC.appAssetUrl, (relPath: string) => ctx.assetUrl(relPath));
  handle(IPC.appVersion, () => ctx.version);
  handle(IPC.appQuit, () => app.quit());
  handle(IPC.appRelaunch, () => {
    app.relaunch();
    app.quit();
  });
  handle(IPC.appWindowClose, () => {
    focusedWindow()?.close();
  });
  handle(IPC.appWindowMinimize, () => {
    focusedWindow()?.minimize();
  });
  handle(IPC.appWindowMaximize, () => {
    const win = focusedWindow();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  handle(IPC.updaterCheck, () => ctx.updater.check({ interactive: true }));
  handle(IPC.updaterDownload, () => ctx.updater.download());
  handle(IPC.updaterQuitAndInstall, () => ctx.updater.quitAndInstall());
  handle(IPC.updaterGetStatus, () => ctx.updater.getStatus());
}
