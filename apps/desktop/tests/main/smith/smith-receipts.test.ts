/**
 * Action receipts, built the way the proposal queue builds them.
 *
 * The load-bearing rules: approval is not success (a failed execution still
 * produces a receipt, carrying the executor's words), the receipt is minted
 * from the executor's own result rather than the model's account of it, it
 * carries no closure and nothing that could re-run the action, and it restates
 * only the redacted args the approval card already showed.
 */

import { describe, expect, it } from 'vitest';
import type { SmithActionProposal } from '../../../src/shared/types.js';
import { SMITH_ARTIFACT_VERSION } from '../../../src/shared/types.js';
import {
  buildActionReceipt,
  receiptLink,
  receiptTarget,
  type ActionExecutionRecord,
} from '../../../src/main/smith/receipts.js';

function proposal(over: Partial<SmithActionProposal> = {}): SmithActionProposal {
  return {
    id: 'prop-1',
    type: 'action',
    createdAt: '2026-08-23T00:00:00Z',
    projectId: 'proj_1',
    operation: 'merge',
    title: 'merge run',
    summary: 'merge the selected run.',
    args: { projectId: 'proj_1', runId: 'run_7' },
    risk: 'git',
    ...over,
  };
}

const succeeded: ActionExecutionRecord = { outcome: 'succeeded', durationMs: 120 };

describe('buildActionReceipt', () => {
  it('records a succeeded action as evidence, not as an approval', () => {
    const artifact = buildActionReceipt(proposal(), { ...succeeded, durationMs: 1500 });

    expect(artifact).toMatchObject({
      kind: 'action_receipt',
      version: SMITH_ARTIFACT_VERSION,
      projectId: 'proj_1',
      warnings: [],
    });
    expect(artifact.receipt).toMatchObject({
      operation: 'merge',
      title: 'merge run',
      target: 'run_7',
      consequences: 'merge the selected run.',
      risk: 'git',
      outcome: 'succeeded',
      durationMs: 1500,
    });
    expect(artifact.receipt.failure).toBeUndefined();
    expect(artifact.id).toBeTruthy();
    expect(artifact.createdAt).toBeGreaterThan(0);
  });

  it('preserves a failure instead of losing it behind the approval', () => {
    const artifact = buildActionReceipt(proposal(), {
      outcome: 'failed',
      durationMs: 90,
      error: 'gh refused: branch is behind',
    });

    expect(artifact.receipt.outcome).toBe('failed');
    expect(artifact.receipt.failure).toBe('gh refused: branch is behind');
    // What was attempted stays on the card; only the link is dropped, because
    // a failed action has no affected object to open.
    expect(artifact.receipt.consequences).toBe('merge the selected run.');
    expect(artifact.receipt.link).toBeUndefined();
  });

  it('names a failure even when the executor supplied no message', () => {
    const artifact = buildActionReceipt(proposal(), { outcome: 'failed', durationMs: 5 });
    expect(artifact.receipt.failure).toBe('the action failed');
  });

  it('caps the failure text rather than pasting a whole stack into the chat', () => {
    const artifact = buildActionReceipt(proposal(), {
      outcome: 'failed',
      durationMs: 5,
      error: 'x'.repeat(5_000),
    });
    expect(artifact.receipt.failure!.length).toBeLessThanOrEqual(600);
    expect(artifact.receipt.failure).toMatch(/…$/);
  });

  it('is clone-safe and carries no executor, handle, or retry affordance', () => {
    const artifact = buildActionReceipt(proposal(), {
      ...succeeded,
      result: { ok: true, url: 'https://github.com/o/r/pull/9' },
    });

    expect(() => structuredClone(artifact)).not.toThrow();
    const flat = JSON.stringify(artifact);
    expect(flat).not.toMatch(/retry/i);
    for (const value of Object.values(artifact.receipt)) {
      expect(typeof value).not.toBe('function');
    }
  });

  it('never rounds a negative or fractional duration into nonsense', () => {
    expect(
      buildActionReceipt(proposal(), { ...succeeded, durationMs: -3 }).receipt.durationMs,
    ).toBe(0);
    expect(
      buildActionReceipt(proposal(), { ...succeeded, durationMs: 12.7 }).receipt.durationMs,
    ).toBe(13);
  });

  it('omits the project scope for a global conversation', () => {
    const global = proposal({ operation: 'update_check', args: {}, risk: 'network' });
    delete (global as { projectId?: string }).projectId;
    expect(buildActionReceipt(global, succeeded).projectId).toBeUndefined();
  });

  it('restates the approved args, bounding a long value', () => {
    const artifact = buildActionReceipt(
      proposal({
        operation: 'start',
        args: { projectId: 'proj_1', pipelineId: 'ship-it', request: 'r'.repeat(1_000) },
      }),
      succeeded,
    );
    expect(artifact.receipt.args.pipelineId).toBe('ship-it');
    expect((artifact.receipt.args.request as string).length).toBeLessThanOrEqual(200);
  });

  it('carries no value the approval card did not already show', () => {
    // The card's args are the redacted ones; a secret never reaches them, and
    // the executor's result must not smuggle one back in.
    const artifact = buildActionReceipt(
      proposal({ operation: 'set_api_key', args: { providerId: 'acme' }, risk: 'credential' }),
      { ...succeeded, result: { ok: true, key: 'sk-super-secret' } },
    );
    expect(JSON.stringify(artifact)).not.toContain('sk-super-secret');
  });
});

