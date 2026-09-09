/**
 * The opt-in Tavily web-search extension for run agents.
 *
 * Nothing here ships with the app: enabling is an explicit, confirmed
 * download of the one exact-pinned npm spec named in `pi/packages.ts`,
 * installed under Foundry's support directory with scripts disabled. The
 * install's presence on disk is the enable switch — sessions opened after an
 * install (or a remove) see the change through `installedOptionalPackages`.
 *
 * The extension reads `TAVILY_API_KEY` from its own process, which is this
 * process: pi runs in-process, so the key is exported into `process.env` here
 * and stripped back out of every child's environment by `spawnEnv`.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { TavilyActionResult, TavilyConnectionState } from '@shared/ipc-contract.js';
import {
  OPTIONAL_PACKAGES,
  optionalPackageDir,
  optionalPackageInstallDir,
  type OptionalPackage,
} from '../pi/packages.js';
import { spawnEnv, whichBinary } from '../system/env.js';
import { electronSafeStorage, SecretFileStore, type SecretStore } from '../system/secret-file.js';

const exec = promisify(execFile);

/** A download over a slow network is fine; a hung one must not be. */
const INSTALL_TIMEOUT_MS = 300_000;

export const TAVILY_KEY_ENV_VAR = 'TAVILY_API_KEY';

const TAVILY_PACKAGE: OptionalPackage = (() => {
  const pkg = OPTIONAL_PACKAGES.find((candidate) => candidate.name === 'tavily');
  if (!pkg) throw new Error('the tavily optional package is not declared');
  return pkg;
})();

export interface TavilyServiceDeps {
  supportDir: string;
  credentials: SecretStore;
  /** Test seam: stands in for the pinned npm download. */
  install?: (npmSpec: string, prefix: string) => Promise<void>;
  /** Test seam: the process environment the key is exported into. */
  env?: NodeJS.ProcessEnv;
  /** Test seam: where the install lands; defaults to the shared layout. */
  installed?: () => boolean;
}

/**
 * `--ignore-scripts` is the whole security posture of the download: the
 * package's own code runs later, inside pi's extension host, never as an
 * install hook. Peers are omitted because pi aliases its own runtime packages
 * over any local copy, so installing them would ship dead weight.
 */
async function npmInstall(npmSpec: string, prefix: string): Promise<void> {
  const npm = whichBinary('npm');
  if (!npm) throw new Error('npm was not found on the resolved PATH');
  mkdirSync(prefix, { recursive: true });
  await exec(
    npm,
    [
      'install',
      npmSpec,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      '--omit=dev',
      '--omit=peer',
      '--prefix',
      prefix,
    ],
    { env: spawnEnv(), timeout: INSTALL_TIMEOUT_MS, encoding: 'utf8' },
  );
}

export class TavilyService {
  constructor(private readonly deps: TavilyServiceDeps) {}

  /**
   * Export the stored key into this process so the in-process extension can
   * read it. Called at startup after safeStorage is available and again after
   * every key change; a key that fails to decrypt surfaces in `state()`
   * rather than blocking launch.
   */
  applyEnv(): void {
    const env = this.deps.env ?? process.env;
    try {
      const key = this.deps.credentials.get();
      if (key) env[TAVILY_KEY_ENV_VAR] = key;
      else delete env[TAVILY_KEY_ENV_VAR];
    } catch {
      delete env[TAVILY_KEY_ENV_VAR];
      console.warn('[tavily] Stored API key could not be read. Re-enter it in Settings.');
    }
  }

  state(): TavilyConnectionState {
    const installed = this.installed();
    let keySet: boolean;
    try {
      keySet = Boolean(this.deps.credentials.get());
    } catch {
      return {
        installed,
        keySet: false,
        npmSpec: TAVILY_PACKAGE.npmSpec,
        detail: 'The stored Tavily API key could not be read. Re-enter it in Settings.',
      };
    }
    return {
      installed,
      keySet,
      npmSpec: TAVILY_PACKAGE.npmSpec,
      detail: installed
        ? keySet
          ? 'Tavily web search is available to run agents.'
          : 'The extension is downloaded. Add a Tavily API key to activate its tools.'
        : 'Tavily web search is off. Enabling downloads the extension package.',
    };
  }

  async install(): Promise<TavilyActionResult> {
    if (this.installed()) return { ok: true, detail: 'Tavily extension is already downloaded.' };
    const prefix = optionalPackageInstallDir(this.deps.supportDir, TAVILY_PACKAGE);
    try {
      await (this.deps.install ?? npmInstall)(TAVILY_PACKAGE.npmSpec, prefix);
    } catch (error) {
      // A partial download must not read as enabled on the next launch.
      rmSync(prefix, { recursive: true, force: true });
      return { ok: false, detail: errorMessage(error) };
    }
    if (!this.installed()) {
      rmSync(prefix, { recursive: true, force: true });
      return {
        ok: false,
        detail: 'The download completed but the package is not where npm should have put it.',
      };
    }
    return {
      ok: true,
      detail: `Downloaded ${TAVILY_PACKAGE.npmSpec}. New agent sessions can now search the web.`,
    };
  }

  remove(): TavilyActionResult {
    rmSync(optionalPackageInstallDir(this.deps.supportDir, TAVILY_PACKAGE), {
      recursive: true,
      force: true,
    });
    return {
      ok: true,
      detail: 'Tavily extension removed. Sessions already open keep their tools until they close.',
    };
  }

  setApiKey(candidate: string): TavilyActionResult {
    const apiKey = candidate.trim();
    if (!apiKey) return { ok: false, detail: 'Enter a Tavily API key.' };
    try {
      this.deps.credentials.set(apiKey);
    } catch (error) {
      return { ok: false, detail: errorMessage(error) };
    }
    this.applyEnv();
    return { ok: true, detail: 'Tavily API key saved.' };
  }

  clearApiKey(): TavilyActionResult {
    this.deps.credentials.clear();
    this.applyEnv();
    return { ok: true, detail: 'Tavily API key removed.' };
  }

  private installed(): boolean {
    if (this.deps.installed) return this.deps.installed();
    return existsSync(optionalPackageDir(this.deps.supportDir, TAVILY_PACKAGE));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

export function tavilyCredentials(supportDir: string): SecretStore {
  return new SecretFileStore(
    join(supportDir, 'credentials', 'tavily-api-key.bin'),
    electronSafeStorage,
    'Tavily API key',
  );
}
