/**
 * The Bridge as the rest of the app sees it: one object that owns the child,
 * the login flows, the auth watcher, and the generated `models.json`.
 *
 * Splitting those apart is what makes a Bridge feel broken. A login that
 * succeeds but never regenerates models leaves the operator staring at a
 * provider marked "connected" with no models behind it; a regeneration that
 * never refreshes pi leaves the file correct and the picker stale. So the
 * sequence is owned in one place: **ensure the port, read the accounts, write
 * the file, and refresh pi exactly once per committed write.**
 *
 * "Exactly once per committed write" is load-bearing. A single login emits
 * several filesystem events; `writeModelsJson` reports whether the bytes
 * actually changed, and a refresh happens only when they did.
 */

import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { piStateDir } from '../pi/runtime.js';
import {
  authenticatedProviders,
  cancelLogin,
  logout as logoutProvider,
  providerStatuses,
  startLogin,
  watchAuthDir,
  type BridgeLoginResult,
  type BridgeProviderStatus,
} from './auth.js';
import {
  BridgeManager,
  BRIDGE_PROCESS_NAME,
  type BridgeEnsureResult,
  type BridgeManagerOptions,
  type BridgeStatus,
} from './manager.js';
import { regenerateModels } from './models.js';
import { bridgeConfigPath } from './paths.js';
import type { BridgeProviderId } from './providers.js';

export interface BridgeServiceOptions {
  supportDir: string;
  port?: number;
  /** Called after a committed models.json write, so the picker can reload. */
  onModelsChanged?: () => void;
  /** Test seams, forwarded verbatim to the manager. */
  manager?: Partial<BridgeManagerOptions>;
  /** Test seam: replace the login child spawn. */
  loginSpawn?: Parameters<typeof startLogin>[0]['spawn'];
  /** Test seam: replace `modelRuntime.refresh()`. */
  refreshModels?: (supportDir: string) => Promise<void>;
}

export interface BridgeSnapshot {
  status: BridgeStatus;
  providers: BridgeProviderStatus[];
  /** Absent until the Bridge has started at least once. */
  baseUrl: string | null;
}

/**
 * Writes the Bridge's `processes` row. Shaped as `Tracer.recordProcess`'s input
 * so a caller can pass the method directly, and typed with a null run id
 * because the Bridge belongs to the app rather than to a run.
 */
export type BridgeProcessRecorder = (input: {
  runId: null;
  kind: 'bridge';
  name: string;
  pid: number;
  command: string;
}) => void;

let singleton: BridgeService | null = null;

/** App-lifetime singleton. Created on first call; subsequent calls reuse it. */
export function getBridgeService(opts?: BridgeServiceOptions): BridgeService {
  if (!singleton) {
    if (!opts) throw new Error('BridgeService is not initialised');
    singleton = new BridgeService(opts);
  }
  return singleton;
}

/** The service if one exists, without creating it. */
export function currentBridgeService(): BridgeService | null {
  return singleton;
}

/** Stop the Bridge and clear the singleton. Safe when it never started. */
export async function shutdownBridgeService(): Promise<void> {
  const service = singleton;
  singleton = null;
  await service?.shutdown();
}

export class BridgeService {
  private readonly manager: BridgeManager;
  private readonly logins = new Map<BridgeProviderId, ChildProcess>();
  private unwatch: (() => void) | null = null;
  private recorder: BridgeProcessRecorder | undefined;
  /** Serialises regeneration so two auth events cannot interleave a write. */
  private regenerating: Promise<void> = Promise.resolve();

  constructor(private readonly opts: BridgeServiceOptions) {
    this.manager = new BridgeManager({
      supportDir: opts.supportDir,
      ...(opts.port !== undefined ? { port: opts.port } : {}),
      // The manager reports its child exactly once; which trace that row lands
      // in is the caller's business, hence the indirection through `recorder`.
      onProcess: (info) =>
        this.recorder?.({
          runId: null,
          kind: 'bridge',
          name: BRIDGE_PROCESS_NAME,
          pid: info.pid,
          command: info.command,
        }),
      ...opts.manager,
    });
  }

  get authDir(): string {
    return this.manager.authDir;
  }

  /**
   * Starts the Bridge if it is not running, then brings models.json in line
   * with the accounts on disk. Safe to call repeatedly; the manager coalesces.
   *
   * `recorder` is how an app-scoped child gets into a per-project trace: the
   * caller that has a tracer passes one, and only the start that actually
   * spawns a child uses it. A caller with no trace to write to (Settings
   * connecting a provider before any run) passes nothing, and the Bridge is
   * simply unrecorded until a run starts one.
   */
  async ensure(recorder?: BridgeProcessRecorder): Promise<BridgeEnsureResult> {
    this.recorder = recorder ?? this.recorder;
    const result = await this.manager.ensure();
    if (result.ok) {
      this.startWatching();
      await this.regenerate();
    }
    return result;
  }