describe('receiptTarget', () => {
  it('names the most specific thing the action ran against', () => {
    expect(receiptTarget(proposal())).toBe('run_7');
    expect(receiptTarget(proposal({ args: { prNumber: 12, projectId: 'proj_1' } }))).toBe('PR #12');
    expect(receiptTarget(proposal({ args: { name: 'planner', projectId: 'proj_1' } }))).toBe(
      'planner',
    );
    expect(receiptTarget(proposal({ args: { projectId: 'proj_1' } }))).toBe('proj_1');
  });

  it('falls back to the scope rather than leaving the target blank', () => {
    expect(receiptTarget(proposal({ args: {} }))).toBe('project proj_1');
    const global = proposal({ args: {} });
    delete (global as { projectId?: string }).projectId;
    expect(receiptTarget(global)).toBe('Foundry');
  });
});

describe('receiptLink', () => {
  it('prefers the URL the executor actually returned', () => {
    expect(
      receiptLink(proposal({ operation: 'create' }), {
        ok: true,
        url: 'https://github.com/o/r/pull/9',
      }),
    ).toEqual({ kind: 'url', label: 'View pull request', url: 'https://github.com/o/r/pull/9' });
  });

  it('unwraps a result nested under the immediate-call envelope', () => {
    expect(
      receiptLink(proposal(), { ok: true, result: { url: 'https://example.test/x' } }),
    ).toEqual({ kind: 'url', label: 'Open', url: 'https://example.test/x' });
  });

  it('addresses a run by its identifiers, not by a live handle', () => {
    expect(receiptLink(proposal(), { ok: true })).toEqual({
      kind: 'run',
      label: 'Open run',
      projectId: 'proj_1',
      runId: 'run_7',
    });
  });

  it('reads the started run id out of the executor result', () => {
    const start = proposal({ operation: 'start', args: { projectId: 'proj_1', pipelineId: 'x' } });
    expect(receiptLink(start, { ok: true, runId: 'run_new' })).toEqual({
      kind: 'run',
      label: 'Open run',
      projectId: 'proj_1',
      runId: 'run_new',
    });
  });

  it('links an edited entity by name, and a rename by its new name', () => {
    const duplicate = proposal({ operation: 'agent_duplicate', args: { name: 'planner' } });
    expect(receiptLink(duplicate, { ok: true })).toEqual({
      kind: 'entity',
      label: 'Open agent',
      entity: 'agent',
      name: 'planner',
    });
    const rename = proposal({ operation: 'agent_rename', args: { from: 'a', to: 'b' } });
    expect(receiptLink(rename, { ok: true })).toMatchObject({ entity: 'agent', name: 'b' });
    const pipeline = proposal({ operation: 'pipeline_reset', args: { id: 'ship-it' } });
    expect(receiptLink(pipeline, { ok: true })).toMatchObject({ entity: 'pipeline' });
  });

  it('offers no link to something the action just deleted', () => {
    const removal = proposal({ operation: 'agent_remove', args: { name: 'planner' } });
    expect(receiptLink(removal, { ok: true })).toBeUndefined();
  });

  it('offers no link at all when nothing addressable was named', () => {
    const check = proposal({ operation: 'update_check', args: {} });
    delete (check as { projectId?: string }).projectId;
    expect(receiptLink(check, { ok: true })).toBeUndefined();
  });
});
