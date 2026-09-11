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
      // The stub also mirrors the durable `orchestrator:list` read so a
      // remount (Settings detour) restores the proposal like the real store.
      await app.evaluate(({ BrowserWindow, ipcMain }) => {
        const mirror = new Map<string, Record<string, unknown>>();
        ipcMain.removeHandler('orchestrator:plan');
        ipcMain.handle('orchestrator:plan', (_event, projectId, prompt, model, reasoningEffort) => {
          const planId = 'plan-e2e-navigation-safe';
          const startedAt = Date.now();
          const plan = {
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
          };
          setTimeout(() => {
            const at = Date.now();
            mirror.set(planId, {
              planId,
              projectId,
              prompt,
              model,
              reasoningEffort,
              status: 'ready',
              detail: 'Plan ready.',
              entries: [],
              plan,
              rawReply: '',
              messages: [],
              revision: 1,
              acceptedRunId: null,
              acceptedPlan: null,
              createdAt: startedAt,
              updatedAt: at,
            });
            BrowserWindow.getAllWindows()[0]?.webContents.send('event:orchestrator-progress', {
              planId,
              projectId,
              status: 'done',
              model,
              reasoningEffort,
              prompt,
              entries: [],
              plan,
              rawReply: '',
              detail: 'Plan ready.',
              startedAt,
              endedAt: Date.now(),
              messages: [],
              revision: 1,
            });
          }, 20);
          return { planId };
        });
        ipcMain.removeHandler('orchestrator:list');
        ipcMain.handle('orchestrator:list', (_event, projectId: string) =>
          [...mirror.values()].filter((row) => row.projectId === projectId),
        );
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

        // Proposal accepts go through `orchestrator:accept` (exactly-once in
        // main), not `runs:start` directly — capture the accepted snapshot here.
        ipcMain.removeHandler('orchestrator:accept');
        ipcMain.handle('orchestrator:accept', (_event, planId, plan) => {
          (globalThis as Record<string, unknown>).foundryE2eStartInput = { planId, plan };
          return { ok: true, runId: 'run-e2e-proposal-canvas' };
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
              messages: [],
              revision: 1,
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

      // Escape inside an open menu dismisses only the menu, not the sheet.
      await window.keyboard.press('Escape');
      await expect(menu).not.toBeVisible();
      await expect(sheet).toBeVisible();

      await window.getByTestId('plan-reasoning-build').click();
      await expect(menu).toBeVisible();
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

  test('expands the canvas full screen and revises the proposal through the plan chat', async ({
    browserName: _browserName,
  }, testInfo) => {
    const fixture = seedOnboardedFixture();
    let app: ElectronApplication | undefined;
    try {
      const launched = await launchFoundry(fixture.userDataDir);
      app = launched.app;
      const { window } = launched;

      // Replace the planner and its follow-up boundary; renderer, preload,
      // IPC push channel, plan card, chat, and full-screen shell stay real.
      await app.evaluate(({ BrowserWindow, ipcMain }) => {
        const planId = 'plan-e2e-chat';
        const basePipeline = {
          id: `generated-${planId}`,
          name: 'Chat proposal',
          description: 'Build, then prove it with the test command.',
          builtin: false,
          acceptance: { kind: 'all_phases_pass' },
          phases: [
            {
              name: 'build',
              kind: 'agent',
              description: 'Implement the scoped change.',
              agent: 'builder',
              model: 'fixture/model',
              reasoningEffort: 'medium',
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
        };
        const state = {
          planId,
          projectId: '',
          status: 'done',
          model: 'fixture/model',
          reasoningEffort: 'medium',
          prompt: '',
          entries: [],
          plan: null as unknown,
          rawReply: '',
          detail: 'Plan ready.',
          startedAt: Date.now(),
          messages: [] as unknown[],
          revision: 1,
        };
        const push = (): void => {
          BrowserWindow.getAllWindows()[0]?.webContents.send('event:orchestrator-progress', {
            ...state,
            messages: [...state.messages],
          });
        };
        ipcMain.removeHandler('orchestrator:plan');
        ipcMain.handle('orchestrator:plan', (_event, projectId, prompt, model, reasoningEffort) => {
          state.projectId = projectId;
          state.prompt = prompt;
          state.model = model;
          state.reasoningEffort = reasoningEffort;
          state.plan = {
            planId,
            projectId,
            prompt,
            refinedRequest: 'Talk the proposal over before starting it.',
            rationale: 'A build proven by the project test command.',
            pipeline: basePipeline,
            agents: [],
            warnings: [],
            model,
            reasoningEffort,
          };
          setTimeout(push, 20);
          return { planId };
        });
        ipcMain.removeHandler('orchestrator:message');
        ipcMain.handle('orchestrator:message', (_event, id, text) => {
          if (id !== planId) return 'session not found';
          state.messages.push({
            id: `op-${state.messages.length}`,
            role: 'operator',
            text,
            at: Date.now(),
          });
          state.status = 'running';
          state.detail = 'considering your message';
          push();
          setTimeout(() => {
            state.messages.push({
              id: `or-${state.messages.length}`,
              role: 'orchestrator',
              text: 'Renamed the verify phase as asked.',
              revisedPlan: true,
              at: Date.now(),
            });
            const plan = state.plan as { pipeline: typeof basePipeline };
            state.plan = {
              ...(state.plan as Record<string, unknown>),
              pipeline: {
                ...plan.pipeline,
                phases: [plan.pipeline.phases[0], { ...plan.pipeline.phases[1], name: 'prove' }],
              },
            };
            state.status = 'done';
            state.detail = 'plan revised';
            state.revision += 1;
            push();
          }, 40);
          return null;
        });
      });

      await expect(window.getByTestId('run-composer')).toBeVisible({ timeout: 20_000 });
      await window.getByTestId('run-request').fill('Prove the plan chat end to end.');
      await window.getByTestId('run-plan').click();

      const planCard = window.getByTestId('plan-card');
      await expect(planCard).toContainText('Chat proposal');

      // Full screen: the same canvas fills a modal; Esc leaves it.
      await window.getByTestId('plan-canvas-expand').click();
      const fullscreen = window.getByTestId('plan-canvas-fullscreen');
      await expect(fullscreen).toBeVisible();
      await expect(fullscreen.getByTestId('plan-canvas-node-build')).toBeVisible();
      const fullscreenProof = testInfo.outputPath('plan-canvas-fullscreen.png');
      await window.screenshot({ path: fullscreenProof, animations: 'disabled' });
      await testInfo.attach('plan canvas full screen', {
        path: fullscreenProof,
        contentType: 'image/png',
      });
      await window.keyboard.press('Escape');
      await expect(fullscreen).not.toBeVisible();

      // Chat: the reply lands in the transcript and the revision replaces the
      // proposal without leaving the card.
      await window.getByTestId('plan-chat-input').fill('rename the verify phase to prove');
      await window.getByTestId('plan-chat-send').click();
      await expect(window.getByTestId('plan-chat-operator')).toContainText('rename the verify');
      await expect(window.getByTestId('plan-chat-orchestrator')).toContainText(
        'Renamed the verify phase',
      );
      await expect(window.getByTestId('plan-chat-revised')).toBeVisible();
      await expect(window.getByTestId('plan-canvas-node-prove')).toBeVisible();
      await expect(planCard).toBeVisible();

      const chatProof = testInfo.outputPath('plan-chat-revised.png');
      await window.screenshot({ path: chatProof, fullPage: true, animations: 'disabled' });
      await testInfo.attach('plan chat revision', { path: chatProof, contentType: 'image/png' });
    } finally {
      await app?.close();
    }
  });
});

test.describe('Runs / Parallel proposals (FOU-349)', () => {
  /**
   * Durable-proposal stub at the IPC seam. The real renderer, preload, React
   * lifecycle, navigation, sidebar, and proposal cards stay under test; only
   * the expensive planner and run start are replaced. Proposals persist in
   * the main process (globalThis), so a renderer reload re-reads them through
   * `orchestrator:list` exactly like the real ProposalStore.
   */
  async function installParallelStub(app: ElectronApplication, doneDelayMs: number): Promise<void> {
    await app.evaluate(
      (electronExports: unknown, args: { doneDelayMs: number }) => {
        const delay = args.doneDelayMs;
        const g = globalThis as Record<string, unknown>;
        const store = new Map<
          string,
          {
            planId: string;
            projectId: string;
            prompt: string;
            model: string;
            reasoningEffort: string;
            status: string;
            detail: string;
            plan: unknown;
            revision: number;
            acceptedRunId: string | null;
            createdAt: number;
            updatedAt: number;
          }
        >();
        g.foundryE2eProposals = store;
        g.foundryE2eAcceptCalls = 0;
        g.foundryE2eSequence = 0;
        const timers = new Map<string, unknown[]>();
        // First evaluate arg is Playwright's CrossProcessExports, mirroring
        // the existing specs' `({ BrowserWindow, ipcMain })` seam.
        const { BrowserWindow, ipcMain } = electronExports as {
          BrowserWindow: {
            getAllWindows(): { webContents?: { send(c: string, p?: unknown): void } }[];
          };
          ipcMain: {
            removeHandler(channel: string): void;
            handle(channel: string, listener: (...args: never[]) => unknown): void;
          };
        };
        const win = (): unknown => BrowserWindow.getAllWindows()[0];
        const send = (channel: string, payload: unknown): void => {
          const w = win() as { webContents?: { send(c: string, p?: unknown): void } } | undefined;
          w?.webContents?.send(channel, payload);
        };
        for (const channel of [
          'orchestrator:plan',
          'orchestrator:list',
          'orchestrator:get',
          'orchestrator:accept',
          'orchestrator:discard',
          'orchestrator:cancel',
        ]) {
          try {
            ipcMain.removeHandler(channel);
          } catch {
            // Fresh handler table; nothing to remove.
          }
        }
        const listed = (projectId: string): unknown[] =>
          [...store.values()]
            .filter((p) => p.projectId === projectId && p.status !== 'discarded')
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((p) => ({
              planId: p.planId,
              projectId: p.projectId,
              prompt: p.prompt,
              model: p.model,
              reasoningEffort: p.reasoningEffort,
              status: p.status,
              detail: p.detail,
              entries: [],
              plan: p.plan,
              rawReply: '',
              messages: [],
              revision: p.revision,
              acceptedRunId: p.acceptedRunId,
              acceptedPlan: p.plan,
              createdAt: p.createdAt,
              updatedAt: p.updatedAt,
            }));
        ipcMain.handle(
          'orchestrator:plan',
          (_event: unknown, projectId: string, prompt: string, model: string, effort: string) => {
            const seq = (g.foundryE2eSequence as number) + 1;
            g.foundryE2eSequence = seq;
            const planId = `plan-e2e-parallel-${seq}`;
            const startedAt = Date.now();
            store.set(planId, {
              planId,
              projectId,
              prompt,
              model,
              reasoningEffort: effort,
              status: 'generating',
              detail: 'Reading the request…',
              plan: null,
              revision: 0,
              acceptedRunId: null,
              createdAt: startedAt,
              updatedAt: startedAt,
            });
            send('event:proposals-changed', { projectId, planId });
            const pending: unknown[] = [];
            timers.set(planId, pending);
            pending.push(
              setTimeout(() => {
                const current = store.get(planId);
                if (!current || current.status !== 'generating') return;
                const plan = {
                  planId,
                  projectId,
                  prompt,
                  refinedRequest: `Parallel proposal ${seq}: ${prompt}`,
                  rationale: 'A build proven by the project test command.',
                  pipeline: {
                    id: `generated-${planId}`,
                    name: `Parallel proposal ${seq}`,
                    description: 'Build, then prove it with the test command.',
                    builtin: false,
                    acceptance: { kind: 'all_phases_pass' },
                    phases: [
                      {
                        name: 'build',
                        kind: 'agent',
                        description: 'Implement the scoped change.',
                        agent: 'builder',
                        model: 'fixture/model',
                      },
                    ],
                  },
                  agents: [],
                  warnings: [],
                  model,
                  reasoningEffort: effort,
                };
                store.set(planId, {
                  ...current,
                  status: 'ready',
                  detail: 'Plan ready.',
                  plan,
                  revision: 1,
                  updatedAt: Date.now(),
                });
                send('event:orchestrator-progress', {
                  planId,
                  projectId,
                  status: 'done',
                  model,
                  reasoningEffort: effort,
                  prompt,
                  entries: [],
                  plan,
                  rawReply: '',
                  detail: 'Plan ready.',
                  startedAt,
                  endedAt: Date.now(),
                  messages: [],
                  revision: 1,
                });
                send('event:proposals-changed', { projectId, planId });
              }, delay),
            );
            return { planId };
          },
        );
        ipcMain.handle('orchestrator:list', (_event: unknown, projectId: string) =>
          listed(projectId),
        );
        ipcMain.handle('orchestrator:get', (_event: unknown, planId: string) => {
          const found = store.get(planId as string);
          return found ?? null;
        });
        ipcMain.handle('orchestrator:cancel', (_event: unknown, planId: string) => {
          const current = store.get(planId as string);
          if (!current || current.status !== 'generating') return false;
          for (const timer of timers.get(planId as string) ?? []) {
            clearTimeout(timer as NodeJS.Timeout);
          }
          store.set(planId as string, { ...current, status: 'cancelled', updatedAt: Date.now() });
          send('event:proposals-changed', { projectId: current.projectId, planId });
          return true;
        });
        ipcMain.handle('orchestrator:discard', (_event: unknown, planId: string) => {
          const current = store.get(planId as string);
          if (!current || current.status === 'accepted') return false;
          if (current.status === 'discarded') return true;
          for (const timer of timers.get(planId as string) ?? []) {
            clearTimeout(timer as NodeJS.Timeout);
          }
          store.set(planId as string, { ...current, status: 'discarded', updatedAt: Date.now() });
          send('event:proposals-changed', { projectId: current.projectId, planId });
          return true;
        });
        ipcMain.handle('orchestrator:accept', (_event: unknown, planId: string) => {
          const current = store.get(planId as string);
          if (!current) {
            return {
              ok: false,
              issues: [{ level: 'error', where: 'plan', message: 'proposal not found' }],
            };
          }
          if (current.acceptedRunId) return { ok: true, runId: current.acceptedRunId };
          g.foundryE2eAcceptCalls = (g.foundryE2eAcceptCalls as number) + 1;
          const runId = `run-e2e-parallel-${planId}`;
          store.set(planId as string, {
            ...current,
            status: 'accepted',
            acceptedRunId: runId,
            updatedAt: Date.now(),
          });
          send('event:proposals-changed', { projectId: current.projectId, planId });
          return { ok: true, runId };
        });
      },
      { doneDelayMs },
    );
  }

  test('submits two prompts concurrently without blocking or cancelling', async ({
    browserName: _browserName,
  }, testInfo) => {
    const fixture = seedOnboardedFixture();
    let app: ElectronApplication | undefined;
    try {
      const launched = await launchFoundry(fixture.userDataDir);
      app = launched.app;
      const { window } = launched;
      await installParallelStub(app, 900);

      await expect(window.getByTestId('run-composer')).toBeVisible({ timeout: 20_000 });
      await window.getByTestId('run-request').fill('First parallel prompt.');
      await window.getByTestId('run-plan').click();
      // The composer stays usable while the first proposal generates.
      await expect(window.getByTestId('run-request')).toBeEnabled();
      await expect(window.getByTestId('run-plan')).toBeEnabled();
      await expect(window.getByTestId('proposal-list')).toBeVisible();

      await window.getByTestId('run-request').fill('Second parallel prompt.');
      await window.getByTestId('run-plan').click();

      // Both proposals coexist; neither submission cancelled the other.
      const proposals = window.getByTestId('proposal-list').locator('[data-testid^="proposal-"]');
      await expect(proposals).toHaveCount(2, { timeout: 10_000 });
      // Sidebar shows both before any run exists.
      const sidebarProposals = window.locator('[data-testid^="sidebar-proposal-"]');
      await expect(sidebarProposals).toHaveCount(2, { timeout: 10_000 });

      // Both complete independently into actionable cards.
      await expect(window.getByTestId('plan-card').first()).toBeVisible({ timeout: 15_000 });
      await expect(window.getByTestId('plan-card')).toHaveCount(2, { timeout: 15_000 });

      const proofPath = testInfo.outputPath('FOU-349-parallel-proposals.png');
      await window.screenshot({ path: proofPath, fullPage: true, animations: 'disabled' });
      await testInfo.attach('FOU-349 parallel proposals', {
        path: proofPath,
        contentType: 'image/png',
      });
    } finally {
      await app?.close();
    }
  });

  test('keeps generation alive across navigation and restores after reload', async ({
    browserName: _browserName,
  }) => {
    const fixture = seedOnboardedFixture();
    let app: ElectronApplication | undefined;
    try {
      const launched = await launchFoundry(fixture.userDataDir);
      app = launched.app;
      const { window } = launched;
      await installParallelStub(app, 1_200);

      await expect(window.getByTestId('run-composer')).toBeVisible({ timeout: 20_000 });
      await window.getByTestId('run-request').fill('Survive a Settings detour and a reload.');
      await window.getByTestId('run-plan').click();
      await expect(window.getByTestId('proposal-list')).toBeVisible();

      // Navigating away does not stop or lose generation.
      await window.getByTestId('nav-settings').click();
      await expect(window.getByTestId('app-view')).toHaveAttribute('data-view', 'settings');
      await window.getByTestId('nav-runs').click();
      await expect(window.getByTestId('app-view')).toHaveAttribute('data-view', 'runs');
      await expect(window.getByTestId('proposal-list')).toBeVisible();

      // Reload restores the durable proposal and receives its late completion.
      await window.reload();
      await expect(window.getByTestId('run-composer')).toBeVisible({ timeout: 20_000 });
      await expect(window.getByTestId('proposal-list')).toBeVisible({ timeout: 15_000 });
      await expect(window.getByTestId('plan-card').first()).toBeVisible({ timeout: 15_000 });
      await expect(window.locator('[data-testid^="sidebar-proposal-"]').first()).toBeVisible({
        timeout: 15_000,
      });
    } finally {
      await app?.close();
    }
  });

  test('accepts exactly once even on a double-click start', async ({
    browserName: _browserName,
  }) => {
    const fixture = seedOnboardedFixture();
    let app: ElectronApplication | undefined;
    try {
      const launched = await launchFoundry(fixture.userDataDir);
      app = launched.app;
      const { window } = launched;
      await installParallelStub(app, 60);

      await expect(window.getByTestId('run-composer')).toBeVisible({ timeout: 20_000 });
      await window.getByTestId('run-request').fill('Exactly-once acceptance.');
      await window.getByTestId('run-plan').click();
      const startButton = window.getByTestId('plan-start').first();
      await expect(startButton).toBeVisible({ timeout: 15_000 });
      await startButton.dblclick();

      await app.evaluate(async () => {
        const deadline = Date.now() + 5_000;
        const g = globalThis as Record<string, unknown>;
        while ((g.foundryE2eAcceptCalls as number) < 1 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      });
      const acceptCalls = await app.evaluate(
        () => (globalThis as Record<string, unknown>).foundryE2eAcceptCalls,
      );
      expect(acceptCalls).toBe(1);
    } finally {
      await app?.close();
    }
  });
});
