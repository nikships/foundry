import { expect, test, type ElectronApplication } from '@playwright/test';
import { launchFoundry } from './harness.js';
import { seedOnboardedFixture } from './seed.js';

test.describe('settings theme', () => {
  test('switches immediately and persists across relaunches', async () => {
    const fixture = seedOnboardedFixture();
    let app: ElectronApplication | undefined;
    try {
      let launched = await launchFoundry(fixture.userDataDir);
      app = launched.app;
      let { window } = launched;

      await expect(window.getByTestId('run-composer')).toBeVisible({ timeout: 20_000 });
      await window.getByTestId('nav-settings').click();
      await expect(window.getByTestId('app-view')).toHaveAttribute(
        'data-settings-pane',
        'preferences',
      );
      await window.getByTestId('settings-tab-preferences').click();

      const picker = window.getByTestId('settings-theme');
      await expect(window.getByTestId('settings-theme-dark')).toHaveAttribute(
        'aria-checked',
        'true',
      );
      const darkBackground = await window.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim(),
      );

      await window.getByTestId('settings-theme-light').click();
      await expect(window.getByTestId('settings-theme-light')).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await expect
        .poll(() =>
          window.evaluate(() => ({
            theme: document.documentElement.dataset.theme,
            colorScheme: document.documentElement.style.colorScheme,
          })),
        )
        .toEqual({ theme: 'light', colorScheme: 'light' });
      const lightBackground = await window.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim(),
      );
      expect(lightBackground).not.toBe(darkBackground);

      await window.getByTestId('settings-theme-midnight').click();
      await expect
        .poll(() =>
          window.evaluate(() => ({
            theme: document.documentElement.dataset.theme,
            colorScheme: document.documentElement.style.colorScheme,
            background: getComputedStyle(document.documentElement)
              .getPropertyValue('--bg-base')
              .trim(),
          })),
        )
        .toEqual({ theme: 'midnight', colorScheme: 'dark', background: '#070b14' });

      await window.getByTestId('settings-theme-dark').click();
      await expect
        .poll(() => window.evaluate(() => document.documentElement.dataset.theme))
        .toBe('dark');

      await window.getByTestId('settings-theme-light').click();
      await expect
        .poll(() => window.evaluate(() => document.documentElement.dataset.theme))
        .toBe('light');
      await expect(picker).toHaveAttribute('data-theme', 'light');
      await app.close();
      app = undefined;

      launched = await launchFoundry(fixture.userDataDir);
      app = launched.app;
      window = launched.window;
      await expect
        .poll(() => window.evaluate(() => document.documentElement.dataset.theme))
        .toBe('light');
      await window.getByTestId('nav-settings').click();
      await window.getByTestId('settings-tab-preferences').click();
      await expect(window.getByTestId('settings-theme-light')).toHaveAttribute(
        'aria-checked',
        'true',
      );
    } finally {
      await app?.close();
    }
  });

  test('search and command palette jump to sections in the new panes', async () => {
    const fixture = seedOnboardedFixture();
    let app: ElectronApplication | undefined;
    try {
      const launched = await launchFoundry(fixture.userDataDir);
      app = launched.app;
      const { window } = launched;

      await expect(window.getByTestId('run-composer')).toBeVisible({ timeout: 20_000 });
      await window.getByTestId('nav-settings').click();
      await window.getByTestId('settings-search').fill('api key');
      await window.getByRole('option').filter({ hasText: 'API keys' }).first().click();
      await expect(window.getByTestId('settings-tab-providers')).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(window.getByTestId('app-view')).toHaveAttribute(
        'data-settings-pane',
        'providers',
      );
      await expect(window.locator('[data-sec="api-keys"]')).toBeInViewport();

      await window.getByTestId('settings-search').fill('');
      await window.keyboard.press('Meta+K');
      await window.getByTestId('settings-palette-input').fill('retention');
      await window.getByRole('option').filter({ hasText: 'Retention' }).first().click();
      await expect(window.getByTestId('settings-tab-system')).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(window.getByTestId('app-view')).toHaveAttribute('data-settings-pane', 'system');
      await expect(window.locator('[data-sec="retention"]')).toBeInViewport();
    } finally {
      await app?.close();
    }
  });
});
