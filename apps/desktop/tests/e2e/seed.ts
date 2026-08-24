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
import type { GeneratedRunPlan, PipelineDef } from '../../src/shared/types.js';
import type { ProposalInput } from '../../src/main/smith/proposals.js';

export const E2E_RUN_ID = 'run_e2e_inspector';
export const E2E_REQUEST = 'FOUNDRY_E2E_INSPECTOR_REQUEST';
export const E2E_TRANSCRIPT = 'FOUNDRY_E2E_TRANSCRIPT_MARKER';
export const E2E_SMITH_MESSAGE = 'FOUNDRY_E2E_SMITH_TRANSCRIPT';
export const E2E_SMITH_PROPOSAL_NAME = 'e2e_planner';
export const E2E_SMITH_ARTIFACT_PIPELINE = 'e2e-designed-pipeline';

const FINAL_FIXTURE_PIPELINE: PipelineDef = {
  id: 'generated-plan-e2e-inspector',
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

const INITIAL_FIXTURE_PIPELINE: PipelineDef = {
  ...FINAL_FIXTURE_PIPELINE,
  phases: [
    ...FINAL_FIXTURE_PIPELINE.phases,
    {
      name: 'obsolete_check',
      kind: 'code',
      description: 'Represent the queued tail replaced by the Orchestrator.',
      command: { argv: ['true'] },
    },
  ],
};

function fixturePlan(projectId: string, pipeline: PipelineDef): GeneratedRunPlan {
  return {
    planId: 'plan-e2e-inspector',
    projectId,
    prompt: E2E_REQUEST,
    refinedRequest: E2E_REQUEST,
    rationale: 'Build once, then amend the failed tail and finish with fresh evidence.',
    pipeline,
    agents: [],
    warnings: [],
    model: 'inherit',
    reasoningEffort: 'medium',
  };
}

export interface SeededFixture {
  userDataDir: string;
  supportDir: string;
  projectPath: string;
  projectId: string;
  runId: string;
}

export type SmithProposalFixture = 'entity' | 'action' | 'secure' | 'none';

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
export function seedOnboardedFixture(
  userDataDir?: string,
  smithProposal: SmithProposalFixture = 'entity',
): SeededFixture {
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
      pipeline: INITIAL_FIXTURE_PIPELINE,
      request: E2E_REQUEST,
      engineer: 'e2e',
      worktreePath: null,
      branch: null,
      baseRef: 'main',
      mode: 'pi',
      plan: fixturePlan(project.id, INITIAL_FIXTURE_PIPELINE),
    });
    const failedPhaseId = tracer.queuePhase({
      runId: E2E_RUN_ID,
      seq: 0,
      name: 'build',
      kind: 'agent',
      owner: 'builder',
      description: 'Fixture build phase',
    });
    const obsoletePhaseId = tracer.queuePhase({
      runId: E2E_RUN_ID,
      seq: 1,
      name: 'obsolete_check',
      kind: 'code',
      owner: 'code',
      description: 'Queued tail replaced by the seeded amendment.',
    });
    tracer.beginQueuedPhase(failedPhaseId);
    tracer.closePhase(failedPhaseId, 'fail', 'seeded verifier failure');
    const amended = tracer.amendRun({
      runId: E2E_RUN_ID,
      failedPhaseId,
      removeQueuedPhaseIds: [obsoletePhaseId],
      pipeline: FINAL_FIXTURE_PIPELINE,
      plan: fixturePlan(project.id, FINAL_FIXTURE_PIPELINE),
      reason: 'Replace the exhausted build attempt with a focused retry.',
      attempt: 1,
      evidence: 'seeded verifier failure',
      before: ['obsolete_check'],
      after: ['build'],
      newPhases: FINAL_FIXTURE_PIPELINE.phases,
      engineer: 'e2e',
    });
    const phaseId = amended.get('build');
    if (!phaseId) throw new Error('seeded amendment did not queue build');
    tracer.beginQueuedPhase(phaseId);
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

  seedSmithChat(supportDir, project.id);
  if (smithProposal !== 'none') seedSmithProposal(supportDir, project.id, smithProposal);

  return {
    userDataDir: root,
    supportDir,
    projectPath,
    projectId: project.id,
    runId: E2E_RUN_ID,
  };
}

/** Persisted Smith transcript the chat screen and bubble restore on open. */
function seedSmithChat(supportDir: string, projectId: string): void {
  const stateDir = join(supportDir, 'pi', 'smith', projectId);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'chat-state.json'),
    `${JSON.stringify(
      {
        sessionId: null,
        modelOverride: null,
        transcript: [
          {
            id: 'e2e-op',
            kind: 'text',
            text: 'What agents do I have?',
            source: 'operator',
            at: 1,
          },
          {
            id: 'e2e-sm',
            kind: 'text',
            text: E2E_SMITH_MESSAGE,
            source: 'smith',
            at: 2,
          },
          // A presented design card, restored the way smith_present persists it.
          {
            id: 'e2e-artifact',
            kind: 'artifact',
            source: 'smith',
            at: 3,
            artifact: {
              id: 'e2e-artifact',
              kind: 'pipeline_design',
              version: 1,
              createdAt: 3,
              projectId,
              rationale: 'A single build phase keeps the fixture legible.',
              warnings: [],
              pipeline: {
                id: E2E_SMITH_ARTIFACT_PIPELINE,
                name: 'Designed pipeline',
                description: 'Seeded design artifact for the Electron UI smoke.',
                acceptance: { kind: 'all_phases_pass' },
                phases: [
                  {
                    name: 'build',
                    kind: 'agent',
                    description: 'Build the change.',
                    agent: 'builder',
                    prompt: { inputs: ['request'] },
                  },
                  {
                    name: 'test',
                    kind: 'code',
                    description: 'Run the checks.',
                    command: { ref: 'test' },
                  },
                ],
              },
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

/** Pending proposal the e2e harness injects via `FOUNDRY_E2E_SMITH_PROPOSAL`. */
function seedSmithProposal(
  supportDir: string,
  projectId: string,
  fixture: Exclude<SmithProposalFixture, 'none'>,
): void {
  mkdirSync(join(supportDir, 'smith'), { recursive: true });
  const input: ProposalInput =
    fixture === 'entity'
      ? {
          type: 'entity',
          kind: 'agent',
          mode: 'create',
          name: E2E_SMITH_PROPOSAL_NAME,
          spec: {
            name: E2E_SMITH_PROPOSAL_NAME,
            purpose: 'E2E fixture agent.',
            model: 'inherit',
            reasoningEffort: 'medium',
            systemPrompt: 'You plan.',
            userPrompt: 'Work on: {{request}}',
            writes: [],
            envelope: 'plan',
            color: '#5ad2dd',
          },
          validation: [],
          overwrites: false,
          projectId,
        }
      : fixture === 'secure'
        ? {
            type: 'action',
            operation: 'set_api_key',
            title: 'Set Gemini API key',
            summary: 'Store a direct API key for Google Gemini.',
            args: { providerId: 'google' },
            risk: 'credential',
            secretRequest: { kind: 'api-key', label: 'API key for google' },
            projectId,
          }
        : {
            type: 'action',
            operation: 'start',
            title: 'Start pipeline run',
            summary: 'Start the prompt pipeline for the E2E project.',
            args: { projectId, pipelineId: 'prompt', request: 'Build the requested change.' },
            risk: 'write',
            projectId,
          };
  writeFileSync(
    join(supportDir, 'smith', 'pending-proposal.json'),
    `${JSON.stringify(input, null, 2)}\n`,
  );
}
