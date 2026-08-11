import { describe, expect, it } from 'vitest';
import type { Acceptance, PhaseDef, PipelineDef } from '@shared/types.js';
import {
  ACCEPTANCE_OPTIONS,
  acceptanceLabel,
  acceptanceReads,
  acceptanceSummary,
  commandText,
  dragPhaseId,
  dropRailId,
  dropSlotId,
  formatClock,
  formatTimeout,
  gateNames,
  issuePhaseIndex,
  newStagePlan,
  parseDragPhaseId,
  parseDropId,
  phaseComposition,
  reorderTarget,
  stageGateSummary,
  stageLabel,
  stageMoveTarget,
  stageOfPhase,
  stageSlots,
  stagesOf,
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

    it('reports where each stage starts', () => {
      const stages = stagesOf(phases);
      expect(stages.map((s) => s.start)).toEqual([0, 3, 5]);
    });
  });

  describe('Stage Board drag and drop', () => {
    // p0 p1 | gate2 | p3 | gate4 | p5
    const phases: PhaseDef[] = [
      { name: 'p0_prep', kind: 'code', description: '' },
      { name: 'p1_build', kind: 'agent', description: '' },
      { name: 'p2_gate1', kind: 'engineer', description: '' },
      { name: 'p3_test', kind: 'code', description: '' },
      { name: 'p4_gate2', kind: 'engineer', description: '' },
      { name: 'p5_ship', kind: 'agent', description: '' },
    ];

    /** The list `movePhaseToNewStage` produces, so a plan is read as an edit. */
    function applyNewStage(from: number, boundary: number, list = phases): string[] | null {
      const plan = newStagePlan(list, from, boundary);
      if (!plan) return null;
      const next = [...list];
      const [item] = next.splice(from, 1);
      const insert: PhaseDef[] = [];
      if (plan.before) insert.push({ name: 'gate_a', kind: 'engineer', description: '' });
      insert.push(item);
      if (plan.after) insert.push({ name: 'gate_b', kind: 'engineer', description: '' });
      next.splice(plan.at, 0, ...insert);
      return next.map((p) => p.name);
    }

    describe('stageSlots', () => {
      it('exposes every insertion point in a stage, gate included', () => {
        const stages = stagesOf(phases);
        // Stage 0 holds p0 and p1 and is closed by gate 2: dropping on 2 puts
        // the phase last in the stage, just before the checkpoint.
        expect(stageSlots(stages[0])).toEqual([0, 1, 2]);
        expect(stageSlots(stages[1])).toEqual([3, 4]);
        expect(stageSlots(stages[2])).toEqual([5, 6]);
      });

      it('gives an empty stage one slot so the column still takes a drop', () => {
        const empty: PhaseDef[] = [
          { name: 'g0', kind: 'engineer', description: '' },
          { name: 'g1', kind: 'engineer', description: '' },
        ];
        const stages = stagesOf(empty);
        expect(stages[1].members).toEqual([]);
        expect(stageSlots(stages[1])).toEqual([1]);
      });
    });

    describe('reorderTarget', () => {
      it('accounts for the splice when the drop is after the phase', () => {
        // p0 dropped on slot 2 (before gate1) lands at index 1 once removed.
        expect(reorderTarget(0, 2)).toBe(1);
        expect(reorderTarget(0, 6)).toBe(5);
      });

      it('uses the slot as-is when the drop is before the phase', () => {
        expect(reorderTarget(5, 0)).toBe(0);
        expect(reorderTarget(3, 1)).toBe(1);
      });

      it('rejects the two slots that bracket the phase already', () => {
        expect(reorderTarget(3, 3)).toBeNull();
        expect(reorderTarget(3, 4)).toBeNull();
      });
    });

    describe('newStagePlan', () => {
      it('closes a stage behind a phase pulled out of a shared stage', () => {
        // p0 leaves p1 behind, so a checkpoint has to separate them.
        expect(applyNewStage(0, 0)).toEqual([
          'p0_prep',
          'gate_b',
          'p1_build',
          'p2_gate1',
          'p3_test',
          'p4_gate2',
          'p5_ship',
        ]);
      });

      it('opens a stage in front of a phase dropped at the end of the run', () => {
        expect(applyNewStage(0, 6)).toEqual([
          'p1_build',
          'p2_gate1',
          'p3_test',
          'p4_gate2',
          'p5_ship',
          'gate_a',
          'p0_prep',
        ]);
      });

      it('closes the stage when the drop lands beside work, not a checkpoint', () => {
        // The gate2 boundary sits right after p3, which is unattended work: it
        // cannot share the stage, so the new one is closed behind the phase.
        expect(applyNewStage(0, 4)).toEqual([
          'p1_build',
          'p2_gate1',
          'p3_test',
          'gate_a',
          'p0_prep',
          'p4_gate2',
          'p5_ship',
        ]);
      });

      it('adds no checkpoint when existing ones already bound the stage', () => {
        // Two adjacent checkpoints are an empty stage; a phase dropped into it
        // is already bounded on both sides.
        const adjacent: PhaseDef[] = [
          { name: 'a0', kind: 'code', description: '' },
          { name: 'a1', kind: 'agent', description: '' },
          { name: 'a2_gate', kind: 'engineer', description: '' },
          { name: 'a3_gate', kind: 'engineer', description: '' },
          { name: 'a4', kind: 'agent', description: '' },
        ];
        expect(applyNewStage(0, 3, adjacent)).toEqual(['a1', 'a2_gate', 'a0', 'a3_gate', 'a4']);
      });

      it('refuses a checkpoint, which is a boundary and not stage contents', () => {
        expect(newStagePlan(phases, 2, 0)).toBeNull();
        expect(newStagePlan(phases, 4, 6)).toBeNull();
      });

      it('refuses a drop that would only add an empty stage beside a lone phase', () => {
        // p3 already has stage 1 to itself, bounded by gate1 and gate2.
        expect(newStagePlan(phases, 3, 2)).toBeNull();
        expect(newStagePlan(phases, 3, 4)).toBeNull();
        // p5 is the last stage, so its own boundaries are gate2 and the end.
        expect(newStagePlan(phases, 5, 4)).toBeNull();
        expect(newStagePlan(phases, 5, 6)).toBeNull();
        // Moving it anywhere else is still a real edit.
        expect(newStagePlan(phases, 3, 0)).not.toBeNull();
      });

      it('refuses an index that names no phase', () => {
        expect(newStagePlan(phases, -1, 0)).toBeNull();
        expect(newStagePlan(phases, 9, 0)).toBeNull();
      });
    });

    describe('drag identifiers', () => {
      it('round-trips phase drag ids', () => {
        expect(parseDragPhaseId(dragPhaseId(3))).toBe(3);
        expect(parseDragPhaseId('slot:3')).toBeNull();
      });

      it('round-trips slot and rail drop ids', () => {
        expect(parseDropId(dropSlotId(2))).toEqual({ kind: 'slot', at: 2 });
        expect(parseDropId(dropRailId(4))).toEqual({ kind: 'rail', boundary: 4 });
        expect(parseDropId(dragPhaseId(1))).toBeNull();
        expect(parseDropId('nonsense')).toBeNull();
      });
    });
  });
});
