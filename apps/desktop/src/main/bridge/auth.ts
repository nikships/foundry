/**
 * Provider login, logout, and account status for the Bridge.
 *
 * CLIProxyAPI owns the OAuth flows: each is a short-lived child started with a
 * `-<provider>-login` flag that opens a browser and writes a JSON file into the
 * auth directory when the operator finishes. Foundry's job is to start that
 * child with a real PATH (a GUI launch inherits launchd's, and `open` is not on
 * it), to watch the directory, and to report status.
 *
 * The one rule that shapes every function here: **no token ever leaves this
 * module.** Auth files hold refresh tokens and access tokens. `readAccounts`
 * reads only `type`, `email`/`login`, `expired`, and `disabled`; nothing else
 * is parsed out, nothing is logged, and `BridgeAccount` is the only shape that
 * crosses IPC. A field added to those files does not become a field the
 * renderer can see unless someone adds it here on purpose.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { spawnEnv } from '../system/env.js';
import { isAlive, killTree } from '../system/procs.js';
import {
  BRIDGE_PROVIDERS,
  bridgeProvider,
  providerForAuthType,
  type BridgeProviderId,
} from './providers.js';

/** One authenticated account, with nothing secret in it. */
export interface BridgeAccount {
  /** The auth file's name. Identifies the account without naming the operator. */
  id: string;
  provider: BridgeProviderId;
  /** Whatever the provider called the account: an email, a login, or the id. */
  label: string;
  /** ISO expiry when the file states one. */
  expiresAt?: string;
  expired: boolean;
  disabled: boolean;
}

export interface BridgeProviderStatus {
  id: BridgeProviderId;
  label: string;
  icon: string;
  /** At least one account that is neither disabled nor expired. */
  authenticated: boolean;
  accounts: BridgeAccount[];
  /** True while a login child for this provider is running. */
  loginInFlight: boolean;
}

export interface BridgeLoginResult {
  ok: boolean;
  /** Operator-facing; never carries provider output that could hold a token. */
  detail: string;
}

export type LoginSpawnFn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe']; detached: boolean },
) => ChildProcess;

/**
 * How long to wait before deciding a login child is "running, browser open".
 *
 * The flows are interactive: the child stays alive until the operator finishes
 * in the browser, so surviving this window is the success signal. A child that
 * exits sooner failed to start the flow.
 */
const LOGIN_SETTLE_MS = 1_200;

/** Auth-directory changes arrive in bursts as a file is written and renamed. */
export const AUTH_WATCH_DEBOUNCE_MS = 400;

/**
 * Reads every account in the auth directory.
 *
 * A file that cannot be parsed, or whose `type` no provider claims, is skipped
 * rather than failing the read: the directory is written by another program and
 * may hold a partially flushed file or an account for a provider Foundry does
 * not offer.
 */
export function readAccounts(authDir: string): BridgeAccount[] {
  let files: string[];
  try {
    files = readdirSync(authDir);
  } catch {
    return [];
  }

  const now = Date.now();
  const accounts: BridgeAccount[] = [];
  for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
    const parsed = readAuthFile(join(authDir, file));
    if (!parsed) continue;
    const provider = providerForAuthType(parsed.type);
    if (!provider) continue;
    const expiresAt = parseExpiry(parsed.expired);
    accounts.push({
      id: file,
      provider: provider.id,
      label: parsed.email || parsed.login || file,
      ...(expiresAt ? { expiresAt } : {}),
      expired: expiresAt ? Date.parse(expiresAt) < now : false,
      disabled: parsed.disabled === true,
    });
  }
  return accounts;
}

/** Every provider with its accounts. Always lists all of them, logged in or not. */
export function providerStatuses(
  authDir: string,
  loginsInFlight: ReadonlySet<string> = new Set(),
): BridgeProviderStatus[] {
  const accounts = readAccounts(authDir);
  return BRIDGE_PROVIDERS.map((provider) => {
    const own = accounts.filter((account) => account.provider === provider.id);
    return {
      id: provider.id,
      label: provider.label,
      icon: provider.icon,
      authenticated: own.some((account) => !account.disabled && !account.expired),
      accounts: own,
      loginInFlight: loginsInFlight.has(provider.id),
    };
  });
}

/** Provider ids with at least one usable account, in table order. */
export function authenticatedProviders(authDir: string): BridgeProviderId[] {
  return providerStatuses(authDir)
    .filter((status) => status.authenticated)
    .map((status) => status.id);
}

/**
 * Watches the auth directory and calls back once per burst.
 *
 * Non-recursive on purpose: CLIProxyAPI writes flat JSON files, and a recursive
 * watcher on macOS costs an FSEvents stream for nothing. A directory that
 * cannot be watched yields a no-op stop function rather than throwing — the
 * status is still correct, it just will not update by itself.
 */
