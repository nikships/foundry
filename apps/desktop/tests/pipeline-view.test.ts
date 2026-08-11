/**
 * The pipeline workbench draws relationships the phase list cannot state on
 * its own — repair loops arcing back to an earlier phase, the phases
 * acceptance actually reads, which phase a validation issue belongs to. All of
 * that is geometry and wording derived from the pipeline, so it is tested here
 * rather than eyeballed in the app.
 */
import { describe, expect, it } from 'vitest';
import type { Acceptance, PhaseDef, ValidationIssue } from '../src/shared/types.js';
import {
  GUTTER_BASE_W,
  LANE_W,
  RUNG_H,
  acceptanceSummary,
  acceptanceTarget,
  arcPath,
  commandText,
  feedbackArcs,
  gutterWidth,
  issuePhaseIndex,
  outcomeMarks,
  phaseComposition,
  rungCenter,
  stageGateSummary,
  stageLabel,
  stageMoveTarget,
  stageOfPhase,
  stagesOf,
  validationSummary,
} from '../src/renderer/pipeline-view.js';

const agent = (name: string, extra: Partial<PhaseDef> = {}): PhaseDef => ({
  name,
  kind: 'agent',
  description: `${name} does a thing`,
  agent: 'builder',
  envelope: 'build',
  ...extra,
});

const code = (name: string, extra: Partial<PhaseDef> = {}): PhaseDef => ({
  name,
  kind: 'code',
  description: `${name} runs a command`,
  command: { ref: 'test' },
  ...extra,
});

const checkpoint = (name: string, extra: Partial<PhaseDef> = {}): PhaseDef => ({
  name,
  kind: 'engineer',
  description: `${name} asks a human`,
  question: 'Ship it?',
  ...extra,
});

describe('phaseComposition', () => {
  it('counts each kind and omits the kinds that are absent', () => {
    expect(phaseComposition([agent('a'), agent('b'), code('c')])).toBe('2 agents · 1 command');
    expect(phaseComposition([checkpoint('c')])).toBe('1 checkpoint');
  });

  it('says so rather than rendering an empty string for a pipeline with no phases', () => {
    expect(phaseComposition([])).toBe('Empty');
  });
});

describe('commandText', () => {
  it('reads a project command reference and a literal argv the same way', () => {
    expect(commandText(code('t', { command: { ref: 'npm test' } }))).toBe('npm test');
    expect(commandText(code('t', { command: { argv: ['npm', 'run', 'lint'] } }))).toBe(
      'npm run lint',
    );
  });

  it('is empty for a phase with no command, so the rung can say "no command"', () => {
    expect(commandText(code('t', { command: undefined }))).toBe('');
  });
});

describe('issuePhaseIndex', () => {
  it('maps a validator label back to the phase it came from', () => {
    expect(issuePhaseIndex('phases[0] plan')).toBe(0);
    expect(issuePhaseIndex('phases[12] review')).toBe(12);
  });

  it('also reads the zod path a schema rejection arrives as', () => {
    // A schema failure is reported as `i.path.join('.')`, not the label form.
    expect(issuePhaseIndex('phases.2.name')).toBe(2);
  });

  it('returns null for issues that belong to the pipeline, not a phase', () => {
    expect(issuePhaseIndex('acceptance')).toBeNull();
    expect(issuePhaseIndex('save')).toBeNull();
    expect(issuePhaseIndex('phases')).toBeNull();
  });
});

describe('acceptance targets', () => {
  const phases = [agent('plan'), agent('build'), code('test')];

  it('names the phase a rule reads, and nothing for the rules that read all of them', () => {
    expect(acceptanceTarget({ kind: 'envelope_status', phase: 'build' })).toBe('build');
    expect(acceptanceTarget({ kind: 'all_phases_pass' })).toBeNull();
  });

  it('marks the last phase for last_phase_pass so the ladder shows where it lands', () => {
    expect(outcomeMarks({ kind: 'last_phase_pass' }, phases)).toEqual([2]);
  });

  it('marks nothing for all_phases_pass, because marking every rung is not a mark', () => {
    expect(outcomeMarks({ kind: 'all_phases_pass' }, phases)).toEqual([]);
  });

  it('marks the named phase, and marks nothing when the name does not resolve', () => {
    expect(outcomeMarks({ kind: 'envelope_status', phase: 'build' }, phases)).toEqual([1]);
    expect(outcomeMarks({ kind: 'phase_flag', phase: 'ghost', flag: 'passed' }, phases)).toEqual(
      [],
    );
  });

  it('marks nothing on an empty pipeline instead of pointing at a phase that is not there', () => {
    expect(outcomeMarks({ kind: 'last_phase_pass' }, [])).toEqual([]);
  });
});

