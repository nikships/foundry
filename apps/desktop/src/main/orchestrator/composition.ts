/**
 * Composition rules as one source: the Orchestrator prompt bullets and the
 * generated-plan rails are the same objects. Changing a rail without the
 * prompt noticing is a snapshot failure, not a silent drift.
 */
import {
  effectivePhaseEnvelope,
  type AgentDef,
  type PhaseDef,
  type PipelineDef,
  type ValidationIssue,
} from '@shared/types.js';
import { envelopeFieldNames } from '../engine/envelopes.js';

export interface CompositionContext {
  pipeline: Pick<PipelineDef, 'phases'>;
  synthesizedAgents: readonly AgentDef[];
  agents: readonly AgentDef[];
  commandNames: readonly string[];
  indexOffset: number;
  scaffold?: boolean;
  /** Ids the current cast pool permits; used for the same-provider warning. */
  allowedModelIds?: readonly string[];
  /** The operator's raw prompt, when the caller has one (planning; not amendments). */
  request?: string;
  /** The brief under scrutiny; absent for amendments, which cannot rewrite it. */
  refinedRequest?: string;
}

export interface CompositionRule {
  id: string;
  bullet: string;
  check: (ctx: CompositionContext) => ValidationIssue[];
}

/** Provider prefix of a `provider/model` id; the whole id if it has no slash. */
export function providerPrefix(modelId: string): string {
  const slash = modelId.indexOf('/');
  return slash === -1 ? modelId : modelId.slice(0, slash);
}

function gateNames(phase: PhaseDef): Set<string> {
  return new Set((phase.gates ?? []).map((spec) => (typeof spec === 'string' ? spec : spec.gate)));
}

function phaseWhere(phase: PhaseDef, index: number, indexOffset: number): string {
  return `phases[${index + indexOffset}] ${phase.name}`;
}

function reviewGateIssues(phase: PhaseDef, where: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const gates = gateNames(phase);
  if (!gates.has('verdict_consistent')) {
    issues.push({
      level: 'error',
      where,
      message: 'a review phase must carry the "verdict_consistent" gate',
    });
  }
  if (!gates.has('disapproval_halts')) {
    issues.push({
      level: 'error',
      where,
      message: 'a review phase must carry the "disapproval_halts" gate',
    });
  }
  return issues;
}

function hasConfiguredCommandGate(phase: PhaseDef): boolean {
  for (const spec of phase.gates ?? []) {
    if (typeof spec === 'string' || spec.gate !== 'command_passes') continue;
    const argv = spec.config?.argv;
    if (
      Array.isArray(argv) &&
      argv.length &&
      argv.every((arg) => typeof arg === 'string' && arg.trim())
    ) {
      return true;
    }
  }
  return false;
}

function proofIssues(input: {
  phase: PhaseDef;
  next: PhaseDef | undefined;
  where: string;
  nextIndex: number;
  commandNames: readonly string[];
  scaffold?: boolean;
}): ValidationIssue[] {
  if (!input.commandNames.length) {
    if (input.scaffold || hasConfiguredCommandGate(input.phase)) return [];
    return [
      {
        level: 'error',
        where: input.where,
        message:
          'an implementation phase needs a configured command_passes gate when no project proof command exists',
      },
    ];
  }

  const proof = input.next;
  if (
    proof?.kind !== 'code' ||
    !proof.command ||
    !('ref' in proof.command) ||
    !input.commandNames.includes(proof.command.ref)
  ) {
    return [
      {
        level: 'error',
        where: input.where,
        message:
          'an implementation phase must be immediately followed by a configured proof command',
      },
    ];
  }

  const issues: ValidationIssue[] = [];
  const proofWhere = `phases[${input.nextIndex}] ${proof.name}`;
  if (proof.optional) {
    issues.push({
      level: 'error',
      where: proofWhere,
      message: 'a proof phase cannot be optional',
    });
  }
  if (proof.feedbackTo !== input.phase.name) {
    issues.push({
      level: 'error',
      where: proofWhere,
      message: `the proof phase must set feedbackTo to "${input.phase.name}"`,
    });
  }
  return issues;
}

