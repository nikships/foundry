/**
 * The shipped roster and the shipped pipelines are two files that have to agree:
 * a pipeline names its agent by string, and an agent names its envelope by
 * string. Nothing at runtime re-checks that pairing before a run spends tokens,
 * so it is checked here.
 *
 * The shipped chains also carry two structural promises that no single phase
 * can see: every phase that edits code is proven by the project's test command
 * before the commit that records it, and every chain ends in a pull request
 * the engine actually opened. Those are pinned per pipeline below.
 */

import { describe, expect, it } from 'vitest';
import { BUILTIN_AGENTS } from '../../../src/main/store/builtin-agents.js';
import { BUILTIN_PIPELINES } from '../../../src/main/store/builtin-pipelines.js';
import { validate as validatePipeline } from '../../../src/main/store/pipelines.js';
import { validate as validateAgent } from '../../../src/main/store/roster.js';
import { exampleFor, schemaFor } from '../../../src/main/engine/envelopes.js';
import {
  PR_FALLBACK_HEADINGS,
  PR_TEMPLATE_SEARCH_PATHS,
  type PhaseDef,
  type PipelineDef,
} from '../../../src/shared/types.js';

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

const byId = (id: string): PipelineDef => {
  const found = BUILTIN_PIPELINES.find((p) => p.id === id);
  if (!found) throw new Error(`no shipped pipeline with id "${id}"`);
  return found;
};

const agentByName = (name: string) => BUILTIN_AGENTS.find((a) => a.name === name);

/** Phases whose agent can touch source code (writes: null = unrestricted). */
function codeEditingPhases(pipeline: PipelineDef): PhaseDef[] {
  return pipeline.phases.filter((phase) => {
    if (phase.kind !== 'agent') return false;
    return agentByName(phase.agent!)?.writes === null;
  });
}

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

  it('lets the production check write, since a check that cannot fix only reports', () => {
    expect(agentByName('finisher')?.writes).toBeNull();
  });

  it('keeps the refiner read-only, since sharpening a request is not doing the work', () => {
    expect(agentByName('refiner')?.writes).toEqual([]);
  });

  it('has the finisher claim its changed files, so diff_matches_claims can check them', () => {
    const finisher = agentByName('finisher');
    expect(finisher?.customFields?.some((f) => f.name === 'changed_files')).toBe(true);
  });
});

