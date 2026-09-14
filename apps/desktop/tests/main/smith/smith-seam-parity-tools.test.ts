/**
 * Project/provider seam parity for full user-level access: `refresh_context`
 * on `smith_projects` and the Live Voice credential seam on
 * `smith_providers`, plus the shared Linear helpers the assigned-work read
 * builds on. Token minting stays renderer-only by assertion.
 */

import { describe, expect, it, vi } from 'vitest';
import { IPC } from '../../../src/shared/ipc-contract.js';
import {
  SMITH_PROJECT_OPERATIONS,
  smithProjectsTool,
} from '../../../src/main/smith/project-tools.js';
import {
  SMITH_PROVIDER_OPERATIONS,
  smithProvidersTool,
} from '../../../src/main/smith/provider-tools.js';
import { ProposalQueue } from '../../../src/main/smith/proposals.js';
import type { MainInvoker } from '../../../src/main/ipc/shared.js';
import { linearIssueStatusLine, splitLinearAssignedIntent } from '../../../src/shared/linear.js';

const json = (r: unknown) =>
  JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text);

function projectHarness() {
  const invoke = vi.fn().mockResolvedValue('normalized');
  const queue = new ProposalQueue(
    () => {},
    async () => ({ ok: true, entity: {} }),
  );
  const tool = smithProjectsTool({
    invoke: invoke as MainInvoker,
    queue,
    projectId: () => 'session-project',
  });
  return {
    invoke,
    queue,
    tool,
    execute: (p: unknown) =>
      (tool.execute as unknown as (id: string, p: unknown) => Promise<unknown>)('call', p),
  };
}

function providerHarness() {
  const invoke = vi.fn().mockResolvedValue('normalized');
  const queue = new ProposalQueue(
    () => {},
    async () => ({ ok: true, entity: {} }),
  );
  const tool = smithProvidersTool({
    invoke: invoke as MainInvoker,
    queue,
    projectId: () => undefined,
  });
  return {
    invoke,
    queue,
    tool,
    execute: (p: unknown) =>
      (tool.execute as unknown as (id: string, p: unknown) => Promise<unknown>)('id', p),
  };
}

describe('smith_projects refresh_context', () => {
  it('declares the operation on the tool schema', () => {
    expect(SMITH_PROJECT_OPERATIONS).toContain('refresh_context');
    const h = projectHarness();
    expect(
      (h.tool.parameters as { properties: { operation: { enum: string[] } } }).properties.operation
        .enum,
    ).toContain('refresh_context');
  });

  it('gates a context refresh as a write on the exact channel', async () => {
    const h = projectHarness();
    const pending = h.execute({ operation: 'refresh_context', projectId: 'p1' });
    await vi.waitFor(() => expect(h.queue.list()).toHaveLength(1));
    expect(h.queue.list()[0]).toMatchObject({
      operation: 'refresh_context',
      risk: 'write',
      args: { projectId: 'p1' },
    });
    expect(h.invoke).not.toHaveBeenCalled();
    await h.queue.answer(h.queue.list()[0]!.id, { approved: true });
    expect(json(await pending)).toEqual({ ok: true, result: 'normalized' });
    expect(h.invoke).toHaveBeenCalledWith(IPC.projectsRefreshContext, 'p1');
  });

  it('requires a project id', async () => {
    expect(json(await projectHarness().execute({ operation: 'refresh_context' }))).toMatchObject({
      ok: false,
      error: expect.stringContaining('projectId'),
    });
  });
});

describe('smith_providers Live Voice seam', () => {
  it('declares the voice credential operations but never token minting', () => {
    expect(SMITH_PROVIDER_OPERATIONS).toEqual(
      expect.arrayContaining([
        'gemini_live_state',
        'gemini_live_set_api_key',
        'gemini_live_clear_api_key',
      ]),
    );
    expect(SMITH_PROVIDER_OPERATIONS).not.toContain('gemini_live_mint_token');
    const h = providerHarness();
    expect(
      (h.tool.parameters as { properties: { operation: { enum: string[] } } }).properties.operation
        .enum,
    ).toEqual([...SMITH_PROVIDER_OPERATIONS]);
  });

  it('reads voice key state immediately', async () => {
    const h = providerHarness();
    expect(json(await h.execute({ operation: 'gemini_live_state' }))).toEqual({
      ok: true,
      result: 'normalized',
    });
    expect(h.invoke).toHaveBeenCalledWith(IPC.geminiLiveState);
    expect(h.queue.list()).toHaveLength(0);
  });

  it('keeps the voice key in the masked approval path', async () => {
    const h = providerHarness();
    const promise = h.execute({ operation: 'gemini_live_set_api_key' });
    await vi.waitFor(() => expect(h.queue.list()).toHaveLength(1));
    const proposal = h.queue.list()[0]!;
    expect(proposal).toMatchObject({
      operation: 'gemini_live_set_api_key',
      args: {},
      risk: 'credential',
      secretRequest: { kind: 'api-key', label: 'Gemini API key for Live Voice' },
    });
    expect(JSON.stringify(proposal)).not.toContain('VOICE-SECRET');
    await h.queue.answer(proposal.id, { approved: true, secret: 'VOICE-SECRET' });
    expect(h.invoke).toHaveBeenCalledWith(IPC.geminiLiveSetApiKey, 'VOICE-SECRET');
    expect(JSON.stringify(json(await promise))).not.toContain('VOICE-SECRET');
  });

  it('gates clearing the voice key as a credential action', async () => {
    const h = providerHarness();
    const promise = h.execute({ operation: 'gemini_live_clear_api_key' });
    await vi.waitFor(() => expect(h.queue.list()).toHaveLength(1));
    expect(h.queue.list()[0]).toMatchObject({
      operation: 'gemini_live_clear_api_key',
      risk: 'credential',
    });
    await h.queue.answer(h.queue.list()[0]!.id, { approved: true });
    expect(h.invoke).toHaveBeenCalledWith(IPC.geminiLiveClearApiKey);
    expect(json(await promise)).toEqual({ ok: true, result: 'normalized' });
  });

  it('rejects an inline voice key like every other secret field', async () => {
    const h = providerHarness();
    expect(
      json(await h.execute({ operation: 'gemini_live_set_api_key', apiKey: 'VOICE-SECRET' })),
    ).toMatchObject({ ok: false, error: expect.stringContaining('masked approval card') });
    expect(h.queue.list()).toHaveLength(0);
    expect(h.invoke).not.toHaveBeenCalled();
  });
});

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
