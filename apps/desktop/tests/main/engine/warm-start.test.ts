/**
 * Start-time warm-up: work done while the proposal is under review is reused
 * by the Start click instead of paid twice, review-time edits survive the
 * merge, and a failed warm never fails the click (start retries).
 */
import { describe, expect, it } from 'vitest';
import {
  startRun,
  warmStartPrep,
  type StartRunDeps,
  type WarmStartDeps,
} from '../../../src/main/engine/operations.js';
import { defaultProject } from '../../../src/main/store/projects.js';
import { defaultSettings } from '../../../src/main/store/settings.js';
import { scriptedOneShots } from '../../helpers/scripted-oneshot.js';
import { tempDir } from '../../helpers/tmp.js';
import type {
  AgentDef,
  PipelineDef,
  ProjectDef,
  StartRunInput,
} from '../../../src/shared/types.js';

const CARD = [
  '## Stack\nTypeScript',
  '## Repository layout\n`apps/`',
  '## Conventions\nStrict TypeScript',
  '## Verification\n`npm run check`',
  '## Setup\n`npm ci`',
].join('\n\n');

const builder = (): AgentDef => ({
  name: 'builder',
  purpose: 'build things',
  model: 'scripted',
  reasoningEffort: 'medium',
  systemPrompt: 'You build.',
  userPrompt: 'Build: {{request}}',
  writes: null,
  envelope: 'build',
  color: '#5ad2dd',
});

const pipeline = (): PipelineDef => ({
  id: 'build-only',
  name: 'Build',
  description: 'One agent phase.',
  acceptance: { kind: 'all_phases_pass' },
  phases: [
    {
      name: 'build',
      kind: 'agent',
      agent: 'builder',
      description: 'Make the change.',
      envelope: 'build',
      prompt: { inputs: ['request'] },
    },
  ],
});

function depsFor(
  store: { current: ProjectDef },
  oneShot: ReturnType<typeof scriptedOneShots>['factory'],
  catalog: { calls: number },
): { warm: WarmStartDeps; start: StartRunDeps; started: ProjectDef[] } {
  const started: ProjectDef[] = [];
  const shared = {
    projectById: (id: string) => (id === store.current.id ? store.current : null),
    settings: () => defaultSettings(),
    oneShot,
  };
  return {
    warm: {
      ...shared,
      saveProject: (next) => {
        store.current = next;
      },
      enabledModelIds: async () => {
        catalog.calls += 1;
        return ['m'];
      },
    },
    start: {
      ...shared,
      pipelineFor: () => pipeline(),
      rosterFor: () => [builder()],
      envelopeDefs: () => [],
      saveProject: (next) => {
        store.current = next;
        return next;
      },
      registry: {
        start: (input) => {
          started.push(input.project);
          return 'run_warm_1';
        },
      },
    },
    started,
  };
}

describe('warmStartPrep', () => {
  it('backs the card once so the Start that follows spends no second turn', async () => {
    const store = { current: defaultProject(tempDir('foundry-warm-start-')) };
    const oneShots = scriptedOneShots([{ text: CARD }]);
    const catalog = { calls: 0 };
    const deps = depsFor(store, oneShots.factory, catalog);

    await warmStartPrep(deps.warm, store.current.id);
    expect(oneShots.calls).toHaveLength(1);
    expect(catalog.calls).toBe(1);
    expect(store.current.contextSummary).toContain('## Stack');

    const input: StartRunInput = {
      projectId: store.current.id,
      pipelineId: 'build-only',
      request: 'add a thing',
    };
    const outcome = await startRun(deps.start, input);

    expect(outcome.ok).toBe(true);
    expect(oneShots.calls).toHaveLength(1);
    expect(deps.started[0]?.contextSummary).toContain('## Setup');
  });

  it('merges the warmed card onto review-time edits instead of the snapshot', async () => {
    const store = { current: defaultProject(tempDir('foundry-warm-merge-')) };
    const oneShots = scriptedOneShots([{ text: CARD }]);
    const catalog = { calls: 0 };
    const deps = depsFor(store, oneShots.factory, catalog);

    const warming = warmStartPrep(deps.warm, store.current.id);
    // The operator configures a command while the warm turn is in flight.
    store.current = {
      ...store.current,
      commands: [{ name: 'test', argv: ['true'] }],
    };
    await warming;

    expect(store.current.commands).toEqual([{ name: 'test', argv: ['true'] }]);
    expect(store.current.contextSummary).toContain('## Verification');
  });

  it('never rejects: a failed warm leaves start to retry', async () => {
    const store = { current: defaultProject(tempDir('foundry-warm-fail-')) };
    const oneShots = scriptedOneShots([{ throws: 'no model' }]);
    const deps = depsFor(store, oneShots.factory, { calls: 0 });
    deps.warm.enabledModelIds = async () => {
      throw new Error('no catalog');
    };

    await expect(warmStartPrep(deps.warm, store.current.id)).resolves.toBeUndefined();
    expect(store.current.contextSummary).toBeUndefined();
  });

  it('does nothing without a project', async () => {
    const oneShots = scriptedOneShots([{ text: CARD }]);
    const store = { current: defaultProject(tempDir('foundry-warm-missing-')) };
    const deps = depsFor(store, oneShots.factory, { calls: 0 });

    await expect(warmStartPrep(deps.warm, 'no-such-project')).resolves.toBeUndefined();
    expect(oneShots.calls).toHaveLength(0);
  });
});
