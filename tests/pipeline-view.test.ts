import { describe, expect, it } from 'vitest';
import type { Acceptance, PhaseDef, PipelineDef } from '@shared/types.js';
import {
  ACCEPTANCE_OPTIONS,
  acceptanceLabel,
  acceptanceReads,
  acceptanceSummary,
  applyPhaseEnvelopeOverride,
  applyPipelineDraftPatch,
  bindPhaseAgent,
  blankPhase,
  commandText,
  defaultCanvasPosition,
  formatClock,
  formatTimeout,
  gateNames,
  inheritEnvelopeOptionLabel,
  issuePhaseIndex,
  phaseComposition,
  phaseEnvelopeChip,
  pipelineFlowEquals,
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

  describe('phase envelope inheritance', () => {
    const agentPhase: PhaseDef = {
      name: 'build',
      kind: 'agent',
      description: 'Implement the change.',
      agent: 'builder',
    };

    it('creates a new agent phase without a pinned envelope', () => {
      const created = blankPhase('agent', new Set());
      expect(created.kind).toBe('agent');
      expect(created.envelope).toBeUndefined();
      expect(created.agent).toBe('builder');
    });

    it('labels the inherit option with the selected agent envelope', () => {
      expect(inheritEnvelopeOptionLabel({ name: 'builder', envelope: 'build' })).toBe(
        'Inherit from builder (build)',
      );
      expect(inheritEnvelopeOptionLabel(undefined)).toBe('Inherit from agent');
    });

    it('does not pin or rewrite an explicit override when the agent changes', () => {
      const overridden = { ...agentPhase, envelope: 'scout' };
      expect(bindPhaseAgent(overridden, 'reviewer')).toEqual({
        ...overridden,
        agent: 'reviewer',
      });
    });

    it('persists an explicit envelope selection as a phase override', () => {
      expect(applyPhaseEnvelopeOverride(agentPhase, 'review').envelope).toBe('review');
    });

    it('clears an override when inherit is selected', () => {
      const overridden = { ...agentPhase, envelope: 'review' };
      expect(applyPhaseEnvelopeOverride(overridden, '').envelope).toBeUndefined();
    });

    it('shows the inherited envelope on the canvas chip', () => {
      expect(phaseEnvelopeChip(agentPhase, 'build')).toEqual({
        label: 'build',
        overridden: false,
        title: 'Inherited from builder (build)',
      });
    });

    it('marks an explicit override on the canvas chip', () => {
      expect(phaseEnvelopeChip({ ...agentPhase, envelope: 'scout' }, 'build')).toEqual({
        label: 'scout',
        overridden: true,
        title: 'Override · scout',
      });
    });

    it('falls back to inherit when no agent envelope is available', () => {
      expect(phaseEnvelopeChip({ ...agentPhase, agent: undefined }, undefined)).toEqual({
        label: 'inherit',
        overridden: false,
        title: 'Inherit from agent',
      });
    });
  });

  describe('pipelineFlowEquals', () => {
    const flow: PipelineDef = {
      id: 'review',
      name: 'Review',
      description: 'A review chain.',
      acceptance: { kind: 'last_phase_pass' },
      phases: [
        { name: 'plan', kind: 'agent', description: 'Write the plan.' },
        { name: 'build', kind: 'agent', description: 'Apply the plan.' },
      ],
    };

    it('ignores viewport and card placement', () => {
      const panned: PipelineDef = {
        ...flow,
        canvas: { viewport: { x: 40, y: -12, zoom: 1.4 } },
      };
      const dragged: PipelineDef = {
        ...flow,
        canvas: { nodes: { plan: { x: 10, y: 20 }, build: { x: 400, y: 20 } } },
      };
      expect(pipelineFlowEquals(flow, panned)).toBe(true);
      expect(pipelineFlowEquals(panned, dragged)).toBe(true);
    });

    it('treats rerouting or other flow edits as a change', () => {
      const rerouted: PipelineDef = {
        ...flow,
        phases: [flow.phases[1]!, flow.phases[0]!],
      };
      const renamed: PipelineDef = { ...flow, name: 'Ship' };
      expect(pipelineFlowEquals(flow, rerouted)).toBe(false);
      expect(pipelineFlowEquals(flow, renamed)).toBe(false);
    });
  });

  describe('applyPipelineDraftPatch', () => {
    const draft: PipelineDef = {
      id: 'review',
      name: 'Review',
      description: 'A review chain.',
      acceptance: { kind: 'last_phase_pass' },
      phases: [{ name: 'plan', kind: 'agent', description: 'Write the plan.' }],
    };

    it('does not ask for a save when only the canvas moved', () => {
      expect(
        applyPipelineDraftPatch(draft, {
          canvas: { viewport: { x: 8, y: 16, zoom: 0.8 }, nodes: { plan: { x: 96, y: 40 } } },
        }).needsSave,
      ).toBe(false);
    });

    it('asks for a save when persisted flow content changes', () => {
      expect(applyPipelineDraftPatch(draft, { name: 'Ship' }).needsSave).toBe(true);
      expect(
        applyPipelineDraftPatch(draft, {
          phases: [
            draft.phases[0]!,
            { name: 'build', kind: 'agent', description: 'Apply the plan.' },
          ],
        }).needsSave,
      ).toBe(true);
    });
  });
});