function reviewGateRuleIssues(ctx: CompositionContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [index, phase] of ctx.pipeline.phases.entries()) {
    if (phase.kind !== 'agent') continue;
    if (effectivePhaseEnvelope(phase, ctx.agents) !== 'review') continue;
    issues.push(...reviewGateIssues(phase, phaseWhere(phase, index, ctx.indexOffset)));
  }
  return issues;
}

function isPrPhase(phase: PhaseDef, agents: readonly AgentDef[]): boolean {
  if (phase.kind !== 'agent') return false;
  return phase.name === 'open_pr' || effectivePhaseEnvelope(phase, agents) === 'pr';
}

function writesWorktree(agent: AgentDef | undefined): boolean {
  const writes = agent?.writes;
  return writes === null || (writes?.length ?? 0) > 0;
}

/**
 * A write-capable review can fix as well as judge. Generated plans that then
 * open a PR still need a later read-only reviewer.
 */
function independentJudgeBeforePrIssues(ctx: CompositionContext): ValidationIssue[] {
  const prIndex = ctx.pipeline.phases.findIndex((phase) => isPrPhase(phase, ctx.agents));
  if (prIndex < 0) return [];

  const byName = new Map(ctx.agents.map((agent) => [agent.name, agent]));
  const issues: ValidationIssue[] = [];
  for (const [index, phase] of ctx.pipeline.phases.entries()) {
    if (index >= prIndex || phase.kind !== 'agent') continue;
    if (effectivePhaseEnvelope(phase, ctx.agents) !== 'review') continue;
    const agent = phase.agent ? byName.get(phase.agent) : undefined;
    if (!writesWorktree(agent)) continue;
    const laterJudge = ctx.pipeline.phases.slice(index + 1, prIndex).some((candidate) => {
      if (candidate.kind !== 'agent') return false;
      if (effectivePhaseEnvelope(candidate, ctx.agents) !== 'review') return false;
      const judge = candidate.agent ? byName.get(candidate.agent) : undefined;
      return judge?.toolProfile === 'read-only';
    });
    if (!laterJudge) {
      issues.push({
        level: 'error',
        where: phaseWhere(phase, index, ctx.indexOffset),
        message:
          'a write-capable review or finisher must be followed by a read-only review before open_pr',
      });
    }
  }
  return issues;
}

function proofRuleIssues(ctx: CompositionContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byName = new Map(ctx.agents.map((agent) => [agent.name, agent]));

  for (const [index, phase] of ctx.pipeline.phases.entries()) {
    if (phase.kind !== 'agent') continue;
    const envelope = effectivePhaseEnvelope(phase, ctx.agents);
    const agent = phase.agent ? byName.get(phase.agent) : undefined;
    const writes = agent?.writes;
    const writesWorktree = writes === null || (writes?.length ?? 0) > 0;
    const needsProof = envelope === 'build' || (envelope === 'review' && writesWorktree);
    if (!needsProof) continue;
    issues.push(
      ...proofIssues({
        phase,
        next: ctx.pipeline.phases[index + 1],
        where: phaseWhere(phase, index, ctx.indexOffset),
        nextIndex: index + ctx.indexOffset + 1,
        commandNames: ctx.commandNames,
        scaffold: ctx.scaffold,
      }),
    );
  }
  return issues;
}

