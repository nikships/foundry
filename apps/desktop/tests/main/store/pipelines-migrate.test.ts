/**
 * A pipelines file is user state plus shipped seeds. Loading it must restore
 * any missing builtin, leave user work alone, and strip `builtin` from an id
 * this build does not ship so a leftover cannot be resurrected by a reset.
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../helpers/tmp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PipelineStore } from '../../../src/main/store/pipelines.js';
import { JsonStore } from '../../../src/main/store/json-store.js';
import { BUILTIN_PIPELINES } from '../../../src/shared/builtin-pipelines.js';
import { healingEligible, type PipelineDef } from '../../../src/shared/types.js';

let dir: string;

beforeEach(() => {
  dir = tempDir('foundry-pipelines-migrate-');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A leftover pipeline whose id this build does not ship. */
const leftover = (): PipelineDef => ({
  id: 'plan-build',
  name: 'Plan → Build',
  description: 'Spec first, then implement it, with each step committed separately.',
  acceptance: { kind: 'envelope_status', phase: 'build' },
  builtin: true,
  phases: [
    {
      name: 'build',
      kind: 'agent',
      agent: 'builder',
      description: 'Implement the plan exactly and report every changed file.',
      envelope: 'build',
      prompt: { inputs: ['request'] },
    },
  ],
});

const userPipeline = (): PipelineDef => ({
  id: 'my-chain',
  name: 'My chain',
  description: 'A pipeline the user built themselves.',
  acceptance: { kind: 'all_phases_pass' },
  phases: [
    {
      name: 'build',
      kind: 'agent',
      agent: 'builder',
      description: 'Do the user-defined work.',
      envelope: 'build',
      prompt: { inputs: ['request'] },
    },
  ],
});

function writeStored(list: PipelineDef[]): void {
  new JsonStore<PipelineDef[]>(join(dir, 'pipelines.json'), () => []).write(list);
}

describe('loading a pipelines file', () => {
  it('seeds every shipped chain that is missing', () => {
    writeStored([leftover(), userPipeline()]);
    const store = new PipelineStore(dir);
    const ids = new Set(store.list().map((p) => p.id));
    for (const shipped of BUILTIN_PIPELINES) {
      expect(ids.has(shipped.id), shipped.id).toBe(true);
    }
  });

  it('keeps an unshipped leftover but strips builtin, so the user can delete it', () => {
    writeStored([leftover(), userPipeline()]);
    const store = new PipelineStore(dir);

    const old = store.list().find((p) => p.id === 'plan-build');
    expect(old).toBeDefined();
    expect(old!.builtin).toBe(false);
    store.remove('plan-build');
    expect(new PipelineStore(dir).list().some((p) => p.id === 'plan-build')).toBe(false);
  });

  it('leaves user pipelines untouched', () => {
    writeStored([userPipeline()]);
    const store = new PipelineStore(dir);
    const mine = store.list().find((p) => p.id === 'my-chain');
    expect(mine?.name).toBe('My chain');
    expect(mine?.builtin ?? false).toBe(false);
  });

  it('never clobbers a user-edited copy of a still-shipped builtin', () => {
    const edited = { ...BUILTIN_PIPELINES[0]!, description: 'my own words' };
    writeStored([edited]);
    const store = new PipelineStore(dir);
    expect(store.get(edited.id)?.description).toBe('my own words');
  });

  it('reports an edited builtin as stale and resets only that entry', () => {
    const edited = { ...BUILTIN_PIPELINES[0]!, description: 'my own words' };
    writeStored([edited, userPipeline()]);
    const store = new PipelineStore(dir);

    expect(store.staleBuiltins()).toContain(edited.id);
    store.resetBuiltin(edited.id);

    expect(store.staleBuiltins()).not.toContain(edited.id);
    expect(store.get(edited.id)).toEqual(BUILTIN_PIPELINES[0]);
    expect(store.get('my-chain')?.name).toBe('My chain');
  });

  it('loads a phase that still carries removed tool and timeout knobs, and drops them', () => {
    const stored = userPipeline();
    stored.phases[0] = {
      ...stored.phases[0]!,
      // Written by a build whose phase schema declared these; nothing ever read
      // them, and the phase must not fail to load because they are still there.
      toolProfile: 'read-only',
      tools: ['read', 'grep'],
      timeoutMs: 900_000,
    } as (typeof stored.phases)[number];
    writeStored([stored]);

    const phase = new PipelineStore(dir).get('my-chain')?.phases[0];

    expect(phase?.name).toBe('build');
    expect(phase).not.toHaveProperty('toolProfile');
    expect(phase).not.toHaveProperty('tools');
    expect(phase).not.toHaveProperty('timeoutMs');
  });

  it('drops leftover engineer checkpoint phases and their canvas nodes', () => {
    const stored = userPipeline();
    stored.phases = [
      stored.phases[0]!,
      {
        name: 'approve',
        kind: 'engineer',
        description: 'Pause so an operator can review the work so far.',
        question: 'Should the run continue?',
      } as unknown as (typeof stored.phases)[number],
    ];
    stored.canvas = {
      nodes: {
        build: { x: 0, y: 0 },
        approve: { x: 320, y: 0 },
      },
    };
    writeStored([stored]);

    const loaded = new PipelineStore(dir).get('my-chain');
    expect(loaded?.phases.map((phase) => phase.name)).toEqual(['build']);
    expect(loaded?.phases.some((phase) => (phase as { kind?: string }).kind === 'engineer')).toBe(
      false,
    );
    expect(loaded?.canvas?.nodes).toEqual({ build: { x: 0, y: 0 } });
  });

  it('does not report a shipped chain as edited just because the file was normalized', () => {
    const shipped = BUILTIN_PIPELINES[0]!;
    writeStored([
      {
        ...shipped,
        phases: shipped.phases.map((phase, i) =>
          i === 0 ? ({ ...phase, tools: ['read'] } as typeof phase) : phase,
        ),
      },
    ]);

    expect(new PipelineStore(dir).staleBuiltins()).not.toContain(shipped.id);
  });

  it('loads a pipeline written before healing existed, and heals its project commands', () => {
    // No `heal` anywhere, which is every pipeline file on disk today. The
    // phase has to load unchanged and pick up the default rather than needing
    // an edit to get a healer.
    const stored = userPipeline();
    stored.phases = [
      ...stored.phases,
      {
        name: 'test',
        kind: 'code',
        description: "Run the project's test command.",
        command: { ref: 'test' },
        feedbackTo: 'build',
      },
    ];
    writeStored([stored]);

    const phase = new PipelineStore(dir).get('my-chain')?.phases[1];
    expect(phase).not.toHaveProperty('heal');
    expect(healingEligible(phase!)).toBe(true);
  });

  it('round-trips an explicit heal choice on a phase', () => {
    const stored = userPipeline();
    stored.phases = [
      ...stored.phases,
      {
        name: 'lint',
        kind: 'code',
        description: 'Run the linter, with healing turned off by hand.',
        command: { ref: 'lint' },
        heal: false,
      },
    ];
    writeStored([stored]);

    const phase = new PipelineStore(dir).get('my-chain')?.phases[1];
    expect(phase?.heal).toBe(false);
    expect(healingEligible(phase!)).toBe(false);
  });

  it('does not treat local canvas placement as a shipped-definition difference', () => {
    writeStored([{ ...BUILTIN_PIPELINES[0]!, canvas: { nodes: { plan: { x: 20, y: 40 } } } }]);
    expect(new PipelineStore(dir).staleBuiltins()).not.toContain(BUILTIN_PIPELINES[0]!.id);
  });
});
