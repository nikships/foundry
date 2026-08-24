import { describe, expect, it } from 'vitest';
import type { AgentDef, GeneratedRunPlan, PipelineDef } from '@shared/types.js';
import { exportedPipelineId } from '@shared/plan-export.js';
import { exportRunPlan } from '@main/store/export-plan.js';
import { PipelineStore } from '@main/store/pipelines.js';
import { RosterStore } from '@main/store/roster.js';
import { tempDir } from '../../helpers/tmp.js';

const SYNTHESIZED_AGENT: AgentDef = {
  name: 'orch_search_specialist',
  purpose: 'Own the bounded search repair.',
  model: 'inherit',
  reasoningEffort: 'medium',
  systemPrompt: 'Repair search behavior.',
  userPrompt: '{{request}}',
  writes: ['src/search/**'],
  envelope: 'build',
  color: '#7755cc',
};

function plan(): GeneratedRunPlan {
  return {
    planId: 'plan-run-specific-123',
    projectId: 'project-1',
    prompt: 'Fix search.',
    refinedRequest: 'Repair search and prove its behavior.',
    rationale: 'One bounded specialist phase is sufficient.',
    pipeline: {
      id: 'generated-plan-run-specific-123',
      name: 'Search repair and proof',
      description: 'Repair the search behavior with a bounded specialist.',
      phases: [
        {
          name: 'repair_search',
          kind: 'agent',
          description: 'Repair search behavior within its owned source tree.',
          agent: SYNTHESIZED_AGENT.name,
          prompt: { inputs: ['request'] },
        },
      ],
      acceptance: { kind: 'all_phases_pass' },
      builtin: false,
    },
    agents: [structuredClone(SYNTHESIZED_AGENT)],
    warnings: [],
    model: 'inherit',
    reasoningEffort: 'medium',
  };
}

function harness() {
  const dir = tempDir('foundry-export-plan-');
  const roster = new RosterStore(dir);
  const pipelines = new PipelineStore(dir);
  const stores = {
    roster,
    pipelines,
    rosterScope: {},
    pipelineScope: {},
    rosterAgents: roster.list(),
    commandNames: [],
    knownEnvelopes: [],
  };
  return { roster, pipelines, stores };
}

describe('orchestrated plan export', () => {
  it('regenerates the pipeline id and saves selected entities as ordinary definitions', () => {
    const { roster, pipelines, stores } = harness();
    const source = plan();

    const result = exportRunPlan(
      source,
      { pipeline: true, agents: [SYNTHESIZED_AGENT.name] },
      stores,
    );

    expect(result.ok).toBe(true);
    const targetId = exportedPipelineId(source.pipeline.name);
    expect(targetId).toBe('search-repair-and-proof');
    expect(targetId).not.toContain(source.planId);
    expect(pipelines.get(targetId)).toMatchObject({
      id: targetId,
      name: source.pipeline.name,
      builtin: false,
    });
    expect(roster.get(SYNTHESIZED_AGENT.name)).toMatchObject({
      purpose: SYNTHESIZED_AGENT.purpose,
      builtin: false,
    });
    expect(pipelines.get(source.pipeline.id)).toBeNull();
  });

  it('refuses an agent-name collision without saving the pipeline', () => {
    const { roster, pipelines, stores } = harness();
    roster.save(structuredClone(SYNTHESIZED_AGENT));

    const result = exportRunPlan(
      plan(),
      { pipeline: true, agents: [SYNTHESIZED_AGENT.name] },
      { ...stores, rosterAgents: roster.list() },
    );

    expect(result).toMatchObject({ ok: false });
    expect(result.issues).toContainEqual({
      level: 'error',
      where: `agent:${SYNTHESIZED_AGENT.name}`,
      message: `An agent named "${SYNTHESIZED_AGENT.name}" already exists.`,
    });
    expect(pipelines.get(exportedPipelineId(plan().pipeline.name))).toBeNull();
  });

  it('preflights a pipeline-id collision before writing a selected agent', () => {
    const { roster, pipelines, stores } = harness();
    const source = plan();
    const existing: PipelineDef = {
      ...source.pipeline,
      id: exportedPipelineId(source.pipeline.name),
      phases: [
        {
          name: 'inspect_search',
          kind: 'agent',
          description: 'Inspect search behavior before any changes are proposed.',
          agent: roster.list()[0]!.name,
          prompt: { inputs: ['request'] },
        },
      ],
    };
    expect(pipelines.save(existing, roster.list(), []).ok).toBe(true);

    const result = exportRunPlan(
      source,
      { pipeline: true, agents: [SYNTHESIZED_AGENT.name] },
      stores,
    );

    expect(result.issues).toContainEqual({
      level: 'error',
      where: 'pipeline',
      message: `A pipeline with id "${existing.id}" already exists.`,
    });
    expect(roster.get(SYNTHESIZED_AGENT.name)).toBeNull();
  });

  it('preflights a pipeline display-name collision before writing a selected agent', () => {
    const { roster, pipelines, stores } = harness();
    const source = plan();
    const existing: PipelineDef = {
      ...source.pipeline,
      id: 'an-unrelated-id',
      name: source.pipeline.name.toUpperCase(),
      phases: [
        {
          name: 'inspect_search',
          kind: 'agent',
          description: 'Inspect search behavior before any changes are proposed.',
          agent: roster.list()[0]!.name,
          prompt: { inputs: ['request'] },
        },
      ],
    };
    expect(pipelines.save(existing, roster.list(), []).ok).toBe(true);

    const result = exportRunPlan(
      source,
      { pipeline: true, agents: [SYNTHESIZED_AGENT.name] },
      stores,
    );

    expect(result.issues).toContainEqual({
      level: 'error',
      where: 'pipeline',
      message: `A pipeline named "${source.pipeline.name}" already exists.`,
    });
    expect(roster.get(SYNTHESIZED_AGENT.name)).toBeNull();
  });

  it('saves one synthesized agent without exporting the pipeline', () => {
    const { roster, pipelines, stores } = harness();

    expect(
      exportRunPlan(plan(), { pipeline: false, agents: [SYNTHESIZED_AGENT.name] }, stores),
    ).toMatchObject({ ok: true });
    expect(roster.get(SYNTHESIZED_AGENT.name)).not.toBeNull();
    expect(pipelines.get(exportedPipelineId(plan().pipeline.name))).toBeNull();
  });
});