function synthesizedReviewerIssues(ctx: CompositionContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const agent of ctx.synthesizedAgents) {
    const usedAsJudge = ctx.pipeline.phases.some(
      (phase) =>
        phase.kind === 'agent' &&
        phase.agent === agent.name &&
        effectivePhaseEnvelope(phase, ctx.agents) === 'review',
    );
    if (!usedAsJudge || !Array.isArray(agent.writes) || agent.writes.length !== 0) continue;
    if (agent.toolProfile !== 'read-only') {
      issues.push({
        level: 'error',
        where: `agents.${agent.name}.toolProfile`,
        message: 'a synthesized judge-only reviewer must use the read-only tool profile',
      });
    }
    const authored = authoredSystemPrompt(agent.systemPrompt, agent.envelope);
    if (!/(read-only|git_diff)/i.test(authored)) {
      issues.push({
        level: 'error',
        where: `agents.${agent.name}.systemPrompt`,
        message: 'a synthesized judge-only reviewer must mention read-only or git_diff',
      });
    }
  }
  return issues;
}

function isReviewPhase(phase: PhaseDef, agents: readonly AgentDef[]): boolean {
  if (phase.kind !== 'agent') return false;
  if (effectivePhaseEnvelope(phase, agents) === 'review') return true;
  return gateNames(phase).has('verdict_consistent');
}

function reviewProviderWarnings(ctx: CompositionContext): ValidationIssue[] {
  const pool = ctx.allowedModelIds ?? [];
  const prefixes = new Set(pool.map(providerPrefix));
  if (prefixes.size < 2) return [];

  let lastBuild: PhaseDef | undefined;
  let lastBuildBeforeReview: PhaseDef | undefined;
  let firstReview: PhaseDef | undefined;
  let firstReviewWhere = '';

  for (const [index, phase] of ctx.pipeline.phases.entries()) {
    if (phase.kind !== 'agent') continue;
    if (effectivePhaseEnvelope(phase, ctx.agents) === 'build') lastBuild = phase;
    if (isReviewPhase(phase, ctx.agents) && !firstReview) {
      firstReview = phase;
      firstReviewWhere = phaseWhere(phase, index, ctx.indexOffset);
      lastBuildBeforeReview = lastBuild;
    }
  }

  const buildModel = lastBuildBeforeReview?.model;
  const reviewModel = firstReview?.model;
  if (!buildModel || !reviewModel || buildModel === 'inherit' || reviewModel === 'inherit') {
    return [];
  }
  const prefix = providerPrefix(reviewModel);
  if (providerPrefix(buildModel) !== prefix) return [];
  return [
    {
      level: 'warning',
      where: firstReviewWhere,
      message: `review uses the same provider prefix "${prefix}" as the last build phase; pick a different family from the cast pool when one is available`,
    },
  ];
}

function mentionsPurpose(prompt: string, purpose: string): boolean {
  if (/purpose/i.test(prompt)) return true;
  return purpose.trim().length > 0 && prompt.toLowerCase().includes(purpose.trim().toLowerCase());
}

function mentionsWriteBoundary(agent: AgentDef, prompt: string): boolean {
  const text = prompt.toLowerCase();
  if (Array.isArray(agent.writes) && agent.writes.length === 0) {
    return /read-only|git_diff|do not (create|edit|delete)|change no files/.test(text);
  }
  if (agent.writes === null) {
    return /unrestricted|any path|whole worktree|write boundary|may write/.test(text);
  }
  if (agent.writes.some((path) => text.includes(path.toLowerCase()))) return true;
  return /write boundary|only (touch|edit|write)/.test(text);
}

function mentionsEnvelopeFields(agent: AgentDef, prompt: string): boolean {
  if (/submit_envelope/i.test(prompt)) return true;
  const fields = envelopeFieldNames(agent.envelope);
  const text = prompt.toLowerCase();
  return fields.filter((field) => text.includes(field.toLowerCase())).length >= 2;
}

