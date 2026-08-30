import { expect, test, type ElectronApplication } from '@playwright/test';
import { E2E_TRANSCRIPT, seedOnboardedFixture } from './seed.js';
import { launchFoundry } from './harness.js';

test.describe('run / Inspector', () => {
  test('shows a phase transcript and toggles into resizable run detail', async () => {
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

      await window.getByTestId('inspector-open-run').click();
      await expect(window.getByTestId('app-view')).toHaveAttribute('data-view', 'run-detail');

      const resizeHandle = window.getByTestId('run-prompt-resize');
      await expect(resizeHandle).toHaveAttribute('aria-valuenow', '76');
      const handleBox = await resizeHandle.boundingBox();
      if (!handleBox) throw new Error('run prompt resize handle has no bounding box');
      await window.mouse.move(
        handleBox.x + handleBox.width / 2,
        handleBox.y + handleBox.height / 2,
      );
      await window.mouse.down();
      await window.mouse.move(
        handleBox.x + handleBox.width / 2,
        handleBox.y + handleBox.height / 2 + 60,
      );
      await window.mouse.up();
      await expect(resizeHandle).toHaveAttribute('aria-valuenow', '136');

      await window.getByTestId('run-open-inspector').click();
      await expect(window.getByTestId('app-view')).toHaveAttribute('data-view', 'inspector');
      await expect(window.getByText(E2E_TRANSCRIPT).first()).toBeVisible();
    } finally {
      await app?.close();
    }
  });
});
