import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PipelineDef, ProjectDef, ValidationIssue } from '@shared/types.js';
import {
  isMissingProjectCommandWarning,
  missingProjectCommandRefs,
  projectCommandsReady,
  seedMissingProjectCommands,
} from '@renderer/view-models/project-commands-view.js';

const here = dirname(fileURLToPath(import.meta.url));
const readRenderer = (path: string): string =>
  readFileSync(join(here, '../../src/renderer', path), 'utf8');

function project(commands: ProjectDef['commands']): ProjectDef {
  return {
    id: 'project-1',
    name: 'multi-language-project',
    path: '/tmp/project',
    baseRef: 'main',
    isolation: true,
    mergePolicy: 'ask',
    commands,
    protectedPaths: [],
    ownRoster: false,
    ownPipelines: false,
    scaffold: true,
    addedAt: '2026-08-27T00:00:00.000Z',
  };
}

const pipeline: PipelineDef = {
  id: 'build-test-lint',
  name: 'Build, test, lint',
  description: 'Builds and checks the project.',
  acceptance: { kind: 'all_phases_pass' },
  phases: [
    { name: 'build', kind: 'code', description: 'Build it.', command: { ref: 'build' } },
    { name: 'test', kind: 'code', description: 'Test it.', command: { ref: 'test' } },
    { name: 'test_again', kind: 'code', description: 'Test it again.', command: { ref: 'test' } },
    { name: 'lint', kind: 'code', description: 'Lint it.', command: { ref: 'lint' } },
  ],
};

describe('project command provisioning', () => {
  it('seeds only missing names and never guesses an npm or other stack-specific argv', () => {
    const original = project([{ name: 'build', argv: ['cargo', 'build'] }]);
    const seeded = seedMissingProjectCommands(original, ['test', 'test', 'lint']);

    expect(seeded.commands).toEqual([
      { name: 'build', argv: ['cargo', 'build'] },
      { name: 'test', argv: [] },
      { name: 'lint', argv: [] },
    ]);
    expect(original.commands).toEqual([{ name: 'build', argv: ['cargo', 'build'] }]);
    expect(projectCommandsReady(seeded.commands)).toBe(false);
    expect(
      projectCommandsReady([
        { name: 'test', argv: ['go', 'test', './...'] },
        { name: 'lint', argv: ['cargo', 'clippy'] },
      ]),
    ).toBe(true);
  });

  it('derives one live affordance row for every missing pipeline ref', () => {
    expect(
      missingProjectCommandRefs(pipeline, [{ name: 'build', argv: ['swift', 'build'] }]),
    ).toEqual(['test', 'lint']);
    expect(
      missingProjectCommandRefs(pipeline, [
        { name: 'build', argv: ['swift', 'build'] },
        { name: 'test', argv: ['swift', 'test'] },
        { name: 'lint', argv: ['swiftlint'] },
      ]),
    ).toEqual([]);
  });

  it('replaces both established frozen warning forms but preserves unrelated warnings', () => {
    const issues: ValidationIssue[] = [
      {
        level: 'warning',
        where: 'phases[1] test',
        message: 'project command "test" is not configured for this project yet',
      },
      {
        level: 'warning',
        where: 'test',
        message:
          'no "test" command in this new project yet — this phase will be skipped until one exists',
      },
      { level: 'warning', where: 'pipeline', message: 'GitHub CLI is unavailable.' },
    ];

    expect(issues.filter(isMissingProjectCommandWarning)).toEqual(issues.slice(0, 2));
    expect(issues.filter((issue) => !isMissingProjectCommandWarning(issue))).toEqual([issues[2]]);
  });

  it('wires the shared editor at both ownership points without navigating away from a plan', () => {
    const wizard = readRenderer('components/project/NewProjectWizard.tsx');
    const planCard = readRenderer('components/run/PlanCard.tsx');
    const editor = readRenderer('components/project/ProjectCommands.tsx');

    expect(wizard).toContain('<ProjectCommandsModal');
    expect(wizard).toContain("commandNames={['test']}");
    expect(wizard).toContain('new-project-configure-commands');
    expect(planCard).toContain('<ProjectCommandsModal');
    expect(planCard).toContain('onSaved={async () => refreshAll()}');
    expect(planCard).not.toContain('onOpenSettings');
    expect(editor).toContain('placeholder="command and arguments"');
    expect(editor).not.toContain('placeholder="npm test"');
    expect(editor).toContain('data-testid={`project-command-${command.name}`}');
    expect(editor).toContain('data-testid={`project-command-${command.name}-try`}');
    expect(editor).toContain('data-testid={`project-command-${command.name}-remove`}');
    expect(editor).toContain('data-testid="project-command-add"');
  });
});
