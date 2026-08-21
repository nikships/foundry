/**
 * Pins the no-provider sentence so Settings and the Smith screen cannot drift.
 */

import { describe, expect, it } from 'vitest';
import { SMITH_NO_PROVIDER_COPY } from '@renderer/view-models/smith-copy.js';

describe('SMITH_NO_PROVIDER_COPY', () => {
  it('points a cold Smith at Settings → Providers', () => {
    expect(SMITH_NO_PROVIDER_COPY).toContain('Settings → Providers');
    expect(SMITH_NO_PROVIDER_COPY).toMatch(/signed-in provider/i);
  });
});
