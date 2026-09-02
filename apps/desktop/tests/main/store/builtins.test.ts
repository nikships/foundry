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
import { BUILTIN_AGENTS } from '../../../src/shared/builtin-agents.js';
import { BUILTIN_PIPELINES } from '../../../src/shared/builtin-pipelines.js';
import { validate as validatePipeline } from '../../../src/main/store/pipelines.js';
import { validate as validateAgent } from '../../../src/main/store/roster.js';
import { exampleFor, schemaFor } from '../../../src/main/engine/envelopes.js';
import { FOUNDRY_RUN_HARNESS } from '../../../src/main/pi/system-prompt.js';
import {
  healingEligible,
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

  it('leaves review failure-reporting instructions to the shared harness', () => {
    for (const name of ['reviewer', 'finisher']) {
      const agent = agentByName(name)!;
      expect(`${agent.systemPrompt}\n${agent.userPrompt}`, name).not.toContain('status: "fail"');
    }
  });

  it('keeps the refiner read-only, since sharpening a request is not doing the work', () => {
    expect(agentByName('refiner')?.writes).toEqual([]);
  });

  /**
   * "You are read-only" used to be prompt text over a session that still held
   * `edit`, `write`, and `bash`. The profile is what makes the claim true: the
   * tool list is the allowlist, so these agents have nothing that could write.
   */
  it('backs every "read-only" claim with the read-only tool profile', () => {
    for (const name of ['refiner', 'scout', 'reviewer', 'pr_writer', 'issue_writer']) {
      const agent = agentByName(name)!;
      expect(agent.toolProfile, name).toBe('read-only');
      expect(agent.writes, name).toEqual([]);
    }
  });

  it('leaves the writing agents on the full surface, shell included', () => {
    for (const name of ['planner', 'builder', 'finisher', 'documenter']) {
      expect(agentByName(name)?.toolProfile, name).toBeUndefined();
    }
  });

  it('never tells a read-only agent to run a command it has no tool for', () => {
    // A read-only session holds no `bash`, so an instruction to run something
    // is an instruction the agent can only fail at. `no raw \`git diff\`` is
    // about what the PR body may contain, not a command, hence the imperatives.
    for (const agent of BUILTIN_AGENTS.filter((a) => a.toolProfile === 'read-only')) {
      const prompts = `${agent.systemPrompt}\n${agent.userPrompt}`;
      expect(prompts, agent.name).not.toMatch(/\b(run|execute|invoke) (the |a )?(command|shell)/i);
      expect(prompts, agent.name).not.toMatch(/\brun\b[^.\n]{0,20}\b(git|npm|tests)\b/i);
    }
  });

  it('points the diff-reading read-only agents at git_diff, not at a shell', () => {
    // Removing `bash` removed `git diff`, and the stat block `runners/agent.ts`
    // injects is a file list that cannot say what changed inside a file. The
    // tool is the replacement, so the prompt has to name it.
    for (const name of ['reviewer', 'pr_writer']) {
      const prompts = `${agentByName(name)!.systemPrompt}\n${agentByName(name)!.userPrompt}`;
      expect(prompts, name).toContain('`git_diff`');
      expect(prompts, name).toMatch(/no shell/i);
    }
  });

  it('never promises a read-only agent a capability the profile removed', () => {
    for (const agent of BUILTIN_AGENTS.filter((a) => a.toolProfile === 'read-only')) {
      const prompts = `${agent.systemPrompt}\n${agent.userPrompt}`;
      // The stat is for orientation. A prompt that presents it as the record of
      // what changed is telling the agent to review a file list.
      if (/changed-file stat/i.test(prompts)) {
        expect(prompts, agent.name).toMatch(/orientation|`git_diff`/i);
      }
    }
  });
});

