import { tempDir } from '../tmp.js';
import { expect, test, type ElectronApplication } from '@playwright/test';
import { launchFoundry } from './harness.js';

test.describe('onboarding / readiness', () => {
  test('walks welcome through providers to the doctor readiness screen', async () => {
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

      await expect(window.getByRole('heading', { name: 'Give the factory a model' })).toBeVisible();

      // The fixture seeds no credential, so this install genuinely cannot reach
      // a model and the step must refuse to advance rather than hand the doctor
      // a factory with nothing to run on.
      await expect(window.getByTestId('onboarding-model-count')).toHaveText('0');
      await expect(window.getByRole('button', { name: /Continue/ })).toBeDisabled();

      // A syntactically valid but fabricated key: pi lists a provider's models
      // once a credential exists for it, and the refresh runs with network off,
      // so this reaches no provider and spends nothing.
      await window.getByLabel('Provider API key').fill('sk-ant-e2e-not-a-real-key');
      await window.getByRole('button', { name: 'Save key' }).click();

      await expect(window.getByTestId('onboarding-model-count')).not.toHaveText('0', {
        timeout: 20_000,
      });
      await expect(window.getByText('ready to run')).toBeVisible();
      await window.getByRole('button', { name: /Continue/ }).click();

      await expect(window.getByRole('heading', { name: 'Make the floor safe' })).toBeVisible();
      await expect(window.getByText('Diagnostics')).toBeVisible();
      await expect(window.getByRole('button', { name: 'Re-check environment' })).toBeVisible();
      // The Bridge binary is absent in a checkout that skipped `fetch:bridge`,
      // and that must not be what stops onboarding: the usable-model check is
      // the only provider check allowed to block.
      await expect(window.getByText('Usable models')).toBeVisible();
    } finally {
      await app?.close();
    }
  });
});
