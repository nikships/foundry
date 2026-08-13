import { tempDir } from '../tmp.js';
import { expect, test, type ElectronApplication } from '@playwright/test';
import { launchFoundry } from './harness.js';

test.describe('onboarding / readiness', () => {
  test('walks welcome through the doctor readiness screen', async () => {
    const userDataDir = tempDir('foundry-e2e-onboard-');
    let app: ElectronApplication | undefined;
    try {
      const launched = await launchFoundry(userDataDir);
      app = launched.app;
      const { window } = launched;

      await expect(window.getByRole('heading', { name: 'Foundry' })).toBeVisible({
        timeout: 20_000,
      });
      await window.getByRole('button', { name: /Begin/ }).click();

      await expect(window.getByRole('heading', { name: /The factory floor/ })).toBeVisible();
      await window.getByRole('button', { name: /Continue/ }).click();

      await expect(window.getByRole('heading', { name: 'Meet the crew' })).toBeVisible();
      await window.getByRole('button', { name: /Continue/ }).click();

      await expect(window.getByRole('heading', { name: 'Agent harness setup' })).toBeVisible();
      await window.getByRole('button', { name: /Continue/ }).click();

      await expect(window.getByRole('heading', { name: 'Make the floor safe' })).toBeVisible();
      await expect(window.getByText('Diagnostics')).toBeVisible();
      await expect(window.getByRole('button', { name: 'Re-check environment' })).toBeVisible();
    } finally {
      await app?.close();
    }
  });
});
