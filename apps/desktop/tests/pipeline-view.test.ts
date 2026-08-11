import { describe, expect, it } from 'vitest';
import type { Acceptance, PhaseDef, PipelineDef, ValidationIssue } from '@shared/types.js';
import {
  acceptanceReads,
  acceptanceSummary,
  commandText,
  formatClock,
  formatTimeout,
  gateNames,
  issuePhaseIndex,
  phaseComposition,
  stageGateSummary,
  stageLabel,
  stageMoveTarget,
  stageOfPhase,
  stagesOf,
  validationSummary,
} from '../src/renderer/pipeline-view.js';

describe('pipeline-view', () => {
  describe('phaseComposition', () => {
    it('summarizes mixed phase kinds', () => {
      const phases: PhaseDef[] = [
        { name: 'p1', kind: 'agent', description: '' },
        { name: 'p2', kind: 'agent', description: '' },
        { name: 'p3', kind: 'code', description: '' },
        { name: 'p4', kind: 'engineer', description: '' },
      ];
      expect(phaseComposition(phases)).toBe('2 agents · 1 command · 1 checkpoint');
    });

    it('handles empty phases', () => {
      expect(phaseComposition([])).toBe('Empty');
    });
  });

  describe('commandText', () => {
    it('returns ref command', () => {
      const phase: PhaseDef = {
        name: 'test',
        kind: 'code',
        description: '',
        command: { ref: 'npm_test' },
      };
      expect(commandText(phase)).toBe('npm_test');
    });

    it('returns builtin command', () => {
      const phase: PhaseDef = {
        name: 'test',
        kind: 'code',
        description: '',
        command: { builtin: 'git_commit' },
      };
      expect(commandText(phase)).toBe('git_commit');
    });

    it('returns argv command', () => {
      const phase: PhaseDef = {
        name: 'test',
        kind: 'code',
        description: '',
        command: { argv: ['echo', 'hi'] },
      };
      expect(commandText(phase)).toBe('echo hi');
    });

    it('returns empty string if no command', () => {
      const phase: PhaseDef = { name: 'test', kind: 'agent', description: '' };
      expect(commandText(phase)).toBe('');
    });
  });

  describe('gateNames', () => {
    it('extracts string and object gate names', () => {
      const phase: PhaseDef = {
        name: 'test',
        kind: 'agent',
        description: '',
        gates: ['tests_pass', { gate: 'lint_clean' }],
      };
      expect(gateNames(phase)).toEqual(['tests_pass', 'lint_clean']);
    });
  });

  describe('issuePhaseIndex', () => {
    it('parses phases[N] format', () => {
      expect(issuePhaseIndex('phases[2] build')).toBe(2);
    });

    it('parses phases.N.field format', () => {
      expect(issuePhaseIndex('phases.3.name')).toBe(3);
    });

    it('returns null for non-phase issues', () => {
      expect(issuePhaseIndex('acceptance')).toBeNull();
      expect(issuePhaseIndex('pipeline.name')).toBeNull();
    });
  });

  describe('acceptanceSummary and acceptanceReads', () => {
    const phases: PhaseDef[] = [
      { name: 'builder', kind: 'agent', description: '' },
      { name: 'verifier', kind: 'agent', description: '' },
    ];

    it('handles all_phases_pass', () => {
      const acc: Acceptance = { kind: 'all_phases_pass' };
      expect(acceptanceSummary(acc, phases)).toBe('Accepted when all 2 phases pass.');
      expect(
        acceptanceReads({ id: 'p', name: 'P', acceptance: acc, phases } as PipelineDef),
      ).toContain('Reads every phase status');
    });

    it('handles last_phase_pass', () => {
      const acc: Acceptance = { kind: 'last_phase_pass' };
      expect(acceptanceSummary(acc, phases)).toBe(
        'Accepted when "verifier", the last phase, ends in success.',
      );
      expect(
        acceptanceReads({ id: 'p', name: 'P', acceptance: acc, phases } as PipelineDef),
      ).toContain('Reads the status of the last phase, verifier');
    });

    it('handles envelope_status', () => {
      const acc: Acceptance = { kind: 'envelope_status', phase: 'verifier' };
      expect(acceptanceSummary(acc, phases)).toBe(
        'Accepted when the envelope returned by "verifier" reports success.',
      );
      expect(
        acceptanceReads({ id: 'p', name: 'P', acceptance: acc, phases } as PipelineDef),
      ).toContain("Reads verifier's envelope");
    });

    it('handles phase_flag', () => {
      const acc: Acceptance = { kind: 'phase_flag', phase: 'verifier', flag: 'approved' };
      expect(acceptanceSummary(acc, phases)).toBe(
        'Accepted when "verifier" returns approved in its envelope.',
      );
      expect(
        acceptanceReads({ id: 'p', name: 'P', acceptance: acc, phases } as PipelineDef),
      ).toContain("Reads verifier's envelope and accepts when it sets approved");
    });
  });

  describe('formatTimeout and formatClock', () => {
    it('formats timeout milliseconds', () => {
      expect(formatTimeout(undefined)).toBe('none');
      expect(formatTimeout(0)).toBe('none');
      expect(formatTimeout(120000)).toBe('2m');
      expect(formatTimeout(45000)).toBe('45s');
    });

    it('formats clock', () => {
      const d = new Date(2026, 7, 11, 14, 30, 0);
      expect(formatClock(d)).toMatch(/\d{2}:\d{2}:\d{2}/);
    });
  });

  describe('validationSummary', () => {
    it('returns error summary when errors exist', () => {
      const issues: ValidationIssue[] = [
        { level: 'error', message: 'Missing name', where: 'phases[0]' },
        { level: 'warning', message: 'No timeout', where: 'phases[1]' },
      ];
      const sum = validationSummary(issues);
      expect(sum.tone).toBe('error');
      expect(sum.label).toBe('1 error');
    });

    it('returns warning summary when only warnings exist', () => {
      const issues: ValidationIssue[] = [
        { level: 'warning', message: 'No timeout', where: 'phases[0]' },
      ];
      const sum = validationSummary(issues);
      expect(sum.tone).toBe('warning');
      expect(sum.label).toBe('1 warning');
    });

    it('returns ready when no issues', () => {
      const sum = validationSummary([], { hasProject: true });
      expect(sum.tone).toBe('ok');
      expect(sum.label).toBe('Ready');
    });
  });

  describe('Stage Board grouping (stagesOf, stageMoveTarget)', () => {
    const phases: PhaseDef[] = [
      { name: 'p0_prep', kind: 'code', description: '' },
      { name: 'p1_build', kind: 'agent', description: '' },
      { name: 'p2_gate1', kind: 'engineer', description: '' },
      { name: 'p3_test', kind: 'code', description: '' },
      { name: 'p4_gate2', kind: 'engineer', description: '' },
      { name: 'p5_ship', kind: 'agent', description: '' },
    ];

    it('splits phases into gated stages', () => {
      const stages = stagesOf(phases);
      expect(stages).toHaveLength(3);

      expect(stages[0].members).toEqual([0, 1]);
      expect(stages[0].gate).toBe(2);

      expect(stages[1].members).toEqual([3]);
      expect(stages[1].gate).toBe(4);

      expect(stages[2].members).toEqual([5]);
      expect(stages[2].gate).toBeNull();
    });

    it('identifies stage of phase', () => {
      const stages = stagesOf(phases);
      expect(stageOfPhase(stages, 0)).toBe(0);
      expect(stageOfPhase(stages, 2)).toBe(0); // gate for stage 0
      expect(stageOfPhase(stages, 3)).toBe(1);
      expect(stageOfPhase(stages, 5)).toBe(2);
    });

    it('computes move targets across gates', () => {
      // p1_build (index 1 in stage 0) moving right (+1) crosses gate1 (index 2) -> lands at index 2
      expect(stageMoveTarget(phases, 1, 1)).toBe(2);

      // p3_test (index 3 in stage 1) moving left (-1) crosses gate1 -> lands at index 2 (after p1_build)
      expect(stageMoveTarget(phases, 3, -1)).toBe(2);

      // Moving a checkpoint itself between stages returns null
      expect(stageMoveTarget(phases, 2, 1)).toBeNull();
      expect(stageMoveTarget(phases, 2, -1)).toBeNull();

      // Moving past the bounds returns null
      expect(stageMoveTarget(phases, 0, -1)).toBeNull();
      expect(stageMoveTarget(phases, 5, 1)).toBeNull();
    });

    it('formats stage labels and gate summary', () => {
      const stages = stagesOf(phases);
      expect(stageLabel(stages[0], 3)).toBe('Stage 1');
      expect(stageLabel(stages[0], 1)).toBe('Whole run');

      expect(stageGateSummary(stages[2], phases)).toBe('Runs to the end, then acceptance decides.');
    });
  });
});
