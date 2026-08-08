/**
 * App lifecycle. The window is a native macOS window: an inset traffic-light
 * title bar over a vibrant sidebar, with the renderer fully sandboxed. All
 * privileged work happens here or below.
 */

import { app, BrowserWindow, Menu, shell } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import type { BrandId } from '@shared/types.js';
import { AppContext } from './context.js';
import { registerIpc } from './ipc/index.js';
import { readBrandSync } from './store/settings.js';
import { killAll } from './system/procs.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.ELECTRON_RENDERER_URL;

let ctx: AppContext | null = null;

/**
 * The window's own backgroundColor is what the user sees between the frame
 * appearing and the first paint, so it has to be the brand's base colour.
 * Neither brand uses vibrancy: both paint an opaque base (Prism's OLED void,
 * Murmur's warm hearth) and desktop bleed-through would wash them out.
 */
const BRAND_BACKGROUND: Record<BrandId, string> = {
  prism: '#000000',
  murmur: '#1A1410',
};

function createWindow(brand: BrandId): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    title: 'Foundry',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 22 },
    backgroundColor: BRAND_BACKGROUND[brand],
    webPreferences: {
      preload: join(here, '../preload/bridge.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  // Painting an empty window before the first frame reads as a hang.
  window.once('ready-to-show', () => window.show());

  // A link in agent output opens in the browser, never inside the app frame.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (DEV_URL) {
    void window.loadURL(`${DEV_URL}?brand=${brand}`);
  } else {
    void window.loadFile(join(here, '../renderer/index.html'), { query: { brand } });
  }
  return window;
}

function menuClick(channel: string): () => void {
  return () => ctx?.broadcast(channel);
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              {
                label: 'Check for Updates…',
                click: () => void ctx?.updater.check({ interactive: true }),
              },
              { type: 'separator' },
              {
                label: 'Settings…',
                accelerator: 'Cmd+,',
                click: menuClick('menu:settings'),
              },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Run', accelerator: 'Cmd+N', click: menuClick('menu:new-run') },
        { label: 'Add Project…', accelerator: 'Cmd+Shift+O', click: menuClick('menu:add-project') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Runs', accelerator: 'Cmd+1', click: menuClick('menu:view-runs') },
        { label: 'Pipelines', accelerator: 'Cmd+2', click: menuClick('menu:view-pipelines') },
        { label: 'Roster', accelerator: 'Cmd+3', click: menuClick('menu:view-roster') },
        { label: 'Inspector', accelerator: 'Cmd+4', click: menuClick('menu:view-inspector') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'droid CLI documentation',
          click: () => void shell.openExternal('https://docs.factory.ai/droid-exec/overview'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// A second instance would open a second SQLite writer against the same trace.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  void app.whenReady().then(() => {
    const supportDir = join(app.getPath('userData'), 'foundry');
    mkdirSync(supportDir, { recursive: true });

    // The brand has to be known before the window exists, so the frame is
    // already the right colour and the renderer can be told which palette to
    // load. `ctx` (and with it SettingsStore) is only built further down.
    const brand: BrandId = readBrandSync(supportDir);

    // Packaged, assets sit beside the app resources; in dev they are in-repo.
    const assetsRoot = app.isPackaged
      ? join(process.resourcesPath, 'assets')
      : join(here, '../../assets');

    ctx = new AppContext(supportDir, assetsRoot);
    registerIpc(ctx);
    buildMenu();
    // Apply the saved brand's dock icon on launch (best-effort, no-op if packs missing).
    try {
      ctx.applyBrandDockIcon();
    } catch {
      // Swallow: icon availability must never block app launch.
    }

    // A run whose engine died with the app can never finish on its own.
    const swept = ctx.registry.sweep(ctx.projects.list());
    if (swept.runsFinalised.length) {
      console.warn(`finalised ${swept.runsFinalised.length} run(s) orphaned by a previous launch`);
    }

    createWindow(brand);

    // A packaged app should discover updates without requiring the user to
    // find the menu item first. The service is a no-op in development builds.
    void ctx.updater.check();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(brand);
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Child processes outlive their parent unless they are told not to.
  app.on('before-quit', () => {
    ctx?.dispose();
    killAll();
  });
}
