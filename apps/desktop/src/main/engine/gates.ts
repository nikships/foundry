/**
 * Gates verify the envelope's CLAIMS, never guesses. A gate returns one check
 * per item it looked at, so a green gate says WHAT it verified rather than only
 * that it passed. Violations are derived from failed checks and travel back to
 * the same agent session as a correction.
 *
 * Gates check what is mechanically checkable; plan quality is a reviewer's job.
 */

import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { GateCheck, GateSpec } from '@shared/types.js';
import type { Envelope } from './envelopes.js';
import { runCommand } from './commands.js';

const TAIL_CHARS = 1000;

export interface GateContext {
  /** Everything a gate resolves paths against: the worktree, not the repo. */
  cwd: string;
}

export interface GateReport {
  gate: string;
  passed: boolean;
  checks: GateCheck[];
}

export type GateFn = (
  envelope: Envelope,
  ctx: GateContext,
  config?: Record<string, unknown>,
) => Promise<GateCheck[]>;

function humanSize(bytes: number): string {
  return bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}KB`;
}

function resolveIn(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

function nothingToVerify(item: string): GateCheck[] {
  return [{ item, ok: true, note: 'nothing to verify' }];
}

const artifacts_exist: GateFn = async (envelope, ctx) => {
  const list = envelope.artifacts ?? [];
  if (!list.length) return nothingToVerify('(no artifacts declared)');
  return list.map((a) => {
    const full = resolveIn(ctx.cwd, a);
    const ok = existsSync(full);
    return {
      item: a,
      ok,
      note: ok ? `exists, ${humanSize(statSync(full).size)}` : 'declared artifact does not exist',
    };
  });
};

const files_non_empty: GateFn = async (envelope, ctx) => {
  const list = envelope.artifacts ?? [];
  const checks: GateCheck[] = [];
  for (const a of list) {
    const full = resolveIn(ctx.cwd, a);
    if (!existsSync(full)) continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      checks.push({ item: a, ok: true, note: 'directory' });
      continue;
    }
    const empty = st.size === 0;
    checks.push({
      item: a,
      ok: !empty,
      note: empty ? 'declared artifact is empty' : `${humanSize(st.size)} of content`,
    });
  }
  return checks.length ? checks : nothingToVerify('(no files to size)');
};

const json_parses: GateFn = async (envelope, ctx) => {
  const checks: GateCheck[] = [];
  for (const a of envelope.artifacts ?? []) {
    if (!a.endsWith('.json')) continue;
    const full = resolveIn(ctx.cwd, a);
    if (!existsSync(full)) continue;
    try {
      const parsed: unknown = JSON.parse(await readFile(full, 'utf8'));
      checks.push({
        item: a,
        ok: true,
        note: `parses, ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
      });
    } catch (e) {
      checks.push({
        item: a,
        ok: false,
        note: `declared JSON artifact does not parse: ${(e as Error).message}`,
      });
    }
  }
  return checks.length ? checks : nothingToVerify('(no JSON artifacts)');
};

const verdict_consistent: GateFn = async (envelope) => {
  const approved = Boolean(envelope.approved);
  const blocking = (envelope.blocking as string[] | undefined) ?? [];
  const findings = (envelope.findings as { requirement: string; met: boolean }[] | undefined) ?? [];
  const unmet = findings.filter((f) => !f.met).map((f) => f.requirement);

  let approvedVsBlocking: string;
  if (!blocking.length) approvedVsBlocking = 'no blocking items';
  else if (approved) approvedVsBlocking = `${blocking.length} blocking item(s) while approved=true`;
  else approvedVsBlocking = `${blocking.length} blocking item(s), not approved`;

  let approvedVsFindings: string;
  if (!unmet.length) approvedVsFindings = 'every requirement met';
  else if (approved)
    approvedVsFindings = `${unmet.length} unmet requirement(s) while approved=true`;
  else approvedVsFindings = `${unmet.length} unmet requirement(s), not approved`;

  const rejectionSupported = approved || blocking.length > 0 || unmet.length > 0;

  return [
    {
      item: 'approved vs blocking',
      ok: !(approved && blocking.length),
      note: approvedVsBlocking,
    },
    {
      item: 'approved vs findings',
      ok: !(approved && unmet.length),
      note: approvedVsFindings,
    },
    {
      item: 'rejection names a problem',
      ok: rejectionSupported,
      note: rejectionSupported
        ? 'verdict is supported'
        : 'approved=false but no blocking item or unmet requirement was given',
    },
  ];
};

