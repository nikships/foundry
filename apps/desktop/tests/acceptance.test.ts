/**
 * Acceptance is a pure function of phases, envelopes, and command results, so
 * every criterion is a table row instead of a repo, a db, and a subprocess.
 */

import { describe, expect, it } from 'vitest';
import { decideAcceptance } from '../src/main/engine/acceptance.js';
import type { Acceptance, CommandResult, PhaseRow, PhaseStatus } from '../src/shared/types.js';
import type { Envelope } from '../src/main/engine/envelopes.js';

function phase(name: string, status: PhaseStatus): PhaseRow {
  return {
    phaseId: `ph_${name}`,
    runId: 'run_x',
    seq: 0,
    name,
    kind: 'agent',
    owner: 'builder',
    description: name,
    status,
    attempt: 1,
    error: null,
    startedAt: null,
    endedAt: null,
  };
}

function envelope(over: Partial<Envelope> = {}): Envelope {
  return {
    status: 'success',
    summary: '',
    artifacts: [],
    notes_for_next_agent: '',
    ...over,
  };
}

function result(over: Partial<CommandResult> = {}): CommandResult {
  return {
    name: 'test',
    command: 'test',
    exitCode: 0,
    passed: true,
    durationMs: 1,
    outputTail: '',
    timedOut: false,
    ...over,
  };
}

interface Case {
  name: string;
  acceptance: Acceptance;
  phases: PhaseRow[];
  envelopes?: [string, Envelope][];
  commands?: [string, CommandResult][];
  accepted: boolean;
  /** A substring the reason must contain, so the banner copy is pinned too. */
  reason: string;
}

