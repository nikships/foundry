/**
 * The shipped roster and the shipped pipelines are two files that have to agree:
 * a pipeline names its agent by string, and an agent names its envelope by
 * string. Nothing at runtime re-checks that pairing before a run spends tokens,
 * so it is checked here.
 */

import { describe, expect, it } from 'vitest';
import { BUILTIN_AGENTS } from '../src/main/store/builtin-agents.js';
import { BUILTIN_PIPELINES } from '../src/main/store/builtin-pipelines.js';
import { validate as validatePipeline } from '../src/main/store/pipelines.js';
import { validate as validateAgent } from '../src/main/store/roster.js';
import { exampleFor, schemaFor } from '../src/main/engine/envelopes.js';
import { PR_FALLBACK_HEADINGS, PR_TEMPLATE_SEARCH_PATHS } from '../src/shared/types.js';

/** Every `{ref}` any shipped pipeline reaches for, so none is a false warning. */
const COMMAND_NAMES = [
  ...new Set(
    BUILTIN_PIPELINES.flatMap((p) =>
      p.phases.flatMap((phase) =>
        phase.command && 'ref' in phase.command ? [phase.command.ref] : [],
      ),
    ),
  ),
];

describe('shipped agents', () => {
  it.each(BUILTIN_AGENTS.map((a) => [a.name, a] as const))('%s validates', (_name, agent) => {
    expect(validateAgent(agent)).toEqual([]);
  });

  it('gives every agent an example that satisfies its own envelope schema', () => {
    for (const agent of BUILTIN_AGENTS) {
      const example = JSON.parse(exampleFor(agent.envelope, agent.customFields));
      const result = schemaFor(agent.envelope, agent.customFields).safeParse(example);
      expect(result.success, `${agent.name} example must validate`).toBe(true);
    }
  });
});

describe('shipped pipelines', () => {
  it.each(BUILTIN_PIPELINES.map((p) => [p.id, p] as const))(
    '%s validates against the shipped roster',
    (_id, pipeline) => {
      expect(validatePipeline(pipeline, BUILTIN_AGENTS, COMMAND_NAMES)).toEqual([]);
    },
  );

  it('holds the refine and ship chain to the phase that judges it', () => {
    const shipped = BUILTIN_PIPELINES.find((p) => p.id === 'refine-build-ship');
    expect(shipped?.acceptance).toEqual({
      kind: 'phase_flag',
      phase: 'production_check',
      flag: 'approved',
    });
    expect(shipped?.phases.map((p) => p.name)).toEqual([
      'refine',
      'plan',
      'commit_plan',
      'build',
      'test',
      'commit_build',
      'production_check',
      'commit_polish',
    ]);
  });

  it('lets the production check write, since a check that cannot fix only reports', () => {
    const finisher = BUILTIN_AGENTS.find((a) => a.name === 'finisher');
    expect(finisher?.writes).toBeNull();
  });

  it('keeps the refiner read-only, since sharpening a request is not doing the work', () => {
    const refiner = BUILTIN_AGENTS.find((a) => a.name === 'refiner');
    expect(refiner?.writes).toEqual([]);
  });

  it('keeps the shipped refine-build-ship and full-sdlc chains unchanged', () => {
    const ship = BUILTIN_PIPELINES.find((p) => p.id === 'refine-build-ship');
    const sdlc = BUILTIN_PIPELINES.find((p) => p.id === 'full-sdlc');
    expect(ship?.phases.map((p) => p.name)).toEqual([
      'refine',
      'plan',
      'commit_plan',
      'build',
      'test',
      'commit_build',
      'production_check',
      'commit_polish',
    ]);
    expect(sdlc?.phases.map((p) => p.name)).toEqual([
      'refine',
      'plan',
      'commit_plan',
      'build',
      'test',
      'commit_build',
      'production_check',
      'commit_polish',
      'review',
      'document',
      'commit_docs',
    ]);
    expect(ship?.phases.some((p) => p.name === 'open_pr')).toBe(false);
    expect(sdlc?.phases.some((p) => p.name === 'open_pr')).toBe(false);
  });

  it('adds PR-enabled copies that append an open_pr phase on the PR envelope', () => {
    const shipPr = BUILTIN_PIPELINES.find((p) => p.id === 'refine-build-ship-pr');
    const sdlcPr = BUILTIN_PIPELINES.find((p) => p.id === 'full-sdlc-pr');
    const ship = BUILTIN_PIPELINES.find((p) => p.id === 'refine-build-ship');
    const sdlc = BUILTIN_PIPELINES.find((p) => p.id === 'full-sdlc');

    expect(shipPr?.name).toBe('Refine → Build → Ship → PR');
    expect(sdlcPr?.name).toBe('Full SDLC → PR');
    expect(shipPr?.acceptance).toEqual(ship?.acceptance);
    expect(sdlcPr?.acceptance).toEqual(sdlc?.acceptance);
    expect(shipPr?.phases.map((p) => p.name)).toEqual([
      ...(ship?.phases.map((p) => p.name) ?? []),
      'open_pr',
    ]);
    expect(sdlcPr?.phases.map((p) => p.name)).toEqual([
      ...(sdlc?.phases.map((p) => p.name) ?? []),
      'open_pr',
    ]);

    for (const pipeline of [shipPr, sdlcPr]) {
      const openPr = pipeline?.phases.find((p) => p.name === 'open_pr');
      expect(openPr).toMatchObject({
        kind: 'agent',
        agent: 'pr_writer',
        envelope: 'pr',
      });
      expect(openPr?.prompt?.inputs).toEqual([
        'request',
        'envelope:plan',
        'envelope:build',
        'envelope:production_check',
      ]);
    }
  });

  it('ships a read-only pr_writer that drafts a pr envelope', () => {
    const writer = BUILTIN_AGENTS.find((a) => a.name === 'pr_writer');
    expect(writer).toBeDefined();
    expect(writer?.envelope).toBe('pr');
    expect(writer?.writes).toEqual([]);
    expect(writer?.builtin).toBe(true);
    expect(writer?.userPrompt).toContain('{{request}}');
    expect(writer?.userPrompt).toContain('{{envelope:plan}}');
    expect(writer?.userPrompt).toContain('{{envelope:build}}');
    expect(writer?.systemPrompt).toContain('Do not create, edit, or delete any file');
    expect(writer?.systemPrompt).toContain('no raw `git diff`');
    expect(writer?.systemPrompt).toContain('no invented issue numbers');

    const listed = [...(writer?.systemPrompt.matchAll(/`([^`]+)`/g) ?? [])].map((m) => m[1]);
    expect(
      listed.filter((path) => (PR_TEMPLATE_SEARCH_PATHS as readonly string[]).includes(path)),
    ).toEqual([...PR_TEMPLATE_SEARCH_PATHS]);

    for (const heading of PR_FALLBACK_HEADINGS) {
      expect(writer?.systemPrompt).toContain(`## ${heading}`);
    }
  });
});