/**
 * A review that does not approve must report `status: "fail"` so the phase
 * aborts, because a disapproving verdict riding a successful phase flows
 * straight into whatever comes next — a commit, a pull request — as if it had
 * been approved. Approvals and honest failures both pass; only the
 * keeps-going disapproval is rejected.
 */
const disapproval_halts: GateFn = async (envelope) => {
  const approved = Boolean(envelope.approved);
  const failed = envelope.status === 'fail';
  const ok = approved || failed;
  let note: string;
  if (approved) note = 'approved';
  else if (failed) note = 'not approved and reported as failure, so the run halts here';
  else
    note =
      'approved=false with status "success" would let disapproved work flow on — close the gaps and approve, or report status "fail" to halt the run here';
  return [{ item: 'disapproval halts the run', ok, note }];
};

/** The generalisation of SSSF's tests_pass: argv comes from the designer. */
const command_passes: GateFn = async (_envelope, ctx, config) => {
  const argv = (config?.argv as string[] | undefined) ?? [];
  if (!argv.length) {
    return [{ item: 'command_passes', ok: false, note: 'gate is configured with no command' }];
  }
  const result = await runCommand({ argv, cwd: ctx.cwd, timeoutMs: 600_000 });
  const label = argv.join(' ');
  return [
    {
      item: label,
      ok: result.passed,
      note: result.passed
        ? `exit 0 in ${(result.durationMs / 1000).toFixed(1)}s`
        : `exit ${result.exitCode ?? 'null'}\n${result.outputTail.slice(-TAIL_CHARS)}`,
    },
  ];
};

export const GATES: Record<string, GateFn> = {
  artifacts_exist,
  files_non_empty,
  json_parses,
  verdict_consistent,
  disapproval_halts,
  command_passes,
};

export const GATE_DESCRIPTIONS: Record<string, string> = {
  artifacts_exist: 'Every path the envelope declares as an artifact exists on disk.',
  files_non_empty: 'Declared artifacts have content, not just a name.',
  json_parses: 'Declared .json artifacts actually parse.',
  verdict_consistent: 'A review cannot approve while it also lists blocking items.',
  disapproval_halts:
    'A review that does not approve must report failure, so disapproved work never flows into later phases.',
  command_passes: 'A configured command exits 0 against the phase result.',
};

export function normaliseGateSpec(spec: string | GateSpec): GateSpec {
  return typeof spec === 'string' ? { gate: spec } : spec;
}

export async function runGates(
  specs: (string | GateSpec)[],
  envelope: Envelope,
  ctx: GateContext,
): Promise<GateReport[]> {
  const reports: GateReport[] = [];
  for (const raw of specs) {
    const spec = normaliseGateSpec(raw);
    const fn = GATES[spec.gate];
    if (!fn) {
      reports.push({
        gate: spec.gate,
        passed: false,
        checks: [{ item: spec.gate, ok: false, note: 'unknown gate: nothing verified it' }],
      });
      continue;
    }
    try {
      const checks = await fn(envelope, ctx, spec.config);
      reports.push({ gate: spec.gate, passed: checks.every((c) => c.ok), checks });
    } catch (e) {
      reports.push({
        gate: spec.gate,
        passed: false,
        checks: [{ item: spec.gate, ok: false, note: `gate threw: ${(e as Error).message}` }],
      });
    }
  }
  return reports;
}

/** Violations are derived from failed checks, never declared separately. */
export function violationsOf(reports: GateReport[]): string[] {
  return reports.flatMap((r) =>
    r.checks.filter((c) => !c.ok).map((c) => `${r.gate} / ${c.item}: ${c.note}`),
  );
}

export function gateCorrection(violations: string[]): string {
  return [
    'Validation gates rejected your last reply. These are mechanical checks against what you claimed:',
    '',
    ...violations.map((v) => `- ${v}`),
    '',
    'Fix the underlying problem (do the work, or correct the claim), then call submit_envelope again.',
  ].join('\n');
}
