import { describe, expect, it } from 'vitest';
import type { Acceptance, PhaseDef, PipelineDef } from '@shared/types.js';
import {
  ACCEPTANCE_OPTIONS,
  acceptanceLabel,
  acceptanceReads,
  acceptanceSummary,
  commandText,
  defaultCanvasPosition,
  formatClock,
  formatTimeout,
  gateNames,
  issuePhaseIndex,
  phaseComposition,
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

  describe('acceptanceLabel', () => {
    it('labels every acceptance kind from the option list', () => {
      for (const option of ACCEPTANCE_OPTIONS) {
        const acceptance = {
          kind: option.value,
          phase: 'verifier',
          flag: 'approved',
        } as Acceptance;
        expect(acceptanceLabel(acceptance)).toBe(option.label);
        expect(option.description.length).toBeGreaterThan(0);
      }
    });

    it('falls back to the raw kind when the rule is not in the list', () => {
      expect(acceptanceLabel({ kind: 'nonexistent' } as unknown as Acceptance)).toBe('nonexistent');
    });
  });

  describe('defaultCanvasPosition', () => {
    it('starts an untouched pipeline as a direct left-to-right flow', () => {
      expect(defaultCanvasPosition(0)).toEqual({ x: 96, y: 168 });
      expect(defaultCanvasPosition(1)).toEqual({ x: 448, y: 168 });
      expect(defaultCanvasPosition(2)).toEqual({ x: 800, y: 168 });
    });
  });
});