describe('acceptanceSummary', () => {
  const phases = [agent('plan'), code('test')];

  it('reads each rule back as a sentence naming the phase it depends on', () => {
    expect(acceptanceSummary({ kind: 'all_phases_pass' }, phases)).toContain('all 2 phases');
    expect(acceptanceSummary({ kind: 'last_phase_pass' }, phases)).toContain('"test"');
    expect(acceptanceSummary({ kind: 'envelope_status', phase: 'plan' }, phases)).toContain(
      '"plan"',
    );
    expect(
      acceptanceSummary({ kind: 'phase_flag', phase: 'plan', flag: 'approved' }, phases),
    ).toContain('approved');
  });

  it('does not claim a last phase on a pipeline that has none', () => {
    const summary = acceptanceSummary({ kind: 'last_phase_pass' }, []);
    expect(summary).toContain('no phases yet');
  });

  it('covers every acceptance kind, so a new rule cannot ship with no wording', () => {
    const kinds: Acceptance[] = [
      { kind: 'all_phases_pass' },
      { kind: 'last_phase_pass' },
      { kind: 'envelope_status', phase: 'plan' },
      { kind: 'phase_flag', phase: 'plan', flag: 'passed' },
    ];
    for (const acceptance of kinds) {
      expect(acceptanceSummary(acceptance, phases)).not.toBe('');
    }
  });
});

describe('feedbackArcs', () => {
  it('draws a loop from the failing phase back to the phase that repairs it', () => {
    const phases = [agent('plan'), agent('build'), code('test', { feedbackTo: 'build' })];
    expect(feedbackArcs(phases)).toEqual([
      { from: 2, to: 1, lane: 0, target: 'build', retries: 1 },
    ]);
  });

  it('carries the repair attempt budget so the gutter can label the loop', () => {
    const phases = [agent('build'), code('test', { feedbackTo: 'build', feedbackRetries: 3 })];
    expect(feedbackArcs(phases)[0]?.retries).toBe(3);
  });

  it('ignores a loop whose target does not exist — that is a validation error, not a line', () => {
    const phases = [agent('build'), code('test', { feedbackTo: 'ghost' })];
    expect(feedbackArcs(phases)).toEqual([]);
  });

  it('ignores a forward or self reference, because a repair only ever goes back', () => {
    const forward = [agent('build', { feedbackTo: 'test' }), code('test')];
    const self = [agent('build', { feedbackTo: 'build' })];
    expect(feedbackArcs(forward)).toEqual([]);
    expect(feedbackArcs(self)).toEqual([]);
  });

  it('gives an overlapping loop its own lane so two arcs never sit on one line', () => {
    // review loops back to plan, spanning the build → plan loop already drawn.
    const phases = [
      agent('plan'),
      agent('build', { feedbackTo: 'plan' }),
      agent('review', { feedbackTo: 'plan' }),
    ];
    const arcs = feedbackArcs(phases);
    expect(arcs.map((a) => a.lane)).toEqual([0, 1]);
  });

  it('reuses the near lane for loops that do not overlap', () => {
    const phases = [
      agent('plan'),
      agent('build', { feedbackTo: 'plan' }),
      agent('doc'),
      agent('review'),
      code('test', { feedbackTo: 'review' }),
    ];
    expect(feedbackArcs(phases).map((a) => a.lane)).toEqual([0, 0]);
  });
});

describe('gutter geometry', () => {
  it('stays at its base width when there are no loops to make room for', () => {
    expect(gutterWidth([])).toBe(GUTTER_BASE_W);
  });

  it('widens by one lane per nesting level', () => {
    const phases = [
      agent('plan'),
      agent('build', { feedbackTo: 'plan' }),
      agent('review', { feedbackTo: 'plan' }),
    ];
    expect(gutterWidth(feedbackArcs(phases))).toBe(GUTTER_BASE_W + 2 * LANE_W);
  });

  it('centres a rung anchor on the row it belongs to', () => {
    expect(rungCenter(0)).toBe(RUNG_H / 2);
    expect(rungCenter(3)).toBe(3 * RUNG_H + RUNG_H / 2);
  });

  it('starts an arc on the rail at the failing rung and ends it at the target rung', () => {
    const arcs = feedbackArcs([agent('build'), code('test', { feedbackTo: 'build' })]);
    const railX = gutterWidth(arcs) - 0.5;
    const path = arcPath(arcs[0]!, railX);
    expect(path.startsWith(`M ${railX} ${rungCenter(1)}`)).toBe(true);
    expect(path).toContain(`V ${rungCenter(0) + 6}`);
  });

  it('pushes an outer lane further from the rail than an inner one', () => {
    const inner = arcPath({ from: 2, to: 1, lane: 0, target: 'a', retries: 1 }, 100);
    const outer = arcPath({ from: 3, to: 0, lane: 1, target: 'a', retries: 1 }, 100);
    const xOf = (path: string): number => Number(/H (-?[\d.]+)/.exec(path)![1]);
    expect(xOf(outer)).toBeLessThan(xOf(inner));
  });
});

