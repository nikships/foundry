/**
 * Executor against real git and a scripted droid stand-in. M3 acceptance
 * criteria: the repair loop converges in-session, boundary violations are
 * reverted with evidence, and a phase that never yields a valid envelope fails.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, projectDbPath, projectRunsDir } from '../src/main/trace/db.js';
import { Tracer } from '../src/main/trace/tracer.js';
import { Executor } from '../src/main/engine/executor.js';
import { defaultProject } from '../src/main/store/projects.js';
import type {
  AgentDef,
  CliConfig,
  CliVendor,
  CommandSpec,
  PhaseDef,
  PipelineDef,
  ProjectDef,
} from '../src/shared/types.js';
import { CLI_VENDOR_IDS } from '../src/shared/types.js';

function sh(cwd: string, argv: string[]): string {
  return execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8' });
}

function scratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-exec-'));
  sh(dir, ['git', 'init', '-q', '-b', 'main']);
  sh(dir, ['git', 'config', 'user.email', 'test@foundry.local']);
  sh(dir, ['git', 'config', 'user.name', 'Foundry Test']);
  writeFileSync(join(dir, 'README.md'), '# scratch\n');
  sh(dir, ['git', 'add', '-A']);
  sh(dir, ['git', 'commit', '-qm', 'initial']);
  return dir;
}

/**
 * Droid stand-in whose whole behaviour is a list of scripted turns, so a
 * pipeline's control flow can be tested without a model in the loop.
 */
