/**
 * Executor against real git and a scripted agent stand-in. M3 acceptance
 * criteria: the repair loop converges in-session, boundary violations are
 * reverted with evidence, and a phase that never yields a valid envelope fails.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../helpers/tmp.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, projectDbPath, projectRunsDir, type Db } from '../../../src/main/trace/db.js';
import { Tracer } from '../../../src/main/trace/tracer.js';
import { Executor, type ExecutorDeps } from '../../../src/main/engine/executor.js';
import { RunRegistry } from '../../../src/main/engine/registry.js';
import { breakdownFile } from '../../../src/main/pi/session.js';
import { exampleFor, jsonSchemaFor } from '../../../src/main/engine/envelopes.js';
import { defaultProject } from '../../../src/main/store/projects.js';
import type {
  AgentDef,
  AppSettings,
  CommandSpec,
  EnvelopeDef,
  LinearRunSource,
  PhaseDef,
  PipelineDef,
  ProjectDef,
} from '../../../src/shared/types.js';
import type { RunSourceLifecycle } from '../../../src/main/engine/source-lifecycle.js';
import type { GhOptions } from '../../../src/main/system/gh.js';
import { makeFakeGh } from '../../helpers/fake-gh.js';
import {
  ScriptedAgent,
  type AskReply,
  type ScriptedAgentOptions,
  type ScriptedAsk,
} from '../../helpers/scripted-transport.js';

function sh(cwd: string, argv: string[]): string {
  try {
    return execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8' });
  } catch (e) {
    // execFileSync reports only "Command failed", which turns any setup failure
    // into an unactionable one; the command's own stderr says what happened.
    const stderr = (e as { stderr?: string }).stderr ?? '';
    throw new Error(`${argv.join(' ')} failed in ${cwd}: ${stderr.trim() || String(e)}`);
  }
}

function scratchRepo(): string {
  const dir = tempDir('foundry-exec-');
  sh(dir, ['git', 'init', '-q', '-b', 'main']);
  sh(dir, ['git', 'config', 'user.email', 'test@foundry.local']);
  sh(dir, ['git', 'config', 'user.name', 'Foundry Test']);
  writeFileSync(join(dir, 'README.md'), '# scratch\n');
  sh(dir, ['git', 'add', '-A']);
  sh(dir, ['git', 'commit', '-qm', 'initial']);
  return dir;
}

function emptyRepo(): string {
  const dir = tempDir('foundry-empty-exec-');
  sh(dir, ['git', 'init', '-q', '-b', 'main']);
  sh(dir, ['git', 'config', 'user.email', 'test@foundry.local']);
  sh(dir, ['git', 'config', 'user.name', 'Foundry Test']);
  return dir;
}

/**
 * The scripted agent for the run currently under construction.
 *
 * Agent phases run in process, so a test scripts the transport rather than a
 * child: `run({ scripted })` hands this to the executor's `transport` seam and
 * the engine drives the production `AgentSession`, policy, and event folding on
 * top of it.
 */
function scriptedAgent(
  turns: string[],
  sideEffects: (string | null)[] = [],
  asks: ScriptedAsk[][] = [],
  options: ScriptedAgentOptions = {},
): ScriptedAgent {
  return new ScriptedAgent(turns, sideEffects, asks, options);
}

/** The replies the scripted agent got back, in the order it raised the asks. */
function askReplies(agent: ScriptedAgent): AskReply[] {
  return agent.askReplies;
}

/** Every turn the engine sent, in order — the wire, not the trace. */
function turnRequests(agent: ScriptedAgent): {
  text: string;
  outputFormat?: unknown;
  systemPrompt?: string;
  sessionId: string;
}[] {
  return agent.turnRequests;
}

/**
 * The session's wire history: every request the engine made plus the turn
 * boundaries the agent answered with, in order. Whether compaction happened
 * mid-turn is only knowable from this ordering.
 */
function wireLog(agent: ScriptedAgent): string[] {
  return agent.wire;
}

/** `"turn <index>"` per turn the scripted agent has begun. */
function turnMarkers(agent: ScriptedAgent): string[] {
  return agent.turnMarkers;
}

/** Whether the scripted agent has begun a turn, i.e. a turn is in flight. */
function turnStarted(agent: ScriptedAgent): boolean {
  return agent.turnStarted;
}

/** How many sessions the run has opened, resumes included. */
function handshakeCount(agent: ScriptedAgent): number {
  return agent.sessionOpens;
}

/** Waits for a condition the scripted agent reports. */
async function until(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const buildAgent = (over: Partial<AgentDef> = {}): AgentDef => ({
  name: 'builder',
  purpose: 'build things',
  model: 'scripted',
  reasoningEffort: 'medium',
  systemPrompt: 'You build.',
  userPrompt: 'Build: {{request}}',
  writes: null,
  envelope: 'build',
  color: '#5ad2dd',
  ...over,
});

function codePhase(name: string, command: CommandSpec, over: Partial<PhaseDef> = {}): PhaseDef {
  return { name, kind: 'code', description: over.description ?? name, command, ...over };
}

function agentPhase(name: string, over: Partial<PhaseDef> = {}): PhaseDef {
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

function pipe(phases: PhaseDef[], over: Partial<PipelineDef> = {}): PipelineDef {
  return {
    id: 'p',
    name: 'p',
    description: over.description ?? 'test pipeline',
    acceptance: { kind: 'all_phases_pass' },
    phases,
    ...over,
  };
}

const linearSource: LinearRunSource = {
  kind: 'linear',
  trigger: 'manual',
  issueId: 'issue-uuid',
  url: 'https://linear.app/foundry/issue/FOU-190',
  revision: '2026-08-25T19:09:16.054Z',
  statusMapping: { started: 'started', completed: 'completed', failed: 'failed' },
  snapshot: {
    id: 'issue-uuid',
    identifier: 'FOU-190',
    title: 'Add Linear integration',
    description: 'Start this pipeline from Linear.',
    url: 'https://linear.app/foundry/issue/FOU-190',
    updatedAt: '2026-08-25T19:09:16.054Z',
    team: { id: 'team-uuid', name: 'Foundry' },
    state: { id: 'todo', name: 'Todo', type: 'unstarted' },
  },
};

function buildEnvelope(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: 'success',
    summary: 'built it',
    artifacts: [],
    commit_message: 'add a thing',
    notes_for_next_agent: '',
    ...over,
  });
}

function reviewEnvelope(approved: boolean): string {
  return JSON.stringify({
    status: 'success',
    summary: 'reviewed',
    artifacts: [],
    approved,
    findings: approved ? [] : [{ requirement: 'it works', met: false, evidence: 'it does not' }],
    blocking: approved ? [] : ['it does not work'],
    notes_for_next_agent: '',
  });
}

function prEnvelope(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: 'success',
    summary: 'drafted the pull request',
    artifacts: [],
    notes_for_next_agent: '',
    title: 'Add the thing',
    body: '## Summary\n\nIt works.\n',
    ...over,
  });
}

/** Point the scratch checkout at a local bare origin so push works offline. */
function addOrigin(repo: string): string {
  const dir = tempDir('foundry-exec-origin-');
  const bare = join(dir, 'origin.git');
  sh(dir, ['git', 'init', '-q', '--bare', '-b', 'main', 'origin.git']);
  sh(repo, ['git', 'remote', 'add', 'origin', bare]);
  sh(repo, ['git', 'push', '-qu', 'origin', 'main']);
  return bare;
}

function prWriter(): AgentDef {
  return buildAgent({
    name: 'pr_writer',
    purpose: 'draft a pr',
    envelope: 'pr',
    writes: [],
    userPrompt: 'Draft a PR for {{request}} on {{branch}} against {{base_ref}}.',
  });
}

function issueWriter(): AgentDef {
  return buildAgent({
    name: 'issue_writer',
    purpose: 'draft an issue',
    envelope: 'issue',
    writes: [],
    userPrompt: 'Draft an issue for {{request}}.',
  });
}

function issueEnvelope(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: 'success',
    summary: 'drafted the issue',
    artifacts: [],
    notes_for_next_agent: '',
    title: 'Fix the thing',
    body: '## Problem\n\nIt is broken.\n',
    labels: [],
    ...over,
  });
}

function fileIssuePhase(over: Partial<PhaseDef> = {}): PhaseDef {
  return agentPhase('file_issue', {
    agent: 'issue_writer',
    envelope: 'issue',
    description: 'File the GitHub issue that tracks the diagnosed problem.',
    prompt: { inputs: ['request'] },
    ...over,
  });
}

function openPrPhase(over: Partial<PhaseDef> = {}): PhaseDef {
  return agentPhase('open_pr', {
    agent: 'pr_writer',
    envelope: 'pr',
    description: 'Open a pull request with a human-readable title and body.',
    prompt: { inputs: ['request', 'envelope:plan', 'envelope:build'] },
    ...over,
  });
}

interface Harness {
  repo: string;
  project: ProjectDef;
  tracer: Tracer;
  support: string;
  db: Db;
}

let h: Harness;

beforeEach(() => {
  const repo = scratchRepo();
  const support = tempDir('foundry-support-');
  const db = openDb(projectDbPath(support, repo));
  h = {
    repo,
    support,
    db,
    tracer: new Tracer(db, projectRunsDir(support, repo)),
    project: { ...defaultProject(repo), mergePolicy: 'never' },
  };
});

interface ProcessRow {
  kind: string;
  name: string;
  pid: number;
  command: string;
  ended_at: string | null;
}

/** Every recorded child, open or closed — `openProcesses` only shows the open ones. */
function processRows(runId: string): ProcessRow[] {
  return h.db
    .prepare('SELECT kind, name, pid, command, ended_at FROM processes WHERE run_id = ?')
    .all(runId) as ProcessRow[];
}

type AskHuman = ConstructorParameters<typeof Executor>[0]['askHuman'];

interface RunInput {
  pipeline: PipelineDef;
  agents?: AgentDef[];
  envelopeDefs?: EnvelopeDef[];
  scripted?: ScriptedAgent;
  /** Reason the session could not be opened, when the run must fail to open one. */
  sessionUnavailable?: string;
  request?: string;
  project?: Partial<ProjectDef>;
  /** The install default an `inherit` roster model resolves against. */
  defaultModel?: string;
  askHuman?: AskHuman;
  envelopeRetries?: number;
  gateRetries?: number;
  compactionThreshold?: number;
  rewindAfterCorrections?: number;
  /** Omitted means no healing, which is what a run with no model configured gets. */
  healing?: ExecutorDeps['healing'];
  gh?: GhOptions;
  landing?: ExecutorDeps['landing'];
  source?: ExecutorDeps['source'];
  sourceLifecycle?: RunSourceLifecycle;
}

function run(input: RunInput): Promise<{ status: string; runId: string }> {
  const started = start(input);
  return started.done;
}

/**
 * The executor's transport seam. One scripted agent per run, so the transports
 * two agents drive share a turn history the way two sessions on one runtime do.
 */
function transportSeam(input: RunInput): ExecutorDeps['transport'] {
  const agent =
    input.scripted ??
    new ScriptedAgent(
      [],
      [],
      [],
      input.sessionUnavailable ? { unavailable: input.sessionUnavailable } : {},
    );
  return (req) => agent.transport(req);
}

/**
 * The run as a live handle rather than a promise, so a test can act on it
 * while it is still in flight — the kill path has no other way in.
 */
function start(input: RunInput): {
  executor: Executor;
  runId: string;
  done: Promise<{ status: string; runId: string }>;
} {
  const runId = `run_${Math.random().toString(36).slice(2, 8)}`;
  // No child is spawned: the scripted agent answers behind the transport seam.
  const executor = new Executor({
    tracer: h.tracer,
    defaultModel: input.defaultModel,
    envelopeRetries: input.envelopeRetries ?? 2,
    gateRetries: input.gateRetries ?? 2,
    compactionThreshold: input.compactionThreshold ?? 0.8,
    rewindAfterCorrections: input.rewindAfterCorrections ?? 2,
    healing: input.healing ?? null,
    supportDir: h.support,
    transport: transportSeam(input),
    agents: input.agents ?? [buildAgent()],
    envelopeDefs: input.envelopeDefs ?? [],
    project: { ...h.project, ...input.project },
    pipeline: input.pipeline,
    request: input.request ?? 'do the thing',
    source: input.source,
    sourceLifecycle: input.sourceLifecycle,
    runId,
    engineer: 'test',
    askHuman: input.askHuman ?? (async () => ({ approve: true })),
    gh: input.gh,
    landing: input.landing,
  });
  return { executor, runId, done: executor.run().then((o) => ({ status: o.status, runId })) };
}

function events(runId: string) {
  return h.tracer.eventsAfter(runId, 0, 1000);
}

