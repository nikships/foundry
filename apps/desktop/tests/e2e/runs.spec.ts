import { expect, test, type ElectronApplication } from '@playwright/test';
import { launchFoundry } from './harness.js';
import { seedOnboardedFixture } from './seed.js';

const REQUEST = 'Keep this proposal after a Settings detour.';

test.describe('Runs / Orchestrator', () => {
  test('restores a finished plan after navigating away from Runs', async ({
    browserName: _browserName,
  }, testInfo) => {
    const fixture = seedOnboardedFixture();
    let app: ElectronApplication | undefined;
    try {
      const launched = await launchFoundry(fixture.userDataDir);
      app = launched.app;
      const { window } = launched;

      // Replace only the expensive planner boundary. The real renderer, preload,
      // IPC push channel, React lifecycle, navigation, and plan card stay under test.
      await app.evaluate(({ BrowserWindow, ipcMain }) => {
        ipcMain.removeHandler('orchestrator:plan');
        ipcMain.handle('orchestrator:plan', (_event, projectId, prompt, model, reasoningEffort) => {
          const planId = 'plan-e2e-navigation-safe';
          const startedAt = Date.now();
          setTimeout(() => {
            BrowserWindow.getAllWindows()[0]?.webContents.send('event:orchestrator-progress', {
              planId,
              projectId,
              status: 'done',
              model,
              reasoningEffort,
              prompt,
              entries: [],
              plan: {
                planId,
                projectId,
                prompt,
                refinedRequest:
                  'Persist the live Runs proposal across a Settings detour without planning twice.',
                rationale:
                  'The proposal remains pending until the operator starts, regenerates, or discards it.',
                pipeline: {
                  id: 'generated-plan-e2e-navigation-safe',
                  name: 'Navigation-safe proposal',
                  description: 'Retain the reviewed proposal while the operator checks Settings.',
                  builtin: false,
                  acceptance: { kind: 'all_phases_pass' },
                  phases: [
                    {
                      name: 'build',
                      kind: 'agent',
                      description: 'Implement and verify the scoped renderer lifetime change.',
                      agent: 'builder',
                      model: 'fixture/model',
                      reasoningEffort: 'low',
                    },
                  ],
                },
                agents: [],
                warnings: [],
                model,
                reasoningEffort,
              },
              rawReply: '',
              detail: 'Plan ready.',
              startedAt,
              endedAt: Date.now(),
            });
          }, 20);
          return { planId };
        });
      });

      await expect(window.getByTestId('run-composer')).toBeVisible({ timeout: 20_000 });
      await window.getByTestId('run-request').fill(REQUEST);
      await window.getByTestId('run-plan').click();

      const planCard = window.getByTestId('plan-card');
      await expect(planCard).toContainText('Navigation-safe proposal');
      await expect(planCard).toContainText('Persist the live Runs proposal');
      const effort = window.getByTestId('plan-effort-build');
      await expect(effort).toContainText('Low');
      await effort.click();
      await window.getByRole('option', { name: 'High', exact: true }).click();
      await expect(effort).toContainText('High');
      await expect(planCard).toContainText('overridden');

      await window.getByTestId('nav-settings').click();
      await expect(window.getByTestId('app-view')).toHaveAttribute('data-view', 'settings');
      await window.getByTestId('nav-runs').click();

      await expect(window.getByTestId('app-view')).toHaveAttribute('data-view', 'runs');
      await expect(window.getByTestId('run-request')).toHaveValue(REQUEST);
      await expect(planCard).toContainText('Navigation-safe proposal');
      await expect(planCard).toContainText('Persist the live Runs proposal');
      await expect(effort).toContainText('High');

      await window.getByTestId('plan-reset-models').click();
      await expect(effort).toContainText('Low');

      const proofPath = testInfo.outputPath('FOU-207-plan-restored.png');
      await window.screenshot({ path: proofPath, fullPage: true, animations: 'disabled' });
      await testInfo.attach('FOU-207 restored plan', { path: proofPath, contentType: 'image/png' });
    } finally {
      await app?.close();
    }
  });
});
