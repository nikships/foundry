/**
 * Showcase backend.
 *
 * The comparison page runs the real Pipelines screens, so it needs a real
 * `window.foundry`. It reuses the web-preview mock for everything except
 * pipelines, which it replaces with a stateful, seeded slice: edits stick,
 * so a reviewer can actually reorder a phase or add a gate and watch both
 * options respond, and the seed carries the structure worth comparing —
 * checkpoints (which give Option B its stages) and a repair loop (which gives
 * Option A its arcs).
 *
 * This module is showcase-only. It never ships in the desktop app, where the
 * preload bridge provides the real API.
 *
 * It must be imported before anything that touches `api.ts`, because that
 * module installs the plain web mock on first load if no bridge is present.
 */
import type { PipelineDef, ValidationIssue } from '@shared/types.js';
import type { SaveResult } from '@shared/ipc-contract.js';
import { createMockFoundryApi } from '../mockFoundry.js';

/**
 * Representative pipelines. Deliberately not the shipped builtins: these carry
 * the shapes the two options are being compared on, including one pipeline
 * that fails validation so the error surfaces can be judged too.
 */
export const SHOWCASE_PIPELINES: PipelineDef[] = [
  {
    id: 'ship-it',
    name: 'Plan → Build → Ship',
    description: 'The everyday chain: plan the work, build it, prove it, then ask before shipping.',
    acceptance: { kind: 'phase_flag', phase: 'review', flag: 'approved' },
    isolation: true,
    phases: [
      {
        name: 'plan',
        kind: 'agent',
        description: 'Turn the request into a bounded plan with an explicit file list.',
        agent: 'planner',
        envelope: 'plan',
        prompt: { template: 'user', inputs: ['request'] },
      },
      {
        name: 'approve_plan',
        kind: 'engineer',
        description: 'A human signs off on scope before any code is written.',
        question: 'Does this plan cover the request without scope creep?',
      },
      {
        name: 'build',
        kind: 'agent',
        description: 'Implement the plan inside the declared write boundary.',
        agent: 'builder',
        envelope: 'build',
        prompt: { template: 'user', inputs: ['request', 'plan'] },
        gates: ['typecheck_passes'],
      },
      {
        name: 'test',
        kind: 'code',
        description: 'Run the suite; a non-zero exit sends the failure back to build.',
        command: { ref: 'test' },
        feedbackTo: 'build',
        feedbackRetries: 2,
      },
      {
        name: 'review',
        kind: 'agent',
        description: 'Judge the diff against the plan and set approved when it holds up.',
        agent: 'reviewer',
        envelope: 'review',
        prompt: { template: 'user', inputs: ['plan', 'build'] },
      },
      {
        name: 'ship',
        kind: 'engineer',
        description: 'Last human gate before the branch is offered for merge.',
        question: 'Ship this branch?',
      },
    ],
  },
  {
    id: 'quick-fix',
    name: 'Quick fix',
    description: 'One agent, one command, no gates. The shape most small changes take.',
    acceptance: { kind: 'all_phases_pass' },
    isolation: true,
    phases: [
      {
        name: 'fix',
        kind: 'agent',
        description: 'Make the smallest change that resolves the report.',
        agent: 'builder',
        envelope: 'build',
        prompt: { template: 'user', inputs: ['request'] },
      },
      {
        name: 'verify',
        kind: 'code',
        description: 'Run the suite and fail the phase on a non-zero exit.',
        command: { argv: ['npm', 'test'] },
        feedbackTo: 'fix',
      },
    ],
  },
  {
    id: 'needs-work',
    name: 'Draft: docs refresh',
    description: 'Half-configured on purpose, so the validation surfaces can be compared.',
    acceptance: { kind: 'all_phases_pass' },
    isolation: false,
    phases: [
      {
        name: 'gather',
        kind: 'agent',
        description: 'Collect what changed since the last docs pass.',
        agent: 'scout',
        envelope: 'scout',
        prompt: { template: 'user', inputs: ['request'] },
      },
      {
        name: 'write',
        kind: 'agent',
        description: 'Write the docs.',
        // No agent set: an agent phase without an agent is a hard error.
        agent: '',
        envelope: 'build',
        prompt: { template: 'user', inputs: ['gather'] },
      },
      {
        name: 'sign_off',
        kind: 'engineer',
        // No question: a checkpoint with nothing to ask is a warning.
        description: 'Someone reads it before it lands.',
      },
    ],
  },
];

