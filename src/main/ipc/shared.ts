import type { ValidationIssue } from '@shared/types.js';
import { IPC } from '@shared/ipc-contract.js';
import type { AppContext } from '../context.js';

/**
 * The one wrapper that reaches the Electron IPC entry point. Routers receive
 * it rather than the module, so `ipc/index.ts` stays the only file that can
 * widen the surface.
 */
export type Handle = <T>(channel: string, fn: (...args: never[]) => Promise<T> | T) => void;

export type Router<Ctx = AppContext> = (ctx: Ctx, handle: Handle) => void;

/** Shared empty issue list: every `ok: true` SaveResult carries the same one. */
export const noIssues: ValidationIssue[] = [];

export const notifySettings = (ctx: Pick<AppContext, 'broadcast'>): void =>
  ctx.broadcast(IPC.eventSettingsChanged);

export const notifyRuns = (ctx: Pick<AppContext, 'broadcast'>): void =>
  ctx.broadcast(IPC.eventRunsChanged);
