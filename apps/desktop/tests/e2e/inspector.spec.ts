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

      await expect(window.getByTestId('run-composer')).toBeVisible({ timeout: 20_000 });
      await window.getByTestId(`sidebar-run-${fixture.runId}`).click();

      await expect(window.getByTestId('app-view')).toHaveAttribute('data-view', 'inspector');
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
