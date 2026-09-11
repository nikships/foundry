/**
 * Shared test harness and helpers for restore test suites.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { openDb, projectDbPath, projectRunsDir, type Db } from '../../../src/main/trace/db.js';
import { Tracer } from '../../../src/main/trace/tracer.js';
import { Executor, type ExecutorDeps } from '../../../src/main/engine/executor.js';
import type { RestoreScope } from '../../../src/main/engine/restore.js';
import { defaultProject } from '../../../src/main/store/projects.js';
import type {
  AgentDef,
  CommandSpec,
  PhaseCheckpointFile,
  PhaseDef,
  PipelineDef,
  ProjectDef,
} from '../../../src/shared/types.js';
import { ScriptedAgent } from '../../helpers/scripted-transport.js';
import { tempDir } from '../../helpers/tmp.js';

export function sh(cwd: string, argv: string[]): string {
  try {
    return execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8' });
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr ?? '';
    throw new Error(`${argv.join(' ')} failed in ${cwd}: ${stderr.trim() || String(e)}`);
  }
}

export function scratchRepo(): string {
  const dir = tempDir('foundry-restore-');
  sh(dir, ['git', 'init', '-q', '-b', 'main']);
  sh(dir, ['git', 'config', 'user.email', 'test@foundry.local']);
  sh(dir, ['git', 'config', 'user.name', 'Foundry Test']);
  writeFileSync(join(dir, 'README.md'), '# scratch\n');
  writeFileSync(join(dir, 'tracked.txt'), 'committed\n');
  sh(dir, ['git', 'add', '-A']);
  sh(dir, ['git', 'commit', '-qm', 'initial']);
  return dir;
}

export const buildAgent = (over: Partial<AgentDef> = {}): AgentDef => ({
  name: 'builder',
  purpose: 'build things',
  model: 'scripted/model',
  reasoningEffort: 'medium',
  systemPrompt: 'You build.',
  userPrompt: 'Build: {{request}}',
  writes: null,
  envelope: 'build',
  color: '#5ad2dd',
  ...over,
});

export function agentPhase(name: string, over: Partial<PhaseDef> = {}): PhaseDef {
  return {
    name,
    kind: 'agent',
    agent: 'builder',
    description: over.description ?? name,
    envelope: 'build',
    prompt: { inputs: ['request'] },
    ...over,
  };
}

export function codePhase(
  name: string,
  command: CommandSpec,
  over: Partial<PhaseDef> = {},
): PhaseDef {
  return { name, kind: 'code', description: over.description ?? name, command, ...over };
}

export function pipe(phases: PhaseDef[], over: Partial<PipelineDef> = {}): PipelineDef {
  return {
    id: 'p',
    name: 'p',
    description: 'restore pipeline',
    acceptance: { kind: 'all_phases_pass' },
    phases,
    ...over,
  };
}

export function buildEnvelope(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: 'success',
    summary: 'built it',
    artifacts: [],
    commit_message: 'add a thing',
    notes_for_next_agent: '',
    ...over,
  });
}

export interface Harness {
  repo: string;
  support: string;
  db: Db;
  tracer: Tracer;
  project: ProjectDef;
}

export function createHarness(): Harness {
  const repo = scratchRepo();
  const support = tempDir('foundry-restore-support-');
  const db = openDb(projectDbPath(support, repo));
  return {
    repo,
    support,
    db,
    tracer: new Tracer(db, projectRunsDir(support, repo)),
    project: { ...defaultProject(repo), mergePolicy: 'never' },
  };
}

export function scopeForHarness(
  h: Harness,
  over: Partial<RestoreScope> = {},
): RestoreScope & { notified: () => number } {
  let notifications = 0;
  const built: RestoreScope = {
    tracer: h.tracer,
    isLive: () => false,
    notifyRuns: () => {
      notifications += 1;
    },
    ...over,
  };
  return { ...built, notified: () => notifications };
}

export interface RunInput {
  pipeline: PipelineDef;
  agents?: AgentDef[];
  scripted?: ScriptedAgent;
  project?: Partial<ProjectDef>;
  runId?: string;
}

export function executorForHarness(
  h: Harness,
  input: RunInput,
  runId: string,
  scripted: ScriptedAgent,
): Executor {
  const deps: ExecutorDeps = {
    tracer: h.tracer,
    envelopeRetries: 2,
    gateRetries: 2,
    compactionThreshold: 0.8,
    rewindAfterCorrections: 2,
    healing: null,
    supportDir: h.support,
    transport: (req) => scripted.transport(req),
    agents: input.agents ?? [buildAgent()],
    envelopeDefs: [],
    project: { ...h.project, ...input.project },
    pipeline: input.pipeline,
    request: 'do the thing',
    runId,
    engineer: 'test',
  };
  return new Executor(deps);
}

export async function runForHarness(
  h: Harness,
  input: RunInput,
): Promise<{ status: string; runId: string }> {
  const runId = input.runId ?? `run_${Math.random().toString(36).slice(2, 8)}`;
  const scripted = input.scripted ?? new ScriptedAgent([buildEnvelope()]);
  const outcome = await executorForHarness(h, input, runId, scripted).run();
  return { status: outcome.status, runId };
}

export function worktreeOfHarness(h: Harness, runId: string): string {
  const path = h.tracer.run(runId)!.worktreePath;
  if (!path) throw new Error(`run ${runId} has no worktree`);
  return path;
}

export function headOf(cwd: string): string {
  return sh(cwd, ['git', 'rev-parse', 'HEAD']).trim();
}

export function checkpointForHarness(h: Harness, runId: string, phaseName: string, generation = 1) {
  const row = h.tracer
    .phaseCheckpoints(runId)
    .find((c) => c.phaseName === phaseName && c.generation === generation);
  if (!row) throw new Error(`no checkpoint for ${phaseName} generation ${generation}`);
  return row;
}

export function rerecordForHarness(
  h: Harness,
  runId: string,
  phaseName: string,
  files: PhaseCheckpointFile[],
  over: { truncated?: boolean; omittedPaths?: string[] } = {},
): string {
  const checkpoint = checkpointForHarness(h, runId, phaseName);
  const payload = h.tracer.phaseCheckpoint(checkpoint.checkpointId)!.payload;
  return h.tracer.recordPhaseCheckpoint({
    runId,
    phaseId: checkpoint.phaseId,
    phaseName: checkpoint.phaseName,
    phaseKind: checkpoint.phaseKind,
    headSha: checkpoint.headSha,
    branch: payload.branch,
    worktreePath: payload.worktreePath,
    isolated: payload.isolated,
    model: checkpoint.model,
    agent: checkpoint.agent,
    agentSessionId: checkpoint.agentSessionId,
    leafMessageId: checkpoint.leafMessageId,
    handoffFiles: payload.handoffFiles,
    envelopePhases: payload.envelopePhases,
    files,
    truncated: over.truncated ?? false,
    omittedPaths: over.omittedPaths ?? [],
    bytesStored: 0,
  }).checkpointId;
}

export function recordedFile(
  path: string,
  content: Buffer,
  state: PhaseCheckpointFile['state'] = 'untracked',
): PhaseCheckpointFile {
  const encoding = Buffer.from(content.toString('utf8'), 'utf8').equals(content)
    ? ('utf8' as const)
    : ('base64' as const);
  return {
    path,
    state,
    contentHash: createHash('sha256').update(content).digest('hex'),
    size: content.byteLength,
    content: content.toString(encoding),
    encoding,
  };
}

export async function rejectedRunWithDirtyCheckpointForHarness(
  h: Harness,
): Promise<{ runId: string; worktree: string }> {
  const outcome = await runForHarness(h, {
    scripted: new ScriptedAgent(['prose, not JSON']),
    pipeline: pipe([
      codePhase('dirty', {
        argv: ['sh', '-c', 'printf "phase-start\\n" > tracked.txt && printf "kept\\n" > extra.txt'],
      }),
      agentPhase('build'),
    ]),
  });
  expect(outcome.status).toBe('rejected');
  return { runId: outcome.runId, worktree: worktreeOfHarness(h, outcome.runId) };
}