export function watchAuthDir(
  authDir: string,
  onChange: () => void,
  debounceMs = AUTH_WATCH_DEBOUNCE_MS,
): () => void {
  mkdirSync(authDir, { recursive: true });
  let timer: NodeJS.Timeout | null = null;
  let watcher: FSWatcher;
  try {
    watcher = watch(authDir, { persistent: false }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        onChange();
      }, debounceMs);
    });
  } catch {
    return () => undefined;
  }
  return () => {
    if (timer) clearTimeout(timer);
    timer = null;
    watcher.close();
  };
}

export interface StartLoginOptions {
  binary: string;
  configPath: string;
  provider: BridgeProviderId;
  /** Test seam: replace child spawn. */
  spawn?: LoginSpawnFn;
  settleMs?: number;
}

/**
 * Starts a provider's OAuth flow.
 *
 * Resolves once the child has proved it is alive (the browser is open) or has
 * already died. The child is *not* awaited to completion: these flows last as
 * long as the human takes, and an IPC call must not block on that. Completion
 * is observed through the auth-directory watcher instead, which is also what
 * makes a login finished in a browser tab days later still land correctly.
 */
export async function startLogin(opts: StartLoginOptions): Promise<{
  result: BridgeLoginResult;
  child: ChildProcess | null;
}> {
  const provider = bridgeProvider(opts.provider);
  if (!provider) {
    return { result: { ok: false, detail: `unknown provider: ${opts.provider}` }, child: null };
  }

  let child: ChildProcess;
  try {
    const spawnFn = opts.spawn ?? spawn;
    child = spawnFn(opts.binary, ['-config', opts.configPath, provider.loginFlag], {
      // The login child shells out to `open` to launch a browser, which a
      // launchd-inherited PATH does not contain. Without spawnEnv() the flow
      // starts, prints a URL nobody sees, and appears to hang.
      env: spawnEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
  } catch (error) {
    return {
      result: {
        ok: false,
        detail: `could not start the ${provider.label} login: ${message(error)}`,
      },
      child: null,
    };
  }

  const settled = await settle(child, opts.settleMs ?? LOGIN_SETTLE_MS);
  if (!settled.alive) {
    return {
      result: {
        ok: false,
        // Deliberately not the child's stdout: a failing OAuth flow can print
        // a callback URL carrying a code.
        detail: settled.detail ?? `the ${provider.label} login exited before opening a browser`,
      },
      child: null,
    };
  }

  return {
    result: {
      ok: true,
      detail: `Finish signing in to ${provider.label} in your browser. Foundry picks up the account when it lands.`,
    },
    child,
  };
}

/**
 * Deletes every auth file for a provider.
 *
 * Logout is a file delete because that is what the Bridge understands: it
 * hot-reloads its auth directory, so a removed file is a removed account with
 * no restart. Returns how many were removed so the caller can tell "logged out"
 * from "was not logged in".
 */
export function logout(authDir: string, provider: BridgeProviderId): number {
  const own = readAccounts(authDir).filter((account) => account.provider === provider);
  let removed = 0;
  for (const account of own) {
    try {
      rmSync(join(authDir, account.id), { force: true });
      removed += 1;
    } catch {
      // A file another process is holding is not worth failing the logout over;
      // the account count in the next status read is the truth.
    }
  }
  return removed;
}

/** SIGTERM an in-flight login child. Used when the operator cancels or quits. */
export function cancelLogin(child: ChildProcess | null): void {
  const pid = child?.pid;
  if (pid && isAlive(pid)) killTree(pid, 'SIGTERM');
}

interface RawAuthFile {
  type: string;
  email?: string;
  login?: string;
  expired?: string;
  disabled?: boolean;
}

function readAuthFile(path: string): RawAuthFile | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.type !== 'string') return null;
    return {
      type: record.type,
      ...(typeof record.email === 'string' ? { email: record.email } : {}),
      ...(typeof record.login === 'string' ? { login: record.login } : {}),
      ...(typeof record.expired === 'string' ? { expired: record.expired } : {}),
      ...(typeof record.disabled === 'boolean' ? { disabled: record.disabled } : {}),
    };
  } catch {
    return null;
  }
}

/** Normalises the provider's timestamp; an unparseable one means "no expiry". */
function parseExpiry(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function settle(
  child: ChildProcess,
  settleMs: number,
): Promise<{ alive: boolean; detail?: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: { alive: boolean; detail?: string }): void => {
      if (done) return;
      done = true;
      resolve(value);
    };
    child.once('error', (err) => finish({ alive: false, detail: message(err) }));
    child.once('exit', (code) =>
      finish({ alive: false, detail: `the login process exited with code ${code ?? 'unknown'}` }),
    );
    setTimeout(() => finish({ alive: true }), settleMs);
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
