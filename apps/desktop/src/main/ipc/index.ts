/**
 * The entire IPC surface, assembled from one router per domain. Every handler is
 * invoke/handle: there is no `ipcRenderer.send` path into the main process and no
 * remote module, so the renderer's only capability is the sum of these routers,
 * which is exactly `src/shared/ipc-contract.ts`.
 *
 * Trace data crosses as polled pages with a change_id cursor rather than a push
 * stream, which is why live view and history are the same query.
 */

import { ipcMain } from 'electron';
import type { AppContext } from '../context.js';
import type { Handle } from './shared.js';
import * as settings from './settings.js';
import * as projects from './projects.js';
import * as roster from './roster.js';
import * as pipelines from './pipelines.js';
import * as catalog from './catalog.js';
import * as runs from './runs.js';
import * as prs from './prs.js';
import * as maintenance from './maintenance.js';
import * as appRouter from './app.js';

export function registerIpc(ctx: AppContext): void {
  const handle: Handle = (channel, fn) => {
    ipcMain.handle(channel, async (_event, ...args) => fn(...(args as never[])));
  };

  settings.register(ctx, handle);
  projects.register(ctx, handle);
  roster.register(ctx, handle);
  pipelines.register(ctx, handle);
  catalog.register(ctx, handle);
  runs.register(ctx, handle);
  prs.register(ctx, handle);
  maintenance.register(ctx, handle);
  appRouter.register(ctx, handle);
}