const CASES: Case[] = [
  // all_phases_pass
  {
    name: 'all green',
    acceptance: { kind: 'all_phases_pass' },
    phases: [phase('a', 'success'), phase('b', 'success')],
    accepted: true,
    reason: 'all 2 phases passed',
  },
  {
    name: 'skipped counts as passing',
    acceptance: { kind: 'all_phases_pass' },
    phases: [phase('a', 'success'), phase('b', 'skipped')],
    accepted: true,
    reason: 'all 2 phases passed',
  },
  {
    name: 'one fail names the phase',
    acceptance: { kind: 'all_phases_pass' },
    phases: [phase('a', 'success'), phase('b', 'fail')],
    accepted: false,
    reason: 'b is fail',
  },
  {
    name: 'a queued phase blocks acceptance',
    acceptance: { kind: 'all_phases_pass' },
    phases: [phase('a', 'fail'), phase('b', 'queued')],
    accepted: false,
    reason: 'b is queued',
  },
  {
    name: 'no phases is vacuously accepted',
    acceptance: { kind: 'all_phases_pass' },
    phases: [],
    accepted: true,
    reason: 'all 0 phases passed',
  },

  // last_phase_pass
  {
    name: 'last green',
    acceptance: { kind: 'last_phase_pass' },
    phases: [phase('a', 'fail'), phase('b', 'success')],
    accepted: true,
    reason: 'the final phase "b" passed',
  },
  {
    name: 'last skipped is not a pass',
    acceptance: { kind: 'last_phase_pass' },
    phases: [phase('a', 'success'), phase('b', 'skipped')],
    accepted: false,
    reason: 'the final phase "b" is skipped',
  },
  {
    name: 'no phases ran',
    acceptance: { kind: 'last_phase_pass' },
    phases: [],
    accepted: false,
    reason: 'the pipeline ran no phases',
  },

  // phase_flag / passed
  {
    name: 'named phase exited 0',
    acceptance: { kind: 'phase_flag', phase: 'test', flag: 'passed' },
    phases: [phase('test', 'success')],
    commands: [['test', result()]],
    accepted: true,
    reason: '"test" exited 0',
  },
  {
    name: 'named phase exited non-zero',
    acceptance: { kind: 'phase_flag', phase: 'test', flag: 'passed' },
    phases: [phase('test', 'success')],
    commands: [['test', result({ passed: false, exitCode: 2 })]],
    accepted: false,
    reason: 'exited 2',
  },
  {
    name: 'abnormal exit reads as abnormally',
    acceptance: { kind: 'phase_flag', phase: 'test', flag: 'passed' },
    phases: [phase('test', 'success')],
    commands: [['test', result({ passed: false, exitCode: null })]],
    accepted: false,
    reason: 'exited abnormally',
  },
  {
    name: 'no command result falls back to phase status',
    acceptance: { kind: 'phase_flag', phase: 'test', flag: 'passed' },
    phases: [phase('test', 'success')],
    accepted: true,
    reason: 'phase "test" passed',
  },
  {
    name: 'phase never ran',
    acceptance: { kind: 'phase_flag', phase: 'ghost', flag: 'passed' },
    phases: [phase('test', 'success')],
    accepted: false,
    reason: 'never ran',
  },
  {
    name: 'phase failed',
    acceptance: { kind: 'phase_flag', phase: 'test', flag: 'passed' },
    phases: [phase('test', 'fail')],
    accepted: false,
    reason: 'is fail',
  },
  {
    // A project with no test command yet skips the phase. Judging the run on a
    // check that never happened would reject every run a new repo makes.
    name: 'a skipped phase could not fail the run',
    acceptance: { kind: 'phase_flag', phase: 'test', flag: 'passed' },
    phases: [phase('test', 'skipped')],
    accepted: true,
    reason: 'was skipped',
  },

  // phase_flag / approved
  {
    name: 'reviewer approved',
    acceptance: { kind: 'phase_flag', phase: 'review', flag: 'approved' },
    phases: [phase('review', 'success')],
    envelopes: [['review', envelope({ approved: true })]],
    accepted: true,
    reason: 'approved the work',
  },
  {
    name: 'reviewer did not approve',
    acceptance: { kind: 'phase_flag', phase: 'review', flag: 'approved' },
    phases: [phase('review', 'success')],
    envelopes: [['review', envelope({ approved: false })]],
    accepted: false,
    reason: 'ran but did not approve the work',
  },
  {
    name: 'approved missing is not approved',
    acceptance: { kind: 'phase_flag', phase: 'review', flag: 'approved' },
    phases: [phase('review', 'success')],
    envelopes: [['review', envelope()]],
    accepted: false,
    reason: 'ran but did not approve the work',
  },

  // envelope_status
  {
    name: 'envelope reported success',
    acceptance: { kind: 'envelope_status', phase: 'build' },
    phases: [phase('build', 'success')],
    envelopes: [['build', envelope()]],
    accepted: true,
    reason: 'reported success',
  },
  {
    name: 'envelope reported fail',
    acceptance: { kind: 'envelope_status', phase: 'build' },
    phases: [phase('build', 'success')],
    envelopes: [['build', envelope({ status: 'fail' })]],
    accepted: false,
    reason: 'reported fail',
  },
  {
    name: 'no envelope reads as nothing',
    acceptance: { kind: 'envelope_status', phase: 'build' },
    phases: [phase('build', 'success')],
    accepted: false,
    reason: 'reported nothing',
  },
  {
    name: 'phase missing',
    acceptance: { kind: 'envelope_status', phase: 'build' },
    phases: [],
    accepted: false,
    reason: 'is missing',
  },
];

describe('acceptance', () => {
  it.each(CASES)('$name', (c) => {
    const verdict = decideAcceptance({
      acceptance: c.acceptance,
      phases: c.phases,
      envelopes: new Map(c.envelopes ?? []),
      commandResults: new Map(c.commands ?? []),
    });
    expect(verdict.accepted).toBe(c.accepted);
    expect(verdict.reason).toContain(c.reason);
  });

  it('fails closed on a criterion this build does not know', () => {
    // Pipelines are JSON on disk; a kind from a newer build must not read as pass.
    const verdict = decideAcceptance({
      acceptance: { kind: 'quorum' } as unknown as Acceptance,
      phases: [phase('a', 'success')],
      envelopes: new Map(),
      commandResults: new Map(),
    });
    expect(verdict.accepted).toBe(false);
  });
});
