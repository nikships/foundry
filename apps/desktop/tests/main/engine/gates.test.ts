import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../helpers/tmp.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { GATES, runGates, violationsOf, gateCorrection } from '../../../src/main/engine/gates.js';
import type { Envelope } from '../../../src/main/engine/envelopes.js';

let dir: string;

beforeAll(() => {
  dir = tempDir('foundry-gates-');
  mkdirSync(join(dir, 'specs'), { recursive: true });
  writeFileSync(join(dir, 'specs', 'plan.md'), '# a real plan\n');
  writeFileSync(join(dir, 'specs', 'empty.md'), '');
  writeFileSync(join(dir, 'good.json'), '{"a":1}');
  writeFileSync(join(dir, 'bad.json'), '{not json');
});

const base: Envelope = { status: 'success', summary: '', artifacts: [], notes_for_next_agent: '' };
const ctx = () => ({ cwd: dir });

describe('artifacts_exist', () => {
  it('passes for a file that is there and reports its size', async () => {
    const checks = await GATES.artifacts_exist!({ ...base, artifacts: ['specs/plan.md'] }, ctx());
    expect(checks[0]!.ok).toBe(true);
    expect(checks[0]!.note).toContain('exists');
  });

  it('fails for a claimed file that is not there', async () => {
    const checks = await GATES.artifacts_exist!({ ...base, artifacts: ['specs/ghost.md'] }, ctx());
    expect(checks[0]!.ok).toBe(false);
  });

  it('is honest that it verified nothing when nothing was claimed', async () => {
    const checks = await GATES.artifacts_exist!(base, ctx());
    expect(checks[0]!.ok).toBe(true);
    expect(checks[0]!.note).toContain('nothing to verify');
  });
});

describe('files_non_empty', () => {
  it('catches an artifact that exists but is empty', async () => {
    const checks = await GATES.files_non_empty!(
      { ...base, artifacts: ['specs/plan.md', 'specs/empty.md'] },
      ctx(),
    );
    expect(checks.find((c) => c.item === 'specs/plan.md')!.ok).toBe(true);
    expect(checks.find((c) => c.item === 'specs/empty.md')!.ok).toBe(false);
  });
});

describe('json_parses', () => {
  it('only judges .json artifacts, and judges them by parsing', async () => {
    const checks = await GATES.json_parses!(
      { ...base, artifacts: ['good.json', 'bad.json', 'specs/plan.md'] },
      ctx(),
    );
    expect(checks).toHaveLength(2);
    expect(checks.find((c) => c.item === 'good.json')!.ok).toBe(true);
    expect(checks.find((c) => c.item === 'bad.json')!.ok).toBe(false);
  });
});

describe('verdict_consistent', () => {
  it('rejects approval alongside blocking items', async () => {
    const checks = await GATES.verdict_consistent!(
      { ...base, approved: true, blocking: ['auth is broken'], findings: [] },
      ctx(),
    );
    expect(checks.find((c) => c.item === 'approved vs blocking')!.ok).toBe(false);
  });

  it('rejects approval alongside unmet requirements', async () => {
    const checks = await GATES.verdict_consistent!(
      {
        ...base,
        approved: true,
        blocking: [],
        findings: [{ requirement: 'tests exist', met: false, evidence: 'none found' }],
      },
      ctx(),
    );
    expect(checks.find((c) => c.item === 'approved vs findings')!.ok).toBe(false);
  });

  it('rejects a rejection that names no problem', async () => {
    const checks = await GATES.verdict_consistent!(
      { ...base, approved: false, blocking: [], findings: [] },
      ctx(),
    );
    expect(checks.find((c) => c.item === 'rejection names a problem')!.ok).toBe(false);
  });

  it('accepts a clean approval', async () => {
    const checks = await GATES.verdict_consistent!(
      {
        ...base,
        approved: true,
        blocking: [],
        findings: [{ requirement: 'it works', met: true, evidence: 'ran it' }],
      },
      ctx(),
    );
    expect(checks.every((c) => c.ok)).toBe(true);
  });
});

describe('disapproval_halts', () => {
  it('rejects a disapproval that still reports phase success', async () => {
    const checks = await GATES.disapproval_halts!(
      { ...base, status: 'success', approved: false },
      ctx(),
    );
    expect(checks[0]!.ok).toBe(false);
    expect(checks[0]!.note).toContain('status "fail"');
  });

  it('accepts an approval', async () => {
    const checks = await GATES.disapproval_halts!(
      { ...base, status: 'success', approved: true },
      ctx(),
    );
    expect(checks[0]!.ok).toBe(true);
  });

  it('accepts a disapproval that honestly fails the phase', async () => {
    const checks = await GATES.disapproval_halts!(
      { ...base, status: 'fail', approved: false },
      ctx(),
    );
    expect(checks[0]!.ok).toBe(true);
    expect(checks[0]!.note).toContain('halts');
  });
});

describe('command_passes', () => {
  it('passes on exit 0', async () => {
    const checks = await GATES.command_passes!(base, ctx(), { argv: ['true'] });
    expect(checks[0]!.ok).toBe(true);
  });

  it('fails on non-zero and keeps the output as evidence', async () => {
    const checks = await GATES.command_passes!(base, ctx(), {
      argv: ['sh', '-c', 'echo boom >&2; exit 3'],
    });
    expect(checks[0]!.ok).toBe(false);
    expect(checks[0]!.note).toContain('exit 3');
    expect(checks[0]!.note).toContain('boom');
  });

  it('fails loudly rather than silently when unconfigured', async () => {
    const checks = await GATES.command_passes!(base, ctx(), {});
    expect(checks[0]!.ok).toBe(false);
  });
});

describe('the gate runner', () => {
  it('reports an unknown gate as a failure, not a pass', async () => {
    const reports = await runGates(['no_such_gate'], base, ctx());
    expect(reports[0]!.passed).toBe(false);
    expect(violationsOf(reports)[0]).toContain('nothing verified it');
  });

  it('derives violations from failed checks only', async () => {
    const reports = await runGates(
      ['artifacts_exist'],
      { ...base, artifacts: ['specs/plan.md', 'nope.md'] },
      ctx(),
    );
    const violations = violationsOf(reports);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('nope.md');
  });

  it('passes a gate spec config through to the gate', async () => {
    const reports = await runGates(
      [{ gate: 'command_passes', config: { argv: ['sh', '-c', 'exit 0'] } }],
      base,
      ctx(),
    );
    expect(reports[0]!.passed).toBe(true);
  });

  it('turns violations into a correction that names each one', async () => {
    const message = gateCorrection(['artifacts_exist / nope.md: missing']);
    expect(message).toContain('nope.md');
    expect(message).toContain('call submit_envelope again');
  });
});