function scriptedDroid(turns: string[], sideEffects: (string | null)[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-scripted-'));
  const state = join(dir, 'turn-count');
  writeFileSync(state, '0');
  const script = `
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { dirname, join } = require('node:path');
const V = { jsonrpc: '2.0', factoryApiVersion: '1.0.0', factoryProtocolVersion: '1.151.0' };
const TURNS = ${JSON.stringify(turns)};
const EFFECTS = ${JSON.stringify(sideEffects)};
const STATE = ${JSON.stringify(state)};
const cwdIndex = process.argv.indexOf('--cwd');
const workdir = cwdIndex >= 0 ? process.argv[cwdIndex + 1] : process.cwd();
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const notify = (n) => out({ ...V, type: 'notification', method: 'droid.session_notification', params: { sessionId: 's1', notification: n } });
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  let i;
  while ((i = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const { id, method, params = {} } = msg;
    if (method === 'droid.initialize_session' || method === 'droid.load_session') {
      out({ ...V, type: 'response', id, result: { sessionId: 's1', settings: { modelId: 'scripted' }, availableModels: [] } });
    } else if (method === 'droid.add_user_message') {
      out({ ...V, type: 'response', id, result: {} });
      const n = Number(readFileSync(STATE, 'utf8')) || 0;
      writeFileSync(STATE, String(n + 1));
      const effect = EFFECTS[n];
      if (effect) {
        const target = join(workdir, effect);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, 'written by the scripted agent\\n');
      }
      const text = TURNS[Math.min(n, TURNS.length - 1)];
      const messageId = 'm' + n;
      notify({ type: 'create_message', message: { id: messageId, role: 'assistant', content: [{ type: 'text', text }] } });
      notify({ type: 'agent_turn_completed', reason: 'completed', turnId: 't' + n, tokenUsage: { inputTokens: 100, outputTokens: 20, factoryCredits: 1 } });
    } else if (method === 'droid.close_session') {
      out({ ...V, type: 'response', id, result: {} });
      setTimeout(() => process.exit(0), 10);
    } else {
      out({ ...V, type: 'response', id, result: {} });
    }
  }
});
`;
  const js = join(dir, 'scripted.cjs');
  writeFileSync(js, script);
  const bin = join(dir, 'droid');
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
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
    prompt: { template: 'user', inputs: ['request'] },
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

function buildEnvelope(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: 'success',
    summary: 'built it',
    artifacts: [],
    changed_files: [],
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

interface Harness {
  repo: string;
  project: ProjectDef;
  tracer: Tracer;
  support: string;
}

let h: Harness;

beforeEach(() => {
  const repo = scratchRepo();
  const support = mkdtempSync(join(tmpdir(), 'foundry-support-'));
  const db = openDb(projectDbPath(support, repo));
  h = {
    repo,
    support,
    tracer: new Tracer(db, projectRunsDir(support, repo)),
    project: { ...defaultProject(repo), mergePolicy: 'never' },
  };
});

type AskHuman = ConstructorParameters<typeof Executor>[0]['askHuman'];

function run(input: {
  pipeline: PipelineDef;
  agents?: AgentDef[];
  droidPath?: string;
  request?: string;
  project?: Partial<ProjectDef>;
  askHuman?: AskHuman;
  turnTimeoutMs?: number;
  envelopeRetries?: number;
  gateRetries?: number;
}): Promise<{ status: string; runId: string }> {
  const runId = `run_${Math.random().toString(36).slice(2, 8)}`;
  // These tests exercise droid, so every vendor points at the same stub: an
  // agent that names another CLI would otherwise spawn a binary the test
  // environment does not have.
  const path = input.droidPath ?? 'droid-not-used';
  const clis = {} as Record<CliVendor, CliConfig>;
  for (const vendor of CLI_VENDOR_IDS) clis[vendor] = { path, extraArgs: [] };
  const executor = new Executor({
    tracer: h.tracer,
    clis,
    autonomy: 'medium',
    turnTimeoutMs: input.turnTimeoutMs ?? 30_000,
    envelopeRetries: input.envelopeRetries ?? 2,
    gateRetries: input.gateRetries ?? 2,
    agents: input.agents ?? [buildAgent()],
    project: { ...h.project, ...input.project },
    pipeline: input.pipeline,
    request: input.request ?? 'do the thing',
    runId,
    engineer: 'test',
    askHuman: input.askHuman ?? (async () => ({ approve: true })),
  });
  return executor.run().then((o) => ({ status: o.status, runId }));
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
  it('parses an envelope, runs gates, and records both', async () => {
    const droid = scriptedDroid([buildEnvelope({ changed_files: ['made.txt'] })], ['made.txt']);
    const outcome = await run({
      droidPath: droid,
      pipeline: pipe(
        [
          agentPhase('build', {
            description: 'Have the scripted agent make a file and claim it.',
            gates: ['diff_matches_claims'],
          }),
        ],
        {
          description: 'one agent phase with a claims gate',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });
    expect(outcome.status).toBe('accepted');
    const envelopes = h.tracer.envelopes(outcome.runId);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.valid).toBe(true);
    const gates = h.tracer.gateResults(outcome.runId);
    expect(gates[0]!.gate).toBe('diff_matches_claims');
    expect(gates[0]!.passed).toBe(true);
  });

  it('corrects a malformed reply in the same session and then succeeds', async () => {
    const droid = scriptedDroid(['I will explain in prose instead of JSON.', buildEnvelope()]);
    const outcome = await run({
      droidPath: droid,
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
    const droid = scriptedDroid(['never json']);
    const outcome = await run({
      droidPath: droid,
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

  it('fails when the agent itself reports failure', async () => {
    const droid = scriptedDroid([buildEnvelope({ status: 'fail', summary: 'could not do it' })]);
    const outcome = await run({
      droidPath: droid,
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
    const droid = scriptedDroid(
      [buildEnvelope(), buildEnvelope(), buildEnvelope()],
      ['forbidden/x.txt', 'forbidden/x.txt', 'forbidden/x.txt'],
    );
    const outcome = await run({
      droidPath: droid,
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
    const droid = scriptedDroid(
      [buildEnvelope({ changed_files: ['allowed/x.txt'] })],
      ['allowed/x.txt'],
    );
    const outcome = await run({
      droidPath: droid,
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
    // First turn claims a file it never wrote; second turn tells the truth.
    const droid = scriptedDroid(
      [
        buildEnvelope({ changed_files: ['ghost.txt'] }),
        buildEnvelope({ changed_files: ['real.txt'] }),
      ],
      [null, 'real.txt'],
    );
    const outcome = await run({
      droidPath: droid,
      pipeline: pipe(
        [
          agentPhase('build', {
            retries: 1,
            description: 'Prove a gate failure costs one message inside the live session.',
            gates: ['diff_matches_claims'],
          }),
        ],
        {
          description: 'a claims gate rejects the first attempt',
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
    const droid = scriptedDroid([envelope, envelope], [null, 'fix.txt']);

    const outcome = await run({
      droidPath: droid,
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
    const droid = scriptedDroid([envelope]);
    const outcome = await run({
      droidPath: droid,
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

describe('acceptance criteria', () => {
  it('rejects a run whose reviewer did not approve, even though every phase ran', async () => {
    const droid = scriptedDroid([reviewEnvelope(false)]);
    const outcome = await run({
      droidPath: droid,
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
});

describe('engineer phases', () => {
  it('records what the human decided and carries their notes forward', async () => {
    const outcome = await run({
      droidPath: 'unused',
      agents: [],
      request: 'ask me',
      turnTimeoutMs: 5000,
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
      droidPath: 'unused',
      agents: [],
      request: 'ask me',
      turnTimeoutMs: 5000,
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

describe('the trace record', () => {
  it('writes prompts, envelopes, and events to disk as the raw record', async () => {
    const droid = scriptedDroid([buildEnvelope({ summary: 'ok', commit_message: 'x' })]);
    const outcome = await run({
      droidPath: droid,
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
    expect(prompt).toContain('changed_files');
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
});
