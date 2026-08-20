/**
 * Isolated Foundry app-support fixtures for Electron UI smoke.
 *
 * Writes the same JSON stores and WAL trace the live app reads, so a spec can
 * open Inspector without a model, network account, or engine run. No credential
 * is seeded and no agent binary is named: a run started by accident has no
 * model to reach and stops at the doctor's blocking check rather than spending
 * anything.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../helpers/tmp.js';
import { SettingsStore } from '../../src/main/store/settings.js';
import { ProjectStore } from '../../src/main/store/projects.js';
import { openDb, projectDbPath, projectRunsDir } from '../../src/main/trace/db.js';
import { Tracer } from '../../src/main/trace/tracer.js';
import type { PipelineDef } from '../../src/shared/types.js';

export const E2E_RUN_ID = 'run_e2e_inspector';
export const E2E_REQUEST = 'FOUNDRY_E2E_INSPECTOR_REQUEST';
export const E2E_TRANSCRIPT = 'FOUNDRY_E2E_TRANSCRIPT_MARKER';

const FIXTURE_PIPELINE: PipelineDef = {
  id: 'prompt',
  name: 'Prompt',
  description: 'One-shot fixture pipeline for Electron UI smoke.',
  acceptance: { kind: 'all_phases_pass' },
  phases: [
    {
      name: 'build',
      kind: 'agent',
      agent: 'builder',
      description: 'Implement the request and leave a transcript.',
      envelope: 'build',
    },
  ],
};

export interface SeededFixture {
  userDataDir: string;
  supportDir: string;
  projectPath: string;
  projectId: string;
  runId: string;
}

function scratchRepo(): string {
  const dir = tempDir('foundry-e2e-repo-');
  const git = (argv: string[]): void => {
    execFileSync('git', argv, { cwd: dir, encoding: 'utf8' });
  };
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'e2e@foundry.local']);
  git(['config', 'user.name', 'Foundry E2E']);
  writeFileSync(join(dir, 'README.md'), '# e2e fixture\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'initial']);
  return dir;
}

/**
 * Seed an isolated Electron `--user-data-dir`.
 *
 * The live app stores state at `<userData>/foundry/` (see `src/main/main.ts`).
 */
export function seedOnboardedFixture(userDataDir?: string): SeededFixture {
  const root = userDataDir ?? tempDir('foundry-e2e-app-');
  const supportDir = join(root, 'foundry');
  mkdirSync(supportDir, { recursive: true });

  const projectPath = scratchRepo();

  const settings = new SettingsStore(supportDir);
  const patched = settings.patch({ onboarded: true, engineerName: 'e2e' });
  if (!patched.ok) {
    throw new Error(`failed to seed settings: ${patched.issues.join('; ')}`);
  }

  const project = new ProjectStore(supportDir).add(projectPath);
  const db = openDb(projectDbPath(supportDir, project.path));
  try {
    const tracer = new Tracer(db, projectRunsDir(supportDir, project.path));
    tracer.startRun({
      runId: E2E_RUN_ID,
      projectId: project.id,
      pipeline: FIXTURE_PIPELINE,
      request: E2E_REQUEST,
      engineer: 'e2e',
      worktreePath: null,
      branch: null,
      baseRef: 'main',
      mode: 'pi',
    });
    const phaseId = tracer.openPhase({
      runId: E2E_RUN_ID,
      seq: 0,
      name: 'build',
      kind: 'agent',
      owner: 'builder',
      description: 'Fixture build phase',
    });
    tracer.event({
      runId: E2E_RUN_ID,
      phaseId,
      type: 'assistant_text',
      name: 'assistant',
      payload: { text: E2E_TRANSCRIPT },
      endedAt: new Date().toISOString(),
    });
    tracer.event({
      runId: E2E_RUN_ID,
      phaseId,
      type: 'tool_call',
      name: 'read: README.md',
      payload: {
        kind: 'read',
        args: { file_path: 'README.md' },
        result: '# e2e fixture\n',
      },
      endedAt: new Date().toISOString(),
    });
    tracer.recordEnvelope({
      runId: E2E_RUN_ID,
      phaseId,
      agent: 'builder',
      schemaKind: 'build',
      payload: {
        status: 'success',
        summary: E2E_TRANSCRIPT,
        artifacts: [],
        notes_for_next_agent: '',
      },
      valid: true,
      attempt: 1,
    });
    tracer.closePhase(phaseId, 'success');
    tracer.finishRun(E2E_RUN_ID, 'accepted', 'seeded Electron UI fixture');
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }

  return {
    userDataDir: root,
    supportDir,
    projectPath,
    projectId: project.id,
    runId: E2E_RUN_ID,
  };
}
