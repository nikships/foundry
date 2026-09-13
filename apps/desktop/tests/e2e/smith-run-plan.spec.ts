import { expect, test } from '@playwright/test';
import { launchFoundry } from './harness.js';
import { seedRunPlanFixture } from './seed-run-plan.js';

test('run_plan uses the shared plan card in Runs and Smith and refreshes a discarded snapshot', async () => {
  const fixture = seedRunPlanFixture();
  const { app, window } = await launchFoundry(fixture.userDataDir);
  try {
    await expect(window.getByTestId('plan-card')).toBeVisible();
    const runsBrief = await window.getByTestId('plan-refined-request').innerText();
    await expect(window.getByTestId('plan-start')).toBeEnabled();
    await window.getByTestId('nav-smith').click();
    const card = window.getByTestId('smith-run-plan');
    await expect(card).toHaveAttribute('data-plan-status', 'ready');
    await expect(card.getByTestId('plan-refined-request')).toHaveText(runsBrief);
    await expect(card.getByTestId('plan-start')).toBeEnabled();
    await card.getByRole('button', { name: 'Inspect phase build', exact: true }).click();
    await window.getByRole('button', { name: 'Reasoning effort for build', exact: true }).click();
    await window.getByRole('option', { name: 'Low', exact: true }).click();
    await window.getByRole('button', { name: 'Close Phase build', exact: true }).click();
    await expect(card.getByTestId('plan-reset-phase-overrides')).toBeVisible();
    await card.getByTestId('plan-reset-phase-overrides').click();
    await expect(card.getByTestId('plan-reset-phase-overrides')).toHaveCount(0);
    await card.getByTestId('plan-discard').click();
    await expect(card).toHaveAttribute('data-plan-status', 'discarded');
    await expect(card.getByTestId('plan-start')).toHaveCount(0);
    await window.reload();
    await window.getByTestId('nav-smith').click();
    await expect(window.getByTestId('smith-run-plan')).toHaveAttribute(
      'data-plan-status',
      'discarded',
    );
  } finally {
    await app.close();
  }
});

test('unavailable run_plan rows render inert snapshots after restoring a chat', async () => {
  const fixture = seedRunPlanFixture(undefined, true);
  const { app, window } = await launchFoundry(fixture.userDataDir);
  try {
    await window.getByTestId('nav-smith').click();
    const card = window.getByTestId('smith-run-plan');
    await expect(card.getByRole('status')).toContainText('snapshot');
    await expect(card).toContainText('Make help text explain the next action.');
    await expect(card.getByTestId('plan-start')).toHaveCount(0);
    await expect(card.getByTestId('plan-discard')).toHaveCount(0);
  } finally {
    await app.close();
  }
});
