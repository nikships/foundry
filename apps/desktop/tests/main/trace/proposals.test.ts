/**
 * Durable proposal rows on the per-project trace DB. Real sqlite, no model.
 *
 * The `proposals` table is the history that survives reload/restart; the
 * in-memory session registry is only the live-turn cache. Only `Tracer`
 * prepares against the table.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../helpers/tmp.js';
import { openDb, projectDbPath, projectRunsDir } from '../../../src/main/trace/db.js';
import { Tracer } from '../../../src/main/trace/tracer.js';
import type { GeneratedRunPlan } from '../../../src/shared/types.js';

function samplePlan(planId: string, projectId: string): GeneratedRunPlan {
  return {
    planId,
    projectId,
    prompt: 'make it better',
    refinedRequest: 'Improve the README with a usage section.',
    rationale: 'Small change, one build phase.',
    pipeline: {
      id: `generated-${planId}`,
      name: 'Build',
      description: 'One build.',
      acceptance: { kind: 'all_phases_pass' },
      phases: [
        {
          name: 'build',
          kind: 'agent',
          agent: 'builder',
          model: 'scripted/strong',
          reasoningEffort: 'high',
          description: 'Make the change.',
          envelope: 'build',
          prompt: { inputs: ['request'] },
        },
      ],
      builtin: false,
    },
    agents: [],
    warnings: [],
    model: 'inherit',
    reasoningEffort: 'high',
  };
}

let support: string;
let tracerFor: (projectPath: string) => Tracer;

beforeEach(() => {
  support = tempDir('foundry-proposals-');
  tracerFor = (projectPath: string) =>
    new Tracer(openDb(projectDbPath(support, projectPath)), projectRunsDir(support, projectPath));
});

describe('proposal persistence', () => {
  it('lists newest-first per project and excludes other projects', () => {
    const tracerA = tracerFor('/repo/a');
    tracerA.createProposal({
      planId: 'plan-first',
      projectId: 'proj_a',
      prompt: 'first',
      model: 'inherit',
      reasoningEffort: 'medium',
      createdAt: 1000,
    });
    tracerA.createProposal({
      planId: 'plan-second',
      projectId: 'proj_a',
      prompt: 'second',
      model: 'inherit',
      reasoningEffort: 'medium',
      createdAt: 2000,
    });
    // Touch the first row so its updated_at overtakes the second.
    tracerA.updateProposal('plan-first', { detail: 'bump', updatedAt: 3000 });

    const tracerB = tracerFor('/repo/b');
    tracerB.createProposal({
      planId: 'plan-other',
      projectId: 'proj_b',
      prompt: 'other',
      model: 'inherit',
      reasoningEffort: 'medium',
      createdAt: 1500,
    });

    const listed = tracerA.proposalsByProject('proj_a');
    expect(listed.map((row) => row.planId)).toEqual(['plan-first', 'plan-second']);
    expect(listed.every((row) => row.projectId === 'proj_a')).toBe(true);
    expect(tracerB.proposalsByProject('proj_b').map((row) => row.planId)).toEqual(['plan-other']);
  });

  it('round-trips entries, plan, messages, and revision', () => {
    const tracer = tracerFor('/repo/a');
    const plan = samplePlan('plan-abc', 'proj_a');
    tracer.createProposal({
      planId: 'plan-abc',
      projectId: 'proj_a',
      prompt: 'make it better',
      model: 'inherit',
      reasoningEffort: 'high',
      createdAt: 1000,
    });
    tracer.updateProposal('plan-abc', {
      status: 'ready',
      detail: 'plan ready',
      entriesJson: JSON.stringify([{ id: 'e1', kind: 'note', text: 'hello', at: 1001 }]),
      planJson: JSON.stringify(plan),
      rawReply: '{"ok":true}',
      messagesJson: JSON.stringify([{ id: 'm1', role: 'operator', text: 'hi', at: 1002 }]),
      revision: 1,
      updatedAt: 2000,
      endedAt: 2000,
    });

    const read = tracer.proposal('plan-abc');
    expect(read).not.toBeNull();
    expect(read!.status).toBe('ready');
    expect(read!.entries).toEqual([{ id: 'e1', kind: 'note', text: 'hello', at: 1001 }]);
    expect(read!.plan).toEqual(plan);
    expect(read!.messages).toEqual([{ id: 'm1', role: 'operator', text: 'hi', at: 1002 }]);
    expect(read!.revision).toBe(1);
    expect(read!.rawReply).toBe('{"ok":true}');
    expect(read!.createdAt).toBe(1000);
    expect(read!.updatedAt).toBe(2000);
    expect(read!.endedAt).toBe(2000);
  });

  it('degrades corrupt JSON to empty/null rather than throwing', () => {
    const tracer = tracerFor('/repo/a');
    tracer.createProposal({
      planId: 'plan-bad',
      projectId: 'proj_a',
      prompt: 'bad',
      model: 'inherit',
      reasoningEffort: 'medium',
      createdAt: 1000,
    });
    const db = openDb(projectDbPath(support, '/repo/a'));
    db.prepare("UPDATE proposals SET entries_json = '{broken', messages_json = '[oops'").run();
    db.prepare("UPDATE proposals SET plan_json = '{broken', accepted_plan_json = '{broken'").run();
    const reopened = new Tracer(db, projectRunsDir(support, '/repo/a'));
    const read = reopened.proposal('plan-bad');
    expect(read!.entries).toEqual([]);
    expect(read!.messages).toEqual([]);
    expect(read!.plan).toBeNull();
    expect(read!.acceptedPlan).toBeNull();
  });

  it('hides discarded tombstones by default and shows them on opt-in', () => {
    const tracer = tracerFor('/repo/a');
    tracer.createProposal({
      planId: 'plan-live',
      projectId: 'proj_a',
      prompt: 'live',
      model: 'inherit',
      reasoningEffort: 'medium',
      createdAt: 1000,
    });
    tracer.createProposal({
      planId: 'plan-gone',
      projectId: 'proj_a',
      prompt: 'gone',
      model: 'inherit',
      reasoningEffort: 'medium',
      createdAt: 1001,
    });
    tracer.updateProposal('plan-gone', { status: 'discarded', updatedAt: 2000 });

    expect(tracer.proposalsByProject('proj_a').map((row) => row.planId)).toEqual(['plan-live']);
    expect(
      tracer
        .proposalsByProject('proj_a', { includeDiscarded: true })
        .map((row) => row.planId)
        .sort(),
    ).toEqual(['plan-gone', 'plan-live']);
  });

  it('survives a reopen: rows come back from the file, not from memory', () => {
    const tracer = tracerFor('/repo/a');
    tracer.createProposal({
      planId: 'plan-durable',
      projectId: 'proj_a',
      prompt: 'durable',
      model: 'inherit',
      reasoningEffort: 'medium',
      createdAt: 1000,
    });
    tracer.updateProposal('plan-durable', { status: 'ready', updatedAt: 2000 });

    const reopened = tracerFor('/repo/a');
    const read = reopened.proposal('plan-durable');
    expect(read!.status).toBe('ready');
    expect(read!.prompt).toBe('durable');
    expect(reopened.proposalsByProject('proj_a')).toHaveLength(1);
  });
});
