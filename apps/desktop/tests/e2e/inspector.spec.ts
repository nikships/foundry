import { expect, test, type ElectronApplication } from '@playwright/test';
import { E2E_TRANSCRIPT, seedOnboardedFixture } from './seed.js';
import { launchFoundry } from './harness.js';

test.describe('run / Inspector', () => {
  test('opens a seeded run and shows its phase transcript', async () => {
    const fixture = seedOnboardedFixture();
    let app: ElectronApplication | undefined;
    try {
      const launched = await launchFoundry(fixture.userDataDir);
      app = launched.app;
      const { window } = launched;

      await expect(
        window.getByRole('heading', { name: 'What should the factory build?' }),
      ).toBeVisible({ timeout: 20_000 });
      await window.getByRole('button', { name: /Accepted\s+Prompt/ }).click();

      await expect(window.getByRole('button', { name: '← Runs' })).toBeVisible();
      await expect(window.getByText('amended ×1', { exact: true })).toBeVisible();
      await window.getByTestId('run-export-plan').click();
      await expect(window.getByText('Save to the Designer', { exact: true })).toBeVisible();
      await window.keyboard.press('Escape');
      await window.getByTitle('Open live transcript in Inspector').click();

      await expect(window.getByRole('button', { name: 'Run', exact: true })).toBeVisible();
      await expect(window.getByText(E2E_TRANSCRIPT).first()).toBeVisible();
      await expect(window.getByText('pipeline amended').first()).toBeVisible();
      await expect(window.getByText(/seeded verifier failure/).first()).toBeVisible();
      await expect(window.getByText('build').first()).toBeVisible();
      await expect(window.getByText('report').first()).toBeVisible();
    } finally {
      await app?.close();
    }
  });
});
