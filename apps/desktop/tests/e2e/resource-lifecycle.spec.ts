import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { seedOnboardedFixture } from './seed.js';
import { launchFoundry } from './harness.js';

// Playwright launches Electron with backgrounding disabled. Supply the visibility
// event at that boundary; real preload, IPC, hooks and rendered updates remain live.
async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((hidden) => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

test('visual polling sleeps when hidden, resumes patched events, and respects the drawer tab', async () => {
  const fixture = seedOnboardedFixture(undefined, 'none');
  let app: ElectronApplication | undefined;
  try {
    const launched = await launchFoundry(fixture.userDataDir);
    app = launched.app;
    const { window } = launched;
    await expect(window.getByTestId('run-composer')).toBeVisible();
    const input = await window.evaluate(async ({ projectId, runId }) => {
      await globalThis.window.foundry.settings.patch({ soundEffects: false });
      const detail = await globalThis.window.foundry.runs.detail(projectId, runId);
      const page = await globalThis.window.foundry.runs.events(projectId, runId, 0);
      return { detail, events: page.events };
    }, fixture);

    // Controlled engine responses, real Electron IPC and renderer lifecycle.
    // No second database writer, no model turn, and no test-only product API.
    const state = await app.evaluateHandle(({ ipcMain }, data) => {
      const state = { ...data, counts: { list: 0, detail: 0, events: 0, tail: 0 } };
      state.detail.live = true;
      state.detail.run!.status = 'running';
      state.detail.phases.at(-1)!.status = 'running';
      for (const channel of ['runs:list', 'runs:detail', 'runs:events', 'runs:liveTail']) {
        ipcMain.removeHandler(channel);
      }
      ipcMain.handle('runs:list', () => {
        state.counts.list++;
        return [state.detail.run];
      });
      ipcMain.handle('runs:detail', () => {
        state.counts.detail++;
        return state.detail;
      });
      ipcMain.handle('runs:events', (_event, _project, _run, cursor: number) => {
        state.counts.events++;
        const events = state.events.filter((event) => event.changeId > cursor);
        return { events, cursor: Math.max(cursor, ...events.map((event) => event.changeId)) };
      });
      ipcMain.handle('runs:liveTail', () => {
        state.counts.tail++;
        return 'Live tail stays current';
      });
      return state;
    }, input);

    await window.getByTestId(`sidebar-run-${fixture.runId}`).click();
    await expect(window.getByTestId('app-view')).toHaveAttribute('data-view', 'inspector');
    await expect.poll(() => state.evaluate((s) => s.counts.events)).toBeGreaterThan(1);
    await setHidden(window, true);
    const hidden = await state.evaluate((s) => ({ ...s.counts }));
    await window.waitForTimeout(1800);
    expect(await state.evaluate((s) => s.counts)).toEqual(hidden);

    await state.evaluate((s) => {
      const text = s.events.find((event) => event.type === 'assistant_text')!;
      text.changeId = 10_000;
      text.payload = { text: 'PATCH_RECEIVED_AFTER_RESTORE' };
    });
    await setHidden(window, false);
    await expect(window.getByText('PATCH_RECEIVED_AFTER_RESTORE')).toBeVisible();
    expect(await state.evaluate((s) => s.counts.events)).toBeGreaterThan(hidden.events);

    await window.getByTestId('inspector-open-run').click();
    await expect(window.getByText('Live tail stays current')).toBeVisible();
    await window.getByTestId('phase-tab-envelope').click();
    const tail = await state.evaluate((s) => s.counts.tail);
    await window.waitForTimeout(600);
    expect(await state.evaluate((s) => s.counts.tail)).toBe(tail);
    await window.getByTestId('phase-tab-timeline').click();
    await expect(window.getByText('Live tail stays current')).toBeVisible();
    expect(await state.evaluate((s) => s.counts.tail)).toBeGreaterThan(tail);

    // Sound notifications are intentionally NOT paused with visual polling.
    await window.evaluate(() => globalThis.window.foundry.settings.patch({ soundEffects: true }));
    await setHidden(window, true);
    const enabled = await state.evaluate((s) => ({ ...s.counts }));
    await expect.poll(() => state.evaluate((s) => s.counts.list)).toBeGreaterThan(enabled.list);
    expect(await state.evaluate((s) => s.counts.detail)).toBe(enabled.detail);
    await window.evaluate(() => globalThis.window.foundry.settings.patch({ soundEffects: false }));
    // Let any sound read already in flight settle before checking teardown.
    await window.waitForTimeout(100);
    const muted = await state.evaluate((s) => ({ ...s.counts }));
    await window.waitForTimeout(1800);
    expect(await state.evaluate((s) => s.counts)).toEqual(muted);
  } finally {
    await app?.close();
  }
});
