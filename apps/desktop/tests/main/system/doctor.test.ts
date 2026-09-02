/**
 * The provider half of the doctor, exercised against injected dependencies.
 *
 * Hermetic by construction: `checkProviders` takes its Bridge and its catalog
 * as `ProviderDoctorDeps`, so every machine this file states — no Bridge binary,
 * a Bridge that will not launch, an empty catalog, an expired account — is a
 * plain object rather than a process. No binary, no port, no network.
 *
 * The one property that matters most: exactly one check blocks. An operator
 * running on their own API keys has no Bridge and a working factory, so a
 * missing binary must report and explain rather than refuse to continue. What
 * does break a run is having no model at all.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../helpers/tmp.js';
import type { DoctorCheck, ModelInfo } from '../../../src/shared/types.js';
import type { BridgeProviderStatus } from '../../../src/main/bridge/auth.js';
import { defaultProject } from '../../../src/main/store/projects.js';
import {
  checkProject,
  checkProviders,
  type ProviderDoctorDeps,
} from '../../../src/main/system/doctor.js';

function model(id: string, displayName = id): ModelInfo {
  return {
    id,
    displayName,
    provider: 'anthropic',
    supportedReasoningEfforts: ['off', 'medium'],
    defaultReasoningEffort: 'medium',
    isCustom: false,
    deprecated: false,
    contextWindow: 200_000,
  };
}

function provider(over: Partial<BridgeProviderStatus> = {}): BridgeProviderStatus {
  return {
    id: 'claude',
    label: 'Claude',
    icon: 'claude',
    authenticated: true,
    accounts: [],
    loginInFlight: false,
    ...over,
  };
}

function deps(over: Partial<ProviderDoctorDeps> = {}): ProviderDoctorDeps {
  return {
    ensureBridge: () => Promise.resolve({ ok: true, detail: 'serving on http://127.0.0.1:37717' }),
    bridgeProviders: () => [],
    agentModels: () => Promise.resolve([model('bridge-claude/claude-opus-5', 'Claude Opus 5')]),
    ...over,
  };
}

const find = (checks: DoctorCheck[], id: string): DoctorCheck | undefined =>
  checks.find((c) => c.id === id);

describe('the Bridge check', () => {
  it('passes with the manager’s own detail when the Bridge is serving', async () => {
    const checks = await checkProviders(deps());
    const bridge = find(checks, 'bridge')!;
    expect(bridge.ok).toBe(true);
    expect(bridge.detail).toContain('37717');
    expect(bridge.fix).toBeUndefined();
  });

  it('explains a missing binary and never blocks on it', async () => {
    const checks = await checkProviders(
      deps({
        ensureBridge: () =>
          Promise.resolve({
            ok: false,
            reason: 'binary_missing' as const,
            detail: 'resources/bridge is empty',
          }),
      }),
    );
    const bridge = find(checks, 'bridge')!;
    expect(bridge.ok).toBe(false);
    expect(bridge.blocking).toBeFalsy();
    expect(bridge.detail).toContain('not installed');
    expect(bridge.detail).toContain('direct API keys still work');
    expect(bridge.fix).toEqual({ kind: 'open-settings', value: 'models' });
  });

  // The manager's `detail` states only the remedy and the check prefixes the
  // reason, so the two must not both name the fault: "the binary is not
  // installed: the binary is not installed; run …" is what this prevents.
  it('states the fault once, not twice', async () => {
    const { BridgeManager } = await import('../../../src/main/bridge/manager.js');
    const manager = new BridgeManager({ supportDir: tempDir('foundry-doctor-bridge-') });
    const real = await manager.ensure();
    if (real.ok) return; // a checkout that ran fetch:bridge has a serving Bridge
    // The same mapping `ipc/maintenance.ts` applies, so the copy under test is
    // the copy the operator reads.
    const checks = await checkProviders(
      deps({
        ensureBridge: () =>
          Promise.resolve({ ok: false, detail: real.detail, reason: real.reason }),
      }),
    );
    const detail = find(checks, 'bridge')!.detail;
    expect(detail.match(/not installed/g) ?? []).toHaveLength(1);
    expect(detail).toContain('fetch:bridge');
  });

  it('names each launch failure in the operator’s terms', async () => {
    const cases: [string, string][] = [
      ['spawn_failed', 'would not launch'],
      ['port_exhausted', 'no port'],
      ['health_timeout', 'never answered'],
    ];
    for (const [reason, phrase] of cases) {
      const checks = await checkProviders(
        deps({
          ensureBridge: () =>
            Promise.resolve({
              ok: false,
              reason: reason as 'spawn_failed',
              detail: 'exit 1',
            }),
        }),
      );
      expect(find(checks, 'bridge')!.detail, reason).toContain(phrase);
    }
  });
});

describe('the usable-models check', () => {
  it('is the only blocking provider check, and only when the catalog is empty', async () => {
    const checks = await checkProviders(deps({ agentModels: () => Promise.resolve([]) }));
    expect(checks.filter((c) => c.blocking).map((c) => c.id)).toEqual(['agent-models']);
    const models = find(checks, 'agent-models')!;
    expect(models.ok).toBe(false);
    expect(models.detail).toContain('no model has a working credential');
    expect(models.fix).toEqual({ kind: 'open-settings', value: 'models' });
  });

  it('passes and names one model when the catalog has any', async () => {
    const checks = await checkProviders(
      deps({
        agentModels: () => Promise.resolve([model('anthropic/a', 'Model A'), model('openai/b')]),
      }),
    );
    const models = find(checks, 'agent-models')!;
    expect(models.ok).toBe(true);
    expect(models.blocking).toBe(false);
    expect(models.detail).toContain('2 models');
    expect(models.detail).toContain('Model A');
  });

  it('stays ok: true and does not name a hidden model when all models are hidden', async () => {
    const checks = await checkProviders(
      deps({
        agentModels: () =>
          Promise.resolve([model('anthropic/a', 'Model A'), model('openai/b', 'Model B')]),
        hiddenModelIds: () => ['anthropic/a', 'openai/b'],
      }),
    );
    const models = find(checks, 'agent-models')!;
    expect(models.ok).toBe(true);
    expect(models.blocking).toBe(false);
    expect(models.detail).toBe('2 models available');
    expect(models.detail).not.toContain('Model A');
    expect(models.detail).not.toContain('Model B');
  });

  it('names the first visible model when some are hidden', async () => {
    const checks = await checkProviders(
      deps({
        agentModels: () =>
          Promise.resolve([model('anthropic/a', 'Model A'), model('openai/b', 'Model B')]),
        hiddenModelIds: () => ['anthropic/a'],
      }),
    );
    const models = find(checks, 'agent-models')!;
    expect(models.ok).toBe(true);
    expect(models.blocking).toBe(false);
    expect(models.detail).toContain('2 models');
    expect(models.detail).toContain('Model B');
    expect(models.detail).not.toContain('Model A');
  });

  // A catalog that throws is indistinguishable from an empty one for the
  // operator, but the reason it threw is the only actionable part.
  it('reports why the catalog could not be read, and still blocks', async () => {
    const checks = await checkProviders(
      deps({ agentModels: () => Promise.reject(new Error('pi agent dir is unreadable')) }),
    );
    const models = find(checks, 'agent-models')!;
    expect(models.ok).toBe(false);
    expect(models.blocking).toBe(true);
    expect(models.detail).toContain('pi agent dir is unreadable');
  });
});

describe('per-provider account checks', () => {
  it('reports nothing for a provider nobody signed into', async () => {
    const checks = await checkProviders(
      deps({ bridgeProviders: () => [provider({ authenticated: false })] }),
    );
    expect(find(checks, 'provider:claude')).toBeUndefined();
  });

  it('reports the soonest expiry for a healthy account', async () => {
    const checks = await checkProviders(
      deps({
        bridgeProviders: () => [
          provider({
            accounts: [
              {
                id: 'claude-2.json',
                provider: 'claude',
                label: 'ada@example.com',
                expiresAt: '2026-12-01T00:00:00.000Z',
                expired: false,
                disabled: false,
              },
              {
                id: 'claude-1.json',
                provider: 'claude',
                label: 'grace@example.com',
                expiresAt: '2026-09-01T00:00:00.000Z',
                expired: false,
                disabled: false,
              },
            ],
          }),
        ],
      }),
    );
    const account = find(checks, 'provider:claude')!;
    expect(account.ok).toBe(true);
    expect(account.label).toBe('Claude account');
    expect(account.detail).toContain('2026-09-01');
    expect(account.fix).toBeUndefined();
  });

  it('says to reconnect an expired sign-in and offers the Providers pane', async () => {
    const checks = await checkProviders(
      deps({
        bridgeProviders: () => [
          provider({
            authenticated: false,
            accounts: [
              {
                id: 'claude-1.json',
                provider: 'claude',
                label: 'ada@example.com',
                expired: true,
                disabled: false,
              },
            ],
          }),
        ],
      }),
    );
    const account = find(checks, 'provider:claude')!;
    expect(account.ok).toBe(false);
    expect(account.detail).toContain('reconnect Claude');
    expect(account.fix).toEqual({ kind: 'open-settings', value: 'models' });
  });

  it('distinguishes every account disabled from an expiry', async () => {
    const checks = await checkProviders(
      deps({
        bridgeProviders: () => [
          provider({
            authenticated: false,
            accounts: [
              {
                id: 'claude-1.json',
                provider: 'claude',
                label: 'ada@example.com',
                expired: false,
                disabled: true,
              },
            ],
          }),
        ],
      }),
    );
    expect(find(checks, 'provider:claude')!.detail).toContain('disabled');
  });

  // A failing account is a fault to fix, not a reason to stop setup: another
  // provider or a direct key can still supply a model.
  it('never blocks, even with every account expired', async () => {
    const checks = await checkProviders(
      deps({
        bridgeProviders: () => [
          provider({
            authenticated: false,
            accounts: [
              {
                id: 'claude-1.json',
                provider: 'claude',
                label: 'ada@example.com',
                expired: true,
                disabled: false,
              },
            ],
          }),
        ],
      }),
    );
    expect(checks.filter((c) => c.blocking)).toEqual([]);
  });
});

describe('checkProject submodules', () => {
  function gitRepo(): string {
    const dir = tempDir('foundry-doctor-repo-');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@foundry.local'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Foundry Test'], { cwd: dir });
    writeFileSync(join(dir, 'README.md'), '# scratch\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: dir });
    return dir;
  }

  it('is green when the repo has submodules, because run worktrees initialize them', async () => {
    const dir = gitRepo();
    writeFileSync(
      join(dir, '.gitmodules'),
      '[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = ./vendor/lib\n',
    );
    mkdirSync(join(dir, 'vendor', 'lib'), { recursive: true });
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'note submodules'], { cwd: dir });

    const checks = await checkProject(defaultProject(dir));
    const row = checks.find((c) => c.id === 'submodules');
    expect(row?.ok).toBe(true);
    expect(row?.detail).toContain('initialized in each run worktree');
  });
});