/**
 * A deliberately small subset of `store/pipelines.validate`, reimplemented
 * here because the renderer may not import main. It covers the rules the
 * showcase actually demonstrates — enough to render real error and warning
 * states in both options, not enough to be mistaken for the real validator.
 */
export function showcaseValidate(pipeline: PipelineDef): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  pipeline.phases.forEach((phase, index) => {
    const where = `phases[${index}] ${phase.name}`;
    if (seen.has(phase.name)) {
      issues.push({ level: 'error', where, message: `duplicate phase name "${phase.name}"` });
    }
    seen.add(phase.name);
    if (!phase.description.trim()) {
      issues.push({ level: 'error', where, message: 'every phase needs a description' });
    }
    if (phase.kind === 'agent' && !phase.agent) {
      issues.push({ level: 'error', where, message: 'an agent phase needs an agent' });
    }
    if (phase.kind === 'engineer' && !phase.question) {
      issues.push({
        level: 'warning',
        where,
        message: 'an engineer phase with no question shows an empty sheet',
      });
    }
    if (phase.feedbackTo && !pipeline.phases.some((p) => p.name === phase.feedbackTo)) {
      issues.push({
        level: 'error',
        where,
        message: `sends failures to "${phase.feedbackTo}", which does not exist`,
      });
    }
  });
  const acceptance = pipeline.acceptance;
  if ('phase' in acceptance && !pipeline.phases.some((p) => p.name === acceptance.phase)) {
    issues.push({
      level: 'error',
      where: 'acceptance',
      message: `acceptance names phase "${acceptance.phase}", which does not exist`,
    });
  }
  return issues;
}

/**
 * Installs the seeded, stateful backend.
 *
 * Called at module scope below rather than by the entry, so the install can
 * never lose an import-order race: any module that wants the seeded API just
 * imports this one before it reaches `api.ts`, and ES module evaluation order
 * does the rest. Ordering it from the entry only works while the bundler
 * keeps the app in a separate chunk.
 */
export function installShowcaseBackend(): void {
  const w = window as unknown as Record<string, unknown>;
  if (w.foundry || w.__foundryWebMockInstalled) return;
  w.__foundryWebMockInstalled = true;

  const api = createMockFoundryApi() as unknown as Record<string, unknown>;
  let state: PipelineDef[] = SHOWCASE_PIPELINES.map((p) => structuredClone(p));

  api.pipelines = {
    list: async (): Promise<PipelineDef[]> => state.map((p) => structuredClone(p)),
    save: async (pipeline: PipelineDef): Promise<SaveResult<PipelineDef[]>> => {
      const issues = showcaseValidate(pipeline);
      if (issues.some((i) => i.level === 'error')) return { ok: false, issues, value: state };
      state = state.some((p) => p.id === pipeline.id)
        ? state.map((p) => (p.id === pipeline.id ? structuredClone(pipeline) : p))
        : [...state, structuredClone(pipeline)];
      return { ok: true, issues, value: state };
    },
    remove: async (id: string): Promise<PipelineDef[]> => {
      state = state.filter((p) => p.id !== id);
      return state;
    },
    duplicate: async (id: string): Promise<PipelineDef | null> => {
      const source = state.find((p) => p.id === id);
      if (!source) return null;
      const copy = structuredClone(source);
      copy.id = `${source.id}-copy-${state.length}`;
      copy.name = `${source.name} copy`;
      copy.builtin = false;
      state = [...state, copy];
      return copy;
    },
    validate: async (pipeline: PipelineDef): Promise<ValidationIssue[]> =>
      showcaseValidate(pipeline),
    dryRun: async () => [
      {
        phase: 'build',
        agent: 'builder',
        model: 'showcase-preview',
        systemPrompt:
          'You are the builder. Work only inside the declared write boundary and return a build envelope.',
        userPrompt:
          'Request: Add rate limiting to the public API\n\nPlan: bound the change to the router and its tests.',
      },
    ],
    reset: async (): Promise<PipelineDef[]> => {
      state = SHOWCASE_PIPELINES.map((p) => structuredClone(p));
      return state;
    },
  };

  w.foundry = api as unknown as never;
  if (!w.foundryMenu) {
    w.foundryMenu = { on: () => () => {} };
  }
}

installShowcaseBackend();