  /** Status plus per-provider accounts. Cheap: a directory read, no spawn. */
  snapshot(): BridgeSnapshot {
    return {
      status: this.manager.status(),
      providers: providerStatuses(this.authDir, new Set(this.logins.keys())),
      baseUrl: this.manager.baseUrl,
    };
  }

  /**
   * Begins a provider's OAuth flow.
   *
   * The Bridge has to be up first: the login child writes into the same auth
   * directory the running Bridge hot-reloads, and starting one without the
   * other produces an account nothing serves.
   */
  async connect(provider: BridgeProviderId): Promise<BridgeLoginResult> {
    const started = await this.ensure();
    if (!started.ok) {
      return { ok: false, detail: `the Bridge is unavailable: ${started.detail}` };
    }
    const binary = this.manager.binary();
    if (!binary) return { ok: false, detail: 'the Bridge binary is not installed' };

    // A second flow for the same provider would race the first one's callback
    // server onto the same port.
    this.cancel(provider);

    const { result, child } = await startLogin({
      binary,
      configPath: bridgeConfigPath(this.opts.supportDir),
      provider,
      ...(this.opts.loginSpawn ? { spawn: this.opts.loginSpawn } : {}),
    });
    if (child) {
      this.logins.set(provider, child);
      child.once('exit', () => {
        this.logins.delete(provider);
        // The account file lands as the flow completes, so the regeneration
        // that matters is the one after the child is gone. The watcher usually
        // gets there first; this covers a filesystem that coalesced the event.
        void this.regenerate();
      });
    }
    return result;
  }

  /** Removes a provider's accounts and drops its models from the catalog. */
  async disconnect(provider: BridgeProviderId): Promise<{ ok: boolean; detail: string }> {
    this.cancel(provider);
    const removed = logoutProvider(this.authDir, provider);
    await this.regenerate();
    return removed > 0
      ? { ok: true, detail: `signed out of ${removed} ${removed === 1 ? 'account' : 'accounts'}` }
      : { ok: false, detail: 'there was no account to sign out of' };
  }

  /** SIGTERMs an in-flight login. Returns false when there was nothing to cancel. */
  cancel(provider: BridgeProviderId): boolean {
    const child = this.logins.get(provider);
    if (!child) return false;
    this.logins.delete(provider);
    cancelLogin(child);
    return true;
  }

  /**
   * Rewrites models.json from the accounts on disk, refreshing pi only when the
   * file actually changed. Serialised: concurrent callers queue behind the
   * in-flight write rather than racing it.
   */
  regenerate(): Promise<void> {
    this.regenerating = this.regenerating.then(() => this.runRegenerate());
    return this.regenerating;
  }

  /** Stops the watcher, cancels logins, and SIGTERMs the child. Idempotent. */
  async shutdown(): Promise<void> {
    this.unwatch?.();
    this.unwatch = null;
    for (const provider of [...this.logins.keys()]) this.cancel(provider);
    await this.manager.shutdown();
  }

  private async runRegenerate(): Promise<void> {
    const baseUrl = this.manager.baseUrl;
    // With no port there is no endpoint to point the models at. Writing them
    // anyway would offer a model whose every request is refused.
    if (!baseUrl) return;
    let changed = false;
    try {
      const result = regenerateModels({
        modelsPath: join(piStateDir(this.opts.supportDir), 'models.json'),
        authenticated: authenticatedProviders(this.authDir),
        baseUrl,
      });
      changed = result.changed;
    } catch (error) {
      // A models.json that cannot be written is a degraded catalog, not a
      // reason to fail the login the operator just completed.
      console.warn(`[bridge] could not write models.json: ${message(error)}`);
      return;
    }
    if (!changed) return;
    try {
      const refresh = this.opts.refreshModels ?? defaultRefresh;
      await refresh(this.opts.supportDir);
    } catch (error) {
      console.warn(`[bridge] pi could not reload its model catalog: ${message(error)}`);
    }
    this.opts.onModelsChanged?.();
  }

  private startWatching(): void {
    if (this.unwatch) return;
    this.unwatch = watchAuthDir(this.authDir, () => {
      void this.regenerate();
    });
  }
}

/**
 * Loaded lazily so building a service — which the app does at startup — does
 * not construct pi's runtime, which reads catalogs off disk.
 */
async function defaultRefresh(supportDir: string): Promise<void> {
  const { refreshCatalog } = await import('../pi/catalog.js');
  await refreshCatalog(supportDir);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
