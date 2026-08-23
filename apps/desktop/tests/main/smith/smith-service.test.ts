/**
 * SmithService: one chat per project, one shared proposal queue, and the
 * optional e2e seed that lets a fixture raise a card without a model.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  SMITH_E2E_PROPOSAL_ENV,
  SmithService,
  readSmithProposalSeed,
  type SmithServiceDeps,
} from '../../../src/main/smith/index.js';
import type { ProposalInput } from '../../../src/main/smith/proposals.js';
import type { SmithChatSession } from '../../../src/main/smith/chat-session.js';
import type { MainInvoker } from '../../../src/main/ipc/shared.js';

const seed: ProposalInput = {
  type: 'entity',
  kind: 'agent',
  mode: 'create',
  name: 'e2e_planner',
  spec: { name: 'e2e_planner' },
  validation: [],
  overwrites: false,
  projectId: 'proj_1',
};

function fakeChat(): SmithChatSession {
  return {
    dispose: vi.fn(async () => undefined),
    absorbArtifact: vi.fn(),
  } as unknown as SmithChatSession;
}

function service(over: Partial<SmithServiceDeps> = {}): SmithService {
  return new SmithService({
    broadcast: () => {},
    channels: { proposalsChanged: 'smith-proposals-changed' },
    save: () => ({ ok: true, entity: {} }),
    createChat: () => fakeChat(),
    ...over,
  });
}

describe('readSmithProposalSeed', () => {
  it('returns null when the env is unset or not JSON', () => {
    expect(readSmithProposalSeed({})).toBeNull();
    expect(readSmithProposalSeed({ [SMITH_E2E_PROPOSAL_ENV]: 'not-json' })).toBeNull();
    expect(
      readSmithProposalSeed({ [SMITH_E2E_PROPOSAL_ENV]: JSON.stringify({ kind: 'agent' }) }),
    ).toBeNull();
  });

  it('accepts a well-formed ProposalInput', () => {
    expect(readSmithProposalSeed({ [SMITH_E2E_PROPOSAL_ENV]: JSON.stringify(seed) })).toEqual(seed);
  });
});

describe('SmithService', () => {
  it('opens one chat per project and reuses it', () => {
    const created: Array<string | undefined> = [];
    const chats = new Map<string, SmithChatSession>();
    const smith = service({
      createChat: (projectId) => {
        created.push(projectId);
        const chat = fakeChat();
        chats.set(projectId ?? 'global', chat);
        return chat;
      },
    });
    const first = smith.chat('proj_1');
    const again = smith.chat('proj_1');
    const other = smith.chat('proj_2');
    expect(first).toBe(again);
    expect(other).not.toBe(first);
    expect(created).toEqual(['proj_1', 'proj_2']);
    expect(smith.chat()).toBe(smith.chat());
    expect(created.at(-1)).toBeUndefined();
    expect(smith.chat('missing')).not.toBeNull();
  });

  it('fails closed until the main invoker is attached, then delegates', async () => {
    const smith = service();
    await expect(smith.invoke('test:channel')).rejects.toThrow(/not attached/);
    const invoke = vi.fn(async () => ({ ok: true })) as unknown as MainInvoker;
    smith.attachInvoker(invoke);
    await expect(smith.invoke('test:channel', 'arg')).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith('test:channel', 'arg');
  });

  it('answers null when createChat cannot open a project', () => {
    const smith = service({ createChat: () => null });
    expect(smith.chat('gone')).toBeNull();
  });

  it('enqueues a seeded proposal at construction', async () => {
    const smith = service({ seedProposal: seed });
    await vi.waitFor(() => expect(smith.proposals.list()).toHaveLength(1));
    expect(smith.proposals.list()[0]).toMatchObject({ name: 'e2e_planner', kind: 'agent' });
  });

  it('files a receipt into the conversation that proposed the action', async () => {
    const chat = fakeChat();
    const smith = service({ createChat: () => chat });
    smith.chat('proj_1');

    const pending = smith.proposals.propose(
      {
        type: 'action',
        operation: 'merge',
        title: 'merge run',
        summary: 'merge the selected run.',
        args: { projectId: 'proj_1', runId: 'run_7' },
        risk: 'git',
        projectId: 'proj_1',
      },
      () => ({ ok: true, modelResult: { ok: true } }),
    );
    await smith.proposals.answer(smith.proposals.list()[0]!.id, { approved: true });
    await pending;

    expect(chat.absorbArtifact).toHaveBeenCalledOnce();
    const artifact = vi.mocked(chat.absorbArtifact).mock.calls[0]![0];
    expect(artifact).toMatchObject({
      kind: 'action_receipt',
      projectId: 'proj_1',
      receipt: { operation: 'merge', outcome: 'succeeded', target: 'run_7' },
    });
  });

  it('files a failed action as a failed receipt rather than dropping it', async () => {
    const chat = fakeChat();
    const smith = service({ createChat: () => chat });
    smith.chat();

    const pending = smith.proposals.propose(
      {
        type: 'action',
        operation: 'update_check',
        title: 'Check for updates',
        summary: 'Contact the update service.',
        args: {},
        risk: 'network',
      },
      () => ({ ok: false, error: 'offline' }),
    );
    await smith.proposals.answer(smith.proposals.list()[0]!.id, { approved: true });
    await pending;

    expect(vi.mocked(chat.absorbArtifact).mock.calls[0]![0]).toMatchObject({
      kind: 'action_receipt',
      receipt: { outcome: 'failed', failure: 'offline' },
    });
  });

  it('does not open a chat just to file a receipt', async () => {
    const created: string[] = [];
    const smith = service({
      createChat: (projectId) => {
        created.push(projectId ?? 'global');
        return fakeChat();
      },
    });

    const pending = smith.proposals.propose(
      {
        type: 'action',
        operation: 'merge',
        title: 'merge run',
        summary: 'merge the selected run.',
        args: { runId: 'run_7' },
        risk: 'git',
        projectId: 'proj_never_opened',
      },
      () => ({ ok: true, modelResult: { ok: true } }),
    );
    await smith.proposals.answer(smith.proposals.list()[0]!.id, { approved: true });
    await expect(pending).resolves.toMatchObject({ approved: true });
    expect(created).toEqual([]);
  });

  it('dispose closes live chats and unblocks a pending proposal', async () => {
    const chat = fakeChat();
    const created: SmithChatSession[] = [];
    const smith = service({
      createChat: () => {
        const next = created.length === 0 ? chat : fakeChat();
        created.push(next);
        return next;
      },
      seedProposal: seed,
    });
    smith.chat('proj_1');
    await vi.waitFor(() => expect(smith.proposals.list()).toHaveLength(1));
    smith.dispose();
    expect(chat.dispose).toHaveBeenCalledOnce();
    expect(smith.proposals.list()).toEqual([]);
    expect(smith.chat('proj_1')).not.toBe(chat);
  });
});