describe('code phases', () => {
  it('accepts a run whose phases all pass', async () => {
    const outcome = await run({
      pipeline: pipe(
        [
          codePhase(
            'one',
            { argv: ['sh', '-c', 'echo hi > a.txt'] },
            {
              description: 'Write a file the second phase can see.',
            },
          ),
          codePhase(
            'two',
            { argv: ['test', '-f', 'a.txt'] },
            {
              description: 'Confirm the file the first phase wrote is there.',
            },
          ),
        ],
        { description: 'two passing commands' },
      ),
    });
    expect(outcome.status).toBe('accepted');
    expect(h.tracer.phases(outcome.runId).map((p) => p.status)).toEqual(['success', 'success']);
  });

  it('maps accepted and rejected executor outcomes onto the source lifecycle', async () => {
    const acceptedStages: string[] = [];
    const accepted = await run({
      pipeline: pipe([codePhase('pass', { argv: ['true'] })]),
      source: linearSource,
      sourceLifecycle: {
        advance: async (stage) => {
          acceptedStages.push(stage);
        },
      },
    });
    expect(accepted.status).toBe('accepted');
    expect(acceptedStages).toEqual(['started', 'completed']);

    const rejectedStages: string[] = [];
    const rejected = await run({
      pipeline: pipe([codePhase('reject', { argv: ['false'] })]),
      source: linearSource,
      sourceLifecycle: {
        advance: async (stage) => {
          rejectedStages.push(stage);
        },
      },
    });
    expect(rejected.status).toBe('rejected');
    expect(rejectedStages).toEqual(['started', 'failed']);
  });

  it('rejects a run when a command fails, and keeps the output as evidence', async () => {
    const outcome = await run({
      pipeline: pipe(
        [
          codePhase(
            'boom',
            { argv: ['sh', '-c', 'echo detail >&2; exit 4'] },
            {
              description: 'Fail on purpose to prove failure is recorded.',
            },
          ),
        ],
        { description: 'one failing command' },
      ),
    });
    expect(outcome.status).toBe('rejected');
    const phase = h.tracer.phases(outcome.runId)[0]!;
    expect(phase.status).toBe('fail');
    expect(phase.error).toContain('exit 4');
  });

  it('lets an optional phase fail without failing the run', async () => {
    const outcome = await run({
      pipeline: pipe(
        [
          codePhase(
            'lint',
            { argv: ['sh', '-c', 'exit 1'] },
            {
              optional: true,
              description: 'Report style problems without blocking the run.',
            },
          ),
        ],
        { description: 'an optional failure' },
      ),
    });
    expect(outcome.status).toBe('accepted');
    expect(h.tracer.phases(outcome.runId)[0]!.status).toBe('skipped');
  });

  it('fails a phase whose project command is not configured, naming the fix', async () => {
    const outcome = await run({
      pipeline: pipe(
        [
          codePhase(
            'test',
            { ref: 'test' },
            {
              description: 'Run the project test command that was never set.',
            },
          ),
        ],
        { description: 'refers to a missing project command' },
      ),
    });
    expect(outcome.status).toBe('rejected');
    expect(h.tracer.phases(outcome.runId)[0]!.error).toContain('is not configured');
  });

  /**
   * A project Foundry created empty has no test command because it has no code
   * yet. Failing there would make a brand-new repo unable to run the pipeline
   * meant to fill it, so the phase skips and says why.
   */
  it('skips an unconfigured project command for a project created empty', async () => {
    const outcome = await run({
      project: { scaffold: true },
      pipeline: pipe(
        [
          codePhase(
            'write',
            { argv: ['sh', '-c', 'echo hi > a.txt'] },
            { description: 'Stand in for the work a build phase would do.' },
          ),
          codePhase(
            'test',
            { ref: 'test' },
            { description: 'Run the project test command this new repo does not have yet.' },
          ),
        ],
        {
          description: 'a new project with no test command',
          acceptance: { kind: 'phase_flag', phase: 'test', flag: 'passed' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    const phases = h.tracer.phases(outcome.runId);
    expect(phases.map((p) => p.status)).toEqual(['success', 'skipped']);
    expect(phases[1]!.error).toContain('no "test" command');
  });

  /**
   * The skip is scoped to the gap it exists for: once the project has the
   * command, the phase runs for real and a failure still fails the run.
   */
  it('still runs the command for a scaffold project that has one', async () => {
    const outcome = await run({
      project: { scaffold: true, commands: [{ name: 'test', argv: ['sh', '-c', 'exit 3'] }] },
      pipeline: pipe(
        [
          codePhase(
            'test',
            { ref: 'test' },
            { description: 'Run the project test command, which now exists.' },
          ),
        ],
        { description: 'a scaffold project that grew a test command' },
      ),
    });

    expect(outcome.status).toBe('rejected');
    expect(h.tracer.phases(outcome.runId)[0]!.error).toContain('exit 3');
  });

  it('runs the worktree sniff when the frozen project command is stale', async () => {
    writeFileSync(
      join(h.repo, 'package.json'),
      JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"' } }),
    );
    sh(h.repo, ['git', 'add', '-A']);
    sh(h.repo, ['git', 'commit', '-qm', 'add package.json']);
    const outcome = await run({
      project: { commands: [{ name: 'test', argv: ['swift', 'test'] }] },
      pipeline: pipe(
        [
          codePhase(
            'test',
            { ref: 'test' },
            { description: 'Run the command the worktree now actually has.' },
          ),
        ],
        { description: 'stale swift test against a node repo' },
      ),
    });
    expect(outcome.status).toBe('accepted');
    const drift = events(outcome.runId).find((e) => e.name === 'command_drift');
    expect(drift).toBeDefined();
    expect(drift!.payload.from).toEqual(['swift', 'test']);
    expect(drift!.payload.to).toEqual(['npm', 'test']);
    expect(existsSync(join(h.tracer.runDir(outcome.runId), 'command-drift.json'))).toBe(true);
  });

  it('runs inside a worktree on its own branch by default', async () => {
    const outcome = await run({
      pipeline: pipe(
        [
          codePhase(
            'write',
            { argv: ['sh', '-c', 'echo isolated > only-in-worktree.txt'] },
            {
              description: 'Write a file so the test can see which tree it landed in.',
            },
          ),
        ],
        { description: 'writes a file to prove where it ran' },
      ),
    });
    const run1 = h.tracer.run(outcome.runId)!;
    expect(run1.branch).toBe(`foundry/${outcome.runId}`);
    // Isolation: the base checkout is untouched.
    expect(existsSync(join(h.repo, 'only-in-worktree.txt'))).toBe(false);
    expect(existsSync(join(run1.worktreePath!, 'only-in-worktree.txt'))).toBe(true);
  });

  it('honours a pipeline that opts out of isolation', async () => {
    const outcome = await run({
      pipeline: pipe(
        [
          codePhase(
            'write',
            { argv: ['sh', '-c', 'echo direct > in-repo.txt'] },
            {
              description: 'Write directly into the checkout to prove isolation is off.',
            },
          ),
        ],
        {
          description: 'docs-only chain that does not need a branch',
          isolation: false,
        },
      ),
    });
    expect(h.tracer.run(outcome.runId)!.worktreePath).toBeNull();
    expect(existsSync(join(h.repo, 'in-repo.txt'))).toBe(true);
  });
});

describe('agent phases', () => {
  it('injects cached repository facts and the exact successful setup result into the system role', async () => {
    const scripted = scriptedAgent([buildEnvelope()]);
    const outcome = await run({
      scripted,
      project: {
        setupScript: 'printf setup-complete',
        contextSummary: '## Stack\nTypeScript',
      },
      pipeline: pipe([agentPhase('build')], {
        acceptance: { kind: 'envelope_status', phase: 'build' },
      }),
    });

    expect(outcome.status).toBe('accepted');
    const system = turnRequests(scripted)[0]!.systemPrompt;
    expect(system).toContain('You build.');
    expect(system).toContain('## Stack\nTypeScript');
    expect(system).toContain(
      `isolated run worktree at ${h.tracer.run(outcome.runId)!.worktreePath}`,
    );
    expect(system).toContain('Setup ran printf setup-complete — exit 0.');
  });

  it('parses an envelope, runs gates, and records both', async () => {
    const scripted = scriptedAgent([buildEnvelope({ artifacts: ['made.txt'] })], ['made.txt']);
    const outcome = await run({
      scripted,
      pipeline: pipe(
        [
          agentPhase('build', {
            description: 'Have the scripted agent make a file and declare it.',
            gates: ['artifacts_exist'],
          }),
        ],
        {
          description: 'one agent phase with an artifacts gate',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });
    expect(outcome.status).toBe('accepted');
    const envelopes = h.tracer.envelopes(outcome.runId);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.valid).toBe(true);
    const gates = h.tracer.gateResults(outcome.runId);
    expect(gates[0]!.gate).toBe('artifacts_exist');
    expect(gates[0]!.passed).toBe(true);
  });

  it('applies a deletion made during an agent turn', async () => {
    const scripted = scriptedAgent([buildEnvelope()], [], [], {
      deleteEffects: ['README.md'],
    });
    const outcome = await run({
      scripted,
      pipeline: pipe(
        [
          agentPhase('build', {
            description: 'Delete a tracked file.',
          }),
        ],
        {
          description: 'deletion during agent turn',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });
    expect(outcome.status).toBe('accepted');
    const worktree = h.tracer.run(outcome.runId)!.worktreePath!;
    expect(existsSync(join(worktree, 'README.md'))).toBe(false);
  });

  it('corrects a malformed reply in the same session and then succeeds', async () => {
    const scripted = scriptedAgent(['I will explain in prose instead of JSON.', buildEnvelope()]);
    const outcome = await run({
      scripted,
      pipeline: pipe(
        [
          agentPhase('build', {
            description: 'Prove a parse failure costs one message, not a restart.',
          }),
        ],
        {
          description: 'first reply is prose, second is an envelope',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });
    expect(outcome.status).toBe('accepted');
    const correction = events(outcome.runId).find((e) => e.type === 'correction');
    expect(correction?.name).toBe('envelope did not parse');
    // Both attempts are recorded: the invalid one is evidence, not noise.
    expect(h.tracer.envelopes(outcome.runId).map((e) => e.valid)).toEqual([false, true]);
  });

  it('fails the phase when no attempt ever produces a valid envelope', async () => {
    const scripted = scriptedAgent(['never json']);
    const outcome = await run({
      scripted,
      pipeline: pipe(
        [agentPhase('build', { description: 'Prove success is earned, never assumed.' })],
        {
          description: 'the agent never produces an envelope',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });
    expect(outcome.status).toBe('rejected');
    expect(h.tracer.phases(outcome.runId)[0]!.status).toBe('fail');
  });

  it('resolves a custom envelope library def into the prompt and the parse', async () => {
    const customEnvelope = JSON.stringify({
      status: 'success',
      summary: 'scouted',
      artifacts: [],
      notes_for_next_agent: '',
      severity: 'high',
    });
    const scripted = scriptedAgent([customEnvelope]);
    const defs: EnvelopeDef[] = [
      {
        name: 'severity_report',
        fields: [{ name: 'severity', type: 'string', required: true, description: 'low|med|high' }],
      },
    ];
    const outcome = await run({
      scripted,
      envelopeDefs: defs,
      agents: [buildAgent({ envelope: 'severity_report' })],
      pipeline: pipe(
        [
          agentPhase('report', {
            description: 'Return a severity-tagged report using a custom envelope.',
            envelope: 'severity_report',
          }),
        ],
        {
          description: 'custom envelope library end-to-end',
          acceptance: { kind: 'envelope_status', phase: 'report' },
        },
      ),
    });
    expect(outcome.status).toBe('accepted');
    const envelopes = h.tracer.envelopes(outcome.runId);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.valid).toBe(true);
    expect(envelopes[0]!.schemaKind).toBe('severity_report');
    expect(envelopes[0]!.payload).toMatchObject({ severity: 'high' });

    const prompt = readFileSync(
      join(h.tracer.runDir(outcome.runId), 'builder/prompts/report-1.md'),
      'utf8',
    );
    expect(prompt).toContain('severity');
    expect(prompt).toContain('low|med|high');
  });

  it('fails when the agent itself reports failure', async () => {
    const scripted = scriptedAgent([buildEnvelope({ status: 'fail', summary: 'could not do it' })]);
    const outcome = await run({
      scripted,
      pipeline: pipe(
        [agentPhase('build', { description: 'Prove a self-reported failure is not overridden.' })],
        {
          description: 'the agent reports its own failure',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });
    expect(outcome.status).toBe('rejected');
    expect(h.tracer.phases(outcome.runId)[0]!.error).toContain('could not do it');
  });

  it('reverts a write outside the boundary and fails with the violation', async () => {
    const scripted = scriptedAgent(
      [buildEnvelope(), buildEnvelope(), buildEnvelope()],
      ['forbidden/x.txt', 'forbidden/x.txt', 'forbidden/x.txt'],
    );
    const outcome = await run({
      scripted,
      agents: [buildAgent({ writes: ['allowed/'] })],
      pipeline: pipe(
        [
          agentPhase('build', {
            retries: 1,
            description: 'Prove the boundary is enforced in code, not by asking.',
          }),
        ],
        {
          description: 'the agent writes outside its boundary',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });
    expect(outcome.status).toBe('rejected');
    const worktree = h.tracer.run(outcome.runId)!.worktreePath!;
    expect(existsSync(join(worktree, 'forbidden/x.txt'))).toBe(false);
    const violation = events(outcome.runId).find((e) => e.name === 'write boundary');
    expect(violation).toBeDefined();
    expect(JSON.stringify(violation!.payload)).toContain('forbidden/x.txt');
  });

  it('allows a write that is inside the boundary', async () => {
    const scripted = scriptedAgent([buildEnvelope()], ['allowed/x.txt']);
    const outcome = await run({
      scripted,
      agents: [buildAgent({ writes: ['allowed/'] })],
      pipeline: pipe(
        [
          agentPhase('build', {
            description: 'Prove an in-boundary write survives enforcement.',
          }),
        ],
        {
          description: 'the agent writes inside its boundary',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });
    expect(outcome.status).toBe('accepted');
    const worktree = h.tracer.run(outcome.runId)!.worktreePath!;
    expect(existsSync(join(worktree, 'allowed/x.txt'))).toBe(true);
  });

  it('retries a gate failure as a correction into the same session', async () => {
    // First turn declares a file it never wrote; second turn tells the truth.
    const scripted = scriptedAgent(
      [buildEnvelope({ artifacts: ['ghost.txt'] }), buildEnvelope({ artifacts: ['real.txt'] })],
      [null, 'real.txt'],
    );
    const outcome = await run({
      scripted,
      pipeline: pipe(
        [
          agentPhase('build', {
            retries: 1,
            description: 'Prove a gate failure costs one message inside the live session.',
            gates: ['artifacts_exist'],
          }),
        ],
        {
          description: 'an artifacts gate rejects the first attempt',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });
    expect(outcome.status).toBe('accepted');
    const gates = h.tracer.gateResults(outcome.runId);
    expect(gates.map((g) => g.passed)).toEqual([false, true]);
    const correction = events(outcome.runId).find(
      (e) => e.type === 'correction' && e.name === 'gate violations',
    );
    expect(correction).toBeDefined();
  });
});

describe('the repair loop', () => {
  function installCheck(body: string): void {
    writeFileSync(join(h.repo, 'check.sh'), body);
    chmodSync(join(h.repo, 'check.sh'), 0o755);
    sh(h.repo, ['git', 'add', '-A']);
    sh(h.repo, ['git', 'commit', '-qm', 'add check']);
  }

  const repairPipeline = (feedbackRetries: number): PipelineDef =>
    pipe(
      [
        agentPhase('build', { description: 'Implement the change the request asks for.' }),
        codePhase(
          'test',
          { ref: 'test' },
          {
            description: 'Run the project check and hand any failure back to the builder.',
            feedbackTo: 'build',
            feedbackRetries,
          },
        ),
      ],
      {
        description: 'build, test, repair',
        acceptance: { kind: 'phase_flag', phase: 'test', flag: 'passed' },
      },
    );

  it('sends a test failure back to the builder and accepts once it converges', async () => {
    // Passes only once the builder has written fix.txt.
    installCheck('#!/bin/sh\ntest -f fix.txt\n');
    const envelope = buildEnvelope({ summary: 'attempted', commit_message: 'work' });
    // First build writes nothing; the repair writes fix.txt.
    const scripted = scriptedAgent([envelope, envelope], [null, 'fix.txt']);

    const outcome = await run({
      scripted,
      project: { commands: [{ name: 'test', argv: ['./check.sh'] }] },
      pipeline: repairPipeline(2),
    });

    expect(outcome.status).toBe('accepted');
    const feedback = events(outcome.runId).find(
      (e) => e.type === 'correction' && e.name === 'feedback to build',
    );
    expect(feedback).toBeDefined();
    const worktree = h.tracer.run(outcome.runId)!.worktreePath!;
    expect(existsSync(join(worktree, 'fix.txt'))).toBe(true);
  });

  it('gives up after the feedback budget rather than looping forever', async () => {
    installCheck('#!/bin/sh\nexit 1\n');
    const envelope = buildEnvelope({ summary: 'tried', commit_message: 'x' });
    const scripted = scriptedAgent([envelope]);
    const outcome = await run({
      scripted,
      project: { commands: [{ name: 'test', argv: ['./check.sh'] }] },
      pipeline: pipe(
        [
          agentPhase('build', {
            description: 'Attempt the change that cannot satisfy the check.',
          }),
          codePhase(
            'test',
            { ref: 'test' },
            {
              description: 'Run the check that always fails and stop after the budget.',
              feedbackTo: 'build',
              feedbackRetries: 1,
            },
          ),
        ],
        {
          description: 'a check that can never pass',
          acceptance: { kind: 'phase_flag', phase: 'test', flag: 'passed' },
        },
      ),
    });
    expect(outcome.status).toBe('rejected');
    expect(h.tracer.phases(outcome.runId).find((p) => p.name === 'test')!.error).toContain(
      'repair attempt',
    );
  });
});

/**
 * Healing sits between a red command and the escalation it used to trigger
 * immediately. The command stays frozen, so what these pin down is the engine's
 * half: who is eligible, how many turns they get, that only the re-run's exit
 * code counts, and that exhaustion still lands on the existing bounded feedback
 * path rather than looping.
 */
describe('healing a failed programmatic phase', () => {
  function installCheck(body: string): void {
    writeFileSync(join(h.repo, 'check.sh'), body);
    chmodSync(join(h.repo, 'check.sh'), 0o755);
    sh(h.repo, ['git', 'add', '-A']);
    sh(h.repo, ['git', 'commit', '-qm', 'add check']);
  }

  /** Passes only once `fix.txt` exists, which is what a healer has to write. */
  const fixableCheck = '#!/bin/sh\ntest -f fix.txt\n';

  interface HealingSpy {
    support: ExecutorDeps['healing'];
    /** Every worktree a healing session was opened against, in order. */
    readonly opens: string[];
    /** Every prompt a healing turn was sent, in order. */
    readonly prompts: string[];
  }

  /**
   * A healing stand-in behind the same interface the real one-shot satisfies:
   * each turn runs `work` in the worktree it was opened against, so the
   * re-run has something real to judge.
   */
  function healingSpy(
    turns: ((cwd: string) => void)[],
    over: Partial<NonNullable<ExecutorDeps['healing']>> = {},
  ): HealingSpy {
    const opens: string[] = [];
    const prompts: string[] = [];
    let index = 0;
    return {
      opens,
      prompts,
      support: {
        attempts: turns.length || 1,
        model: 'provider/healer',
        reasoningEffort: 'medium',
        ...over,
        open: (cwd) => {
          opens.push(cwd);
          return {
            send: async (text) => {
              prompts.push(text);
              turns[index++]?.(cwd);
              return { text: 'made the smallest fix' };
            },
            abort: () => undefined,
          };
        },
      },
    };
  }

  const project = { commands: [{ name: 'test', argv: ['./check.sh'] }] };

  const healPipeline = (over: Partial<PhaseDef> = {}): PipelineDef =>
    pipe(
      [
        codePhase(
          'test',
          { ref: 'test' },
          { description: 'Run the project check and let a healer repair it.', ...over },
        ),
      ],
      {
        description: 'a check a healer may repair',
        acceptance: { kind: 'phase_flag', phase: 'test', flag: 'passed' },
      },
    );

  it('repairs the failure and accepts once the exact command passes', async () => {
    installCheck(fixableCheck);
    const spy = healingSpy([(cwd) => writeFileSync(join(cwd, 'fix.txt'), 'healed\n')]);

    const outcome = await run({ project, healing: spy.support, pipeline: healPipeline() });

    expect(outcome.status).toBe('accepted');
    expect(h.tracer.phases(outcome.runId)[0]!.status).toBe('success');
    // The healer worked in the run's own worktree, never the checkout.
    const worktree = h.tracer.run(outcome.runId)!.worktreePath!;
    expect(spy.opens).toEqual([worktree]);
    expect(existsSync(join(worktree, 'fix.txt'))).toBe(true);
    expect(existsSync(join(h.repo, 'fix.txt'))).toBe(false);
  });

  it('re-runs the exact same argv rather than anything the healer chose', async () => {
    installCheck(fixableCheck);
    const spy = healingSpy([(cwd) => writeFileSync(join(cwd, 'fix.txt'), 'healed\n')]);

    const outcome = await run({ project, healing: spy.support, pipeline: healPipeline() });

    const calls = events(outcome.runId).filter(
      (e) => e.type === 'tool_call' && e.name.startsWith('test:'),
    );
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((e) => JSON.stringify(e.payload.argv)))).toEqual(
      new Set([JSON.stringify(['./check.sh'])]),
    );
    expect(calls.map((e) => e.payload.passed)).toEqual([false, true]);
  });

  it('records the healing model, the attempt count, and the command log', async () => {
    installCheck(fixableCheck);
    const spy = healingSpy([(cwd) => writeFileSync(join(cwd, 'fix.txt'), 'healed\n')]);

    const outcome = await run({ project, healing: spy.support, pipeline: healPipeline() });

    const started = events(outcome.runId).find((e) => e.name === 'healing test');
    expect(started?.payload).toMatchObject({ model: 'provider/healer', attempts: 1 });
    const attempt = events(outcome.runId).find(
      (e) => e.type === 'correction' && e.name === 'healing attempt 1 on test',
    );
    expect(attempt?.payload).toMatchObject({ model: 'provider/healer', passed: true });
    expect(String(attempt?.payload.summary)).toContain('smallest fix');
    const settled = events(outcome.runId).find((e) => e.name === 'healing test succeeded');
    expect(settled?.payload).toMatchObject({ escalation: 'none' });
    expect(existsSync(join(h.tracer.runDir(outcome.runId), 'commands', 'test.heal-1.log'))).toBe(
      true,
    );
  });

  it('hands the healer the frozen command, the failure, and the run request', async () => {
    installCheck(fixableCheck);
    const spy = healingSpy([(cwd) => writeFileSync(join(cwd, 'fix.txt'), 'healed\n')]);

    await run({
      project: { ...project, protectedPaths: ['vendor/'] },
      healing: spy.support,
      request: 'teach the widget to fly',
      pipeline: healPipeline(),
    });

    expect(spy.prompts).toHaveLength(1);
    expect(spy.prompts[0]).toContain('./check.sh');
    expect(spy.prompts[0]).toContain('exited 1');
    expect(spy.prompts[0]).toContain('teach the widget to fly');
    expect(spy.prompts[0]).toContain('vendor/');
  });

  it('escalates through feedbackTo once its attempts are spent', async () => {
    installCheck('#!/bin/sh\ntest -f fix.txt\n');
    const envelope = buildEnvelope({ summary: 'attempted', commit_message: 'work' });
    // The healer cannot fix it; the builder can, on the feedback re-entry.
    const scripted = scriptedAgent([envelope, envelope], [null, 'fix.txt']);
    const spy = healingSpy([() => undefined, () => undefined]);

    const outcome = await run({
      scripted,
      project,
      healing: spy.support,
      pipeline: pipe(
        [
          agentPhase('build', { description: 'Implement the change the request asks for.' }),
          codePhase(
            'test',
            { ref: 'test' },
            {
              description: 'Run the project check, heal it, then hand it back to the builder.',
              feedbackTo: 'build',
              feedbackRetries: 2,
            },
          ),
        ],
        {
          description: 'healing that gives up, then feedback that converges',
          acceptance: { kind: 'phase_flag', phase: 'test', flag: 'passed' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    // Both healing turns were spent before the failure escalated, and the
    // phase's re-entry did not hand it a fresh budget: healing is bounded per
    // run, so a struggling run does not earn more model time than a calm one.
    expect(spy.prompts).toHaveLength(2);
    const gaveUp = events(outcome.runId).find((e) => e.name === 'healing test gave up');
    expect(gaveUp?.payload).toMatchObject({ attempts: 2, budget: 2, escalation: 'build' });
    expect(
      events(outcome.runId).find((e) => e.type === 'correction' && e.name === 'feedback to build'),
    ).toBeDefined();
  });

  it('does not open a second healing session when the phase is re-entered', async () => {
    installCheck('#!/bin/sh\ntest -f fix.txt\n');
    const envelope = buildEnvelope({ summary: 'attempted', commit_message: 'work' });
    const scripted = scriptedAgent([envelope, envelope], [null, 'fix.txt']);
    // One turn of budget, spent on the first visit and unavailable on the second.
    const spy = healingSpy([() => undefined]);

    const outcome = await run({
      scripted,
      project,
      healing: spy.support,
      pipeline: pipe(
        [
          agentPhase('build', { description: 'Implement the change the request asks for.' }),
          codePhase(
            'test',
            { ref: 'test' },
            {
              description: 'Run the project check, heal it once, then hand it back.',
              feedbackTo: 'build',
              feedbackRetries: 2,
            },
          ),
        ],
        {
          description: 'a healing budget that does not renew on re-entry',
          acceptance: { kind: 'phase_flag', phase: 'test', flag: 'passed' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    expect(spy.opens).toHaveLength(1);
    expect(events(outcome.runId).filter((e) => e.name === 'healing test')).toHaveLength(1);
  });

  it('interrupts the healing turn in flight rather than waiting out its timeout', async () => {
    installCheck('#!/bin/sh\nexit 1\n');
    const cancel = { fire: (): void => undefined };
    let aborted = false;
    /**
     * A turn that answers only once something aborts it — which is what a real
     * provider call is: `cancelled()` is polled between awaits, and a turn
     * already in flight has no next await point for up to its 15 minute
     * timeout. If cancel cannot reach the agent, this test hangs.
     */
    const support: ExecutorDeps['healing'] = {
      attempts: 1,
      model: 'provider/healer',
      reasoningEffort: 'medium',
      open: () => {
        let release = (): void => undefined;
        const interrupted = new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          send: async () => {
            cancel.fire();
            await interrupted;
            return { text: 'interrupted mid-turn' };
          },
          abort: () => {
            aborted = true;
            release();
          },
        };
      },
    };

    const started = start({ project, healing: support, pipeline: healPipeline() });
    cancel.fire = () => started.executor.cancel();
    const outcome = await started.done;

    expect(aborted).toBe(true);
    expect(outcome.status).toBe('killed');
  });

  it('fails the run normally when healing is exhausted and no owner is configured', async () => {
    installCheck('#!/bin/sh\nexit 1\n');
    const spy = healingSpy([() => undefined, () => undefined]);

    const outcome = await run({ project, healing: spy.support, pipeline: healPipeline() });

    expect(outcome.status).toBe('rejected');
    expect(h.tracer.phases(outcome.runId)[0]!.error).toBe('exit 1');
    const gaveUp = events(outcome.runId).find((e) => e.name === 'healing test gave up');
    expect(gaveUp?.payload.escalation).toBe('no feedback owner: the run fails');
  });

  it('reverts a healing write to a protected path and still fails the run', async () => {
    installCheck('#!/bin/sh\nexit 1\n');
    const spy = healingSpy([
      (cwd) => {
        mkdirSync(join(cwd, 'vendor'), { recursive: true });
        writeFileSync(join(cwd, 'vendor', 'lib.txt'), 'rewritten\n');
      },
    ]);

    const outcome = await run({
      project: { ...project, protectedPaths: ['vendor/'] },
      healing: spy.support,
      pipeline: healPipeline(),
    });

    expect(outcome.status).toBe('rejected');
    const worktree = h.tracer.run(outcome.runId)!.worktreePath!;
    expect(existsSync(join(worktree, 'vendor', 'lib.txt'))).toBe(false);
    const attempt = events(outcome.runId).find(
      (e) => e.type === 'correction' && e.name === 'healing attempt 1 on test',
    );
    expect(attempt?.payload.violations).toEqual(['vendor/lib.txt (protected path)']);
  });

  it('does not heal an optional failure — it never fails the run to begin with', async () => {
    installCheck('#!/bin/sh\nexit 1\n');
    const spy = healingSpy([() => undefined]);

    const outcome = await run({
      project,
      healing: spy.support,
      pipeline: pipe([codePhase('test', { ref: 'test' }, { optional: true })], {
        description: 'an optional check nothing needs to repair',
      }),
    });

    expect(outcome.status).toBe('accepted');
    expect(spy.opens).toEqual([]);
  });

  it('heals a literal argv too: what a command is does not predict a repairable failure', async () => {
    const spy = healingSpy([(cwd) => writeFileSync(join(cwd, 'fix.txt'), 'healed\n')]);
    const outcome = await run({
      healing: spy.support,
      pipeline: pipe([codePhase('check', { argv: ['test', '-f', 'fix.txt'] })], {
        description: 'a literal command whose failure a healer can repair',
      }),
    });

    expect(outcome.status).toBe('accepted');
    expect(spy.opens).toHaveLength(1);
  });

  it('skips healing on a project command the phase opted out of', async () => {
    installCheck('#!/bin/sh\nexit 1\n');
    const spy = healingSpy([() => undefined]);

    const outcome = await run({
      project,
      healing: spy.support,
      pipeline: healPipeline({ heal: false }),
    });

    expect(outcome.status).toBe('rejected');
    expect(spy.opens).toEqual([]);
  });

  it('does not heal a missing project command — that is configuration, not a fault', async () => {
    const spy = healingSpy([() => undefined]);
    const outcome = await run({
      project: { commands: [] },
      healing: spy.support,
      pipeline: healPipeline(),
    });

    expect(outcome.status).toBe('rejected');
    expect(spy.opens).toEqual([]);
    expect(h.tracer.phases(outcome.runId)[0]!.error).toContain('is not configured');
  });

  it('does not heal a scaffold skip — there is no command to repair yet', async () => {
    const spy = healingSpy([() => undefined]);
    const outcome = await run({
      project: { commands: [], scaffold: true },
      healing: spy.support,
      pipeline: healPipeline(),
    });

    expect(h.tracer.phases(outcome.runId)[0]!.status).toBe('skipped');
    expect(spy.opens).toEqual([]);
  });

  it('leaves the pre-healing behaviour intact when no healing model is configured', async () => {
    installCheck('#!/bin/sh\nexit 1\n');
    const outcome = await run({ project, pipeline: healPipeline() });

    expect(outcome.status).toBe('rejected');
    expect(events(outcome.runId).some((e) => e.name.startsWith('healing'))).toBe(false);
  });

  it('stops healing when the run is cancelled mid-turn', async () => {
    installCheck('#!/bin/sh\nexit 1\n');
    const opens: string[] = [];
    let cancel: (() => void) | null = null;
    const support: ExecutorDeps['healing'] = {
      attempts: 3,
      model: 'provider/healer',
      reasoningEffort: 'medium',
      open: (cwd) => {
        opens.push(cwd);
        return {
          send: async () => {
            cancel?.();
            return { text: 'stopped' };
          },
          abort: () => undefined,
        };
      },
    };

    const started = start({ project, healing: support, pipeline: healPipeline() });
    cancel = () => started.executor.cancel();
    const outcome = await started.done;

    expect(outcome.status).toBe('killed');
    // One turn was opened; the cancel landed before a second could start.
    expect(opens).toHaveLength(1);
    // The command was not re-run after the cancel: only the original failure.
    expect(
      events(outcome.runId).filter((e) => e.type === 'tool_call' && e.name.startsWith('test:')),
    ).toHaveLength(1);
  });
});

/**
 * A `feedbackTo` jump re-enters a phase whose live session already holds that
 * phase's rendered prompt, so the re-entry may be a short delta. It may be a
 * delta only while that is still true: after a rewind, a compaction, or a
 * session replacement the prompt has to be rendered again in full. A wrong
 * delta is a correctness bug; a needless full prompt only costs tokens.
 */
describe('feedback re-entry into an already-prompted phase', () => {
  function installCheck(body: string): void {
    writeFileSync(join(h.repo, 'check.sh'), body);
    chmodSync(join(h.repo, 'check.sh'), 0o755);
    sh(h.repo, ['git', 'add', '-A']);
    sh(h.repo, ['git', 'commit', '-qm', 'add check']);
  }

  /** Fails until the builder writes fix.txt, then hands the failure to `build`. */
  function repairPipeline(phases: PhaseDef[] = []): PipelineDef {
    return pipe(
      [
        agentPhase('build', { description: 'Implement the change the request asks for.' }),
        ...phases,
        codePhase(
          'test',
          { ref: 'test' },
          {
            description: 'Run the project check and hand any failure back to the builder.',
            feedbackTo: 'build',
            feedbackRetries: 2,
          },
        ),
      ],
      {
        description: 'build, test, repair',
        acceptance: { kind: 'phase_flag', phase: 'test', flag: 'passed' },
      },
    );
  }

  const project = { commands: [{ name: 'test', argv: ['./check.sh'] }] };

  /** Every prompt sent to the `build` agent, in order. */
  function buildPrompts(agent: ScriptedAgent): string[] {
    return turnRequests(agent).map((t) => t.text);
  }

  it('sends only the feedback evidence, not the whole prompt again', async () => {
    installCheck('#!/bin/sh\ntest -f fix.txt\n');
    const envelope = buildEnvelope({ summary: 'attempted', commit_message: 'work' });
    const scripted = scriptedAgent([envelope, envelope], [null, 'fix.txt']);

    const outcome = await run({ scripted, project, pipeline: repairPipeline() });
    expect(outcome.status).toBe('accepted');

    const prompts = buildPrompts(scripted);
    expect(prompts).toHaveLength(2);
    // The first entry is the whole phase prompt.
    expect(prompts[0]).toContain('do the thing');
    expect(prompts[0]).toContain(exampleFor('build'));
    // The re-entry is the evidence plus a continue instruction, and nothing the
    // session is already holding: no request, no envelope example.
    expect(prompts[1]).toContain('A check failed after your last attempt');
    expect(prompts[1]).toContain('./check.sh');
    expect(prompts[1]).not.toContain('do the thing');
    expect(prompts[1]).not.toContain(exampleFor('build'));
    expect(prompts[1]!.length).toBeLessThan(prompts[0]!.length);

    // Same live conversation: a delta is only correct because of that.
    const turns = wireLog(scripted).filter((l) => l.startsWith('turn_started'));
    for (const turn of turns) expect(turn).toContain('session=s1');
    expect(handshakeCount(scripted)).toBe(1);

    // The trace still records what was sent, under its own name rather than
    // overwriting the first entry's record.
    const dir = h.tracer.runDir(outcome.runId);
    expect(readFileSync(join(dir, 'builder/prompts/build-1.md'), 'utf8')).toContain('do the thing');
    const second = readFileSync(join(dir, 'builder/prompts/build-2.md'), 'utf8');
    expect(second).toContain('A check failed after your last attempt');
    expect(second).not.toContain(exampleFor('build'));
    expect(
      events(outcome.runId)
        .filter((e) => e.type === 'log' && e.name === 'prompt')
        .map((e) => e.payload.kind),
    ).toEqual(['full', 'delta']);
  });

  it('renders the whole prompt again when a rewind dropped the anchor', async () => {
    installCheck('#!/bin/sh\ntest -f fix.txt\n');
    const envelope = buildEnvelope({ summary: 'attempted', commit_message: 'work' });
    // The first reply cannot be parsed, so the first correction rewinds — which
    // branches the conversation before the phase prompt itself.
    const scripted = scriptedAgent(
      ['prose, not JSON', envelope, envelope],
      [null, null, 'fix.txt'],
    );

    const outcome = await run({
      scripted,
      project,
      rewindAfterCorrections: 1,
      pipeline: repairPipeline(),
    });
    expect(outcome.status).toBe('accepted');
    expect(wireLog(scripted)).toContain('rewind');

    const prompts = buildPrompts(scripted);
    expect(prompts).toHaveLength(3);
    // Turn 2 is the feedback re-entry, and the rewound session no longer holds
    // the prompt: it arrives in full, feedback appended.
    expect(prompts[2]).toContain('do the thing');
    expect(prompts[2]).toContain(exampleFor('build'));
    expect(prompts[2]).toContain('./check.sh');
    expect(
      events(outcome.runId)
        .filter((e) => e.type === 'log' && e.name === 'prompt')
        .map((e) => e.payload.kind),
    ).toEqual(['full', 'full']);
  });

  it('renders the whole prompt again when the session was compacted in between', async () => {
    installCheck('#!/bin/sh\ntest -f fix.txt\n');
    const envelope = buildEnvelope({ summary: 'attempted', commit_message: 'work' });
    const scripted = scriptedAgent([envelope, envelope], [null, 'fix.txt'], [], {
      contextUsed: 85_000,
      contextUsedAfterCompaction: 8_500,
    });

    const outcome = await run({ scripted, project, pipeline: repairPipeline() });
    expect(outcome.status).toBe('accepted');
    expect(wireLog(scripted).filter((l) => l === 'compact')).toHaveLength(1);

    const prompts = buildPrompts(scripted);
    expect(prompts).toHaveLength(2);
    // A summarised conversation may no longer carry the prompt verbatim, so the
    // re-entry cannot assume it is there.
    expect(prompts[1]).toContain('do the thing');
    expect(prompts[1]).toContain(exampleFor('build'));
    expect(prompts[1]).toContain('./check.sh');
  });

  it('renders the whole prompt again when the agent session was replaced', async () => {
    installCheck('#!/bin/sh\ntest -f fix.txt\n');
    const envelope = buildEnvelope({ summary: 'attempted', commit_message: 'work' });
    // The middle phase runs the same agent on another model, which closes the
    // session and opens a successor that holds none of `build`'s prompt.
    const scripted = scriptedAgent(
      [envelope, envelope, envelope, envelope],
      [null, null, 'fix.txt'],
    );

    const outcome = await run({
      scripted,
      project,
      pipeline: repairPipeline([
        agentPhase('probe', {
          model: 'scripted-other',
          description: 'Run the same agent on another model, which replaces its session.',
        }),
      ]),
    });
    expect(outcome.status).toBe('accepted');

    const requests = turnRequests(scripted);
    expect(requests).toHaveLength(4);
    // build(s1) → probe(s2) → build(s3): each model change is a new session.
    expect(requests.map((r) => r.sessionId)).toEqual(['s1', 's2', 's3', 's4']);
    expect(requests[2]!.text).toContain('do the thing');
    expect(requests[2]!.text).toContain(exampleFor('build'));
    expect(requests[2]!.text).toContain('./check.sh');
  });

  /**
   * `{{feedback}}` is a documented template token and `renderTemplate`
   * substitutes it in the system template as well as the user one, so an agent
   * whose roster role names it has always received the real evidence there.
   * The delta trims the *user* message; the standing role is re-sent in full on
   * every turn and must still carry the evidence, or a roster that reads its
   * feedback from the system role silently starts seeing "(no feedback)".
   */
  const feedbackInRole = (): AgentDef =>
    buildAgent({
      systemPrompt: 'You build.\n\n# Last failure\n\n{{feedback}}',
    });

  /** Every system role sent to the `build` agent, in order. */
  function buildRoles(agent: ScriptedAgent): string[] {
    return turnRequests(agent).map((t) => t.systemPrompt ?? '');
  }

  it('carries the real evidence in the system role on the delta path', async () => {
    installCheck('#!/bin/sh\ntest -f fix.txt\n');
    const envelope = buildEnvelope({ summary: 'attempted', commit_message: 'work' });
    const scripted = scriptedAgent([envelope, envelope], [null, 'fix.txt']);

    const outcome = await run({
      scripted,
      project,
      agents: [feedbackInRole()],
      pipeline: repairPipeline(),
    });
    expect(outcome.status).toBe('accepted');

    const roles = buildRoles(scripted);
    expect(roles).toHaveLength(2);
    // First entry: no failure has happened yet, so the token renders empty.
    expect(roles[0]).toContain('(no feedback)');
    // Re-entry: the user message is a delta, but the role still names the
    // failing command, because the role is what this roster reads it from.
    expect(buildPrompts(scripted)[1]).not.toContain('do the thing');
    expect(roles[1]).toContain('./check.sh');
    expect(roles[1]).toContain('test failed');
    expect(roles[1]).not.toContain('(no feedback)');

    // The trace agrees with the wire rather than recording a role never sent.
    const record = readFileSync(
      join(h.tracer.runDir(outcome.runId), 'builder/prompts/build-2.md'),
      'utf8',
    );
    expect(record).toContain('./check.sh');
    expect(record).not.toContain('(no feedback)');
  });

  it('carries the real evidence in the system role on the full path too', async () => {
    installCheck('#!/bin/sh\ntest -f fix.txt\n');
    const envelope = buildEnvelope({ summary: 'attempted', commit_message: 'work' });
    // Compaction between the phases forces the re-entry down the full path.
    const scripted = scriptedAgent([envelope, envelope], [null, 'fix.txt'], [], {
      contextUsed: 85_000,
      contextUsedAfterCompaction: 8_500,
    });

    const outcome = await run({
      scripted,
      project,
      agents: [feedbackInRole()],
      pipeline: repairPipeline(),
    });
    expect(outcome.status).toBe('accepted');
    expect(wireLog(scripted).filter((l) => l === 'compact')).toHaveLength(1);

    const roles = buildRoles(scripted);
    expect(roles).toHaveLength(2);
    expect(roles[0]).toContain('(no feedback)');
    // The full prompt went back on the wire, and the role carries the evidence
    // on this path as well — the two paths cannot disagree about the role.
    expect(buildPrompts(scripted)[1]).toContain('do the thing');
    expect(roles[1]).toContain('./check.sh');
    expect(roles[1]).not.toContain('(no feedback)');
  });

  /**
   * `compose()` derives one system role per entry and both paths return it, so
   * a read-only agent must be told it has no shell on a feedback re-entry
   * exactly as on first entry. A delta that trimmed the role's tool facts would
   * leave the agent believing it can run commands it does not have.
   */
  it('keeps shell guidance out of a read-only agent’s role on both prompt paths', async () => {
    installCheck('#!/bin/sh\ntest -f fix.txt\n');
    const envelope = buildEnvelope({ summary: 'attempted', commit_message: 'work' });
    const readOnly = buildAgent({ writes: ['fix.txt'], toolProfile: 'read-only' });

    // The first run re-enters via the delta path; the second compacts in
    // between, which forces the full path. The role must read the same way.
    for (const options of [
      {},
      { contextUsed: 85_000, contextUsedAfterCompaction: 8_500 },
    ] as ScriptedAgentOptions[]) {
      const scripted = scriptedAgent([envelope, envelope], [null, 'fix.txt'], [], options);
      const outcome = await run({
        scripted,
        project,
        agents: [readOnly],
        pipeline: repairPipeline(),
      });
      expect(outcome.status).toBe('accepted');

      const roles = buildRoles(scripted);
      expect(roles).toHaveLength(2);
      for (const role of roles) {
        expect(role).not.toContain('# Worktree and shell');
        expect(role).not.toContain('Setup ran');
      }
    }
  });
});

describe('acceptance criteria', () => {
  it('rejects a run whose reviewer did not approve, even though every phase ran', async () => {
    const scripted = scriptedAgent([reviewEnvelope(false)]);
    const outcome = await run({
      scripted,
      agents: [buildAgent({ name: 'reviewer', envelope: 'review' })],
      pipeline: pipe(
        [
          agentPhase('review', {
            agent: 'reviewer',
            description: 'Judge the work and record why it does not pass.',
            envelope: 'review',
            gates: ['verdict_consistent'],
          }),
        ],
        {
          description: 'acceptance hangs on the reviewer verdict',
          acceptance: { kind: 'phase_flag', phase: 'review', flag: 'approved' },
        },
      ),
    });
    // Phase succeeded; the run is still not accepted.
    expect(h.tracer.phases(outcome.runId)[0]!.status).toBe('success');
    expect(outcome.status).toBe('rejected');
  });

  /**
   * The shipped chains rely on this: a disapproving reviewer must stop the
   * pipeline before a later commit or PR phase can record the rejected work.
   * `disapproval_halts` corrects a disapproval that reports success; the
   * honest retry (`status: "fail"`) aborts the phase, so the commit that
   * follows never runs.
   */
  it('halts before later phases when a gated reviewer does not approve', async () => {
    const disapproveButContinue = JSON.stringify({
      status: 'success',
      summary: 'not good enough',
      artifacts: [],
      approved: false,
      findings: [{ requirement: 'it works', met: false, evidence: 'it does not' }],
      blocking: ['it does not work'],
      notes_for_next_agent: '',
    });
    const scripted = scriptedAgent([disapproveButContinue, reviewEnvelope(false)]);
    const outcome = await run({
      scripted,
      agents: [buildAgent({ name: 'reviewer', envelope: 'review' })],
      pipeline: pipe(
        [
          agentPhase('review', {
            agent: 'reviewer',
            retries: 2,
            description: 'Judge the work; a disapproval must stop the run here.',
            envelope: 'review',
            gates: ['verdict_consistent', 'disapproval_halts'],
          }),
          codePhase(
            'commit_build',
            { argv: ['sh', '-c', 'echo should-never-run > landed.txt'] },
            { description: 'Record work that must not be recorded when rejected.' },
          ),
        ],
        {
          description: 'a rejection must never flow into the commit',
          acceptance: { kind: 'last_phase_pass' },
        },
      ),
    });

    expect(outcome.status).toBe('rejected');
    const phases = h.tracer.phases(outcome.runId);
    expect(phases.find((p) => p.name === 'review')!.status).toBe('fail');
    // The commit phase never ran: it is still queued, and its file never landed.
    expect(phases.find((p) => p.name === 'commit_build')!.status).toBe('queued');
    const row = h.tracer.run(outcome.runId)!;
    expect(existsSync(join(row.worktreePath!, 'landed.txt'))).toBe(false);
  });
});

describe('engineer phases', () => {
  it('records what the human decided and carries their notes forward', async () => {
    const outcome = await run({
      agents: [],
      request: 'ask me',
      envelopeRetries: 1,
      gateRetries: 1,
      pipeline: pipe(
        [
          {
            name: 'approve',
            kind: 'engineer',
            description: 'Pause so a human can confirm before anything else runs.',
            question: 'Ship it?',
          },
        ],
        { description: 'pause for a human' },
      ),
      askHuman: async (req) => {
        expect(req.body).toBe('Ship it?');
        return { approve: true, text: 'go ahead, but watch the migration' };
      },
    });
    expect(outcome.status).toBe('accepted');
    const interrupt = events(outcome.runId).find((e) => e.type === 'interrupt');
    expect(interrupt!.payload.decision).toBe('approve');
    expect(interrupt!.payload.text).toContain('migration');
  });

  it('fails the run when the human rejects', async () => {
    const outcome = await run({
      agents: [],
      request: 'ask me',
      envelopeRetries: 1,
      gateRetries: 1,
      pipeline: pipe(
        [
          {
            name: 'approve',
            kind: 'engineer',
            description: 'Pause so a human can stop the run here.',
            question: 'Ship it?',
          },
        ],
        { description: 'pause for a human who says no' },
      ),
      askHuman: async () => ({ approve: false }),
    });
    expect(outcome.status).toBe('rejected');
  });
});

describe('zero-interrupt runs', () => {
  /**
   * Every kind of ask a run can raise, in one phase: a command, a write outside
   * the worktree, a read, and a tool no rule covers. None of them may reach a
   * human, and each must settle the way the policy says.
   */
  const everyAsk = (outside: string): ScriptedAsk[] => [
    { tool: 'bash', input: { command: 'git commit --allow-empty -m probe' } },
    { tool: 'write', input: { path: outside, content: 'escaped' }, writeIfAllowed: outside },
    { tool: 'read', input: { path: 'README.md' } },
    { tool: 'some_future_tool', input: {} },
  ];

  it('settles with no human prompt and traces only the denials', async () => {
    const outside = join(tempDir('foundry-outside-'), 'escaped.txt');
    const scripted = scriptedAgent([buildEnvelope()], [], [everyAsk(outside)]);
    let humanAsked = 0;

    const outcome = await run({
      scripted,
      pipeline: pipe(
        [agentPhase('build', { description: 'Raise every kind of ask a run can raise.' })],
        {
          description: 'an agent that asks for everything',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
      askHuman: async () => {
        humanAsked++;
        return { approve: true };
      },
    });

    expect(outcome.status).toBe('accepted');
    expect(humanAsked).toBe(0);

    const interrupts = events(outcome.runId).filter((e) => e.type === 'interrupt');
    // Allows pair 1:1 with the tool_call already in the transcript; only a
    // denial is worth an interrupt row.
    expect(interrupts).toHaveLength(2);
    for (const event of interrupts) {
      expect(event.payload.auto).toBe(true);
      expect(event.payload.reason).toBeTruthy();
      expect(event.name).toBe('deny (policy)');
    }

    const forTool = (tool: string) => interrupts.find((e) => e.payload.tool === tool);

    expect(forTool('bash')).toBeUndefined();
    expect(forTool('read')).toBeUndefined();
    expect(forTool('write')!.payload.reason).toEqual(
      expect.stringContaining('outside the run worktree'),
    );
    // A tool this build does not classify fails closed: the write boundary only
    // sees inside the worktree, so an unclassified tool could act outside it.
    expect(String(forTool('some_future_tool')!.payload.reason)).toContain(
      'not a tool this policy recognises',
    );

    // The trace is not the wire. What settles the call is the decision the agent
    // received, because a block it never saw is a write that still happened.
    const replies = askReplies(scripted);
    expect(replies.map((r) => `${r.tool}:${r.decision.outcome}`)).toEqual([
      'bash:allow',
      'write:deny',
      'read:allow',
      'some_future_tool:deny',
    ]);

    // The denial has to actually stop the write, not merely be recorded.
    expect(existsSync(outside)).toBe(false);
  });
});

describe('the safety net under a zero-interrupt policy', () => {
  it('reverts a boundary violation that never went through an ask', async () => {
    const scripted = scriptedAgent(
      [buildEnvelope(), buildEnvelope()],
      ['forbidden/slipped.txt', 'forbidden/slipped.txt'],
    );
    const outcome = await run({
      scripted,
      agents: [buildAgent({ writes: ['allowed/'] })],
      pipeline: pipe(
        [
          agentPhase('build', {
            retries: 1,
            description: 'Prove git, not the ask layer, is what enforces the boundary.',
          }),
        ],
        {
          description: 'the agent writes outside its boundary without asking',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('rejected');
    const worktree = h.tracer.run(outcome.runId)!.worktreePath!;
    expect(existsSync(join(worktree, 'forbidden/slipped.txt'))).toBe(false);
    const violation = events(outcome.runId).find((e) => e.name === 'write boundary');
    expect(JSON.stringify(violation!.payload)).toContain('forbidden/slipped.txt');
    expect(events(outcome.runId).some((e) => e.name === 'boundary violation')).toBe(true);
  });

  it('fails the phase on a protected path however many retries it gets', async () => {
    const scripted = scriptedAgent(
      [buildEnvelope(), buildEnvelope(), buildEnvelope()],
      ['.foundry/stash.json', '.foundry/stash.json', '.foundry/stash.json'],
    );
    const outcome = await run({
      scripted,
      agents: [buildAgent({ writes: null })],
      pipeline: pipe(
        [
          agentPhase('build', {
            retries: 2,
            description: 'Prove a protected path cannot be retried into a pass.',
          }),
        ],
        {
          description: 'the agent writes a protected path',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('rejected');
    expect(h.tracer.phases(outcome.runId)[0]!.status).toBe('fail');
    const worktree = h.tracer.run(outcome.runId)!.worktreePath!;
    expect(existsSync(join(worktree, '.foundry/stash.json'))).toBe(false);
  });
});

describe('the trace record', () => {
  it('writes prompts, envelopes, and events to disk as the raw record', async () => {
    const scripted = scriptedAgent([buildEnvelope({ summary: 'ok', commit_message: 'x' })]);
    const outcome = await run({
      scripted,
      pipeline: pipe(
        [
          agentPhase('build', {
            description: 'Produce a record on disk as well as in the db.',
          }),
        ],
        {
          description: 'one agent phase',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });
    const dir = h.tracer.runDir(outcome.runId);
    expect(existsSync(join(dir, 'request.md'))).toBe(true);
    expect(existsSync(join(dir, 'pipeline.json'))).toBe(true);
    expect(existsSync(join(dir, 'events.jsonl'))).toBe(true);
    expect(existsSync(join(dir, 'builder/prompts/build-1.md'))).toBe(true);
    // Prompt on disk is exactly what was sent, envelope example included.
    const prompt = readFileSync(join(dir, 'builder/prompts/build-1.md'), 'utf8');
    expect(prompt).toContain('do the thing');
    expect(prompt).toContain('commit_message');
  });

  it('records the resolved model on agent_start when the roster says inherit (FOU-68)', async () => {
    const scripted = scriptedAgent([buildEnvelope()]);
    const outcome = await run({
      scripted,
      agents: [buildAgent({ model: 'inherit' })],
      defaultModel: 'bridge-claude/claude-sonnet-5',
      pipeline: pipe(
        [agentPhase('build', { description: 'Record which model actually served the turn.' })],
        { acceptance: { kind: 'envelope_status', phase: 'build' } },
      ),
    });
    expect(outcome.status).toBe('accepted');
    const start = events(outcome.runId).find((e) => e.type === 'agent_start');
    expect(start!.payload.model).toBe('bridge-claude/claude-sonnet-5');
    // The event agrees with the session row the Inspector already trusts.
    const session = h.tracer.agentSessions(outcome.runId)[0]!;
    expect(session.model).toBe('bridge-claude/claude-sonnet-5');
  });

  it('records the roster model verbatim on agent_start when one is pinned', async () => {
    const scripted = scriptedAgent([buildEnvelope()]);
    const outcome = await run({
      scripted,
      agents: [buildAgent({ model: 'bridge-claude/claude-opus-5' })],
      defaultModel: 'bridge-claude/claude-sonnet-5',
      pipeline: pipe(
        [agentPhase('build', { description: 'A pinned model outranks the run default.' })],
        { acceptance: { kind: 'envelope_status', phase: 'build' } },
      ),
    });
    expect(outcome.status).toBe('accepted');
    const start = events(outcome.runId).find((e) => e.type === 'agent_start');
    expect(start!.payload.model).toBe('bridge-claude/claude-opus-5');
  });

  it('uses a phase model override ahead of the selected agent model', async () => {
    const scripted = scriptedAgent([buildEnvelope()]);
    const outcome = await run({
      scripted,
      agents: [buildAgent({ model: 'bridge-claude/claude-sonnet-5' })],
      pipeline: pipe(
        [
          agentPhase('build', {
            description: 'Use the model selected for this phase.',
            model: 'bridge-claude/claude-opus-5',
          }),
        ],
        { acceptance: { kind: 'envelope_status', phase: 'build' } },
      ),
    });
    expect(outcome.status).toBe('accepted');
    const start = events(outcome.runId).find((e) => e.type === 'agent_start');
    expect(start!.payload.model).toBe('bridge-claude/claude-opus-5');
    expect(h.tracer.agentSessions(outcome.runId)[0]!.model).toBe('bridge-claude/claude-opus-5');
  });

  it('opens a new session when consecutive phases override one agent with different models', async () => {
    const scripted = scriptedAgent([buildEnvelope(), buildEnvelope()]);
    const outcome = await run({
      scripted,
      agents: [buildAgent({ model: 'bridge-claude/claude-sonnet-5' })],
      pipeline: pipe(
        [
          agentPhase('plan', {
            description: 'Plan with the selected planning model.',
            model: 'bridge-claude/claude-haiku-5',
          }),
          agentPhase('build', {
            description: 'Build with the selected implementation model.',
            model: 'bridge-claude/claude-opus-5',
          }),
        ],
        { acceptance: { kind: 'all_phases_pass' } },
      ),
    });
    expect(outcome.status).toBe('accepted');
    expect(scripted.sessionOpens).toBe(2);
    expect(
      events(outcome.runId)
        .filter((event) => event.type === 'agent_start')
        .map((event) => event.payload.model),
    ).toEqual(['bridge-claude/claude-haiku-5', 'bridge-claude/claude-opus-5']);
  });

  it('queues every phase up front so the waterfall can draw what has not run', async () => {
    const outcome = await run({
      pipeline: pipe(
        [
          codePhase(
            'first',
            { argv: ['false'] },
            {
              description: 'Fail immediately so later phases never start.',
            },
          ),
          codePhase(
            'second',
            { argv: ['true'] },
            {
              description: 'Never run, and stay visible as queued in the trace.',
            },
          ),
        ],
        { description: 'stops early on purpose' },
      ),
    });
    const phases = h.tracer.phases(outcome.runId);
    expect(phases.map((p) => p.status)).toEqual(['fail', 'queued']);
  });

  it('runs an execution in an initially empty repository without failing isolation', async () => {
    const empty = emptyRepo();
    const scripted = scriptedAgent(
      [buildEnvelope({ summary: 'created initial app' })],
      ['index.ts'],
    );
    const outcome = await run({
      scripted,
      project: { ...defaultProject(empty), mergePolicy: 'auto' },
      pipeline: pipe([agentPhase('build', { description: 'build initial project' })], {
        acceptance: { kind: 'all_phases_pass' },
      }),
      request: 'make initial project',
    });
    expect(outcome.status).toBe('accepted');
  });

  it('auto-merges through recordLanding: applies command drift and clears the worktree path', async () => {
    const projectState: { project: ProjectDef } = {
      project: {
        ...defaultProject(h.repo),
        mergePolicy: 'auto',
        commands: [{ name: 'test', argv: ['swift', 'test'] }],
      },
    };
    const notifies = { runs: 0, settings: 0 };
    const outcome = await run({
      project: projectState.project,
      landing: {
        currentProject: () => projectState.project,
        saveProject: (next) => {
          projectState.project = next;
          return { ok: true };
        },
        notifySettings: () => {
          notifies.settings += 1;
        },
        notifyRuns: () => {
          notifies.runs += 1;
        },
      },
      pipeline: pipe(
        [
          codePhase(
            'manifest',
            { argv: ['sh', '-c', "printf 'test:\\n\\ttrue\\n' > Makefile"] },
            { description: 'Add a Makefile so the next phase sniffs a different test command.' },
          ),
          codePhase(
            'test',
            { ref: 'test' },
            { description: 'Run the frozen test command, which should drift to make test.' },
          ),
        ],
        { description: 'auto-merge applies the sniffed command' },
      ),
    });

    expect(outcome.status).toBe('accepted');
    await expect.poll(() => h.tracer.run(outcome.runId)?.merged).toBe(true);
    const landed = h.tracer.run(outcome.runId)!;
    expect(landed.worktreePath).toBeNull();
    expect(existsSync(join(h.repo, '.foundry-worktrees', outcome.runId))).toBe(false);
    expect(projectState.project.commands[0]!.argv).toEqual(['make', 'test']);
    const names = events(outcome.runId).map((e) => e.name);
    expect(names).toContain('command_drift');
    expect(names).toContain('command_drift_applied');
    expect(notifies.settings).toBe(1);
    expect(notifies.runs).toBe(1);
  });
});

/**
 * The transport under the executor, exercised the way a run actually uses it.
 * These pin the properties a runtime swap could quietly lose — that agent
 * phases record which transport answered, that an in-process session leaves no
 * child behind, and that a failing turn fails rather than degrading to
 * something with a weaker permission policy.
 */
describe('the agent transport under the executor', () => {
  it('runs agent phases on the in-process transport', async () => {
    const scripted = scriptedAgent([buildEnvelope()]);
    const outcome = await run({
      scripted,
      pipeline: pipe(
        [agentPhase('build', { description: 'Prove the agent phase drove the transport.' })],
        {
          description: 'one agent phase over the transport',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    expect(h.tracer.run(outcome.runId)!.mode).toBe('pi');
    const sessions = h.tracer.agentSessions(outcome.runId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.mode).toBe('pi');
    // The session id only exists if the session actually opened.
    expect(sessions[0]!.agentSessionId).toBe('s1');
  });

  it('records no child process, because the agent runs in this process', async () => {
    const scripted = scriptedAgent([buildEnvelope()]);
    const outcome = await run({
      scripted,
      pipeline: pipe(
        [agentPhase('build', { description: 'Prove no per-agent child is spawned.' })],
        {
          description: 'one agent phase',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    // The agent runtime is a library call, so an agent phase has no child to
    // record or reap — and nothing can outlive the run.
    expect(processRows(outcome.runId)).toHaveLength(0);
    expect(h.tracer.openProcesses(outcome.runId)).toHaveLength(0);
  });

  it('keeps one session across a correction rather than reopening', async () => {
    const scripted = scriptedAgent(['prose, not JSON', buildEnvelope()]);
    const outcome = await run({
      scripted,
      pipeline: pipe([agentPhase('build', { description: 'Correct in the live session.' })], {
        description: 'a correction inside one session',
        acceptance: { kind: 'envelope_status', phase: 'build' },
      }),
    });

    expect(outcome.status).toBe('accepted');
    const sessions = h.tracer.agentSessions(outcome.runId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.mode).toBe('pi');
    expect(
      events(outcome.runId).some(
        (e) => e.type === 'correction' && e.name === 'envelope did not parse',
      ),
    ).toBe(true);
    // One session for the whole phase: a reopen would have started twice.
    expect(handshakeCount(scripted)).toBe(1);
  });

  it('leaves a stalled turn running until the operator kills it', async () => {
    const scripted = scriptedAgent([buildEnvelope()], [], [], { stallOnTurns: [0] });
    const launched = start({
      scripted,
      pipeline: pipe(
        [agentPhase('build', { description: 'Prove a stalled turn has no deadline.' })],
        {
          description: 'a transport that stays live until the operator acts',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    await until(() => turnRequests(scripted).length === 1, 'stalled turn to begin');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.tracer.run(launched.runId)!.status).toBe('running');
    expect(events(launched.runId).some((e) => e.name === 'builder: turn failed')).toBe(false);

    launched.executor.cancel();
    expect((await launched.done).status).toBe('killed');
  });

  it('continues a naturally failed run in the same worktree and persisted agent session', async () => {
    const pipeline = pipe(
      [
        codePhase('prepare', { argv: ['sh', '-c', 'echo prepared >> prepare-count'] }),
        agentPhase('build', { description: 'Finish after the interrupted turn.' }),
      ],
      {
        description: 'a run that can continue after an app restart',
        acceptance: { kind: 'envelope_status', phase: 'build' },
      },
    );
    const failed = scriptedAgent([buildEnvelope()], [], [], { dieOnTurns: [0] });
    const first = await run({ pipeline, scripted: failed });

    expect(first.status).toBe('rejected');
    const before = h.tracer.run(first.runId)!;
    const phaseIds = h.tracer.phases(first.runId).map((phase) => phase.phaseId);
    const sessionId = h.tracer.agentSessions(first.runId)[0]!.agentSessionId;
    expect(readFileSync(join(before.worktreePath!, 'prepare-count'), 'utf8')).toBe('prepared\n');

    const continued = scriptedAgent([buildEnvelope()]);
    const executor = new Executor({
      tracer: h.tracer,
      envelopeRetries: 2,
      gateRetries: 2,
      compactionThreshold: 0.8,
      rewindAfterCorrections: 2,
      supportDir: h.support,
      transport: (req) => continued.transport(req),
      agents: [buildAgent()],
      envelopeDefs: [],
      project: h.project,
      pipeline,
      request: 'do the thing',
      runId: first.runId,
      engineer: 'test',
      askHuman: async () => ({ approve: true }),
    });
    const outcome = await executor.resume();

    expect(outcome.status).toBe('accepted');
    expect(h.tracer.phases(first.runId).map((phase) => phase.phaseId)).toEqual(phaseIds);
    expect(readFileSync(join(before.worktreePath!, 'prepare-count'), 'utf8')).toBe('prepared\n');
    expect(turnRequests(continued)[0]!.sessionId).toBe(sessionId);
    expect(events(first.runId)).toContainEqual(
      expect.objectContaining({ type: 'log', name: 'run continued' }),
    );
    // A correction is not a recovery: nothing was abandoned, so nothing is
    // recorded as having been.
    expect(events(first.runId).filter((e) => e.name === 'run recovered')).toEqual([]);
  });

  it('fails the phase when the session dies mid-turn', async () => {
    const scripted = scriptedAgent([buildEnvelope(), buildEnvelope()], [], [], { dieOnTurns: [0] });
    const outcome = await run({
      scripted,
      pipeline: pipe(
        [agentPhase('build', { description: 'Prove a dead session is not papered over.' })],
        {
          description: 'a transport that dies',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('rejected');
    expect(h.tracer.run(outcome.runId)!.mode).toBe('pi');
    // No fallback events exist to be logged, because no fallback exists.
    expect(events(outcome.runId).some((e) => /fallback/.test(e.name))).toBe(false);
    expect(h.tracer.openProcesses(outcome.runId)).toHaveLength(0);
  });
});

/**
 * Pre-emptive compaction. The engine, not the agent, decides when a session has
 * filled up, and it decides it BETWEEN phases: compacting mid-turn would rewrite
 * the history a turn in flight is reasoning over.
 *
 * Compaction is in place — the session keeps its identity and loses messages —
 * so what a test can assert is the occupancy either side of it and that the run
 * carried on. There is no successor id to name.
 */
describe('compaction between phases', () => {
  /** Two agent phases so there is an inter-phase window at all. */
  function twoPhases(over: Partial<PipelineDef> = {}): PipelineDef {
    return pipe(
      [
        agentPhase('build', { description: 'Fill the context up.' }),
        agentPhase('polish', { description: 'Run after the window was compacted.' }),
      ],
      {
        description: 'two agent phases with a compaction window between them',
        acceptance: { kind: 'envelope_status', phase: 'polish' },
        ...over,
      },
    );
  }

  function compactions(runId: string) {
    return events(runId).filter((e) => e.type === 'compaction');
  }

  it('compacts a session over the threshold and runs the next phase on it', async () => {
    const scripted = scriptedAgent([buildEnvelope(), buildEnvelope()], [], [], {
      contextUsed: 85_000,
      contextUsedAfterCompaction: 8_500,
    });
    const outcome = await run({ scripted, pipeline: twoPhases() });

    expect(outcome.status).toBe('accepted');
    // One compaction, in the one window there was for it.
    const compacted = wireLog(scripted).filter((line) => line === 'compact');
    expect(compacted).toHaveLength(1);

    // Compaction is in place, so the id the trace carries is the one a resumed
    // run reopens — and it is the same session that was compacted.
    const sessions = h.tracer.agentSessions(outcome.runId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.agentSessionId).toBe('s1');

    const turns = wireLog(scripted).filter((line) => line.startsWith('turn_started'));
    expect(turns).toHaveLength(2);
    for (const turn of turns) expect(turn).toContain('session=s1');
    // One open, so the compaction did not cost a reopen either.
    expect(handshakeCount(scripted)).toBe(1);
  });

  it('records what the compaction removed and the window either side of it', async () => {
    const scripted = scriptedAgent([buildEnvelope(), buildEnvelope()], [], [], {
      contextUsed: 85_000,
      contextUsedAfterCompaction: 8_500,
    });
    const outcome = await run({ scripted, pipeline: twoPhases() });

    const rows = compactions(outcome.runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('builder');
    expect(rows[0]!.payload.removedCount).toBe(7);
    expect(rows[0]!.payload.before).toEqual({ used: 85_000, limit: 100_000 });
    expect(rows[0]!.payload.after).toEqual({ used: 8_500, limit: 100_000 });
  });

  it('leaves a session under the threshold alone', async () => {
    const scripted = scriptedAgent([buildEnvelope(), buildEnvelope()], [], [], {
      contextUsed: 40_000,
    });
    const outcome = await run({ scripted, pipeline: twoPhases() });

    expect(outcome.status).toBe('accepted');
    expect(wireLog(scripted)).not.toContain('compact');
    expect(compactions(outcome.runId)).toHaveLength(0);
    expect(h.tracer.agentSessions(outcome.runId)[0]!.agentSessionId).toBe('s1');
  });

  it('honours a threshold the operator moved', async () => {
    const scripted = scriptedAgent([buildEnvelope(), buildEnvelope()], [], [], {
      contextUsed: 60_000,
    });
    const outcome = await run({
      scripted,
      compactionThreshold: 0.5,
      pipeline: twoPhases(),
    });

    expect(outcome.status).toBe('accepted');
    expect(wireLog(scripted).filter((l) => l === 'compact')).toHaveLength(1);
  });

  it('never compacts inside a turn, correction retries included', async () => {
    // Phase one needs a correction, so the phase spans two turns with one
    // inter-phase window after them — over threshold from the very first stats.
    const scripted = scriptedAgent(['prose, not JSON', buildEnvelope(), buildEnvelope()], [], [], {
      contextUsed: 90_000,
      contextUsedAfterCompaction: 9_000,
    });
    const outcome = await run({ scripted, pipeline: twoPhases() });

    expect(outcome.status).toBe('accepted');
    const log = wireLog(scripted);
    // Every compaction sits outside an open turn: between a completion and the
    // next turn's start, never between a start and its completion.
    let openTurn = false;
    for (const line of log) {
      if (line.startsWith('turn_started')) openTurn = true;
      if (line.startsWith('turn_completed')) openTurn = false;
      if (line === 'compact') expect(openTurn).toBe(false);
    }
    expect(log.filter((l) => l === 'compact')).toHaveLength(1);
    // Three turns: the bad envelope, its correction, then phase two.
    expect(log.filter((l) => l.startsWith('turn_started'))).toHaveLength(3);
  });

  it('carries a post-compaction correction on the compacted session', async () => {
    // Phase two's first reply is unparseable, so its correction is the first
    // thing the compacted session ever sees.
    const scripted = scriptedAgent([buildEnvelope(), 'prose, not JSON', buildEnvelope()], [], [], {
      contextUsed: 85_000,
      contextUsedAfterCompaction: 8_500,
    });
    const outcome = await run({ scripted, pipeline: twoPhases() });

    expect(outcome.status).toBe('accepted');
    const turns = wireLog(scripted).filter((l) => l.startsWith('turn_started'));
    expect(turns).toHaveLength(3);
    // All three turns, the post-compaction correction included, are the same
    // conversation: compaction shortens a session, it does not replace one.
    for (const turn of turns) expect(turn).toContain('session=s1');

    // One session row for the agent, and the correction is inside the phase.
    const sessions = h.tracer.agentSessions(outcome.runId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.agentSessionId).toBe('s1');
    expect(
      events(outcome.runId).some(
        (e) => e.type === 'correction' && e.name === 'envelope did not parse',
      ),
    ).toBe(true);
    // Compaction is not a reopen, so the run never opens a second session.
    expect(handshakeCount(scripted)).toBe(1);
  });

  it('carries on with the run when the session refuses to compact', async () => {
    const scripted = scriptedAgent([buildEnvelope(), buildEnvelope()], [], [], {
      contextUsed: 85_000,
      compactFails: true,
    });
    const outcome = await run({ scripted, pipeline: twoPhases() });

    // A failed compaction costs the run nothing: the next phase runs on the
    // session it already had and acceptance decides the outcome as usual.
    expect(outcome.status).toBe('accepted');
    expect(wireLog(scripted).filter((l) => l === 'compact')).toHaveLength(1);
    expect(compactions(outcome.runId)).toHaveLength(0);
    expect(h.tracer.agentSessions(outcome.runId)[0]!.agentSessionId).toBe('s1');
    const turns = wireLog(scripted).filter((l) => l.startsWith('turn_started'));
    expect(turns[1]).toContain('session=s1');
    // The failure is on the record, so a run that then hits the wall explains itself.
    const failures = events(outcome.runId).filter((e) => e.name === 'builder: compaction failed');
    expect(failures).toHaveLength(1);
    expect(String(failures[0]!.payload.message)).toContain('nothing to compact');
  });
});

/**
 * The envelope as a wire constraint. The schema an agent turn carries is the
 * same zod instance the reply is parsed against, and a structured reply is
 * still only a candidate: nothing succeeds without passing the parse.
 */
describe('structured-output envelopes', () => {
  /** Prose no `extractJson` can rescue, so only structuredOutput can settle it. */
  const NO_JSON = 'I did the work. There is no JSON anywhere in this sentence.';

  const structuredBuild = {
    status: 'success',
    summary: 'built it from the schema',
    artifacts: [],
    commit_message: 'add a thing',
    notes_for_next_agent: '',
  };

  function corrections(runId: string) {
    return events(runId).filter(
      (e) => e.type === 'correction' && e.name === 'envelope did not parse',
    );
  }

  it('constrains agent turns with the envelope schema and no other phase', async () => {
    const scripted = scriptedAgent([buildEnvelope()]);
    const outcome = await run({
      scripted,
      pipeline: pipe(
        [
          agentPhase('build', { description: 'Carry the envelope schema on the wire.' }),
          {
            name: 'approve',
            kind: 'engineer',
            description: 'A human checkpoint, which is not an agent turn.',
            question: 'Ship it?',
          },
          codePhase('check', { argv: ['true'] }, { description: 'A command, not an agent turn.' }),
        ],
        {
          description: 'agent, engineer, and code phases side by side',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    // Only the agent phase ever sends a turn, and it carries the schema the
    // reply is parsed against — same source, so the two cannot drift.
    const requests = turnRequests(scripted);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.outputFormat).toEqual({
      type: 'json_schema',
      schema: JSON.parse(JSON.stringify(jsonSchemaFor('build'))),
    });
  });

  it('carries an agent’s custom fields into the schema it puts on the wire', async () => {
    const scripted = scriptedAgent([buildEnvelope({ severity: 'high' })]);
    const custom = [
      { name: 'severity', type: 'string' as const, required: true, description: 'low|med|high' },
    ];
    const outcome = await run({
      scripted,
      agents: [buildAgent({ customFields: custom })],
      pipeline: pipe(
        [agentPhase('build', { description: 'Constrain the turn with the extended schema.' })],
        {
          description: 'an agent with a custom envelope field',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    const format = turnRequests(scripted)[0]!.outputFormat as { schema: Record<string, unknown> };
    expect(format.schema).toEqual(JSON.parse(JSON.stringify(jsonSchemaFor('build', custom))));
    expect(format.schema.required).toContain('severity');
  });

  it('still shows the agent the generated example beside the schema', async () => {
    const scripted = scriptedAgent([buildEnvelope()]);
    const outcome = await run({
      scripted,
      pipeline: pipe(
        [agentPhase('build', { description: 'Keep the prompt example alongside the constraint.' })],
        {
          description: 'the prompt example survives the wire constraint',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    // Removing the example is an eval-backed decision, not a side effect of
    // gaining a second channel for the same shape.
    const example = exampleFor('build');
    expect(String(turnRequests(scripted)[0]!.text)).toContain(example);
    const prompt = readFileSync(
      join(h.tracer.runDir(outcome.runId), 'builder/prompts/build-1.md'),
      'utf8',
    );
    expect(prompt).toContain(example);
  });

  it('accepts a valid structured reply whose text carries no envelope at all', async () => {
    const scripted = scriptedAgent([NO_JSON], [], [], { structuredOutputs: [structuredBuild] });
    const outcome = await run({
      scripted,
      pipeline: pipe(
        [agentPhase('build', { description: 'Settle the phase from the structured reply.' })],
        {
          description: 'structured output is the primary path',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    expect(corrections(outcome.runId)).toHaveLength(0);
    const envelopes = h.tracer.envelopes(outcome.runId);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.valid).toBe(true);
    expect(envelopes[0]!.payload).toMatchObject({
      status: 'success',
      summary: 'built it from the schema',
      commit_message: 'add a thing',
    });
  });

  it('accepts a structured reply on a non-generic kind with a required field', async () => {
    const structuredReview = {
      status: 'success',
      summary: 'reviewed from the schema',
      artifacts: [],
      approved: true,
      findings: [],
      blocking: [],
      notes_for_next_agent: '',
    };
    const scripted = scriptedAgent([NO_JSON], [], [], { structuredOutputs: [structuredReview] });
    const outcome = await run({
      scripted,
      agents: [buildAgent({ name: 'reviewer', envelope: 'review' })],
      pipeline: pipe(
        [
          agentPhase('review', {
            agent: 'reviewer',
            envelope: 'review',
            description: 'Settle a review phase from the structured reply.',
          }),
        ],
        {
          description: 'structured output on the review kind',
          acceptance: { kind: 'phase_flag', phase: 'review', flag: 'approved' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    expect(corrections(outcome.runId)).toHaveLength(0);
    expect(h.tracer.envelopes(outcome.runId)[0]!.payload).toMatchObject({
      approved: true,
      summary: 'reviewed from the schema',
    });
  });

  it('corrects a structured reply the schema accepts but the parse rejects', async () => {
    // `status: 'maybe'` is a string, so a loose schema check waves it through;
    // the zod enum is what actually decides, and it is the only authority.
    const bogus = { ...structuredBuild, status: 'maybe' };
    const scripted = scriptedAgent([NO_JSON, buildEnvelope()], [], [], {
      structuredOutputs: [bogus, null],
    });
    const outcome = await run({
      scripted,
      pipeline: pipe(
        [agentPhase('build', { description: 'Never trust a transport’s conformance claim.' })],
        {
          description: 'structured output that fails the zod parse',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    const corrected = corrections(outcome.runId);
    expect(corrected).toHaveLength(1);
    expect(String(corrected[0]!.payload.problem)).toContain('status');
    // Both attempts are recorded, the rejected one as evidence.
    expect(h.tracer.envelopes(outcome.runId).map((e) => e.valid)).toEqual([false, true]);
  });

  it('reads the text when the agent could not shape the reply, without burning a retry', async () => {
    const scripted = scriptedAgent([buildEnvelope()], [], [], {
      turnReasons: ['structured_output_invalid'],
    });
    const outcome = await run({
      scripted,
      pipeline: pipe(
        [agentPhase('build', { description: 'Fall back to the text on the same attempt.' })],
        {
          description: 'a schema failure whose text still parses',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    expect(corrections(outcome.runId)).toHaveLength(0);
    expect(turnRequests(scripted)).toHaveLength(1);
    expect(h.tracer.envelopes(outcome.runId).map((e) => e.valid)).toEqual([true]);
  });

  it('spends the envelope budget, not a second one, when neither channel parses', async () => {
    const scripted = scriptedAgent([NO_JSON], [], [], {
      turnReasons: ['structured_output_missing', 'structured_output_missing'],
    });
    const outcome = await run({
      scripted,
      envelopeRetries: 1,
      pipeline: pipe(
        [agentPhase('build', { description: 'Prove a schema failure has no budget of its own.' })],
        {
          description: 'neither structured output nor text ever parses',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('rejected');
    // envelopeRetries + 1 attempts, exactly today's arithmetic.
    expect(turnRequests(scripted)).toHaveLength(2);
    expect(corrections(outcome.runId)).toHaveLength(2);
    // Born fail: nothing about a schema failure flips a phase.
    expect(h.tracer.phases(outcome.runId)[0]!.status).toBe('fail');
  });

  it('keeps the bad-envelope-then-good scenario at one correction and two attempts', async () => {
    // The pre-SDK baseline for this scenario, unchanged by the wire constraint.
    const scripted = scriptedAgent(['I will explain in prose instead of JSON.', buildEnvelope()]);
    const outcome = await run({
      scripted,
      pipeline: pipe(
        [agentPhase('build', { description: 'Hold the envelope retry rate where it was.' })],
        {
          description: 'first reply is prose, second is an envelope',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    expect(h.tracer.phases(outcome.runId)[0]!.status).toBe('success');
    expect(corrections(outcome.runId)).toHaveLength(1);
    expect(turnRequests(scripted)).toHaveLength(2);
    expect(h.tracer.envelopes(outcome.runId).map((e) => e.valid)).toEqual([false, true]);
  });
});

/**
 * Rewind instrumentation (Phase 3b part 1): every agent-phase correction carries
 * a per-phase running correctionIndex shared across envelope/boundary/gate, so
 * traces can answer "which attempt index succeeded".
 */
describe('correction instrumentation', () => {
  function agentCorrections(runId: string) {
    return events(runId).filter(
      (e) =>
        e.type === 'correction' &&
        (e.name === 'envelope did not parse' ||
          e.name === 'boundary violation' ||
          e.name === 'gate violations'),
    );
  }

  it('numbers every correction in a phase with a shared running correctionIndex', async () => {
    // Envelope fail → boundary fail → gate fail → success. One counter across
    // the three kinds, and the existing attempt field stays on each payload.
    const scripted = scriptedAgent(
      [
        'prose, not JSON',
        buildEnvelope(),
        buildEnvelope({ artifacts: ['ghost.txt'] }),
        buildEnvelope({ artifacts: ['real.txt'] }),
      ],
      [null, 'forbidden/slipped.txt', null, 'real.txt'],
    );
    const outcome = await run({
      scripted,
      agents: [buildAgent({ writes: ['allowed/', 'real.txt'] })],
      envelopeRetries: 1,
      pipeline: pipe(
        [
          agentPhase('build', {
            retries: 2,
            description: 'Share one correctionIndex across envelope, boundary, and gate.',
            gates: ['artifacts_exist'],
          }),
        ],
        {
          description: 'three correction kinds then success',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    const corrections = agentCorrections(outcome.runId);
    expect(corrections.map((e) => e.name)).toEqual([
      'envelope did not parse',
      'boundary violation',
      'gate violations',
    ]);
    expect(corrections.map((e) => e.payload.correctionIndex)).toEqual([1, 2, 3]);
    // attempt is still present — Banner detail keys off it.
    for (const event of corrections) {
      expect(typeof event.payload.attempt).toBe('number');
      expect(event.payload.attempt).toBeGreaterThan(0);
    }
  });

  it('resets correctionIndex at the start of each agent phase', async () => {
    const scripted = scriptedAgent([
      'phase-one prose',
      buildEnvelope({ summary: 'phase one' }),
      'phase-two prose',
      buildEnvelope({ summary: 'phase two' }),
    ]);
    const outcome = await run({
      scripted,
      pipeline: pipe(
        [
          agentPhase('first', {
            description: 'First phase burns one envelope correction.',
          }),
          agentPhase('second', {
            description: 'Second phase starts the counter over.',
          }),
        ],
        {
          description: 'two agent phases each with one envelope correction',
          acceptance: { kind: 'all_phases_pass' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    const corrections = agentCorrections(outcome.runId);
    expect(corrections).toHaveLength(2);
    expect(corrections.map((e) => e.payload.correctionIndex)).toEqual([1, 1]);
    // Distinct phases — the counter did not bleed across.
    expect(corrections[0]!.phaseId).not.toBe(corrections[1]!.phaseId);
  });
});

/**
 * A kill is an operator verdict, not a transport flap. A killed turn looks
 * exactly like a failed one from the inside, so every recovery path has to stand
 * down once the kill has fired, or the operator's kill settles as an accepted run.
 */
describe('killing a run mid-turn', () => {
  it('settles killed rather than recovering the turn', async () => {
    // Turn 0 is begun and never answered, so the kill lands mid-turn.
    // Turn 1 would succeed: without the short-circuit, a recovery attempt
    // finishes the phase and the run settles accepted.
    const scripted = scriptedAgent([buildEnvelope(), buildEnvelope(), buildEnvelope()], [], [], {
      stallOnTurns: [0],
    });
    const started = start({
      scripted,
      pipeline: pipe(
        [agentPhase('build', { description: 'Prove a kill is not a transport failure.' })],
        {
          description: 'a run killed mid-turn',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    await until(() => turnStarted(scripted), 'the scripted agent to start its turn');
    started.executor.cancel();
    const outcome = await started.done;

    expect(outcome.status).toBe('killed');
    const row = h.tracer.run(outcome.runId)!;
    expect(row.status).toBe('killed');
    expect(row.outcomeDetail).toBe('the run was killed');

    // The killed turn is not filed as an agent failure: a kill is what the
    // operator asked for, so the timeline must not read like a broken agent.
    expect(events(outcome.runId).filter((e) => e.name === 'builder: turn failed')).toEqual([]);
    // Only the one turn the kill landed on was ever spent.
    expect(turnMarkers(scripted)).toEqual(['turn 0']);
    expect(h.tracer.run(outcome.runId)!.mode).toBe('pi');
    expect(h.tracer.openProcesses(outcome.runId)).toHaveLength(0);
  });

  it('does not accept a run whose remaining phases never ran', async () => {
    const scripted = scriptedAgent([buildEnvelope(), buildEnvelope()], [], [], {
      stallOnTurns: [1],
    });
    const started = start({
      scripted,
      pipeline: pipe(
        [
          agentPhase('build', { description: 'Pass before the kill lands.' }),
          agentPhase('review', { description: 'Never finish: the kill lands here.' }),
        ],
        {
          description: 'a kill after one phase already passed',
          // The phase that passed would satisfy acceptance on its own.
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    await until(
      () =>
        turnMarkers(scripted).length === 2 &&
        h.tracer.phases(started.runId)[0]?.status === 'success',
      'the first phase to pass and the second turn to start',
    );
    started.executor.cancel();
    const outcome = await started.done;

    expect(outcome.status).toBe('killed');
    expect(h.tracer.run(outcome.runId)!.outcomeDetail).toBe('the run was killed');
  });

  it('never spends a turn after the kill landed', async () => {
    const scripted = scriptedAgent([buildEnvelope(), buildEnvelope()], [], [], {
      stallOnTurns: [0],
    });
    const started = start({
      scripted,
      pipeline: pipe([agentPhase('build', { description: 'Prove no turn outlives the kill.' })], {
        description: 'a killed run spends nothing more',
        acceptance: { kind: 'envelope_status', phase: 'build' },
      }),
    });

    await until(() => turnStarted(scripted), 'the scripted agent to start its turn');
    started.executor.cancel();
    await started.done;

    // A turn spent after the kill is both real money and a result the run
    // could still be settled on.
    expect(turnMarkers(scripted)).toHaveLength(1);
    expect(h.tracer.openProcesses(started.runId)).toHaveLength(0);
  });
});

/**
 * Continuing a killed run.
 *
 * A rejected or failed run is continued as a correction: the interrupted
 * agent's own session is reopened, because it still describes the phase and
 * ends on a turn that actually completed. A kill is different — the operator
 * cut a turn off mid-flight, so reopening that conversation would make a
 * truncated exchange the context the retry reasons from. The phase restarts on
 * a new session over the worktree the kill left behind, and the abandoned
 * conversation stays on the record rather than being deleted.
 */
describe('continuing a killed run', () => {
  const killedPipeline = (): PipelineDef =>
    pipe(
      [
        codePhase('prepare', { argv: ['sh', '-c', 'echo prepared >> prepare-count'] }),
        agentPhase('build', { description: 'Restart this phase after the kill.' }),
      ],
      {
        description: 'a run the operator stopped mid-phase',
        acceptance: { kind: 'envelope_status', phase: 'build' },
      },
    );

  /** Runs `killedPipeline` until the agent turn is in flight, then kills it. */
  async function killedRun(): Promise<{ runId: string; scripted: ScriptedAgent }> {
    const scripted = scriptedAgent([buildEnvelope(), buildEnvelope()], [], [], {
      stallOnTurns: [0],
    });
    const started = start({ scripted, pipeline: killedPipeline() });
    await until(() => turnStarted(scripted), 'the scripted agent to start its turn');
    started.executor.cancel();
    const outcome = await started.done;
    expect(outcome.status).toBe('killed');
    return { runId: outcome.runId, scripted };
  }

  /** A resume on its own executor, the way `RunRegistry.resume` builds one. */
  function continueRun(
    runId: string,
    continued: ScriptedAgent,
    over: Partial<ExecutorDeps> = {},
  ): Promise<{ status: string }> {
    const executor = new Executor({
      tracer: h.tracer,
      envelopeRetries: 2,
      gateRetries: 2,
      compactionThreshold: 0.8,
      rewindAfterCorrections: 2,
      supportDir: h.support,
      transport: (req) => continued.transport(req),
      agents: [buildAgent()],
      envelopeDefs: [],
      project: h.project,
      pipeline: killedPipeline(),
      request: 'do the thing',
      runId,
      engineer: 'test',
      askHuman: async () => ({ approve: true }),
      ...over,
    });
    return executor.resume();
  }

  function recoveryEvent(runId: string) {
    const rows = events(runId).filter((e) => e.name === 'run recovered');
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  it('restarts the interrupted phase on a new session', async () => {
    const { runId } = await killedRun();
    const abandoned = h.tracer.agentSessions(runId)[0]!.agentSessionId;
    expect(abandoned).toBeTruthy();

    const continued = scriptedAgent([buildEnvelope()], [], [], { sessionIdPrefix: 'k' });
    const outcome = await continueRun(runId, continued);

    expect(outcome.status).toBe('accepted');
    // The engine asked for a new conversation rather than the persisted one.
    expect(continued.reopened).toEqual([{ agent: 'builder', existingSessionId: null }]);
    expect(turnRequests(continued)[0]!.sessionId).not.toBe(abandoned);
    expect(turnRequests(continued)[0]!.sessionId).toBe('k1');
  });

  it('records the recovery with both session ids and how the run had stopped', async () => {
    const { runId } = await killedRun();
    const abandoned = h.tracer.agentSessions(runId)[0]!.agentSessionId;

    const continued = scriptedAgent([buildEnvelope()], [], [], { sessionIdPrefix: 'k' });
    await continueRun(runId, continued);

    // `reopenRun` overwrote `killed` in place, so this event is the only
    // remaining record that the run had been stopped by hand.
    expect(recoveryEvent(runId).payload).toMatchObject({
      fromStatus: 'killed',
      strategy: 'fresh_session',
      phase: 'build',
      agent: 'builder',
      previousSessionId: abandoned,
      newSessionId: 'k1',
    });
  });

  it('keeps the abandoned session id on the record and the transcript it produced', async () => {
    const { runId } = await killedRun();
    const abandoned = h.tracer.agentSessions(runId)[0]!.agentSessionId;
    // Identity, not a count: a comparison of lengths alone would still pass if
    // the continue had deleted every killed-attempt event and written more.
    const killedAttempt = events(runId)
      .filter((e) => e.phaseId)
      .map((e) => e.eventId);
    expect(killedAttempt.length).toBeGreaterThan(0);

    const continued = scriptedAgent([buildEnvelope()], [], [], { sessionIdPrefix: 'k' });
    await continueRun(runId, continued);

    // The row is keyed on (run, agent), so the successor overwrites it in
    // place. What survives the kill is the transcript and the recovery event
    // that names the abandoned id.
    expect(h.tracer.agentSessions(runId)).toHaveLength(1);
    const after = new Set(events(runId).map((e) => e.eventId));
    for (const id of killedAttempt) expect(after.has(id)).toBe(true);
    expect(events(runId).filter((e) => e.phaseId).length).toBeGreaterThan(killedAttempt.length);
    expect(recoveryEvent(runId).payload.previousSessionId).toBe(abandoned);
  });

  it('resolves the roster model rather than inheriting a failed-over one', async () => {
    const { runId } = await killedRun();
    // What a failover mid-kill leaves behind: the persisted row names a model
    // the roster never asked for. The lookup `sessionFor` skips is keyed by
    // model, so a row under the roster's own name has to be present too —
    // otherwise this passes on a plain miss rather than on the ban.
    h.tracer.upsertAgentSession({
      runId,
      agent: 'builder',
      model: 'failed-over/model',
      reasoningEffort: 'medium',
      agentSessionId: 'abandoned-session',
      mode: 'pi',
      color: '#5ad2dd',
    });
    h.tracer.upsertAgentSession({
      runId,
      agent: 'builder',
      model: 'scripted',
      reasoningEffort: 'medium',
      agentSessionId: 'abandoned-roster-session',
      mode: 'pi',
      color: '#5ad2dd',
    });

    const continued = scriptedAgent([buildEnvelope()], [], [], { sessionIdPrefix: 'k' });
    await continueRun(runId, continued);

    // Neither persisted row is reopened, and the roster model is the one the
    // restarted phase runs on.
    expect(continued.reopened).toEqual([{ agent: 'builder', existingSessionId: null }]);
    expect(turnRequests(continued)[0]!.sessionId).toBe('k1');
    const agentStart = events(runId)
      .filter((e) => e.type === 'agent_start')
      .at(-1);
    expect(agentStart!.payload.model).toBe('scripted');
  });

  it('sends a full prompt with a recovery note instead of a delta', async () => {
    const { runId } = await killedRun();
    const continued = scriptedAgent([buildEnvelope()], [], [], { sessionIdPrefix: 'k' });
    await continueRun(runId, continued);

    const prompt = turnRequests(continued)[0]!.text;
    // Full: the new session holds nothing, so the phase's own ask is re-sent.
    expect(prompt).toContain('Build: do the thing');
    expect(prompt).toContain('## Report');
    expect(prompt).toContain('## Recovering an interrupted attempt');
    expect(prompt).toContain('stopped by the operator while the "build" phase');
    expect(prompt).toMatch(/may already contain partial/);
    expect(events(runId)).toContainEqual(
      expect.objectContaining({
        type: 'log',
        name: 'prompt',
        payload: expect.objectContaining({ phase: 'build', kind: 'full' }),
      }),
    );
  });

  it('keeps earlier phases and the dirty worktree rather than replaying setup', async () => {
    const { runId } = await killedRun();
    const worktree = h.tracer.run(runId)!.worktreePath!;
    // A partial write from the killed attempt, which the operator's Continue
    // must not roll back: earlier phases wrote into the same tree.
    writeFileSync(join(worktree, 'half-written.txt'), 'from the killed attempt\n');
    const phaseIds = h.tracer.phases(runId).map((phase) => phase.phaseId);

    const continued = scriptedAgent([buildEnvelope()], [], [], { sessionIdPrefix: 'k' });
    const outcome = await continueRun(runId, continued);

    expect(outcome.status).toBe('accepted');
    expect(h.tracer.phases(runId).map((phase) => phase.phaseId)).toEqual(phaseIds);
    // The code phase that already passed is not re-run, so its append-only
    // marker still reads once.
    expect(readFileSync(join(worktree, 'prepare-count'), 'utf8')).toBe('prepared\n');
    expect(readFileSync(join(worktree, 'half-written.txt'), 'utf8')).toBe(
      'from the killed attempt\n',
    );
  });

  it('refuses a merged killed run', async () => {
    const { runId } = await killedRun();
    h.tracer.setMerged(runId, true);

    await expect(continueRun(runId, scriptedAgent([buildEnvelope()]))).rejects.toThrow(
      'a merged run cannot be continued',
    );
  });

  it('refuses a killed run whose worktree is gone', async () => {
    const { runId } = await killedRun();
    const worktree = h.tracer.run(runId)!.worktreePath!;
    sh(h.repo, ['git', 'worktree', 'remove', '--force', worktree]);

    await expect(continueRun(runId, scriptedAgent([buildEnvelope()]))).rejects.toThrow(
      'this run’s worktree is no longer available',
    );
  });

  it('refuses a killed run with no failed phase left to continue', async () => {
    const { runId } = await killedRun();
    for (const phase of h.tracer.phases(runId)) {
      if (phase.status === 'fail') h.tracer.closePhase(phase.phaseId, 'success');
    }

    await expect(continueRun(runId, scriptedAgent([buildEnvelope()]))).rejects.toThrow(
      'this run has no failed phase to continue',
    );
  });

  it('refuses a run that settled accepted, naming every continuable status', async () => {
    const scripted = scriptedAgent([buildEnvelope(), buildEnvelope()]);
    const accepted = await run({ scripted, pipeline: killedPipeline() });
    expect(accepted.status).toBe('accepted');

    await expect(continueRun(accepted.runId, scriptedAgent([buildEnvelope()]))).rejects.toThrow(
      'only a rejected, failed, or killed run can be continued',
    );
  });
});

/**
 * The registry's own gate on Continue — what the desktop banner, the Companion
 * route, and Smith all reach through.
 *
 * The pipeline here is code-only on purpose: a registry-launched run builds its
 * own transport, and there is no model in a unit test. What is under test is
 * eligibility and the launch, not the agent path the executor suite above
 * already covers.
 */
describe('the registry gate on continuing a killed run', () => {
  function registry(): RunRegistry {
    return new RunRegistry({
      appSupportDir: h.support,
      settings: () => ({ compactionThreshold: 0.8 }) as AppSettings,
      engineerName: 'test',
      onRunFinished: () => undefined,
      onInterruptsChanged: () => undefined,
      onRunsChanged: () => undefined,
    });
  }

  /**
   * A killed run whose interrupted phase is a command that fails until a
   * sentinel exists — so continuing it can actually converge without a model.
   */
  async function killedCodeRun(): Promise<{ runId: string; worktree: string }> {
    const pipeline = pipe(
      [codePhase('gate', { argv: ['sh', '-c', 'test -f go'] }, { heal: false })],
      { description: 'a command the operator stopped the run over' },
    );
    const outcome = await run({ pipeline });
    expect(outcome.status).toBe('rejected');
    // The trace a kill leaves: a terminal `killed` row over a red phase, with
    // the worktree kept.
    h.tracer.finishRun(outcome.runId, 'killed', 'the run was killed');
    const worktree = h.tracer.run(outcome.runId)!.worktreePath!;
    return { runId: outcome.runId, worktree };
  }

  const resumeInput = (runId: string) => ({
    project: h.project,
    runId,
    agents: [buildAgent()],
    envelopeDefs: [],
  });

  it('accepts a killed run and re-runs the command it stopped', async () => {
    const { runId, worktree } = await killedCodeRun();
    writeFileSync(join(worktree, 'go'), '');

    const runs = registry();
    // A killed *command* is not a restart: there is no conversation to
    // abandon, so the operator is told the ordinary thing.
    const answer = runs.resume(resumeInput(runId));
    expect(answer).toEqual({ ok: true, detail: 'Continuing from “gate”…' });

    await until(() => !runs.isLive(runId), 'the continued run to settle');
    expect(runs.tracerFor(h.project).run(runId)!.status).toBe('accepted');
  });

  it('records no recovery for a killed command phase', async () => {
    const { runId, worktree } = await killedCodeRun();
    writeFileSync(join(worktree, 'go'), '');

    const runs = registry();
    expect(runs.resume(resumeInput(runId)).ok).toBe(true);
    await until(() => !runs.isLive(runId), 'the continued run to settle');

    // Nothing was moved off a session, so a `run recovered` row would claim a
    // recovery that never happened — and could never be completed, because no
    // session opens to supply the successor id.
    expect(events(runId).filter((e) => e.name === 'run recovered')).toEqual([]);
    expect(events(runId).find((e) => e.name === 'run continued')!.payload).toMatchObject({
      phase: 'gate',
      fromStatus: 'killed',
      strategy: 'reopen_session',
    });
  });

  it('still calls a failed run a continuation rather than a restart', async () => {
    const pipeline = pipe(
      [codePhase('gate', { argv: ['sh', '-c', 'test -f go'] }, { heal: false })],
      { description: 'a command that simply failed' },
    );
    const outcome = await run({ pipeline });
    expect(outcome.status).toBe('rejected');

    expect(registry().resume(resumeInput(outcome.runId)).detail).toBe('Continuing from “gate”…');
  });

  it('refuses a merged killed run, a missing worktree, and a run with nothing red', async () => {
    const merged = await killedCodeRun();
    h.tracer.setMerged(merged.runId, true);
    expect(registry().resume(resumeInput(merged.runId))).toEqual({
      ok: false,
      detail: 'a merged run cannot be continued',
    });

    const discarded = await killedCodeRun();
    sh(h.repo, ['git', 'worktree', 'remove', '--force', discarded.worktree]);
    expect(registry().resume(resumeInput(discarded.runId))).toEqual({
      ok: false,
      detail: 'this run’s worktree is no longer available',
    });

    const green = await killedCodeRun();
    for (const phase of h.tracer.phases(green.runId)) {
      h.tracer.closePhase(phase.phaseId, 'success');
    }
    expect(registry().resume(resumeInput(green.runId))).toEqual({
      ok: false,
      detail: 'this run has no failed phase to continue',
    });
  });

  it('refuses an accepted run by naming every continuable status', async () => {
    const outcome = await run({
      pipeline: pipe([codePhase('gate', { argv: ['true'] })], { description: 'a green run' }),
    });
    expect(outcome.status).toBe('accepted');

    expect(registry().resume(resumeInput(outcome.runId))).toEqual({
      ok: false,
      detail: 'only a rejected, failed, or killed run can be continued',
    });
  });
});

/**
 * What is filling an agent's context. The session is the only thing that can
 * answer, and it dies with the run, so the answer has to outlive it or the
 * Inspector shows every finished run the same empty panel.
 */
describe('the context breakdown an agent leaves behind', () => {
  function registry(): RunRegistry {
    return new RunRegistry({
      appSupportDir: h.support,
      settings: () => ({}) as AppSettings,
      engineerName: 'test',
      onRunFinished: () => undefined,
      onInterruptsChanged: () => undefined,
      onRunsChanged: () => undefined,
    });
  }

  it('records the breakdown each turn produced with the run files', async () => {
    const scripted = scriptedAgent([buildEnvelope()]);
    const outcome = await run({
      scripted,
      pipeline: pipe([agentPhase('build', { description: 'Produce one turn to snapshot.' })], {
        description: 'a run whose breakdown is kept',
        acceptance: { kind: 'envelope_status', phase: 'build' },
      }),
    });

    expect(outcome.status).toBe('accepted');
    const captured = h.tracer.readRunJson<{
      capturedAt: string;
      breakdown: { modelId: string; usedTokens: number; freeTokens: number; contextBudget: number };
    }>(outcome.runId, breakdownFile('builder'));
    // Context stats and the breakdown come off the same session, so the
    // occupancy the agent reports and the one the snapshot keeps are one number.
    expect(captured?.breakdown.usedTokens).toBe(1234);
    // Used plus free is the whole budget: the lane draws the bar from these two
    // numbers alone, so a drift between them would show as a gap or an overflow.
    expect(captured!.breakdown.usedTokens + captured!.breakdown.freeTokens).toBe(
      captured!.breakdown.contextBudget,
    );
    expect(captured?.breakdown.modelId).toBe('scripted');
    expect(Date.parse(captured!.capturedAt)).toBeGreaterThan(0);
  });

  it('answers for a finished run from that record, marked as not live', async () => {
    const scripted = scriptedAgent([buildEnvelope()]);
    const outcome = await run({
      scripted,
      pipeline: pipe([agentPhase('build', { description: 'Produce one turn to snapshot.' })], {
        description: 'a finished run still explains its context',
        acceptance: { kind: 'envelope_status', phase: 'build' },
      }),
    });

    const result = await registry().contextBreakdown(h.project, outcome.runId, 'builder');
    expect(result.breakdown?.usedTokens).toBe(1234);
    expect(result.live).toBe(false);
    expect(result.capturedAt).toBeTruthy();
    expect(result.reason).toBeUndefined();
  });

  it('says why there is nothing rather than answering with an empty breakdown', async () => {
    const result = await registry().contextBreakdown(h.project, 'run_never_existed', 'builder');
    expect(result.breakdown).toBeNull();
    expect(result.reason).toBe('not_live');
  });
});

/**
 * Rewind correction loops. After N failed corrections PhaseRewinder rewinds
 * the session before the retry turn — without extending budgets. File restore
 * itself is covered in tests/rewinder.test.ts.
 */
describe('rewind correction policy', () => {
  const PHASE_START = 'phase-start content\n';
  const seedThenBuild = (): PipelineDef =>
    pipe(
      [
        codePhase(
          'seed',
          { argv: ['sh', '-c', 'printf "phase-start content\\n" > watched.txt'] },
          { description: 'Leave a dirty file the agent phase will snapshot.' },
        ),
        agentPhase('build', {
          description: 'Fail twice so the 2nd correction rewinds, then succeed.',
        }),
      ],
      {
        description: 'seed a dirty file, then an agent phase that rewinds',
        acceptance: { kind: 'envelope_status', phase: 'build' },
      },
    );

  function corrections(runId: string) {
    return events(runId).filter((e) => e.type === 'correction');
  }

  it('rewinds on the 2nd correction and retries on the rewound session', async () => {
    const scripted = scriptedAgent(
      ['prose', 'still prose', buildEnvelope()],
      ['watched.txt', 'watched.txt', null],
      [],
      { rewindFiles: { 'watched.txt': PHASE_START } },
    );
    const outcome = await run({
      scripted,
      envelopeRetries: 2,
      pipeline: seedThenBuild(),
    });
    expect(outcome.status).toBe('accepted');

    const wire = wireLog(scripted);
    expect(wire).toContain('get_rewind_info');
    expect(wire).toContain('rewind');
    // The engine asks what a rewind could restore before it rewinds, and the
    // retry turn comes after both.
    const infoAt = wire.indexOf('get_rewind_info');
    const rewindAt = wire.indexOf('rewind');
    expect(infoAt).toBeGreaterThanOrEqual(0);
    expect(rewindAt).toBeGreaterThan(infoAt);
    const turns = wire.filter((line) => line.startsWith('turn_started'));
    expect(turns).toHaveLength(3);
    // A rewind moves the session back through its own history rather than
    // minting a new one, so every turn is the same session.
    for (const turn of turns) expect(turn).toContain('session=s1');
    expect(h.tracer.agentSessions(outcome.runId)[0]!.agentSessionId).toBe('s1');

    const rewound = corrections(outcome.runId).filter((e) => e.payload.rewind === true);
    expect(rewound).toHaveLength(1);
    expect(rewound[0]!.payload.correctionIndex).toBe(2);
    expect(rewound[0]!.payload.restoredCount).toBe(1);
    expect(rewound[0]!.payload.deletedCount).toBe(0);
    // No novel event type — architecture reuses correction.
    expect(events(outcome.runId).map((e) => e.type)).not.toContain('rewind');
  });

  it('falls back to append-style correction when rewind fails', async () => {
    const scripted = scriptedAgent(['prose', 'still prose', buildEnvelope()], [], [], {
      rewindFiles: { 'watched.txt': PHASE_START },
      rewindFails: true,
    });
    const outcome = await run({
      scripted,
      envelopeRetries: 2,
      pipeline: seedThenBuild(),
    });
    // A refused rewind must not fail the phase: the append-style retry still runs.
    expect(outcome.status).toBe('accepted');
    expect(wireLog(scripted)).toContain('get_rewind_info');
    expect(wireLog(scripted)).not.toContain('rewind');
    // All three turns stayed on the original session.
    const turns = wireLog(scripted).filter((line) => line.startsWith('turn_started'));
    expect(turns).toHaveLength(3);
    for (const turn of turns) expect(turn).toContain('session=s1');
    expect(h.tracer.agentSessions(outcome.runId)[0]!.agentSessionId).toBe('s1');
    expect(corrections(outcome.runId).some((e) => e.payload.rewind === true)).toBe(false);
    expect(events(outcome.runId).some((e) => e.name === 'builder: rewind failed')).toBe(true);
  });

  it('disables rewind entirely when rewindAfterCorrections is 0', async () => {
    const scripted = scriptedAgent(['prose', 'still prose', buildEnvelope()], [], [], {
      rewindFiles: { 'watched.txt': PHASE_START },
    });
    const outcome = await run({
      scripted,
      envelopeRetries: 2,
      rewindAfterCorrections: 0,
      pipeline: seedThenBuild(),
    });
    expect(outcome.status).toBe('accepted');
    expect(wireLog(scripted)).not.toContain('get_rewind_info');
    expect(wireLog(scripted)).not.toContain('rewind');
    expect(corrections(outcome.runId).some((e) => e.payload.rewind === true)).toBe(false);
  });

  it('does not extend the envelope budget when a rewind runs', async () => {
    // Every reply is prose: envelopeRetries+1 attempts, then the phase fails.
    // Rewind on the 2nd correction must not buy an extra turn.
    const scripted = scriptedAgent(['no', 'still no', 'nope', 'never'], [], [], {
      rewindFiles: { 'watched.txt': PHASE_START },
    });
    const outcome = await run({
      scripted,
      envelopeRetries: 2,
      rewindAfterCorrections: 2,
      pipeline: seedThenBuild(),
    });
    expect(outcome.status).toBe('rejected');
    expect(h.tracer.phases(outcome.runId).find((p) => p.name === 'build')!.status).toBe('fail');
    // envelopeRetries + 1 turn attempts, exactly — rewind consumed a correction
    // slot inside that envelope, it did not add one.
    expect(turnRequests(scripted)).toHaveLength(3);
    expect(wireLog(scripted)).toContain('rewind');
    const envelopeCorrections = corrections(outcome.runId).filter(
      (e) => e.name === 'envelope did not parse',
    );
    expect(envelopeCorrections).toHaveLength(3);
  });
});

/** VAL-CROSS-009 — rewind and compaction coexist without trace corruption. */
describe('rewind and compaction coexist (VAL-CROSS-009)', () => {
  const PHASE_START = 'phase-start content\n';

  it('records both a rewind and a compaction, keeps event ordering and the session row intact', async () => {
    // Two agent phases: phase-one trips a rewind on its 2nd correction; between
    // phases the session is full and gets compacted before phase-two.
    const scripted = scriptedAgent(
      ['prose', 'still prose', buildEnvelope(), buildEnvelope()],
      ['watched.txt', 'watched.txt', null, null],
      [],
      {
        rewindFiles: { 'watched.txt': PHASE_START },
        contextUsed: 85_000,
        contextUsedAfterCompaction: 8_500,
      },
    );
    const outcome = await run({
      scripted,
      envelopeRetries: 2,
      compactionThreshold: 0.8,
      rewindAfterCorrections: 2,
      pipeline: pipe(
        [
          codePhase(
            'seed',
            { argv: ['sh', '-c', 'printf "phase-start content\\n" > watched.txt'] },
            { description: 'Seed a dirty file so rewind has something to restore.' },
          ),
          agentPhase('one', {
            description: 'Fail twice to trigger rewind on the 2nd correction, then succeed.',
          }),
          agentPhase('two', { description: 'Run after the compaction.' }),
        ],
        {
          description: 'rewind in phase-one + compaction between phases',
          acceptance: { kind: 'all_phases_pass' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    const runId = outcome.runId;

    // Both event kinds are present in the same run.
    const all = events(runId);
    const hadRewind = all.some((e) => e.type === 'correction' && e.payload.rewind === true);
    const hadCompaction = all.some((e) => e.type === 'compaction');
    expect(hadRewind).toBe(true);
    expect(hadCompaction).toBe(true);

    // Every payload is valid JSON (tracer stores object, not string — assert no null payloads).
    for (const e of all) {
      expect(e.payload).not.toBeNull();
      expect(typeof e.payload).toBe('object');
    }

    // change_id replay yields all rows once (cursor pagination, same as VAL-CROSS-006).
    let cursor = 0;
    const replayed: ReturnType<typeof events> = [];
    for (;;) {
      const page = h.tracer.eventsAfter(runId, cursor, 10);
      if (!page.length) break;
      replayed.push(...page);
      cursor = page[page.length - 1]!.changeId;
    }
    expect(replayed).toHaveLength(all.length);
    const ids = replayed.map((r) => r.changeId);
    for (let i = 1; i < ids.length; i++) expect(ids[i]!).toBeGreaterThan(ids[i - 1]!);
    const byId = new Map(replayed.map((r) => [r.eventId, r]));
    expect(byId.size).toBe(replayed.length);

    // One agent_sessions row for the agent, re-persisted by both the rewind and
    // the compaction rather than duplicated by either.
    const sessions = h.db
      .prepare(
        'SELECT agent, agent_session_id FROM agent_sessions WHERE run_id = ? ORDER BY last_used_at',
      )
      .all(runId) as { agent: string; agent_session_id: string }[];
    expect(sessions.some((s) => s.agent === 'builder')).toBe(true);
    const builder = sessions.find((s) => s.agent === 'builder')!;
    expect(builder.agent_session_id).toBeTruthy();

    expect(h.tracer.run(runId)!.outcomeDetail).toBeTruthy();
  });
});

/**
 * VAL-PROD-012 — a session that cannot start surfaces as a settled failure, not
 * a hang and not a quiet downgrade. There is one transport an agent run has, so
 * "cannot start it" has to reach the operator as a failed run carrying the
 * reason; the old behaviour (fall through to a subprocess, then to a one-shot
 * child that never consults the policy) finished the run under a weaker policy
 * than was configured and said nothing.
 */
describe('a session that will not start (VAL-PROD-012)', () => {
  it('settles failed with a legible outcome_detail rather than degrading', async () => {
    const outcome = await run({
      sessionUnavailable: 'no model provider is configured',
      pipeline: pipe([agentPhase('build', { description: 'the session cannot start' })], {
        description: 'a session that will not start',
        acceptance: { kind: 'envelope_status', phase: 'build' },
      }),
    });

    // No hang, no perpetual running — run settles terminal.
    expect(['failed', 'rejected']).toContain(outcome.status);
    const row = h.tracer.run(outcome.runId)!;
    expect(row.outcomeDetail).toBeTruthy();
    // The trace explains the root cause rather than masking it.
    const combined = events(outcome.runId)
      .map((e) => JSON.stringify(e.payload))
      .join('\n');
    expect(combined).toMatch(/agent session start failed/i);
    expect(combined).toMatch(/no model provider is configured/i);
  });
});

/**
 * FOU-17 — the PR phase is an ordinary agent phase whose envelope the engine
 * acts on: it pushes `foundry/<runId>` and runs `gh pr create`, then records
 * the number and URL on the run. FOU-15 governs the failures: every one is a
 * hard fail carrying the exact error, and none of them invents a PR.
 */
describe('open_pr phase (FOU-17)', () => {
  it('pushes the run branch, creates the PR, and records its number and url', async () => {
    const bare = addOrigin(h.repo);
    const scripted = scriptedAgent([prEnvelope()]);
    const gh = makeFakeGh({ createUrl: 'https://github.com/acme/widgets/pull/42' });

    const outcome = await run({
      scripted,
      agents: [prWriter()],
      gh: { bin: gh.bin },
      pipeline: pipe([openPrPhase()], {
        description: 'draft and open the pull request',
        acceptance: { kind: 'envelope_status', phase: 'open_pr' },
      }),
    });

    expect(outcome.status).toBe('accepted');
    const row = h.tracer.run(outcome.runId)!;
    expect(row.prNumber).toBe(42);
    expect(row.prUrl).toBe('https://github.com/acme/widgets/pull/42');

    // gh could only have seen a head the engine had already pushed.
    const branch = `foundry/${outcome.runId}`;
    expect(sh(bare, ['git', 'rev-parse', `refs/heads/${branch}`]).trim()).toBeTruthy();

    // The envelope's title and body are what reached `gh pr create`, and the
    // PR targets the project base ref rather than whatever gh would default to.
    const create = gh.calls().find((argv) => argv[0] === 'pr' && argv[1] === 'create')!;
    expect(create).toBeDefined();
    expect(create).toContain('--head');
    expect(create).toContain(branch);
    expect(create).toContain('--base');
    expect(create).toContain('main');
    expect(create).toContain('Add the thing');
    expect(create.join('\n')).toContain('## Summary');
  });

  it('renders bounded accumulated git context only into a diff-consuming phase', async () => {
    addOrigin(h.repo);
    const branchPoint = sh(h.repo, ['git', 'rev-parse', 'HEAD']).trim();
    const scripted = scriptedAgent([buildEnvelope(), prEnvelope()], ['README.md', null]);
    const gh = makeFakeGh({ createUrl: 'https://github.com/acme/widgets/pull/8' });

    const outcome = await run({
      scripted,
      agents: [buildAgent(), prWriter()],
      gh: { bin: gh.bin },
      pipeline: pipe([agentPhase('build'), openPrPhase()], {
        description: 'render branch and base ref',
        acceptance: { kind: 'envelope_status', phase: 'open_pr' },
      }),
    });

    const buildPrompt = h.tracer.readPrompt(outcome.runId, 'builder', 'build');
    const prompt = h.tracer.readPrompt(outcome.runId, 'pr_writer', 'open_pr');
    expect(buildPrompt).not.toContain('## Accumulated git context');
    expect(prompt).toContain('## Accumulated git context');
    expect(prompt).toContain(`foundry/${outcome.runId}`);
    expect(prompt).toContain('- Base ref: main');
    expect(prompt).toContain(`- Branch point: ${branchPoint}`);
    expect(prompt).toMatch(/README\.md\s+\|/);
    const stat = prompt.match(/```text\n([\s\S]*?)\n```/)?.[1] ?? '';
    expect(stat.length).toBeLessThanOrEqual(4000);
  });

  it('reuses the existing PR for a branch instead of opening a second one', async () => {
    addOrigin(h.repo);
    const scripted = scriptedAgent([prEnvelope()]);
    // `gh pr create` failing on an existing PR is how a re-run looks; openPr
    // answers with the PR already there rather than a duplicate or an error.
    const gh = makeFakeGh({
      createError: 'a pull request for branch already exists',
      prView: {
        number: 7,
        url: 'https://github.com/acme/widgets/pull/7',
        headRefName: 'foundry/x',
        baseRefName: 'main',
      },
    });

    const outcome = await run({
      scripted,
      agents: [prWriter()],
      gh: { bin: gh.bin },
      pipeline: pipe([openPrPhase()], {
        description: 'discover the pull request that already exists',
        acceptance: { kind: 'envelope_status', phase: 'open_pr' },
      }),
    });

    expect(outcome.status).toBe('accepted');
    const row = h.tracer.run(outcome.runId)!;
    expect(row.prNumber).toBe(7);
    expect(row.prUrl).toBe('https://github.com/acme/widgets/pull/7');
    // Deduplication is a discovery, not a second create.
    expect(gh.calls().filter((argv) => argv[0] === 'pr' && argv[1] === 'create')).toHaveLength(1);
  });

  it('hard fails with the exact gh error, records no PR, and keeps the worktree', async () => {
    addOrigin(h.repo);
    const scripted = scriptedAgent([prEnvelope()]);
    const gh = makeFakeGh({ createError: 'GraphQL: Resource not accessible by integration' });

    const outcome = await run({
      scripted,
      agents: [prWriter()],
      gh: { bin: gh.bin },
      pipeline: pipe([openPrPhase()], {
        description: 'surface a refused pull request',
        acceptance: { kind: 'envelope_status', phase: 'open_pr' },
      }),
    });

    expect(outcome.status).toBe('rejected');
    const row = h.tracer.run(outcome.runId)!;
    expect(row.prNumber).toBeNull();
    expect(row.prUrl).toBeNull();
    // The operator gets gh's own words, not a paraphrase.
    expect(row.outcomeDetail).toContain('Resource not accessible by integration');
    const phase = h.tracer.phases(outcome.runId)[0]!;
    expect(phase.status).toBe('fail');
    expect(phase.error).toContain('Resource not accessible by integration');
    // The manual "Open PR…" fallback needs the branch and worktree intact.
    expect(row.branch).toBe(`foundry/${outcome.runId}`);
    expect(existsSync(row.worktreePath!)).toBe(true);
  });

  it('fails without reaching gh when the repo has no remote to push to', async () => {
    const scripted = scriptedAgent([prEnvelope()]);
    const gh = makeFakeGh();

    const outcome = await run({
      scripted,
      agents: [prWriter()],
      gh: { bin: gh.bin },
      pipeline: pipe([openPrPhase()], {
        description: 'a checkout with nowhere to push',
        acceptance: { kind: 'envelope_status', phase: 'open_pr' },
      }),
    });

    expect(outcome.status).toBe('rejected');
    expect(h.tracer.run(outcome.runId)!.outcomeDetail).toContain('no git remote');
    expect(gh.calls().some((argv) => argv[0] === 'pr' && argv[1] === 'create')).toBe(false);
  });

  /**
   * The failure this phase exists to prevent: a chain whose acceptance is an
   * earlier phase's flag must not settle accepted when the PR never opened.
   */
  it('rejects the whole run even when an earlier phase already approved it', async () => {
    addOrigin(h.repo);
    const scripted = scriptedAgent([reviewEnvelope(true), prEnvelope()]);
    const gh = makeFakeGh({ createError: 'could not create pull request' });

    const outcome = await run({
      scripted,
      agents: [buildAgent({ name: 'reviewer', envelope: 'review', writes: [] }), prWriter()],
      gh: { bin: gh.bin },
      pipeline: pipe(
        [
          agentPhase('review', {
            agent: 'reviewer',
            envelope: 'review',
            description: 'Approve the work so acceptance would otherwise pass.',
          }),
          openPrPhase({ prompt: { inputs: ['request'] } }),
        ],
        {
          description: 'approved work whose pull request could not be opened',
          acceptance: { kind: 'phase_flag', phase: 'review', flag: 'approved' },
        },
      ),
    });

    expect(outcome.status).toBe('rejected');
    expect(h.tracer.run(outcome.runId)!.prUrl).toBeNull();
    expect(h.tracer.phases(outcome.runId).map((p) => p.status)).toEqual(['success', 'fail']);
  });

  it('never opens a PR for a pipeline that runs without isolation', async () => {
    addOrigin(h.repo);
    const scripted = scriptedAgent([prEnvelope()]);
    const gh = makeFakeGh();

    const outcome = await run({
      scripted,
      agents: [prWriter()],
      gh: { bin: gh.bin },
      pipeline: pipe([openPrPhase()], {
        description: 'no worktree, so there is no run branch to open a PR from',
        isolation: false,
        acceptance: { kind: 'envelope_status', phase: 'open_pr' },
      }),
    });

    expect(outcome.status).toBe('rejected');
    expect(h.tracer.run(outcome.runId)!.outcomeDetail).toContain('no branch');
    expect(gh.calls()).toEqual([]);
  });

  it('fails a pr envelope whose title or body is blank rather than opening an empty PR', async () => {
    addOrigin(h.repo);
    // A schema-valid envelope can still carry whitespace, which would become a
    // PR with no title. The engine refuses before touching the remote.
    const scripted = scriptedAgent([prEnvelope({ title: '   ' })]);
    const gh = makeFakeGh();

    const outcome = await run({
      scripted,
      agents: [prWriter()],
      gh: { bin: gh.bin },
      pipeline: pipe([openPrPhase()], {
        description: 'a blank title must not reach gh',
        acceptance: { kind: 'envelope_status', phase: 'open_pr' },
      }),
    });

    expect(outcome.status).toBe('rejected');
    expect(h.tracer.run(outcome.runId)!.outcomeDetail).toContain('title or body');
    expect(gh.calls()).toEqual([]);
  });
});

/**
 * FOU-80 — the issue phase mirrors the PR phase's contract: the agent only
 * drafts, the engine runs `gh issue create` and records the number and URL on
 * the run, and a phase that could not file the issue hard-fails the run with
 * the exact gh error.
 */
describe('file_issue phase (FOU-80)', () => {
  it('files the issue and records its number and url on the run', async () => {
    const scripted = scriptedAgent([issueEnvelope({ labels: ['bug'] })]);
    const gh = makeFakeGh({ issueUrl: 'https://github.com/acme/widgets/issues/33' });

    const outcome = await run({
      scripted,
      agents: [issueWriter()],
      gh: { bin: gh.bin },
      pipeline: pipe([fileIssuePhase()], {
        description: 'draft and file the github issue',
        acceptance: { kind: 'envelope_status', phase: 'file_issue' },
      }),
    });

    expect(outcome.status).toBe('accepted');
    const row = h.tracer.run(outcome.runId)!;
    expect(row.issueNumber).toBe(33);
    expect(row.issueUrl).toBe('https://github.com/acme/widgets/issues/33');
    // The PR columns stay untouched: an issue is not a pull request.
    expect(row.prNumber).toBeNull();
    expect(row.prUrl).toBeNull();

    const create = gh.calls().find((argv) => argv[0] === 'issue' && argv[1] === 'create')!;
    expect(create).toBeDefined();
    expect(create).toContain('--title');
    expect(create).toContain('Fix the thing');
    expect(create).toContain('--label');
    expect(create).toContain('bug');
    expect(create.join('\n')).toContain('## Problem');

    // The trace carries the created issue, so the outcome is inspectable.
    const issueLog = events(outcome.runId).find((e) => e.name === 'issue create')!;
    expect(issueLog).toBeDefined();
    expect(issueLog.payload.number).toBe(33);
    expect(issueLog.payload.url).toBe('https://github.com/acme/widgets/issues/33');
  });

  it('hard fails the run with the exact gh error when the create is refused', async () => {
    const scripted = scriptedAgent([issueEnvelope()]);
    const gh = makeFakeGh({ issueCreateError: 'GraphQL: Resource not accessible by integration' });

    const outcome = await run({
      scripted,
      agents: [issueWriter()],
      gh: { bin: gh.bin },
      pipeline: pipe([fileIssuePhase()], {
        description: 'surface a refused issue create',
        acceptance: { kind: 'envelope_status', phase: 'file_issue' },
      }),
    });

    expect(outcome.status).toBe('rejected');
    const row = h.tracer.run(outcome.runId)!;
    expect(row.issueNumber).toBeNull();
    expect(row.issueUrl).toBeNull();
    expect(row.outcomeDetail).toContain('Resource not accessible by integration');
    const phase = h.tracer.phases(outcome.runId)[0]!;
    expect(phase.status).toBe('fail');
  });

  it('rejects the whole run even when a later phase would have settled acceptance', async () => {
    const scripted = scriptedAgent([issueEnvelope(), buildEnvelope()]);
    const gh = makeFakeGh({ issueCreateError: 'no issues enabled on this repository' });

    const outcome = await run({
      scripted,
      agents: [issueWriter(), buildAgent()],
      gh: { bin: gh.bin },
      pipeline: pipe([fileIssuePhase(), agentPhase('build')], {
        description: 'an aborted issue phase must not fall through to acceptance',
        acceptance: { kind: 'all_phases_pass' },
      }),
    });

    expect(outcome.status).toBe('rejected');
    expect(h.tracer.run(outcome.runId)!.outcomeDetail).toContain('no issues enabled');
  });

  it('fails an issue envelope whose title or body is blank rather than filing an empty issue', async () => {
    const scripted = scriptedAgent([issueEnvelope({ title: '   ' })]);
    const gh = makeFakeGh();

    const outcome = await run({
      scripted,
      agents: [issueWriter()],
      gh: { bin: gh.bin },
      pipeline: pipe([fileIssuePhase()], {
        description: 'a blank title must not reach gh',
        acceptance: { kind: 'envelope_status', phase: 'file_issue' },
      }),
    });

    expect(outcome.status).toBe('rejected');
    expect(h.tracer.run(outcome.runId)!.outcomeDetail).toContain('title or body');
    expect(gh.calls()).toEqual([]);
  });
});
