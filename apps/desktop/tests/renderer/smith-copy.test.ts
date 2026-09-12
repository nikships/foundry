/**
 * Pins the no-provider sentence so Settings and the Smith screen cannot drift.
 */

import { describe, expect, it } from 'vitest';
import {
  SMITH_ASSIGNED_EMPTY_COPY,
  SMITH_NO_PROVIDER_COPY,
  SMITH_ORCHESTRATOR_ASYNC_COPY,
  SMITH_QUICK_PROMPTS_LABEL,
  SMITH_SECRET_VOICE_COPY,
  SMITH_USER_ACCESS_COPY,
} from '@renderer/view-models/smith-copy.js';

describe('SMITH_NO_PROVIDER_COPY', () => {
  it('points a cold Smith at Settings → Providers', () => {
    expect(SMITH_NO_PROVIDER_COPY).toContain('Settings → Providers');
    expect(SMITH_NO_PROVIDER_COPY).toMatch(/signed-in provider/i);
  });
});

describe('smith user-level access copy', () => {
  it('names every capability in both surfaces with the approval rule', () => {
    expect(SMITH_USER_ACCESS_COPY).toMatch(/assigned Linear/i);
    expect(SMITH_USER_ACCESS_COPY).toMatch(/orchestrator plan/i);
    expect(SMITH_USER_ACCESS_COPY).toMatch(/saved pipeline/i);
    expect(SMITH_USER_ACCESS_COPY).toMatch(/voice/i);
    expect(SMITH_USER_ACCESS_COPY).toMatch(/approval/i);
  });

  it('keeps secrets in the masked card and plans async with a handle', () => {
    expect(SMITH_SECRET_VOICE_COPY).toMatch(/masked card/i);
    expect(SMITH_SECRET_VOICE_COPY).toMatch(/never spoken/i);
    expect(SMITH_ORCHESTRATOR_ASYNC_COPY).toMatch(/plan ID/i);
    expect(SMITH_ORCHESTRATOR_ASYNC_COPY).toMatch(/status/i);
    expect(SMITH_ASSIGNED_EMPTY_COPY).toMatch(/No tickets/i);
    expect(SMITH_QUICK_PROMPTS_LABEL.trim().length).toBeGreaterThan(0);
  });
});
