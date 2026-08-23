import { expect, test, type ElectronApplication } from '@playwright/test';
import { E2E_SMITH_MESSAGE, E2E_SMITH_PROPOSAL_NAME, seedOnboardedFixture } from './seed.js';
import { launchFoundry } from './harness.js';

test.describe('smith / chat', () => {
  test('opens the chat screen and bubble against a seeded transcript and proposal', async () => {
    const fixture = seedOnboardedFixture();
    let app: ElectronApplication | undefined;
    try {
      const launched = await launchFoundry(fixture.userDataDir);
      app = launched.app;
      const { window } = launched;

      await expect(window.getByPlaceholder(/What should the factory build/)).toBeVisible({
        timeout: 20_000,
      });

      const bubble = window.getByTestId('smith-bubble');
      await expect(bubble).toBeVisible();
      await bubble.click();

      const popover = window.getByTestId('smith-popover');
      await expect(popover).toBeVisible();
      await expect(popover.getByText(E2E_SMITH_MESSAGE)).toBeVisible();
      await expect(popover.getByTestId('smith-proposal-card')).toBeVisible();
      await expect(
        popover.getByRole('heading', { name: `Smith wants to create ${E2E_SMITH_PROPOSAL_NAME}` }),
      ).toBeVisible();

      await window.getByTestId('smith-bubble-close').click();
      await expect(popover).toBeHidden();

      await window.getByTestId('nav-smith').click();
      await expect(window.getByTestId('app-view')).toHaveAttribute('data-view', 'smith');
      await expect(window.getByTestId('smith-bubble')).toBeHidden();
      await expect(window.getByTestId('smith-input')).toBeVisible();
      await expect(
        window.getByTestId('smith-transcript').getByText(E2E_SMITH_MESSAGE),
      ).toBeVisible();
      await expect(window.getByTestId('smith-proposal-card')).toBeVisible();
      await expect(
        window.getByRole('heading', { name: `Smith wants to create ${E2E_SMITH_PROPOSAL_NAME}` }),
      ).toBeVisible();
    } finally {
      await app?.close();
    }
  });

  test('switches to global scope and renders an approval-gated action', async () => {
    const fixture = seedOnboardedFixture(undefined, 'action');
    let app: ElectronApplication | undefined;
    try {
      const launched = await launchFoundry(fixture.userDataDir);
      app = launched.app;
      const { window } = launched;
      await window.getByTestId('nav-smith').click();
      const card = window.getByTestId('smith-proposal-card');
      await expect(card).toContainText('Start pipeline run');
      await expect(card).toContainText('Build the requested change.');
      await window.getByTestId('smith-proposal-reject').click();
      await expect(card).toBeHidden();
      await window.getByTestId('smith-scope').selectOption('__all__');
      await expect(window.getByTestId('smith-scope')).toHaveValue('__all__');

      // Smith refuses to send on a model the operator did not choose, and the
      // catalog here is whatever the machine's credentials expose — a CI runner
      // has none, a developer's install has its own set. So assert the
      // invariant that holds in both: the composer is open exactly when no
      // notice is explaining why it is shut, and a shut composer always says
      // why. A disabled input with nothing next to it is the failure worth
      // catching, and pinning a model id would only hide which case ran.
      const notice = window.getByTestId('smith-model-blocked');
      const input = window.getByTestId('smith-input');
      const blocked = await input.isDisabled();
      await expect(notice).toBeVisible({ visible: blocked });
      if (blocked) await expect(notice).not.toBeEmpty();
    } finally {
      await app?.close();
    }
  });

  test('docks the launcher clear of every screen\u2019s controls', async () => {
    const fixture = seedOnboardedFixture(undefined, 'none');
    let app: ElectronApplication | undefined;
    try {
      const launched = await launchFoundry(fixture.userDataDir);
      app = launched.app;
      const { window } = launched;
      await expect(window.getByTestId('smith-bubble')).toBeVisible({ timeout: 20_000 });

      // The launcher docks in the titlebar band precisely because every screen
      // reserves it. Pin that, or a future move back onto the canvas passes the
      // proximity check below merely by landing somewhere currently empty.
      const band = await window.evaluate(() => {
        const el = document.querySelector('[data-testid="smith-bubble"]');
        if (!el) throw new Error('launcher missing');
        const raw = getComputedStyle(document.documentElement).getPropertyValue('--titlebar-h');
        return { bottom: el.getBoundingClientRect().bottom, titlebarH: parseInt(raw, 10) };
      });
      expect(band.bottom).toBeLessThanOrEqual(band.titlebarH);

      // The launcher is fixed, so a screen that anchors its own control under it
      // is covered. Measure rather than eyeball: report any focusable control
      // within `pad` of the launcher box, which catches "technically clear but
      // unclickably close" as well as a real overlap.
      const pad = 8;
      const tooClose = async (): Promise<string[]> =>
        window.evaluate((gap) => {
          const launcher = document.querySelector('[data-testid="smith-bubble"]');
          if (!launcher) throw new Error('launcher missing');
          const r = launcher.getBoundingClientRect();
          const sel =
            'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"]), ' +
            '[role="button"], [role="tab"], [role="slider"], [role="combobox"], [role="switch"]';
          return [...document.querySelectorAll(sel)]
            .filter((el) => el !== launcher && !launcher.contains(el) && !el.contains(launcher))
            .filter((el) => {
              const q = el.getBoundingClientRect();
              return (
                q.width > 0 &&
                q.height > 0 &&
                q.left < r.right + gap &&
                q.right > r.left - gap &&
                q.top < r.bottom + gap &&
                q.bottom > r.top - gap
              );
            })
            .map(
              (el) =>
                (el as HTMLElement).dataset.testid ||
                el.getAttribute('aria-label') ||
                el.tagName.toLowerCase(),
            );
        }, pad);
      const clear = async (where: string): Promise<void> => {
        expect(
          await tooClose(),
          `${where}: a control sits within ${pad}px of the launcher`,
        ).toEqual([]);
      };

      // Awaiting the view attribute keeps the probe off a half-rendered screen:
      // Inspector and Pull Requests both add controls after an async load.
      for (const view of ['runs', 'inspector', 'design', 'prs'] as const) {
        await window.getByTestId(`nav-${view}`).click();
        await expect(window.getByTestId('app-view')).toHaveAttribute('data-view', view);
        await clear(view);
      }

      for (const tab of ['pipelines', 'agents', 'envelopes'] as const) {
        await window.getByTestId('nav-design').click();
        await window.getByTestId(`tab-${tab}`).click();
        await expect(window.getByTestId('app-view')).toHaveAttribute('data-design-tab', tab);
        await clear(`design/${tab}`);
      }

      // Run detail is where the float overlapped scrolling transcript rows.
      await window.getByTestId('nav-runs').click();
      await window.getByTestId(`run-row-${fixture.runId}`).click();
      await expect(window.getByTestId('app-view')).toHaveAttribute('data-view', 'run-detail');
      await clear('run-detail');

      await window.getByTestId('nav-settings').click();
      for (const pane of ['models', 'project', 'app'] as const) {
        await window.getByTestId(`settings-tab-${pane}`).click();
        await expect(window.getByTestId('app-view')).toHaveAttribute('data-settings-pane', pane);
        await clear(`settings/${pane}`);
      }
    } finally {
      await app?.close();
    }
  });

  test('keeps provider secrets masked and outside proposal text', async () => {
    const fixture = seedOnboardedFixture(undefined, 'secure');
    let app: ElectronApplication | undefined;
    const fixtureSecret = 'e2e-secret-never-render';
    try {
      const launched = await launchFoundry(fixture.userDataDir);
      app = launched.app;
      const { window } = launched;
      await window.getByTestId('nav-smith').click();
      const card = window.getByTestId('smith-proposal-card');
      const input = window.getByTestId('smith-proposal-secret');
      await expect(input).toHaveAttribute('type', 'password');
      await input.fill(fixtureSecret);
      await expect(card).not.toContainText(fixtureSecret);
      await expect(window.getByTestId('smith-transcript')).not.toContainText(fixtureSecret);
      await window.getByTestId('smith-proposal-reject').click();
      await expect(card).toBeHidden();
      await expect(window.getByTestId('smith-proposal-secret')).toHaveCount(0);
    } finally {
      await app?.close();
    }
  });
});
