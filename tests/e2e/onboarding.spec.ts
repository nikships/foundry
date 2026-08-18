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

      const count = window.getByTestId('onboarding-model-count');
      const next = window.getByRole('button', { name: /Continue/ });
      await expect(count).toBeVisible();

      // The step gates on a reachable model, and whether one exists is a
      // property of the machine rather than of the fixture: `--user-data-dir`
      // isolates Foundry's own state, but pi reads the operator's provider keys
      // from their environment. So the assertion is the gate itself — Continue
      // is available exactly when a model is — which holds both on a developer's
      // credentialled Mac and on a CI runner with nothing.
      if ((await count.textContent()) === '0') {
        await expect(next).toBeDisabled();
        await expect(window.getByText('none reachable')).toBeVisible();

        // A syntactically plausible but fabricated key. pi lists a provider's
        // models once a credential exists for it and the refresh runs with
        // network off, so this reaches no provider and spends nothing.
        await window.getByLabel('Provider API key').fill('sk-ant-e2e-not-a-real-key');
        await window.getByRole('button', { name: 'Save key' }).click();
        await expect(count).not.toHaveText('0', { timeout: 20_000 });
      }

      await expect(window.getByText('ready to run')).toBeVisible();
      await expect(next).toBeEnabled();
      await next.click();

      await expect(window.getByRole('heading', { name: 'Make the floor safe' })).toBeVisible();
      await expect(window.getByText('Diagnostics')).toBeVisible();
      await expect(window.getByRole('button', { name: 'Re-check environment' })).toBeVisible();
      // A checkout that skipped `fetch:bridge` has no Bridge binary, and that
      // must not be what stops onboarding: the usable-model check is the only
      // provider check allowed to block. `.first()` because when that check
      // fails (a runner with no credentials), the Blocked divider repeats the
      // label alongside the check row itself.
      await expect(window.getByText('Usable models').first()).toBeVisible();
    } finally {
      await app?.close();
    }
  });
});