describe('validationSummary', () => {
  const error: ValidationIssue = { level: 'error', where: 'phases[0] plan', message: 'boom' };
  const warning: ValidationIssue = { level: 'warning', where: 'acceptance', message: 'hmm' };

  it('reads as ready when nothing is wrong and a project is selected', () => {
    const summary = validationSummary([], { hasProject: true });
    expect(summary.tone).toBe('ok');
    expect(summary.detail).toContain('ready to run');
  });

  it('says a project is missing rather than claiming the pipeline can run', () => {
    expect(validationSummary([], { hasProject: false }).detail).toContain('Select a project');
  });

  it('reports warnings without calling the pipeline broken, because it still saves', () => {
    const summary = validationSummary([warning]);
    expect(summary.tone).toBe('warning');
    expect(summary.label).toBe('1 warning');
    expect(summary.detail).toContain('Saved and runnable');
  });

  it('lets an error outrank a warning and says that saving has stopped', () => {
    const summary = validationSummary([warning, error]);
    expect(summary.tone).toBe('error');
    expect(summary.label).toBe('1 error');
    expect(summary.detail).toContain('stop saving');
    expect(summary.errors).toEqual([error]);
    expect(summary.warnings).toEqual([warning]);
  });
});

describe('stages', () => {
  const gate = (name: string, question = 'Ship it?'): PhaseDef => ({
    name,
    kind: 'engineer',
    description: `${name} asks a human`,
    question,
  });

  it('splits the run on checkpoints, with the gate closing its stage', () => {
    const phases = [agent('plan'), agent('build'), gate('g1'), code('test')];
    expect(stagesOf(phases).map((s) => ({ members: s.members, gate: s.gate, end: s.end }))).toEqual(
      [
        { members: [0, 1], gate: 2, end: 3 },
        { members: [3], gate: null, end: 4 },
      ],
    );
  });

  it('always ends with an ungated stage, so there is somewhere to add', () => {
    const trailing = stagesOf([agent('plan'), gate('g1')]);
    expect(trailing).toHaveLength(2);
    expect(trailing[1]).toEqual({ index: 1, members: [], gate: null, end: 2 });
    expect(stagesOf([])).toEqual([{ index: 0, members: [], gate: null, end: 0 }]);
  });

  it('gives an ungated pipeline exactly one stage rather than none', () => {
    expect(stagesOf([agent('a'), code('b')])).toHaveLength(1);
  });

  it('places a gate in the stage it closes, not the one after it', () => {
    const phases = [agent('plan'), gate('g1'), code('test')];
    const stages = stagesOf(phases);
    expect(stageOfPhase(stages, 0)).toBe(0);
    expect(stageOfPhase(stages, 1)).toBe(0);
    expect(stageOfPhase(stages, 2)).toBe(1);
  });

  it('moves a phase across a gate by moving it past the checkpoint', () => {
    const phases = [agent('plan'), agent('build'), gate('g1'), code('test')];
    const to = stageMoveTarget(phases, 1, 1);
    expect(to).toBe(2);
    const next = [...phases];
    next.splice(to!, 0, next.splice(1, 1)[0]!);
    expect(next.map((p) => p.name)).toEqual(['plan', 'g1', 'build', 'test']);
  });

  it('moves a phase back over a gate to the end of the earlier stage', () => {
    const phases = [agent('plan'), agent('build'), gate('g1'), code('test')];
    const to = stageMoveTarget(phases, 3, -1);
    expect(to).toBe(2);
    const next = [...phases];
    next.splice(to!, 0, next.splice(3, 1)[0]!);
    expect(next.map((p) => p.name)).toEqual(['plan', 'build', 'test', 'g1']);
  });

  it('lands in an empty leading stage at the very front', () => {
    const phases = [gate('g1'), agent('a')];
    expect(stageMoveTarget(phases, 1, -1)).toBe(0);
  });

  it('refuses moves with no stage to land in, and never moves a gate itself', () => {
    const phases = [agent('plan'), gate('g1'), code('test')];
    expect(stageMoveTarget(phases, 0, -1)).toBeNull();
    expect(stageMoveTarget(phases, 2, 1)).toBeNull();
    // A checkpoint is the boundary between stages; it cannot sit inside one.
    expect(stageMoveTarget(phases, 1, 1)).toBeNull();
    expect(stageMoveTarget(phases, 1, -1)).toBeNull();
  });

  it('names the single stage for what it is, and numbers the rest', () => {
    const one = stagesOf([agent('a')]);
    expect(stageLabel(one[0]!, 1)).toBe('Whole run');
    const many = stagesOf([agent('a'), gate('g'), agent('b')]);
    expect(stageLabel(many[0]!, 2)).toBe('Stage 1');
    expect(stageLabel(many[1]!, 2)).toBe('Stage 2');
  });

  it('says what closes a stage, quoting the question when there is one', () => {
    const phases = [agent('a'), gate('g', 'Looks right?'), agent('b')];
    const stages = stagesOf(phases);
    expect(stageGateSummary(stages[0]!, phases)).toContain('Looks right?');
    expect(stageGateSummary(stages[1]!, phases)).toContain('acceptance');
  });
});