describe('builtin prompt contracts', () => {
  const planner = agentByName('planner')!;
  const builder = agentByName('builder')!;
  const scout = agentByName('scout')!;

  it('snapshots the planner contract: required sections, no invented paths, specs/ only', () => {
    expect(planner.writes).toEqual(['specs/']);
    expect(planner.systemPrompt).toMatchInlineSnapshot(`
      "# Planner

      ## Purpose

      Turn a request into a plan the builder can implement without asking questions.

      ## Instructions

      - Read only what you need to understand the request.
      - Do not invent paths. Name a file only when you have seen it in the tree; omit it rather than guess.
      - Write the plan to a file under \`specs/\` and declare that path in your artifacts. The spec must contain these sections, in this order:
        - Goal — the outcome, in one paragraph.
        - Files — exact paths to create, edit, or delete.
        - Stepwise changes — the edits, in order, tied to those files.
        - Tests to add/run — the tests the builder must write or run before claiming done.
        - Out of scope — what this plan must not do.
        - Risks — what could go wrong, including missing context.
      - Do not implement anything. Planning and building are different phases for a reason.
      - If blocked, fail closed: report \`status: fail\`, put the blocker in \`summary\` and \`notes_for_next_agent\`, and do not invent success."
    `);
    expect(planner.userPrompt).toContain(
      'Goal, Files, Stepwise changes, Tests to add/run, Out of scope, Risks',
    );
    expect(planner.userPrompt).toContain('Do not invent paths');
    expect(planner.userPrompt).not.toMatch(/handoff/i);
  });

  it('snapshots the builder contract: open artifacts, listed files, test-first, missing spec fails', () => {
    expect(builder.systemPrompt).toMatchInlineSnapshot(`
      "# Builder

      ## Purpose

      Implement the plan (or request) exactly.

      ## Instructions

      - If a prior envelope carries a plan, its \`files_to_touch\`, \`steps\`, and \`verification\` plus the declared artifact file are your spec. Open the artifact paths first. If they disagree, report \`status: "fail"\` rather than guessing.
      - If a prior envelope carries a diagnosis or test failures, that is your spec. Open any declared artifact paths first and follow it.
      - Implement only the files the spec lists. Do not touch unrelated files, and do not invent work the spec did not ask for.
      - If the plan's verification names tests, write or update those tests in the same turn, before claiming success. Tests are part of the change, not a later command.
      - When fixing test failures, address every reported failure, not the first one.
      - Verify your work runs before reporting, and judge that by exit status. If tests were not run, or a required artifact is missing, fail the envelope.
      - If the spec is missing or too ambiguous to implement, fail the envelope. Do not guess a design.
      - Make the smallest change that satisfies the request; do not refactor unrelated code.
      - If blocked, fail closed: report \`status: fail\`, put the blocker in \`summary\` and \`notes_for_next_agent\`, and do not invent success."
    `);
    expect(builder.userPrompt).toContain('Open the spec artifact paths first');
    expect(builder.userPrompt).toContain('Change only the listed files');
    expect(builder.userPrompt).toContain(
      'Write or update the tests the spec names before claiming success',
    );
    expect(builder.userPrompt).not.toMatch(/handoff/i);
  });

  it('snapshots the scout contract: path+symbol+observation, contradict the premise', () => {
    expect(scout.systemPrompt).toMatchInlineSnapshot(`
      "# Scout

      ## Purpose

      Answer a question about this codebase with evidence, changing nothing.

      ## Instructions

      - You are read-only. Do not create, edit, or delete any file.
      - Each \`findings\` entry is one concrete observation in the form \`path + symbol + observation\`. A finding without a location is a guess.
      - Report what is actually there. If the tree contradicts the premise of the question, say so as a finding.
      - If blocked, fail closed: report \`status: fail\`, put the blocker in \`summary\` and \`notes_for_next_agent\`, and do not invent success."
    `);
    expect(scout.userPrompt).toContain('path + symbol + observation');
    expect(scout.userPrompt).toMatch(/disagrees with the question's premise|contradict/i);
    expect(scout.userPrompt).not.toMatch(/handoff/i);
  });

  it('puts a fail-closed contract on every shipped systemPrompt', () => {
    expect(BUILTIN_AGENTS).toHaveLength(9);
    for (const agent of BUILTIN_AGENTS) {
      expect(agent.systemPrompt, agent.name).toMatch(/fail closed/i);
      expect(agent.systemPrompt, agent.name).toContain('status: fail');
      expect(agent.systemPrompt, agent.name).toContain('summary');
      expect(agent.systemPrompt, agent.name).toContain('notes_for_next_agent');
    }
  });

  it('keeps the harness review halt line, quoted status fail stays out of review seeds', () => {
    expect(FOUNDRY_RUN_HARNESS).toContain('when `approved` is false, report `status: "fail"` too');
    for (const name of ['reviewer', 'finisher']) {
      const agent = agentByName(name)!;
      expect(`${agent.systemPrompt}\n${agent.userPrompt}`, name).not.toContain('status: "fail"');
    }
  });

  it('never mentions handoff in a builtin userPrompt', () => {
    for (const agent of BUILTIN_AGENTS) {
      expect(agent.userPrompt, agent.name).not.toMatch(/handoff/i);
    }
  });

  it('states that tests are part of the build in a shipped pipeline description', () => {
    const descriptions = BUILTIN_PIPELINES.map((p) => p.description);
    expect(descriptions.some((d) => /tests are part of the build/i.test(d))).toBe(true);
    expect(agentByName('builder')!.systemPrompt).toMatch(/tests are part of the change/i);
  });

  it('accepts a successful builder envelope that lists the tests it added', () => {
    const envelope = {
      status: 'success',
      summary: 'implemented with tests',
      artifacts: ['src/foo.ts', 'src/foo.test.ts'],
      notes_for_next_agent: '',
      commit_message: 'Add foo with tests',
    };
    expect(schemaFor('build').safeParse(envelope).success).toBe(true);
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

  it('inherits every agent envelope without restating it on the phase', () => {
    for (const pipeline of BUILTIN_PIPELINES) {
      for (const phase of pipeline.phases.filter((candidate) => candidate.kind === 'agent')) {
        expect(phase.envelope, `${pipeline.id}/${phase.name}`).toBeUndefined();
        expect(agentByName(phase.agent!)?.envelope, `${pipeline.id}/${phase.name}`).toBeTruthy();
        expect(phase.prompt, `${pipeline.id}/${phase.name}`).not.toHaveProperty('template');
      }
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

  it('heals every code phase whose failure fails the run, without any of them saying so', () => {
    for (const pipeline of BUILTIN_PIPELINES) {
      for (const phase of pipeline.phases) {
        if (phase.kind !== 'code') continue;
        // The shipped chains predate healing and carry no `heal` field. The
        // default has to land where it is wanted on its own, or every phase
        // would need editing to get a healer.
        expect(phase.heal, `${pipeline.id}/${phase.name} does not pin healing`).toBeUndefined();
        expect(healingEligible(phase), `${pipeline.id}/${phase.name} heals`).toBe(true);
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
      'ship-pr': [
        'envelope:refine.improved_request',
        'envelope:plan',
        'envelope:build',
        'envelope:production_check',
      ],
      'sdlc-pr': [
        'envelope:refine.improved_request',
        'envelope:plan',
        'envelope:build',
        'envelope:production_check',
        'envelope:review',
        'envelope:document',
      ],
    };
    for (const pipeline of BUILTIN_PIPELINES) {
      const openPr = pipeline.phases.at(-1)!;
      expect(openPr).toMatchObject({ kind: 'agent', agent: 'pr_writer' });
      expect(openPr.prompt?.inputs, pipeline.id).toEqual(expected[pipeline.id]);
    }
  });

  it('uses the refined request for every later agent phase in ship and SDLC', () => {
    for (const id of ['ship-pr', 'sdlc-pr']) {
      const pipeline = byId(id);
      const refineIndex = pipeline.phases.findIndex((phase) => phase.name === 'refine');
      for (const phase of pipeline.phases.slice(refineIndex + 1)) {
        if (phase.kind !== 'agent') continue;
        expect(phase.prompt?.inputs, `${id}/${phase.name}`).toContain(
          'envelope:refine.improved_request',
        );
        expect(phase.prompt?.inputs, `${id}/${phase.name}`).not.toContain('request');
      }
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
    expect(issuePhase).toMatchObject({ kind: 'agent', agent: 'issue_writer' });
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
