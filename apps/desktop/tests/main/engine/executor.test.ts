/**
 * Executor test suite — split across files to parallelize over CPU cores.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createHarness,
  sh,
  scriptedAgent,
  turnRequests,
  buildAgent,
  codePhase,
  agentPhase,
  pipe,
  linearSource,
  buildEnvelope,
  runForHarness,
  eventsForHarness,
  type Harness,
  type RunInput,
} from './executor-harness.js';
import type { EnvelopeDef, PipelineDef } from '../../../src/shared/types.js';

let h: Harness;

beforeEach(() => {
  h = createHarness();
});
const run = (input: RunInput) => runForHarness(h, input);
const events = (runId: string) => eventsForHarness(h, runId);

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
    expect(system).toContain('# Repository context');
    expect(system).toContain('## Stack\nTypeScript');
    expect(system).toContain(
      `this pipeline's worktree at ${h.tracer.run(outcome.runId)!.worktreePath}`,
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

  it('fails artifacts_exist and files_non_empty when the envelope declares none', async () => {
    const scripted = scriptedAgent([buildEnvelope({ artifacts: [] })]);
    const outcome = await run({
      scripted,
      pipeline: pipe(
        [
          agentPhase('build', {
            description: 'An empty artifact list is a vacuous pass unless the gates fail it.',
            gates: ['artifacts_exist', 'files_non_empty'],
          }),
        ],
        {
          description: 'empty artifacts must fail the existence and non-empty gates',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });
    expect(outcome.status).toBe('rejected');
    const gates = h.tracer.gateResults(outcome.runId);
    expect(gates.map((g) => [g.gate, g.passed])).toEqual([
      ['artifacts_exist', false],
      ['files_non_empty', false],
    ]);
  });

  it('passes planner gates when the spec file is declared and non-empty', async () => {
    const planBody = {
      status: 'success',
      summary: 'planned',
      artifacts: ['specs/run-plan.md'],
      notes_for_next_agent: '',
      commit_message: 'add the plan',
      files_to_touch: ['README.md'],
      steps: ['add a usage section'],
      verification: ['readme still renders'],
    };
    const scripted = scriptedAgent([JSON.stringify(planBody)], ['specs/run-plan.md']);
    const outcome = await run({
      scripted,
      agents: [buildAgent({ name: 'planner', envelope: 'plan', writes: ['specs/'] })],
      pipeline: pipe(
        [
          agentPhase('plan', {
            agent: 'planner',
            envelope: 'plan',
            description: 'Write a spec file and declare it.',
            gates: ['artifacts_exist', 'files_non_empty'],
          }),
        ],
        {
          description: 'planner happy-path with a declared spec',
          acceptance: { kind: 'envelope_status', phase: 'plan' },
        },
      ),
    });
    expect(outcome.status).toBe('accepted');
    const gates = h.tracer.gateResults(outcome.runId);
    expect(gates.map((g) => [g.gate, g.passed])).toEqual([
      ['artifacts_exist', true],
      ['files_non_empty', true],
    ]);
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

    const format = turnRequests(scripted)[0]!.outputFormat as {
      schema: { required?: string[]; properties?: Record<string, unknown> };
    };
    expect(format.schema.required).toContain('severity');
    expect(format.schema.properties).toHaveProperty('severity');
    const prompt = readFileSync(
      join(h.tracer.runDir(outcome.runId), 'builder/prompts/report-1.md'),
      'utf8',
    );
    expect(prompt).toContain('call `submit_envelope` once');
    expect(prompt).not.toContain('low|med|high');
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
