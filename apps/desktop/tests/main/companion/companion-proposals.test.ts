/**
 * Companion durable proposal routes: list + accept over the same store the
 * desktop IPC serves. Real HTTP on loopback, no model.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../helpers/tmp.js';
import { CompanionHost } from '../../../src/main/companion/host.js';
import { defaultProject } from '../../../src/main/store/projects.js';
import { defaultSettings } from '../../../src/main/store/settings.js';
import type { CompanionPairResult } from '../../../src/shared/companion.js';
import type { GeneratedRunPlan, ProposalSnapshot } from '../../../src/shared/types.js';

function sampleSnapshot(planId: string): ProposalSnapshot {
  return {
    planId,
    projectId: 'proj_a',
    prompt: 'make it better',
    model: 'inherit',
    reasoningEffort: 'medium',
    status: 'ready',
    detail: 'plan ready',
    entries: [],
    plan: null,
    rawReply: '',
    messages: [],
    revision: 1,
    acceptedRunId: null,
    acceptedPlan: null,
    createdAt: 1000,
    updatedAt: 2000,
  };
}

describe('companion proposal list/accept', () => {
  let host: CompanionHost;
  let origin: () => string;
  let accepts: Array<{ planId: string; plan?: GeneratedRunPlan }>;

  beforeEach(async () => {
    const support = tempDir('foundry-companion-proposals-');
    const project = { ...defaultProject('/tmp/repo'), id: 'proj_a', name: 'A' };
    accepts = [];
    host = new CompanionHost({
      supportDir: support,
      projects: () => [project],
      projectById: (id) => (id === project.id ? project : null),
      pipelinesFor: () => [],
      rosterFor: () => [],
      envelopeDefs: () => [],
      settings: () => defaultSettings(),
      saveProject: (next) => next,
      oneShot: () => {
        throw new Error('no one-shot');
      },
      registry: {
        start: () => 'run_1',
        tracerFor: () => {
          throw new Error('no tracer');
        },
        isLive: () => false,
        kill: () => false,
        resume: () => ({ ok: false, detail: 'no' }),
      },
      appVersion: () => '0.0.0-test',
      notifyRuns: () => {},
      onStateChanged: () => {},
      orchestrator: {
        options: async () => ({ models: [], model: 'inherit', reasoningEffort: 'medium' }),
        start: () => ({ planId: 'plan_1' }),
        state: () => null,
        cancel: () => false,
        list: (projectId) =>
          projectId === 'proj_a' ? [sampleSnapshot('plan_1'), sampleSnapshot('plan_2')] : [],
        accept: async (planId, plan) => {
          accepts.push({ planId, ...(plan ? { plan } : {}) });
          return { ok: true, runId: 'run_1' };
        },
      },
      bindHost: '127.0.0.1',
    });
    const state = await host.start();
    if (!state.running || !state.origin) throw new Error('host did not start');
    origin = () => host.state().origin as string;
  });

  afterEach(async () => {
    await host.stop();
  });

  async function pair(): Promise<string> {
    const payload = host.pairingPayload();
    if (!payload) throw new Error('no payload');
    const res = await fetch(`${origin()}/pair`, {
      method: 'POST',
      body: JSON.stringify({
        protocolVersion: payload.protocolVersion,
        secret: payload.secret,
        deviceName: 'Test',
      }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as CompanionPairResult).token;
  }

  function authed(token: string, path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${origin()}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
  }

  it('lists durable proposals for a project', async () => {
    const token = await pair();
    const res = await authed(token, '/v1/orchestrator/plans?projectId=proj_a');
    expect(res.status).toBe(200);
    const rows = (await res.json()) as ProposalSnapshot[];
    expect(rows.map((r) => r.planId)).toEqual(['plan_1', 'plan_2']);
  });

  it('refuses list without projectId', async () => {
    const token = await pair();
    const res = await authed(token, '/v1/orchestrator/plans');
    expect(res.status).toBe(400);
  });

  it('accepts a proposal exactly once via HTTP', async () => {
    const token = await pair();
    const res = await authed(token, '/v1/orchestrator/plans/plan_1/accept', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, runId: 'run_1' });
    expect(accepts).toEqual([{ planId: 'plan_1' }]);
  });

  it('answers 404 when the orchestrator has no list/accept verbs', async () => {
    await host.stop();
    const support = tempDir('foundry-companion-proposals-legacy-');
    const project = { ...defaultProject('/tmp/repo'), id: 'proj_a', name: 'A' };
    const legacy = new CompanionHost({
      supportDir: support,
      projects: () => [project],
      projectById: (id) => (id === project.id ? project : null),
      pipelinesFor: () => [],
      rosterFor: () => [],
      envelopeDefs: () => [],
      settings: () => defaultSettings(),
      saveProject: (next) => next,
      oneShot: () => {
        throw new Error('no one-shot');
      },
      registry: {
        start: () => 'run_1',
        tracerFor: () => {
          throw new Error('no tracer');
        },
        isLive: () => false,
        kill: () => false,
        resume: () => ({ ok: false, detail: 'no' }),
      },
      appVersion: () => '0.0.0-test',
      notifyRuns: () => {},
      onStateChanged: () => {},
      orchestrator: {
        options: async () => ({ models: [], model: 'inherit', reasoningEffort: 'medium' }),
        start: () => ({ planId: 'plan_1' }),
        state: () => null,
        cancel: () => false,
      },
      bindHost: '127.0.0.1',
    });
    const state = await legacy.start();
    expect(state.running).toBe(true);
    const payload = legacy.pairingPayload();
    if (!payload || !legacy.state().origin) throw new Error('no legacy host');
    const pairRes = await fetch(`${legacy.state().origin}/pair`, {
      method: 'POST',
      body: JSON.stringify({
        protocolVersion: payload.protocolVersion,
        secret: payload.secret,
        deviceName: 'Test',
      }),
    });
    const token = ((await pairRes.json()) as CompanionPairResult).token;
    const authedFetch = (path: string, init: RequestInit = {}): Promise<Response> =>
      fetch(`${legacy.state().origin}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      });
    await expect(authedFetch('/v1/orchestrator/plans?projectId=proj_a')).resolves.toMatchObject({
      status: 404,
    });
    await expect(
      authedFetch('/v1/orchestrator/plans/plan_1/accept', { method: 'POST', body: '{}' }),
    ).resolves.toMatchObject({ status: 404 });
    await legacy.stop();
  });
});
