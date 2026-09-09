/**
 * The opt-in Tavily extension: a confirmed download of one exact-pinned spec,
 * a key that lives in an encrypted file and this process's environment, and
 * an on-disk install whose presence is the enable switch.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../helpers/tmp.js';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value.split('').reverse().join('')),
    decryptString: (value: Buffer) => value.toString().split('').reverse().join(''),
  },
}));

const { TavilyService, tavilyCredentials, TAVILY_KEY_ENV_VAR } =
  await import('../../../src/main/tavily/service.js');
const { OPTIONAL_PACKAGES, optionalPackageDir, installedOptionalPackages } =
  await import('../../../src/main/pi/packages.js');

const TAVILY = OPTIONAL_PACKAGES.find((pkg) => pkg.name === 'tavily')!;

let support: string;
let env: NodeJS.ProcessEnv;

/** Lay the directory npm would have produced for the pinned spec. */
function layInstall(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: TAVILY.npmName }));
}

function service(overrides?: {
  install?: (spec: string, prefix: string) => Promise<void>;
}): InstanceType<typeof TavilyService> {
  return new TavilyService({
    supportDir: support,
    credentials: tavilyCredentials(support),
    env,
    ...(overrides?.install ? { install: overrides.install } : {}),
  });
}

beforeEach(() => {
  support = tempDir('foundry-tavily-');
  env = {};
});

describe('the Tavily optional package declaration', () => {
  it('is exact-pinned, never a range npm could widen', () => {
    expect(TAVILY.npmSpec).toMatch(/^@tavily\/pi-extension@\d+\.\d+\.\d+$/);
    expect(TAVILY.npmName).toBe('@tavily/pi-extension');
  });

  it('marks its network-read tools safe for read-only reviewers', () => {
    expect(TAVILY.extensionsForReadOnly).toBe(true);
  });
});

describe('enabling', () => {
  it('downloads the pinned spec into support and reports installed', async () => {
    const installs: [string, string][] = [];
    const svc = service({
      install: async (spec, prefix) => {
        installs.push([spec, prefix]);
        layInstall(optionalPackageDir(support, TAVILY));
      },
    });

    expect(svc.state().installed).toBe(false);
    const result = await svc.install();
    expect(result.ok).toBe(true);
    expect(installs).toEqual([[TAVILY.npmSpec, join(support, 'pi-packages', 'tavily')]]);
    expect(svc.state().installed).toBe(true);
    // The install is what package resolution sees; no second flag exists.
    expect(installedOptionalPackages(support)).toEqual([
      { pkg: TAVILY, dir: optionalPackageDir(support, TAVILY) },
    ]);
  });

  it('cleans up a failed download so the next launch does not read as enabled', async () => {
    const svc = service({
      install: async (_spec, prefix) => {
        mkdirSync(join(prefix, 'node_modules'), { recursive: true });
        throw new Error('network gave out');
      },
    });
    const result = await svc.install();
    expect(result).toEqual({ ok: false, detail: 'network gave out' });
    expect(svc.state().installed).toBe(false);
    expect(installedOptionalPackages(support)).toEqual([]);
  });

  it('is idempotent once installed', async () => {
    layInstall(optionalPackageDir(support, TAVILY));
    const install = vi.fn();
    const result = await service({ install }).install();
    expect(result.ok).toBe(true);
    expect(install).not.toHaveBeenCalled();
  });
});

describe('removal', () => {
  it('deletes the install and keeps the stored key', async () => {
    layInstall(optionalPackageDir(support, TAVILY));
    const svc = service();
    svc.setApiKey('tvly-keep-me');

    expect(svc.remove().ok).toBe(true);
    expect(svc.state()).toMatchObject({ installed: false, keySet: true });
    expect(installedOptionalPackages(support)).toEqual([]);
  });
});

describe('the API key', () => {
  it('round-trips encrypted, never plaintext on disk, and exports into env', () => {
    const svc = service();
    expect(svc.setApiKey('  tvly-secret-value  ')).toMatchObject({ ok: true });
    expect(env[TAVILY_KEY_ENV_VAR]).toBe('tvly-secret-value');
    const file = join(support, 'credentials', 'tavily-api-key.bin');
    expect(readFileSync(file, 'utf8')).not.toContain('tvly-secret-value');
  });

  it('clears the environment with the stored key', () => {
    const svc = service();
    svc.setApiKey('tvly-secret');
    expect(svc.clearApiKey().ok).toBe(true);
    expect(env[TAVILY_KEY_ENV_VAR]).toBeUndefined();
    expect(svc.state().keySet).toBe(false);
  });

  it('rejects an empty key', () => {
    expect(service().setApiKey('   ').ok).toBe(false);
  });

  it('applyEnv exports a stored key at startup and drops an undecryptable one', () => {
    const svc = service();
    svc.setApiKey('tvly-startup');
    const fresh: NodeJS.ProcessEnv = {};
    new TavilyService({
      supportDir: support,
      credentials: tavilyCredentials(support),
      env: fresh,
    }).applyEnv();
    expect(fresh[TAVILY_KEY_ENV_VAR]).toBe('tvly-startup');

    const broken: NodeJS.ProcessEnv = { [TAVILY_KEY_ENV_VAR]: 'stale' };
    new TavilyService({
      supportDir: support,
      credentials: {
        has: () => true,
        get: () => {
          throw new Error('cannot decrypt');
        },
        set: () => {},
        clear: () => {},
      },
      env: broken,
    }).applyEnv();
    expect(broken[TAVILY_KEY_ENV_VAR]).toBeUndefined();
  });
});
