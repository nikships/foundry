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

      await window.getByTestId('nav-settings').click();
      await expect(window.getByTestId('app-view')).toHaveAttribute('data-view', 'settings');
      await window.getByTestId('nav-runs').click();

      await expect(window.getByTestId('app-view')).toHaveAttribute('data-view', 'runs');
      await expect(window.getByTestId('run-request')).toHaveValue(REQUEST);
      await expect(planCard).toContainText('Navigation-safe proposal');
      await expect(planCard).toContainText('Persist the live Runs proposal');

      const proofPath = testInfo.outputPath('FOU-207-plan-restored.png');
      await window.screenshot({ path: proofPath, fullPage: true, animations: 'disabled' });
      await testInfo.attach('FOU-207 restored plan', { path: proofPath, contentType: 'image/png' });
    } finally {
      await app?.close();
    }
  });

  test('inspects proposal phases on the canvas, overrides casting, and starts the modified plan', async ({
    browserName: _browserName,
  }, testInfo) => {
    const fixture = seedOnboardedFixture();
    let app: ElectronApplication | undefined;
    try {
      const launched = await launchFoundry(fixture.userDataDir);
      app = launched.app;
      const { window } = launched;

      // Replace the two expensive boundaries: the planner and the model
      // catalog. Everything else — renderer, preload, IPC, plan card, canvas,
      // inspector, dropdowns — stays real.
      await app.evaluate(({ BrowserWindow, ipcMain }) => {
        ipcMain.removeHandler('catalog:agentModels');
        ipcMain.handle('catalog:agentModels', () => [
          {
            id: 'fixture/model',
            displayName: 'Fixture Model',
            provider: 'fixture',
            supportedReasoningEfforts: ['low', 'medium', 'high'],
            defaultReasoningEffort: 'medium',
            isCustom: false,
            deprecated: false,
          },
          {
            id: 'fixture/alt',
            displayName: 'Fixture Alt',
            provider: 'fixture',
            supportedReasoningEfforts: ['low', 'medium', 'high'],
            defaultReasoningEffort: 'medium',
            isCustom: false,
            deprecated: false,
          },
        ]);

        ipcMain.removeHandler('runs:start');
        ipcMain.handle('runs:start', (_event, input) => {
          (globalThis as Record<string, unknown>).foundryE2eStartInput = input;
          return { ok: true, issues: [] };
        });

        ipcMain.removeHandler('orchestrator:plan');
        ipcMain.handle('orchestrator:plan', (_event, projectId, prompt, model, reasoningEffort) => {
          const planId = 'plan-e2e-proposal-canvas';
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
                refinedRequest: 'Inspect the proposal on a canvas before starting it.',
                rationale: 'A build proven by the project test command.',
                pipeline: {
                  id: 'generated-plan-e2e-proposal-canvas',
                  name: 'Canvas proposal',
                  description: 'Build, then prove it with the test command.',
                  builtin: false,
                  acceptance: { kind: 'last_phase_pass' },
                  phases: [
                    {
                      name: 'build',
                      kind: 'agent',
                      description: 'Implement the scoped change.',
                      agent: 'builder',
                      model: 'fixture/model',
                      reasoningEffort: 'medium',
                      gates: ['boundary_respected'],
                      prompt: { inputs: ['request'] },
                    },
                    {
                      name: 'verify',
                      kind: 'code',
                      description: 'Run the focused checks.',
                      command: { ref: 'test' },
                      feedbackTo: 'build',
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
      await window.getByTestId('run-request').fill('Prove the proposal canvas end to end.');
      await window.getByTestId('run-plan').click();

      const planCard = window.getByTestId('plan-card');
      await expect(planCard).toContainText('Canvas proposal');

      // The proposal renders as a read-only canvas with one node per phase.
      const canvas = window.getByTestId('plan-canvas');
      await expect(canvas).toBeVisible();
      const buildNode = window.getByTestId('plan-canvas-node-build');
      const verifyNode = window.getByTestId('plan-canvas-node-verify');
      await expect(buildNode).toBeVisible();
      await expect(verifyNode).toBeVisible();
      await expect(verifyNode).toContainText('decides');

      // Keyboard: arrow keys walk execution order, Enter inspects.
      await buildNode.focus();
      await window.keyboard.press('ArrowRight');
      await expect(verifyNode).toBeFocused();
      await window.keyboard.press('ArrowLeft');
      await expect(buildNode).toBeFocused();
      await window.keyboard.press('Enter');

      const sheet = window.getByTestId('plan-phase-sheet');
      await expect(sheet).toBeVisible();
      await expect(window.getByTestId('plan-phase-sheet-title')).toContainText('build');
      await expect(sheet).toContainText('boundary_respected');

      // The reasoning menu opens compact; the model menu keeps its rich width.
      await window.getByTestId('plan-reasoning-build').click();
      const menu = window.locator('[role="listbox"]');
      await expect(menu).toBeVisible();
      const compactBox = await menu.boundingBox();
      expect(compactBox).not.toBeNull();
      expect(compactBox!.width).toBeLessThan(280);
      await menu.getByRole('option', { name: 'High' }).click();
      await expect(sheet).toContainText('overridden');

      const sheetProofPath = testInfo.outputPath('FOU-298-phase-inspector.png');
      await window.screenshot({ path: sheetProofPath, fullPage: true, animations: 'disabled' });
      await testInfo.attach('FOU-298 phase inspector', {
        path: sheetProofPath,
        contentType: 'image/png',
      });

      await sheet.getByLabel('Model', { exact: true }).click();
      const modelMenu = window.locator('[role="listbox"]');
      await expect(modelMenu).toBeVisible();
      const richBox = await modelMenu.boundingBox();
      expect(richBox).not.toBeNull();
      expect(richBox!.width).toBeGreaterThanOrEqual(320);
      await modelMenu.getByRole('option', { name: 'Fixture Alt' }).click();

      // Escape dismisses the inspector and returns focus to the node, which
      // now wears the override mark.
      await window.keyboard.press('Escape');
      await expect(sheet).not.toBeVisible();
      await expect(buildNode).toBeFocused();
      await expect(buildNode).toContainText('ovr');

      // Reset restores the proposal exactly.
      await window.getByTestId('plan-reset-phase-overrides').click();
      await expect(buildNode).not.toContainText('ovr');
      await expect(window.getByTestId('plan-reset-phase-overrides')).not.toBeVisible();

      // Re-cast once more and start: the run receives the modified plan.
      await buildNode.click();
      await expect(sheet).toBeVisible();
      await sheet.getByLabel('Model', { exact: true }).click();
      await window.locator('[role="listbox"]').getByRole('option', { name: 'Fixture Alt' }).click();
      await window.keyboard.press('Escape');

      const proofPath = testInfo.outputPath('FOU-298-proposal-canvas.png');
      await window.screenshot({ path: proofPath, fullPage: true, animations: 'disabled' });
      await testInfo.attach('FOU-298 proposal canvas', {
        path: proofPath,
        contentType: 'image/png',
      });

      await window.getByTestId('plan-start').click();
      await expect(planCard).not.toBeVisible();

      const startInput = await app.evaluate(
        () => (globalThis as Record<string, unknown>).foundryE2eStartInput,
      );
      const started = startInput as {
        plan: { pipeline: { phases: Array<{ name: string; model?: string }> } };
      };
      expect(started.plan.pipeline.phases[0]).toMatchObject({
        name: 'build',
        model: 'fixture/alt',
      });
    } finally {
      await app?.close();
    }
  });
});
