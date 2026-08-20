import { describe, expect, it } from 'vitest';
import { agentSystemRole } from '../../../src/main/engine/agent-context.js';

const LEGACY_CLAIM =
  "You inherit the operator's PATH and credentials. Project dependencies are available only when the worktree setup installed them.";

describe('run-agent system context', () => {
  it('adds the repository card and worktree-accurate setup evidence for writable agents', () => {
    const role = agentSystemRole({
      rosterRole: `# Builder\n\n${LEGACY_CLAIM}`,
      repositoryContext: '## Stack\nTypeScript',
      writes: null,
      cwd: '/repo/.foundry-worktrees/run_1',
      projectPath: '/repo',
      setup: { command: 'npm ci', exitCode: 0 },
    });

    expect(role).toContain('# Builder');
    expect(role).toContain('## Stack\nTypeScript');
    expect(role).toContain('isolated run worktree at /repo/.foundry-worktrees/run_1');
    expect(role).toContain('Setup ran npm ci — exit 0.');
    expect(role).not.toContain(LEGACY_CLAIM);
  });

  it('omits all shell and setup guidance for read-only agents', () => {
    const role = agentSystemRole({
      rosterRole: `# Scout\n\n${LEGACY_CLAIM}`,
      repositoryContext: '## Layout\nsrc/',
      writes: [],
      cwd: '/repo/.foundry-worktrees/run_1',
      projectPath: '/repo',
      setup: { command: 'npm ci', exitCode: 0 },
    });

    expect(role).toContain('## Layout\nsrc/');
    expect(role).not.toContain('# Worktree and shell');
    expect(role).not.toContain('Setup ran');
    expect(role).not.toContain(LEGACY_CLAIM);
  });

  it('states when a writable run is operating directly in the project checkout', () => {
    const role = agentSystemRole({
      rosterRole: '# Builder',
      writes: ['src/'],
      cwd: '/repo',
      projectPath: '/repo',
    });

    expect(role).toContain('project checkout at /repo; this run is not isolated');
    expect(role).toContain('Do not assume dependencies, toolchains, or credentials');
  });
});
