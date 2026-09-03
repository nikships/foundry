import { describe, expect, it } from 'vitest';
import { wantsGitContext } from '../../../src/main/engine/runners/agent.js';
import type { AgentDef, PhaseDef, PipelineDef } from '../../../src/shared/types.js';

const qa: Pick<AgentDef, 'name' | 'envelope' | 'toolProfile' | 'writes'> = {
  name: 'qa',
  envelope: 'review',
  toolProfile: 'read-only',
  writes: [],
};

const refiner: Pick<AgentDef, 'name' | 'envelope' | 'toolProfile' | 'writes'> = {
  name: 'refiner',
  envelope: 'brief',
  toolProfile: 'read-only',
  writes: [],
};

const builder: Pick<AgentDef, 'name' | 'envelope' | 'toolProfile' | 'writes'> = {
  name: 'builder',
  envelope: 'build',
  writes: null,
};

function phase(name: string, over: Partial<PhaseDef> = {}): PhaseDef {
  return {
    name,
    kind: 'agent',
    agent: name,
    description: name,
    ...over,
  };
}

function pipeline(phases: PhaseDef[]): PipelineDef {
  return {
    id: 'p',
    name: 'p',
    description: 'test',
    acceptance: { kind: 'all_phases_pass' },
    phases,
  };
}

describe('wantsGitContext', () => {
  it('injects for a synthesized reviewer named qa with envelope review', () => {
    const review = phase('review', { agent: 'qa', envelope: 'review' });
    expect(wantsGitContext(qa, review, pipeline([review]), [qa])).toBe(true);
  });

  it('injects for a read-only agent after a write phase', () => {
    const build = phase('build', { agent: 'builder', envelope: 'build' });
    const scout = phase('audit', { agent: 'refiner', envelope: 'brief' });
    expect(wantsGitContext(refiner, scout, pipeline([build, scout]), [builder, refiner])).toBe(
      true,
    );
  });

  it('skips a read-only agent with no prior write phase', () => {
    const refine = phase('refine', { agent: 'refiner', envelope: 'brief' });
    expect(wantsGitContext(refiner, refine, pipeline([refine]), [refiner])).toBe(false);
  });

  it('skips a writer whose envelope is not review/pr/document', () => {
    const build = phase('build', { agent: 'builder', envelope: 'build' });
    expect(wantsGitContext(builder, build, pipeline([build]), [builder])).toBe(false);
  });
});
