/**
 * Start-time backfill: a project with an empty card gets one before the
 * registry launches the run, so the first agent turn already has the facts.
 */
import { describe, expect, it } from 'vitest';
import { startRun, type StartRunDeps } from '../../../src/main/engine/operations.js';
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

describe('startRun project-card backfill', () => {
  it('generates and persists a card when contextSummary is empty', async () => {
    const project: ProjectDef = defaultProject(tempDir('foundry-context-start-'));
    let stored = project;
    const oneShots = scriptedOneShots([{ text: CARD }]);
    const started: ProjectDef[] = [];

    const deps: StartRunDeps = {
      projectById: (id) => (id === stored.id ? stored : null),
      pipelineFor: () => pipeline(),
      rosterFor: () => [builder()],
      envelopeDefs: () => [],
      settings: () => defaultSettings(),
      saveProject: (next) => {
        stored = next;
        return next;
      },
      oneShot: oneShots.factory,
      registry: {
        start: (input) => {
          started.push(input.project);
          return 'run_context_1';
        },
      },
    };
    const input: StartRunInput = {
      projectId: project.id,
      pipelineId: 'build-only',
      request: 'add a thing',
    };

    const outcome = await startRun(deps, input);

    expect(outcome.ok).toBe(true);
    expect(oneShots.calls).toHaveLength(1);
    expect(oneShots.calls[0]).toMatchObject({ cwd: project.path, access: 'read' });
    expect(stored.contextSummary).toContain('## Stack');
    expect(stored.contextSummary).toContain('## Verification');
    expect(started[0]?.contextSummary).toContain('## Setup');
  });

  it('does not spend a turn when the card is already present and not stale', async () => {
    const project: ProjectDef = {
      ...defaultProject(tempDir('foundry-context-start-cached-')),
      contextSummary: CARD,
    };
    const oneShots = scriptedOneShots([{ text: 'must not run' }]);
    const deps: StartRunDeps = {
      projectById: (id) => (id === project.id ? project : null),
      pipelineFor: () => pipeline(),
      rosterFor: () => [builder()],
      envelopeDefs: () => [],
      settings: () => defaultSettings(),
      saveProject: () => {
        throw new Error('must not persist');
      },
      oneShot: oneShots.factory,
      registry: { start: () => 'run_context_2' },
    };

    const outcome = await startRun(deps, {
      projectId: project.id,
      pipelineId: 'build-only',
      request: 'add a thing',
    });

    expect(outcome.ok).toBe(true);
    expect(oneShots.calls).toHaveLength(0);
  });
});
