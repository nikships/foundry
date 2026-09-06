import { describe, expect, it, vi } from 'vitest';
import { register } from '../../../src/main/ipc/settings.js';
import type { Handle } from '../../../src/main/ipc/shared.js';
import { IPC, type SaveResult } from '../../../src/shared/ipc-contract.js';
import type { AppSettings } from '../../../src/shared/types.js';

function settingsWith(theme: AppSettings['theme']): AppSettings {
  return { theme } as AppSettings;
}

function setup(result: { ok: true; settings: AppSettings } | { ok: false; issues: string[] }) {
  const handlers = new Map<string, (...args: never[]) => unknown>();
  const applyTheme = vi.fn();
  const broadcast = vi.fn();
  const patch = vi.fn(() => result);
  const handle: Handle = (channel, handler) => {
    handlers.set(channel, handler);
  };

  register({ settings: { get: vi.fn(), patch }, applyTheme, broadcast } as never, handle);

  return {
    applyTheme,
    broadcast,
    patch,
    patchSettings: handlers.get(IPC.settingsPatch) as (
      patch: Partial<AppSettings>,
    ) => SaveResult<AppSettings>,
  };
}

describe('settings IPC theme updates', () => {
  it('updates the native palette and notifies renderers after a successful theme save', () => {
    const light = settingsWith('light');
    const { applyTheme, broadcast, patch, patchSettings } = setup({ ok: true, settings: light });

    expect(patchSettings({ theme: 'light' })).toEqual({ ok: true, issues: [], value: light });
    expect(patch).toHaveBeenCalledWith({ theme: 'light' });
    expect(applyTheme).toHaveBeenCalledWith('light');
    expect(broadcast).toHaveBeenCalledWith(IPC.eventSettingsChanged);
  });

  it('applies a named palette the same way as light and dark', () => {
    const midnight = settingsWith('midnight');
    const { applyTheme, patch, patchSettings } = setup({ ok: true, settings: midnight });

    expect(patchSettings({ theme: 'midnight' })).toEqual({
      ok: true,
      issues: [],
      value: midnight,
    });
    expect(patch).toHaveBeenCalledWith({ theme: 'midnight' });
    expect(applyTheme).toHaveBeenCalledWith('midnight');
  });

  it('does not change the native palette or claim a save when validation rejects the patch', () => {
    const { applyTheme, broadcast, patchSettings } = setup({
      ok: false,
      issues: ['theme: Invalid option'],
    });

    expect(patchSettings({ theme: 'sepia' as never })).toEqual({
      ok: false,
      issues: [{ level: 'error', where: 'settings', message: 'theme: Invalid option' }],
    });
    expect(applyTheme).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });
});
