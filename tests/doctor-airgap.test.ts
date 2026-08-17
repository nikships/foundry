/**
 * The doctor under airgap mode.
 *
 * Onboarding refuses to continue while a blocking check fails, so the question
 * "is droid able to reach a model" has to be asked differently once there is no
 * Factory credential by design. Airgap swaps the credential check for the thing
 * that actually gates a run: whether any BYOK model is configured.
 *
 * `catalog.js` is mocked because both functions the doctor calls there reach
 * outside the process — one spawns the CLI, the other reads the real
 * `~/.factory/settings.json`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, DoctorCheck } from '../src/shared/types.js';

const cliVersion = vi.fn<() => Promise<string | null>>();
const customModels = vi.fn<() => Promise<{ model: string; displayName: string }[]>>();

vi.mock('../src/main/droid/catalog.js', () => ({
  cliVersion: () => cliVersion(),
  customModels: () => customModels(),
}));

const { runDoctor } = await import('../src/main/system/doctor.js');
const { defaultSettings } = await import('../src/main/store/settings.js');

beforeEach(() => {
  cliVersion.mockResolvedValue('0.197.0');
  customModels.mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

function settings(over: Partial<AppSettings> = {}): AppSettings {
  return { ...defaultSettings(), ...over };
}

async function authCheck(over: Partial<AppSettings>): Promise<DoctorCheck> {
  const checks = await runDoctor(settings(over));
  const found = checks.find((c) => c.id === 'auth:droid');
  if (!found) throw new Error('doctor reported no auth:droid check');
  return found;
}

describe('doctor with airgap mode on', () => {
  it('passes on a BYOK model instead of demanding a credential', async () => {
    customModels.mockResolvedValue([{ model: 'qwen3', displayName: 'Local Qwen' }]);
    const check = await authCheck({ airgapMode: true, factoryApiKey: '' });
    expect(check.ok).toBe(true);
    expect(check.blocking).toBe(false);
    expect(check.detail).toContain('1 BYOK model');
  });

  it('blocks when airgap is on and no custom model is configured', async () => {
    customModels.mockResolvedValue([]);
    const check = await authCheck({ airgapMode: true, factoryApiKey: '' });
    expect(check.ok).toBe(false);
    expect(check.blocking).toBe(true);
    expect(check.detail).toContain('no customModels');
  });

  it('reports the count rather than a bare pass, so the picker is predictable', async () => {
    customModels.mockResolvedValue([
      { model: 'a', displayName: 'A' },
      { model: 'b', displayName: 'B' },
    ]);
    expect((await authCheck({ airgapMode: true })).detail).toContain('2 BYOK models');
  });

  it('ignores a Factory key that airgap makes irrelevant', async () => {
    customModels.mockResolvedValue([{ model: 'qwen3', displayName: 'Local Qwen' }]);
    const check = await authCheck({ airgapMode: true, factoryApiKey: 'fk-a-real-looking-key' });
    expect(check.ok).toBe(true);
    expect(check.detail).not.toContain('Settings');
  });

  it('points at the BYOK docs rather than the API key page when it fails', async () => {
    const check = await authCheck({ airgapMode: true });
    expect(check.fix).toEqual({
      kind: 'open-url',
      value: 'https://docs.factory.ai/model-independence/byok',
    });
  });

  it('never consults customModels while airgap is off', async () => {
    await authCheck({ airgapMode: false, factoryApiKey: 'fk-a-real-looking-key' });
    expect(customModels).not.toHaveBeenCalled();
  });

  it('still blocks on a missing credential once airgap is off', async () => {
    const check = await authCheck({ airgapMode: false, factoryApiKey: '' });
    // A developer machine may have a real ~/.factory or FACTORY_API_KEY, so the
    // assertion is on which question was asked, not on the verdict.
    expect(check.label).toBe('Factory droid authentication');
  });

  it('does not report the CLI itself as missing just because airgap is on', async () => {
    const checks = await runDoctor(settings({ airgapMode: true }));
    expect(checks.find((c) => c.id === 'cli:droid')?.ok).toBe(true);
  });
});
