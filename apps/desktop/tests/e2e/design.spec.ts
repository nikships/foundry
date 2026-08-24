import { expect, test, type ElectronApplication } from '@playwright/test';
import { seedOnboardedFixture } from './seed.js';
import { launchFoundry } from './harness.js';

test.describe('design / Pipelines', () => {
  test('opens a phase from its card and creates valid pipelines without initial errors', async () => {
    const fixture = seedOnboardedFixture();
    let app: ElectronApplication | undefined;
    try {
      const launched = await launchFoundry(fixture.userDataDir);
      app = launched.app;
      const { window } = launched;

      await expect(
        window.getByRole('heading', { name: 'What should the factory build?' }),
      ).toBeVisible({ timeout: 20_000 });
      await window.getByTestId('nav-design').click();
      await window.getByTestId('tab-pipelines').click();
      await expect(window.getByTestId('pipeline-selector')).toBeVisible();

      const planCard = window.getByTestId('pipeline-phase-plan');
      await expect(planCard).toBeVisible();
      await planCard.click();

      const sheet = window.getByRole('dialog', { name: 'Edit plan' });
      await expect(sheet).toBeVisible();
      const description = sheet.getByLabel('Description');
      await description.fill('Write the implementable plan the builder will follow.');
      await expect(
        planCard.getByText('Write the implementable plan the builder will follow.'),
      ).toBeVisible();

      await sheet.getByRole('button', { name: 'Close Edit plan' }).click();
      await expect(sheet).toBeHidden();

      await window.getByTestId('pipeline-selector').click();
      await window.getByTestId('pipeline-new').click();

      const selector = window.getByTestId('pipeline-selector');
      await expect(selector).toHaveAttribute('data-pipeline-id', /^pipeline-\d/);
      const starterSheet = window.getByRole('dialog', { name: 'Edit new_agent' });
      await expect(starterSheet).toBeVisible();
      await expect(window.getByText('Valid', { exact: true })).toBeVisible();
      await expect(window.getByText(/lowercase kebab-case id/i)).toHaveCount(0);
      await expect(starterSheet.getByRole('alert')).toHaveCount(0);

      await starterSheet.getByRole('button', { name: 'Close Edit new_agent' }).click();
      await expect(starterSheet).toBeHidden();

      await window.getByTestId('pipeline-add-command').click();
      const commandSheet = window.getByRole('dialog', { name: 'Edit new_command' });
      await expect(commandSheet).toBeVisible();
      await expect(commandSheet.getByRole('alert')).toHaveCount(0);
      await commandSheet.getByRole('button', { name: 'Close Edit new_command' }).click();

      await window.getByTestId('pipeline-add-checkpoint').click();
      const checkpointSheet = window.getByRole('dialog', { name: 'Edit new_checkpoint' });
      await expect(checkpointSheet).toBeVisible();
      await expect(checkpointSheet.getByRole('alert')).toHaveCount(0);
    } finally {
      await app?.close();
    }
  });
});