describe('shipped pipelines', () => {
  it.each(BUILTIN_PIPELINES.map((p) => [p.id, p] as const))(
    '%s validates against the shipped roster',
    (_id, pipeline) => {
      expect(validatePipeline(pipeline, BUILTIN_AGENTS, COMMAND_NAMES)).toEqual([]);
    },
  );

  it('ships exactly six multi-phase chains, each ending in open_pr', () => {
    expect(BUILTIN_PIPELINES.map((p) => p.id)).toEqual([
      'build-pr',
      'fix-pr',
      'spec-pr',
      'triage-issue-pr',
      'ship-pr',
      'sdlc-pr',
    ]);
    for (const pipeline of BUILTIN_PIPELINES) {
      expect(pipeline.phases.length, `${pipeline.id} is multi-phase`).toBeGreaterThanOrEqual(4);
      expect(pipeline.phases.at(-1)?.name, `${pipeline.id} ends in open_pr`).toBe('open_pr');
    }
  });

  /**
   * FOU-80: every shipped chain must leave a software-development artifact —
   * a pull request carrying implementation work or a spec. The PR phase is
   * pinned as the terminal phase above; this pins the artifact the PR carries:
   * either an unrestricted code-editing phase ran, or a planner phase wrote a
   * spec and a commit phase recorded it before the PR opened.
   */
  it('gives every chain a tangible artifact for its PR: code changes or a committed spec', () => {
    for (const pipeline of BUILTIN_PIPELINES) {
      const editsCode = codeEditingPhases(pipeline).length > 0;
      const specIndex = pipeline.phases.findIndex(
        (p) => p.kind === 'agent' && agentByName(p.agent!)?.writes?.includes('specs/'),
      );
      const commitAfterSpec =
        specIndex >= 0 &&
        pipeline.phases
          .slice(specIndex + 1)
          .some((p) => p.kind === 'code' && p.command && 'builtin' in p.command);
      expect(
        editsCode || commitAfterSpec,
        `${pipeline.id} produces implementation changes or a committed spec`,
      ).toBe(true);
    }
  });

  it('accepts every chain on the PR envelope, never an earlier flag', () => {
    for (const pipeline of BUILTIN_PIPELINES) {
      expect(pipeline.acceptance, pipeline.id).toEqual({
        kind: 'envelope_status',
        phase: 'open_pr',
      });
    }
  });

  it('pins the phase order of each chain', () => {
    expect(byId('build-pr').phases.map((p) => p.name)).toEqual([
      'plan',
      'commit_plan',
      'build',
      'test',
      'commit_build',
      'open_pr',
    ]);
    expect(byId('fix-pr').phases.map((p) => p.name)).toEqual([
      'diagnose',
      'fix',
      'test',
      'commit_fix',
      'open_pr',
    ]);
    expect(byId('spec-pr').phases.map((p) => p.name)).toEqual([
      'survey',
      'spec',
      'commit_spec',
      'open_pr',
    ]);
    expect(byId('triage-issue-pr').phases.map((p) => p.name)).toEqual([
      'diagnose',
      'file_issue',
      'spec',
      'commit_spec',
      'open_pr',
    ]);
    expect(byId('ship-pr').phases.map((p) => p.name)).toEqual([
      'refine',
      'plan',
      'commit_plan',
      'build',
      'test',
      'commit_build',
      'production_check',
      'verify',
      'commit_polish',
      'open_pr',
    ]);
    expect(byId('sdlc-pr').phases.map((p) => p.name)).toEqual([
      'refine',
      'plan',
      'commit_plan',
      'build',
      'test',
      'commit_build',
      'production_check',
      'verify',
      'commit_polish',
      'review',
      'document',
      'commit_docs',
      'open_pr',
    ]);
  });

  it('never commits or opens a PR on unproven code: every code edit is followed by a test run before its commit', () => {
    for (const pipeline of BUILTIN_PIPELINES) {
      for (const phase of codeEditingPhases(pipeline)) {
        const index = pipeline.phases.findIndex((p) => p.name === phase.name);
        const after = pipeline.phases.slice(index + 1);
        const testIndex = after.findIndex(
          (p) => p.kind === 'code' && p.command && 'ref' in p.command && p.command.ref === 'test',
        );
        const commitIndex = after.findIndex(
          (p) => p.kind === 'code' && p.command && 'builtin' in p.command,
        );
        expect(
          testIndex,
          `${pipeline.id}/${phase.name} is followed by a test phase`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          testIndex,
          `${pipeline.id}/${phase.name}: the test runs before the commit that records it`,
        ).toBeLessThan(commitIndex === -1 ? Number.POSITIVE_INFINITY : commitIndex);
      }
    }
  });

  it('routes every test failure back to the phase that owns the fix', () => {
    for (const pipeline of BUILTIN_PIPELINES) {
      for (const phase of pipeline.phases) {
        if (phase.kind !== 'code' || !phase.command || !('ref' in phase.command)) continue;
        expect(phase.feedbackTo, `${pipeline.id}/${phase.name} names its fixer`).toBeTruthy();
        const target = pipeline.phases.find((p) => p.name === phase.feedbackTo);
        expect(target?.kind, `${pipeline.id}/${phase.name} feeds back to an agent`).toBe('agent');
        expect(
          agentByName(target!.agent!)?.writes,
          `${pipeline.id}/${phase.name} feeds back to an agent that can actually write the fix`,
        ).toBeNull();
      }
    }
  });

  it('halts every review verdict that does not approve, so rejected work cannot reach the PR', () => {
    for (const pipeline of BUILTIN_PIPELINES) {
      for (const phase of pipeline.phases) {
        if (phase.kind !== 'agent') continue;
        const envelope = phase.envelope ?? agentByName(phase.agent!)?.envelope;
        if (envelope !== 'review') continue;
        expect(phase.gates, `${pipeline.id}/${phase.name} verdict is self-consistent`).toContain(
          'verdict_consistent',
        );
        expect(phase.gates, `${pipeline.id}/${phase.name} disapproval halts the run`).toContain(
          'disapproval_halts',
        );
      }
    }
  });

  it('re-proves the production-check fixes before committing them', () => {
    for (const id of ['ship-pr', 'sdlc-pr']) {
      const names = byId(id).phases.map((p) => p.name);
      const check = names.indexOf('production_check');
      const verify = names.indexOf('verify');
      const polish = names.indexOf('commit_polish');
      expect(check, id).toBeGreaterThanOrEqual(0);
      expect(verify, id).toBe(check + 1);
      expect(polish, id).toBe(verify + 1);
      const verifyPhase = byId(id).phases[verify]!;
      expect(verifyPhase.feedbackTo).toBe('production_check');
    }
  });

  it('feeds the PR writer every envelope its chain produced, so the body describes the whole run', () => {
    const expected: Record<string, string[]> = {
      'build-pr': ['request', 'envelope:plan', 'envelope:build'],
      'fix-pr': ['request', 'envelope:diagnose', 'envelope:fix'],
      'spec-pr': ['request', 'envelope:survey', 'envelope:spec'],
      'triage-issue-pr': ['request', 'envelope:diagnose', 'envelope:file_issue', 'envelope:spec'],
      'ship-pr': ['request', 'envelope:plan', 'envelope:build', 'envelope:production_check'],
      'sdlc-pr': [
        'request',
        'envelope:plan',
        'envelope:build',
        'envelope:production_check',
        'envelope:review',
        'envelope:document',
      ],
    };
    for (const pipeline of BUILTIN_PIPELINES) {
      const openPr = pipeline.phases.at(-1)!;
      expect(openPr).toMatchObject({ kind: 'agent', agent: 'pr_writer', envelope: 'pr' });
      expect(openPr.prompt?.inputs, pipeline.id).toEqual(expected[pipeline.id]);
    }
  });

  it('keeps spec-pr free of code-editing phases and test refs, so it runs on any repo', () => {
    const spec = byId('spec-pr');
    expect(codeEditingPhases(spec)).toEqual([]);
    expect(
      spec.phases.some(
        (p) => p.kind === 'code' && p.command && 'ref' in p.command && p.command.ref === 'test',
      ),
    ).toBe(false);
  });

  it('keeps triage-issue-pr free of code-editing phases and test refs, so it runs on any repo', () => {
    const triage = byId('triage-issue-pr');
    expect(codeEditingPhases(triage)).toEqual([]);
    expect(
      triage.phases.some(
        (p) => p.kind === 'code' && p.command && 'ref' in p.command && p.command.ref === 'test',
      ),
    ).toBe(false);
  });

  it('files the issue from the diagnosed evidence, before the spec is written', () => {
    const triage = byId('triage-issue-pr');
    const issuePhase = triage.phases.find((p) => p.name === 'file_issue')!;
    expect(issuePhase).toMatchObject({ kind: 'agent', agent: 'issue_writer', envelope: 'issue' });
    expect(issuePhase.prompt?.inputs).toEqual(['request', 'envelope:diagnose']);
    const names = triage.phases.map((p) => p.name);
    expect(names.indexOf('file_issue')).toBeGreaterThan(names.indexOf('diagnose'));
    expect(names.indexOf('file_issue')).toBeLessThan(names.indexOf('spec'));
  });

  it('ships a read-only issue_writer that drafts an issue envelope', () => {
    const writer = agentByName('issue_writer');
    expect(writer).toBeDefined();
    expect(writer?.envelope).toBe('issue');
    expect(writer?.writes).toEqual([]);
    expect(writer?.builtin).toBe(true);
    expect(writer?.userPrompt).toContain('{{request}}');
    expect(writer?.systemPrompt).toContain('Do not create, edit, or delete any file');
    expect(writer?.systemPrompt).toContain('Title: imperative, ≤72 characters');
  });

  it('ships a read-only pr_writer that drafts a pr envelope', () => {
    const writer = agentByName('pr_writer');
    expect(writer).toBeDefined();
    expect(writer?.envelope).toBe('pr');
    expect(writer?.writes).toEqual([]);
    expect(writer?.builtin).toBe(true);
    expect(writer?.userPrompt).toContain('{{request}}');
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
