/**
 * Shared Linear helpers the assigned-work read builds on.
 */

import { describe, expect, it } from 'vitest';
import { linearIssueStatusLine, splitLinearAssignedIntent } from '../../../src/shared/linear.js';

describe('shared Linear assigned-work helpers', () => {
  it('leaves a plain search untouched', () => {
    expect(splitLinearAssignedIntent('FOU-190')).toEqual({ assigned: false, query: 'FOU-190' });
    expect(splitLinearAssignedIntent('  auth bug  ')).toEqual({
      assigned: false,
      query: 'auth bug',
    });
    expect(splitLinearAssignedIntent('')).toEqual({ assigned: false, query: '' });
  });

  it('detects assigned-to-me phrasing and strips it from the filter', () => {
    expect(splitLinearAssignedIntent("what's assigned to me")).toEqual({
      assigned: true,
      query: '',
    });
    expect(splitLinearAssignedIntent('my tickets')).toEqual({ assigned: true, query: '' });
    expect(splitLinearAssignedIntent('show me my work')).toEqual({ assigned: true, query: '' });
    expect(splitLinearAssignedIntent('my open tickets for auth')).toEqual({
      assigned: true,
      query: 'open auth',
    });
  });

  it('lets an explicit flag win over the text', () => {
    expect(splitLinearAssignedIntent('my tickets', false)).toEqual({
      assigned: false,
      query: 'my tickets',
    });
    expect(splitLinearAssignedIntent('FOU-190', true)).toEqual({
      assigned: true,
      query: 'FOU-190',
    });
  });

  it('summarises status with the interpretable state type', () => {
    expect(
      linearIssueStatusLine({
        identifier: 'FOU-190',
        title: 'Add Linear integration',
        state: { id: 's1', name: 'In Progress', type: 'started' },
        team: { id: 't1', name: 'Foundry' },
        updatedAt: '2026-08-25T19:09:16.054Z',
      }),
    ).toBe(
      'FOU-190: Add Linear integration — In Progress (started) · Foundry · updated 2026-08-25T19:09:16.054Z',
    );
  });
});