function synthesizedPromptIssues(ctx: CompositionContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const agent of ctx.synthesizedAgents) {
    const prompt = authoredSystemPrompt(agent.systemPrompt, agent.envelope);
    if (!mentionsPurpose(prompt, agent.purpose)) {
      issues.push({
        level: 'error',
        where: `agents.${agent.name}.systemPrompt`,
        message: 'a synthesized agent systemPrompt must state its purpose',
      });
    }
    if (!mentionsWriteBoundary(agent, prompt)) {
      issues.push({
        level: 'error',
        where: `agents.${agent.name}.systemPrompt`,
        message: 'a synthesized agent systemPrompt must state its write boundary',
      });
    }
    if (!mentionsEnvelopeFields(agent, prompt)) {
      issues.push({
        level: 'error',
        where: `agents.${agent.name}.systemPrompt`,
        message: 'a synthesized agent systemPrompt must state the envelope fields it fills',
      });
    }
    if (!agent.userPrompt.includes('{{request}}')) {
      issues.push({
        level: 'warning',
        where: `agents.${agent.name}.userPrompt`,
        message: 'userPrompt does not include {{request}}; phase inputs will only be appended',
      });
    }
  }
  return issues;
}

/** Slashed tokens that could name a repository location. */
const PATH_TOKEN = /[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@*-]+)+/g;

/**
 * Whether a slashed token reads as a repository path rather than prose like
 * "read/write": three or more segments, or a file extension on the last one.
 * All-digit tokens (dates such as 09/03/2026) are prose.
 */
function looksLikeRepoPath(token: string): boolean {
  if (!/[A-Za-z]/.test(token)) return false;
  const segments = token.split('/');
  if (segments.length >= 3) return true;
  return /\.[A-Za-z0-9]{1,5}$/.test(segments[segments.length - 1]!);
}

/**
 * The brief must stay behavioral: a repository path belongs in refinedRequest
 * only when the operator wrote it. Compared against the raw request rather
 * than the repository, because the summary is exactly where an invented
 * location would have come from. Stands down when there is no raw prompt to
 * compare against (image-only planning, run amendments).
 */
function inventedPathIssues(ctx: CompositionContext): ValidationIssue[] {
  const request = ctx.request?.trim();
  const brief = ctx.refinedRequest;
  if (!request || !brief) return [];
  const invented = new Set<string>();
  for (const match of brief.matchAll(PATH_TOKEN)) {
    const token = match[0];
    // A token right after "//" is the host half of a URL, not a repo path.
    const at = match.index ?? 0;
    if (at > 0 && brief[at - 1] === '/') continue;
    if (looksLikeRepoPath(token) && !request.includes(token)) invented.add(token);
  }
  return [...invented].map((token) => ({
    level: 'error' as const,
    where: 'refinedRequest',
    message: `the brief invents repository path "${token}" — refinedRequest stays behavioral and names a path only when the operator did`,
  }));
}

function engineerPhaseIssues(ctx: CompositionContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [index, phase] of ctx.pipeline.phases.entries()) {
    if (phase.kind === 'agent' || phase.kind === 'code') continue;
    issues.push({
      level: 'error',
      where: phaseWhere(phase, index, ctx.indexOffset),
      message: 'generated plans cannot include engineer or checkpoint phases',
    });
  }
  return issues;
}

/**
 * Canonical envelope constitution Foundry stamps onto a synthesized agent so
 * the model does not have to invent one. Compressed from the matching builtin
 * roster prompt; roster one-liners stay lean.
 */
const ENVELOPE_CONSTITUTIONS: Record<string, string> = {
  brief: [
    '## Envelope constitution (brief)',
    'You are read-only. Rewrite the request into a self-contained brief.',
    'Fill improved_request, constraints, acceptance_criteria, status, and summary.',
  ].join('\n'),
  plan: [
    '## Envelope constitution (plan)',
    'Write a concrete plan under specs/; do not implement.',
    'Fill artifacts, commit_message, status, and summary. Stay inside the write boundary.',
  ].join('\n'),
  build: [
    '## Envelope constitution (build)',
    'Implement the plan or request exactly. Make the smallest change that satisfies it.',
    'Fill commit_message, artifacts, status, and summary. Stay inside the write boundary.',
  ].join('\n'),
  scout: [
    '## Envelope constitution (scout)',
    'You are read-only. Cite concrete paths and symbols.',
    'Fill findings, status, and summary. A finding without a location is a guess.',
  ].join('\n'),
  review: [
    '## Envelope constitution (review)',
    'You are read-only. Call git_diff for the patch of what this run changed.',
    'Fill approved, findings, blocking, status, and summary. Do not fix what you find.',
  ].join('\n'),
  document: [
    '## Envelope constitution (document)',
    'Document what changed for a later reader. Declare the written path in artifacts.',
    'Fill artifacts, status, and summary. Stay inside the write boundary.',
  ].join('\n'),
  pr: [
    '## Envelope constitution (pr)',
    'You are read-only. Call git_diff for the patch; change no files.',
    'Fill title and body. Follow a repository PR template when one exists.',
  ].join('\n'),
  issue: [
    '## Envelope constitution (issue)',
    'You are read-only. Ground the issue in located evidence; change no files.',
    'Fill title, body, and labels.',
  ].join('\n'),
  generic: [
    '## Envelope constitution (generic)',
    'Stay inside the write boundary. Fill status, summary, artifacts, and notes_for_next_agent.',
  ].join('\n'),
};

