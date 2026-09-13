import { describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../helpers/tmp.js';
import { runPlanFixture } from '../../helpers/run-plan.js';
import { scriptedOneShots } from '../../helpers/scripted-oneshot.js';
import { openDb, projectDbPath, projectRunsDir } from '../../../src/main/trace/db.js';
import { Tracer } from '../../../src/main/trace/tracer.js';
import { SmithService } from '../../../src/main/smith/index.js';
import type { SmithChatSession } from '../../../src/main/smith/chat-session.js';
import { createComposeSessions } from '../../../src/main/smith/compose/session.js';
import { ProposalStore, proposalToLiveState } from '../../../src/main/smith/compose/proposals.js';
import { validateRunPlanArtifact } from '../../../src/main/smith/present-tools.js';
import { smithRunPlanArtifact } from '../../../src/shared/smith-run-plan.js';

function setup() {
  const root = tempDir('smith-run-plan-');
  const db = openDb(projectDbPath(root, '/fixture'));
  const tracer = new Tracer(db, projectRunsDir(root, '/fixture'));
  const plans = createComposeSessions(scriptedOneShots([]).factory, () => {});
  const startRun = vi.fn(async () => ({ ok: true as const, runId: 'accepted-run' }));
  const store = new ProposalStore({
    tracerFor: () => tracer,
    projectIds: () => ['project'],
    plans,
    startRun,
    broadcast: () => {},
  });
  const createChat = vi.fn(
    () => ({ absorbArtifact: vi.fn(), dispose: vi.fn() }) as unknown as SmithChatSession,
  );
  const smith = new SmithService({
    composeProposals: store,
    createChat,
    broadcast: () => {},
    channels: { proposalsChanged: 'changed' },
    save: () => ({ ok: true, entity: {} }),
  });
  return {
    store,
    smith,
    createChat,
    startRun,
    close: () => {
      smith.dispose();
      db.close();
    },
  };
}

describe('SmithService run plans', () => {
  it('does not open a chat to file a ready card', () => {
    const s = setup();
    try {
      s.store.onProgress(proposalToLiveState(runPlanFixture())!);
      expect(s.createChat).not.toHaveBeenCalled();
    } finally {
      s.close();
    }
  });

  it('delivers once per revision, handles late global origin, and records exactly-once acceptance', async () => {
    const s = setup();
    try {
      const project = s.smith.chat('project')!;
      const global = s.smith.chat()!;
      const row = runPlanFixture();
      s.store.onProgress(proposalToLiveState(row)!);
      s.store.onProgress(proposalToLiveState(row)!);
      expect(project.absorbArtifact).toHaveBeenCalledTimes(1);
      expect(global.absorbArtifact).not.toHaveBeenCalled();
      s.store.recordIssuingScope(row.planId, undefined);
      s.store.recordIssuingScope(row.planId, undefined);
      expect(global.absorbArtifact).toHaveBeenCalledTimes(1);
      expect(project.absorbArtifact).toHaveBeenCalledTimes(1);
      row.revision = 2;
      s.store.onProgress(proposalToLiveState(row)!);
      expect(project.absorbArtifact).toHaveBeenCalledTimes(2);
      await Promise.all([s.store.accept(row.planId), s.store.accept(row.planId)]);
      expect(s.startRun).toHaveBeenCalledTimes(1);
      expect(project.absorbArtifact).toHaveBeenLastCalledWith(
        expect.objectContaining({
          kind: 'run_plan',
          status: 'accepted',
          revision: 2,
          acceptedRunId: 'accepted-run',
        }),
      );
      expect(global.absorbArtifact).toHaveBeenCalledTimes(3);
    } finally {
      s.close();
    }
  });

  it('emits failed cards but no cancelled or discarded artifacts; unsubscribes on dispose', () => {
    const s = setup();
    try {
      const chat = s.smith.chat('project')!;
      const row = {
        ...runPlanFixture(),
        status: 'failed' as const,
        plan: null,
        detail: 'No valid envelope',
      };
      s.store.onProgress(proposalToLiveState(row)!);
      expect(chat.absorbArtifact).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'failed', rationale: 'No valid envelope' }),
      );
      const transitions = vi.fn();
      const off = s.store.onTransition(transitions);
      s.store.discard(row.planId);
      expect(transitions).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'discarded' }),
      );
      expect(chat.absorbArtifact).toHaveBeenCalledTimes(1);
      const generating = {
        ...runPlanFixture(),
        planId: 'cancel-me',
        status: 'generating' as const,
      };
      s.store.onProgress(proposalToLiveState(generating)!);
      expect(s.store.cancel(generating.planId)).toBe(true);
      expect(transitions).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'cancelled' }),
      );
      expect(chat.absorbArtifact).toHaveBeenCalledTimes(1);
      off();
      s.smith.dispose();
      s.store.onProgress(proposalToLiveState({ ...runPlanFixture(), planId: 'another' })!);
      expect(chat.absorbArtifact).toHaveBeenCalledTimes(1);
    } finally {
      s.close();
    }
  });
});

describe('main run_plan validation', () => {
  it('rejects oversized, extra and secret-shaped data, and accepts all effort levels', () => {
    const artifact = smithRunPlanArtifact(runPlanFixture());
    expect(validateRunPlanArtifact(artifact)).toBe(true);
    expect(validateRunPlanArtifact({ ...artifact, title: 'x'.repeat(121) })).toBe(false);
    expect(validateRunPlanArtifact({ ...artifact, plan_json: '{}' })).toBe(false);
    expect(validateRunPlanArtifact({ ...artifact, rationale: 'sk-' + 'a'.repeat(25) })).toBe(false);
    artifact.phases[0]!.reasoningEffort = 'xhigh';
    expect(validateRunPlanArtifact(artifact)).toBe(true);
  });
});
