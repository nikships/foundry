/**
 * Run-start command fill uses the same submit_result path as DetectSession.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../helpers/tmp.js';
import { scriptedOneShots } from '../../helpers/scripted-oneshot.js';
import { startRun } from '../../../src/main/engine/operations.js';
import { defaultProject } from '../../../src/main/store/projects.js';
import { defaultSettings } from '../../../src/main/store/settings.js';
import type { PipelineDef, ProjectDef } from '../../../src/shared/types.js';

function pipe(): PipelineDef {
  return {
    id: 'p',
    name: 'P',
    description: 'a pipeline whose test phase is a project command ref',
    acceptance: { kind: 'all_phases_pass' },
    phases: [
      {
        name: 'test',
        kind: 'code',
        description: 'Run the project test command.',
        command: { ref: 'test' },
      },
    ],
  };
}

describe('start-run command fill', () => {
  it('parses a detect reply that only calls submit_result', async () => {
    const dir = tempDir('foundry-start-detect-');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), '# hi\n');
    let project: ProjectDef = {
      ...defaultProject(dir),
      commands: [],
      // Keep this test on command detection; project-card backfill owns a
      // separate one-shot and has its own startRun integration coverage.
      contextSummary: 'Cached project context.',
    };
    const oneShots = scriptedOneShots([
      {
        structuredOutput: {
          commands: [{ name: 'test', argv: ['true'], source: 'README.md' }],
        },
      },
    ]);

    const outcome = await startRun(
      {
        projectById: (id) => (id === project.id ? project : null),
        pipelineFor: () => pipe(),
        rosterFor: () => [],
        envelopeDefs: () => [],
        settings: () => defaultSettings(),
        saveProject: (next) => {
          project = next;
          return next;
        },
        oneShot: oneShots.factory,
        registry: { start: () => 'run_fill' },
      },
      { projectId: project.id, pipelineId: 'p', request: 'do the thing' },
    );

    expect(outcome.ok).toBe(true);
    expect(oneShots.calls).toHaveLength(1);
    expect(oneShots.calls[0]!.access).toBe('read');
    expect(oneShots.calls[0]!.outputFormat?.type).toBe('json_schema');
    expect(oneShots.calls[0]!.systemPrompt).toContain('Call submit_result exactly once');
    expect(project.commands).toEqual([{ name: 'test', argv: ['true'] }]);
  });
});
