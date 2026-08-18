/**
 * The shipped pipeline set was replaced wholesale (five PR-ending chains), so
 * migration has two jobs on a file written by an older build: seed the new
 * builtins without touching user work, and strip `builtin` from ids this build
 * no longer ships so the leftovers are ordinary, deletable pipelines instead of
 * entries a reset or a missing-builtin restore would fight over.
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PipelineStore } from '../src/main/store/pipelines.js';
import { JsonStore } from '../src/main/store/json-store.js';
import { BUILTIN_PIPELINES } from '../src/main/store/builtin-pipelines.js';
import type { PipelineDef } from '../src/shared/types.js';

let dir: string;

beforeEach(() => {
  dir = tempDir('foundry-pipelines-migrate-');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The retired `plan-build` chain as an older build wrote it. */
const retired = (): PipelineDef => ({
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
      prompt: { template: 'user', inputs: ['request'] },
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
      prompt: { template: 'user', inputs: ['request'] },
    },
  ],
});

function writeStored(list: PipelineDef[]): void {
  new JsonStore<PipelineDef[]>(join(dir, 'pipelines.json'), () => []).write(list);
}

describe('loading a pipelines file from before the PR-chain revamp', () => {
  it('seeds every new shipped chain', () => {
    writeStored([retired(), userPipeline()]);
    const store = new PipelineStore(dir);
    const ids = new Set(store.list().map((p) => p.id));
    for (const shipped of BUILTIN_PIPELINES) {
      expect(ids.has(shipped.id), shipped.id).toBe(true);
    }
  });

  it('keeps the retired chain but strips builtin, so the user can delete it', () => {
    writeStored([retired(), userPipeline()]);
    const store = new PipelineStore(dir);

    const old = store.list().find((p) => p.id === 'plan-build');
    expect(old).toBeDefined();
    expect(old!.builtin).toBe(false);
    // Deletion sticks: nothing restores an id this build does not ship.
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
});
