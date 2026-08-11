/**
 * The Smith socket server's dispatch surface, driven directly (no real socket).
 *
 * The load-bearing rule: validation runs BEFORE any card. An invalid create
 * comes straight back as `{ ok:false, validation:[…] }` with nothing enqueued;
 * only a valid spec reaches the proposal queue and blocks. Read ops answer from
 * the stores immediately. Overwrite is decided by whether the store already has
 * the name/id.
 */

import { describe, expect, it, vi } from 'vitest';
import type { AgentDef } from '../src/shared/types.js';
import { ProposalQueue } from '../src/main/smith/proposals.js';
import { SmithSocketServer } from '../src/main/smith/socket-server.js';

const validAgent: AgentDef = {
  name: 'planner',
  purpose: 'Plan the work.',
  model: 'inherit',
  reasoningEffort: 'medium',
  systemPrompt: 'You plan.',
  userPrompt: 'Work on: {{request}}',
  writes: [],
  envelope: 'plan',
  color: '#5ad2dd',
};

/**
 * A project as the store holds it: far more than the protocol may hand out, so
 * the projection assertion below is meaningful.
 */
const storedProject = {
  id: 'proj_1a2b',
  name: 'Foundry',
  path: '/Users/nik/code/foundry',
  baseRef: 'main',
  isolation: true,
  mergePolicy: 'manual',
  commands: [{ name: 'test', argv: ['npm', 'test'] }],
  protectedPaths: ['.github/'],
  ownRoster: false,
  ownPipelines: false,
  setupScript: 'npm ci',
  addedAt: '2026-08-01T00:00:00.000Z',
};

/** A store-shaped ctx with just what the server reads; agents seed the roster. */
function makeCtx(seed: AgentDef[] = []) {
  const agents = [...seed];
  return {
    roster: { get: (name: string) => agents.find((a) => a.name === name) ?? null },
    pipelines: { get: () => null },
    envelopes: { list: () => [], get: () => null },
    projects: { list: () => [storedProject] },
    rosterScope: () => undefined,
    pipelineScope: () => undefined,
    rosterFor: () => agents,
    pipelinesFor: () => [],
    commandNames: () => [],
  } as unknown as ConstructorParameters<typeof SmithSocketServer>[1];
}

function makeServer(ctx = makeCtx()): { server: SmithSocketServer; queue: ProposalQueue } {
  const queue = new ProposalQueue(
    () => {},
    async (p) => ({ ok: true, entity: p.spec }),
  );
  const server = new SmithSocketServer('/tmp/unused-smith.sock', ctx, queue);
  return { server, queue };
}

describe('SmithSocketServer.dispatch', () => {
  it('lists entities from the store without approval', async () => {
    const { server } = makeServer(makeCtx([validAgent]));
    const res = await server.dispatch({ op: 'list', kind: 'agent' });
    expect(res).toEqual({ ok: true, kind: 'agent', entities: [validAgent] });
  });

  it('shows a named entity, or errors when it is absent', async () => {
    const { server } = makeServer(makeCtx([validAgent]));
    expect(await server.dispatch({ op: 'show', kind: 'agent', name: 'planner' })).toEqual({
      ok: true,
      kind: 'agent',
      entity: validAgent,
    });
    expect(await server.dispatch({ op: 'show', kind: 'agent', name: 'ghost' })).toEqual({
      ok: false,
      error: 'no agent named "ghost"',
    });
  });

  it('refuses an invalid create before raising a card', async () => {
    const queue = new ProposalQueue(
      () => {},
      async (p) => ({ ok: true, entity: p.spec }),
    );
    const proposeSpy = vi.spyOn(queue, 'propose');
    const server = new SmithSocketServer('/tmp/x.sock', makeCtx(), queue);

    const res = await server.dispatch({
      op: 'create',
      kind: 'agent',
      spec: { ...validAgent, name: 'Bad Name', color: 'red' },
    });

    expect(res.ok).toBe(false);
    expect('validation' in res && res.validation.length).toBeTruthy();
    expect(proposeSpy).not.toHaveBeenCalled();
  });

  it('enqueues a valid create and resolves with the saved entity on approve', async () => {
    const { server, queue } = makeServer();
    const pending = server.dispatch({ op: 'create', kind: 'agent', spec: validAgent });

    // The valid spec is now pending a human decision.
    await vi.waitFor(() => expect(queue.list()).toHaveLength(1));
    const proposal = queue.list()[0]!;
    expect(proposal.mode).toBe('create');
    expect(proposal.overwrites).toBe(false);

    await queue.answer(proposal.id, { approved: true });
    await expect(pending).resolves.toEqual({ ok: true, entity: validAgent });
  });

  it('marks an edit of an existing agent as an overwrite', async () => {
    const { server, queue } = makeServer(makeCtx([validAgent]));
    const pending = server.dispatch({
      op: 'edit',
      kind: 'agent',
      name: 'planner',
      spec: { ...validAgent, purpose: 'Plan more.' },
    });

    await vi.waitFor(() => expect(queue.list()).toHaveLength(1));
    const proposal = queue.list()[0]!;
    expect(proposal.mode).toBe('edit');
    expect(proposal.overwrites).toBe(true);

    await queue.answer(proposal.id, { approved: false, note: 'nope' });
    await expect(pending).resolves.toEqual({ ok: false, rejected: true, note: 'nope' });
  });

  it('returns proposal_pending when a second write races a pending one', async () => {
    const { server, queue } = makeServer();
    const first = server.dispatch({ op: 'create', kind: 'agent', spec: validAgent });
    await vi.waitFor(() => expect(queue.list()).toHaveLength(1));

    const second = await server.dispatch({
      op: 'create',
      kind: 'agent',
      spec: { ...validAgent, name: 'builder' },
    });
    expect(second).toEqual({ ok: false, error: 'proposal_pending' });

    await queue.answer(queue.list()[0]!.id, { approved: false });
    await first;
  });

  it('rejects a write with no spec object', async () => {
    const { server } = makeServer();
    expect(await server.dispatch({ op: 'create', kind: 'agent' })).toEqual({
      ok: false,
      error: 'create/edit needs a spec object',
    });
  });

  it('lists projects as id/name/path only, so no project config leaks to an agent', async () => {
    const { server } = makeServer();
    const res = await server.dispatch({ op: 'list', kind: 'project' });
    expect(res).toEqual({
      ok: true,
      kind: 'project',
      entities: [{ id: 'proj_1a2b', name: 'Foundry', path: '/Users/nik/code/foundry' }],
    });
  });

  it('refuses every non-list op on a project, raising no card', async () => {
    const { server, queue } = makeServer();
    const proposeSpy = vi.spyOn(queue, 'propose');

    for (const op of ['show', 'create', 'edit'] as const) {
      const res = await server.dispatch({ op, kind: 'project', name: 'proj_1a2b', spec: {} });
      expect(res.ok).toBe(false);
      expect('error' in res && res.error).toContain('read-only');
    }

    expect(proposeSpy).not.toHaveBeenCalled();
    expect(queue.list()).toHaveLength(0);
  });
});
