/**
 * Acceptance is the pipeline's own declared criterion, never a vibe. The
 * reason travels with the verdict so the banner can say what was checked
 * rather than restating the status it already shows.
 *
 * Pure by construction: phases come in as rows already read from the trace,
 * so a verdict can be tested against a table without a repo, a db, or an
 * agent.
 */

import type { Acceptance, CommandResult, PhaseRow } from '@shared/types.js';
import type { Envelope } from './envelopes.js';

export interface AcceptanceInput {
  acceptance: Acceptance;
  phases: PhaseRow[];
  envelopes: ReadonlyMap<string, Envelope>;
  commandResults: ReadonlyMap<string, CommandResult>;
}

export interface Verdict {
  accepted: boolean;
  reason: string;
}

function allPhasesVerdict(phases: PhaseRow[]): Verdict {
  const bad = phases.filter((phase) => phase.status !== 'success' && phase.status !== 'skipped');
  return bad.length
    ? {
        accepted: false,
        reason: `every phase had to pass; ${bad.map((phase) => `${phase.name} is ${phase.status}`).join(', ')}`,
      }
    : { accepted: true, reason: `all ${phases.length} phases passed` };
}

function lastPhaseVerdict(phases: PhaseRow[]): Verdict {
  const last = phases[phases.length - 1];
  if (!last) return { accepted: false, reason: 'the pipeline ran no phases' };
  return last.status === 'success'
    ? { accepted: true, reason: `the final phase "${last.name}" passed` }
    : { accepted: false, reason: `the final phase "${last.name}" is ${last.status}` };
}

function phaseFlagVerdict(
  acceptance: Extract<Acceptance, { kind: 'phase_flag' }>,
  phases: PhaseRow[],
  envelopes: ReadonlyMap<string, Envelope>,
  commandResults: ReadonlyMap<string, CommandResult>,
): Verdict {
  const phase = phases.find((candidate) => candidate.name === acceptance.phase);
  if (!phase) return { accepted: false, reason: `phase "${acceptance.phase}" never ran` };
  // A skipped phase produced no verdict either way. Treating it as a
  // rejection would judge the run on a check that never happened.
  if (phase.status === 'skipped') {
    return {
      accepted: true,
      reason: `"${phase.name}" was skipped (${phase.error || 'nothing to run'}), so it could not fail the run`,
    };
  }
  if (phase.status !== 'success') {
    return { accepted: false, reason: `phase "${phase.name}" is ${phase.status}` };
  }
  if (acceptance.flag === 'passed') {
    const result = commandResults.get(acceptance.phase);
    if (!result) return { accepted: true, reason: `phase "${phase.name}" passed` };
    return result.passed
      ? { accepted: true, reason: `"${phase.name}" exited 0` }
      : { accepted: false, reason: `"${phase.name}" exited ${result.exitCode ?? 'abnormally'}` };
  }
  return envelopes.get(acceptance.phase)?.approved === true
    ? { accepted: true, reason: `"${phase.name}" approved the work` }
    : { accepted: false, reason: `"${phase.name}" ran but did not approve the work` };
}

function envelopeStatusVerdict(
  acceptance: Extract<Acceptance, { kind: 'envelope_status' }>,
  phases: PhaseRow[],
  envelopes: ReadonlyMap<string, Envelope>,
): Verdict {
  const phase = phases.find((candidate) => candidate.name === acceptance.phase);
  if (!phase || phase.status !== 'success') {
    return {
      accepted: false,
      reason: `phase "${acceptance.phase}" is ${phase?.status ?? 'missing'}`,
    };
  }
  const envelope = envelopes.get(acceptance.phase);
  return envelope?.status === 'success'
    ? { accepted: true, reason: `"${phase.name}" reported success` }
    : {
        accepted: false,
        reason: `"${phase.name}" reported ${String(envelope?.status ?? 'nothing')}`,
      };
}

export function decideAcceptance(input: AcceptanceInput): Verdict {
  const { acceptance, phases, envelopes, commandResults } = input;

  switch (acceptance.kind) {
    case 'all_phases_pass':
      return allPhasesVerdict(phases);
    case 'last_phase_pass':
      return lastPhaseVerdict(phases);
    case 'phase_flag':
      return phaseFlagVerdict(acceptance, phases, envelopes, commandResults);
    case 'envelope_status':
      return envelopeStatusVerdict(acceptance, phases, envelopes);

    default:
      return { accepted: false, reason: 'the pipeline has no acceptance criterion' };
  }
}
