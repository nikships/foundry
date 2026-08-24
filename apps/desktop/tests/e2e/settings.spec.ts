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

      await expect(
        window.getByRole('heading', { name: 'What should the factory build?' }),
      ).toBeVisible({ timeout: 20_000 });
      await window.getByTestId('nav-settings').click();
      await window.getByTestId('settings-tab-app').click();

      const picker = window.getByTestId('settings-theme');
      await expect(picker).toHaveText('Dark');
      const darkBackground = await window.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim(),
      );

      await picker.click();
      await window.getByRole('option', { name: 'Light', exact: true }).click();
      await expect(picker).toHaveText('Light');
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

      await picker.click();
      await window.getByRole('option', { name: 'Dark', exact: true }).click();
      await expect
        .poll(() => window.evaluate(() => document.documentElement.dataset.theme))
        .toBe('dark');

      await picker.click();
      await window.getByRole('option', { name: 'Light', exact: true }).click();
      await expect
        .poll(() => window.evaluate(() => document.documentElement.dataset.theme))
        .toBe('light');
      await app.close();
      app = undefined;

      launched = await launchFoundry(fixture.userDataDir);
      app = launched.app;
      window = launched.window;
      await expect
        .poll(() => window.evaluate(() => document.documentElement.dataset.theme))
        .toBe('light');
      await window.getByTestId('nav-settings').click();
      await window.getByTestId('settings-tab-app').click();
      await expect(window.getByTestId('settings-theme')).toHaveText('Light');
    } finally {
      await app?.close();
    }
  });
});