export function envelopeConstitution(envelope: string): string {
  return ENVELOPE_CONSTITUTIONS[envelope] ?? ENVELOPE_CONSTITUTIONS.generic!;
}

/** The prompt the Orchestrator authored, without the constitution Foundry appends. */
export function authoredSystemPrompt(systemPrompt: string, envelope: string): string {
  const constitution = envelopeConstitution(envelope);
  const idx = systemPrompt.lastIndexOf(constitution);
  if (idx === -1) return systemPrompt;
  return systemPrompt.slice(0, idx).trimEnd();
}

export function injectEnvelopeConstitution(systemPrompt: string, envelope: string): string {
  const constitution = envelopeConstitution(envelope);
  if (systemPrompt.includes(constitution)) return systemPrompt;
  return `${systemPrompt.trimEnd()}\n\n${constitution}`;
}

/**
 * One object per composition rule. `bullet` is what the Orchestrator is told;
 * `check` is what `generatedCompositionIssues` runs. They cannot drift.
 */
export const COMPOSITION_RULES: CompositionRule[] = [
  {
    id: 'refined-request',
    bullet:
      'Always rewrite the operator\'s prompt into a behavior-level brief first. That brief is "refinedRequest" and becomes the run request: state the user goal and the observable behavior to deliver, keep every explicit requirement and named interface, format, compatibility, or scope constraint verbatim, keep stated or strongly implied edge cases (empty states, errors, boundaries, retries, lifecycle), and keep any testable acceptance evidence the request provides. Do not prescribe implementation in the brief: never add repository paths, filenames, components, symbols, test IDs, APIs, libraries, architecture, data models, or an implementation sequence the operator did not state — downstream agents inspect the repository and decide how. A path or implementation detail belongs in the brief only when the operator wrote it.',
    check: inventedPathIssues,
  },
  {
    id: 'proof',
    bullet:
      'Every implementation phase using a build envelope, and every write-capable review phase, is proven before any commit. When Project commands are listed, immediately follow the agent with a code phase using one {"ref": ...} and set "feedbackTo" to the phase that owns a failure. When no Project command exists, put a configured "command_passes" gate on the agent instead. A new scaffold with no command yet is the only exception.',
    check: proofRuleIssues,
  },
  {
    id: 'review-gates',
    bullet:
      'Reviewer/verifier agent phases carry the "verdict_consistent" and "disapproval_halts" gates.',
    check: reviewGateRuleIssues,
  },
  {
    id: 'independent-review-before-pr',
    bullet:
      'A write-capable review or finisher that is followed by a PR must itself be followed by a read-only review phase before open_pr. Builtin sdlc-pr is the shape.',
    check: independentJudgeBeforePrIssues,
  },
  {
    id: 'phase-model',
    bullet:
      '**Every agent phase names its own model and reasoning level.** Set "model" to one of the configured cast-pool ids you are shown and set "reasoningEffort" to one of that model\'s listed efforts. Choose both for that phase\'s work: give design, review, and hard implementation the strongest models and reasoning, and hand mechanical or narrowly scoped work a smaller model and lower effort. Never omit "model", write "inherit", or leave the model choice to the agent, roster, or install default — a plan with an unnamed model is rejected.',
    check: () => [],
  },
  {
    id: 'feedback-to',
    bullet: 'A proof code phase\'s "feedbackTo" names the earlier agent phase that owns the fix.',
    check: () => [],
  },
  {
    id: 'flake-rerun',
    bullet:
      'Proof code phases that run a project command ({"ref":"test"}, lint, typecheck, or any listed proof command) set "flakeRerun": 2 so a flaky check is re-run without edits before healing. Do not set 0 on a proof phase.',
    check: () => [],
  },
  {
    id: 'acceptance',
    bullet:
      'Acceptance is {"kind":"envelope_status","phase":<final PR phase>} when the plan ends in a PR phase, otherwise {"kind":"all_phases_pass"}.',
    check: () => [],
  },
  {
    id: 'prefer-roster',
    bullet:
      'Prefer roster agents when the supplied purpose, envelope, write boundary, and tool profile all fit. Do not assume capabilities that are not in their summary. Unrestricted roster writes (shown as "unrestricted") do not fit a path-bounded request — do not appoint that agent just because its purpose is "implement".',
    check: () => [],
  },
  {
    id: 'synthesized-agent',
    bullet:
      'A synthesized agent gets a one-line purpose, a tight "writes" boundary containing only paths its phase must touch, and never the name of a roster agent. When the request names the files or directories to touch, synthesize the implementation agent rather than using an unrestricted roster builder. A synthesized judge-only reviewer uses "writes":[] and "toolProfile":"read-only". Use the build envelope for implementation agents. Foundry appends the canonical envelope constitution to the synthesized systemPrompt after you submit.',
    check: synthesizedReviewerIssues,
  },
  {
    id: 'synthesized-prompts',
    bullet:
      "A synthesized agent's systemPrompt states its purpose, write boundary, and the envelope fields it must fill — not a one-word instruction. A judge-only reviewer (writes: []) mentions read-only or git_diff. userPrompt includes {{request}} so phase inputs land in context.",
    check: synthesizedPromptIssues,
  },
  {
    id: 'phase-names',
    bullet:
      'Phase names are lowercase snake_case and unique; pipeline ids are chosen by Foundry, not by you.',
    check: () => [],
  },
  {
    id: 'no-engineer',
    bullet: 'Never emit an engineer/checkpoint phase.',
    check: engineerPhaseIssues,
  },
  {
    id: 'review-provider',
    bullet:
      'When the cast pool spans two or more provider prefixes, prefer a different family for the first review than the last build. Using the same prefix is allowed but warned.',
    check: reviewProviderWarnings,
  },
];

export function compositionRuleBullets(): string {
  return COMPOSITION_RULES.map((rule) => `- ${rule.bullet}`).join('\n');
}

/**
 * Quality invariants unique to generated plans. Hand-built pipelines remain
 * editable, while an Orchestrator proposal must prove the guarantees its card
 * claims before it can reach the operator.
 */
export function generatedCompositionIssues(
  pipeline: Pick<PipelineDef, 'phases'>,
  synthesizedAgents: readonly AgentDef[],
  agents: readonly AgentDef[],
  commandNames: readonly string[],
  opts: {
    indexOffset?: number;
    scaffold?: boolean;
    allowedModelIds?: readonly string[];
    request?: string;
    refinedRequest?: string;
  } = {},
): ValidationIssue[] {
  const ctx: CompositionContext = {
    pipeline,
    synthesizedAgents,
    agents,
    commandNames,
    indexOffset: opts.indexOffset ?? 0,
    scaffold: opts.scaffold,
    allowedModelIds: opts.allowedModelIds,
    request: opts.request,
    refinedRequest: opts.refinedRequest,
  };
  return COMPOSITION_RULES.flatMap((rule) => rule.check(ctx));
}
