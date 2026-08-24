/**
 * What the Orchestrator is told and how its answer is read.
 *
 * The Orchestrator proposes; code disposes. This file owns the standing
 * rules, the per-request prompt (context summary, commands, roster, envelope
 * library, gate catalog, builtin shapes as few-shot), the strict-JSON parse,
 * and the post-parse rails — the same `validate()` + `preflightForRun()` a
 * hand-built pipeline passes. A plan that cannot survive those rails never
 * reaches the operator's card.
 */

import { z } from 'zod';
import { REASONING_EFFORTS } from '@shared/reasoning-effort.js';
import {
  BUILTIN_ENVELOPE_BLURBS,
  type AgentDef,
  type EnvelopeDef,
  type GeneratedRunPlan,
  type PipelineDef,
  type ProjectCommand,
  type ReasoningEffort,
  type ValidationIssue,
} from '@shared/types.js';
import { BUILTIN_PIPELINES } from '@shared/builtin-pipelines.js';
import { pipelineSchema, validate as validatePipeline } from '../store/pipelines.js';
import { validate as validateAgent } from '../store/roster.js';
import { GATE_DESCRIPTIONS } from '../engine/gates.js';
import { preflightForRun } from '../engine/preflight.js';

/** Colours handed to synthesized agents, since the model does not pick paint. */
const SYNTH_COLORS = ['#5ad2dd', '#d2a05a', '#a05ad2', '#7ad25a', '#d25a7a', '#5a8ad2'] as const;

export const ORCHESTRATOR_PROMPT = `You are the Orchestrator: you read one request and this repository, then compose the run-specific pipeline that fulfils it, from the building blocks you are given.

Composition rules (enforced by code where possible; follow all of them):
- Always rewrite the operator's prompt into a full brief first. That brief is "refinedRequest" and becomes the run request; keep every constraint the operator stated.
- Every code-editing agent phase is followed by proof before any commit: code phases running {"ref": ...} commands that exist in the project commands (test, typecheck, lint).
- Reviewer/verifier agent phases carry the "verdict_consistent" and "disapproval_halts" gates.
- A code phase's "feedbackTo" names the earlier agent phase that owns the fix.
- Acceptance is {"kind":"envelope_status","phase":<final PR phase>} when the plan ends in a PR phase, otherwise {"kind":"all_phases_pass"}.
- Prefer roster agents when one fits. A synthesized agent gets a one-line purpose, a tight "writes" boundary (only the paths its phase must touch), and never the name of a roster agent.
- Phase names are lowercase snake_case and unique; pipeline ids are chosen by Foundry, not by you.

Reply with a single JSON object and nothing else:
{
  "refinedRequest": "<the full brief>",
  "rationale": "<why the pipeline has this shape, one short paragraph>",
  "pipeline": { "name": ..., "description": ..., "acceptance": ..., "phases": [...] },
  "agents": [ <synthesized agents only; empty when the roster covers every phase> ]
}

Each synthesized agent: {"name","purpose","systemPrompt","userPrompt","writes","envelope"} plus optional "model" (omit to inherit the install default), "reasoningEffort", "toolProfile" ("read-only" for reviewers).
Each phase follows the pipeline schema you were shown in the examples: {"name","kind","description"} plus "agent"/"prompt"/"envelope"/"gates" for agent phases, "command"/"feedbackTo"/"heal" for code phases, "question" for engineer phases.`;

export interface PlanPromptInputs {
  request: string;
  contextSummary: string;
  commands: ProjectCommand[];
  roster: AgentDef[];
  envelopeDefs: EnvelopeDef[];
  /** Whether gh can open PRs here, which decides the acceptance guidance. */
  ghAvailable?: boolean;
}

/** Compact one-line summary per roster agent — not prompts, to keep context lean. */
function rosterLines(roster: AgentDef[]): string {
  return roster
    .map(
      (a) =>
        `- ${a.name}: ${a.purpose} (envelope ${a.envelope}; writes ${
          a.writes === null ? 'unrestricted' : a.writes.length ? a.writes.join(', ') : 'read-only'
        })`,
    )
    .join('\n');
}

/** The builtin shapes, stripped to what teaches composition. */
function fewShotPipelines(): string {
  return BUILTIN_PIPELINES.map((p) => {
    const { canvas: _canvas, builtin: _builtin, ...shape } = p;
    return JSON.stringify(shape);
  }).join('\n');
}

export function buildPlanPrompt(inputs: PlanPromptInputs): string {
  const parts = ['Compose the pipeline for this request.', '', `## Request`, inputs.request];
  if (inputs.contextSummary) {
    parts.push('', '## Repository', inputs.contextSummary);
  }
  parts.push(
    '',
    '## Project commands (the only {"ref"} values a code phase may use)',
    inputs.commands.length
      ? inputs.commands.map((c) => `- ${c.name}: ${c.argv.join(' ')}`).join('\n')
      : '(none configured yet)',
    '',
    '## Roster agents (prefer these when one fits)',
    inputs.roster.length ? rosterLines(inputs.roster) : '(empty roster)',
    '',
    '## Envelopes',
    Object.entries(BUILTIN_ENVELOPE_BLURBS)
      .map(([kind, blurb]) => `- ${kind}: ${blurb}`)
      .join('\n'),
    ...(inputs.envelopeDefs.length
      ? [
          'Custom envelopes in the library:',
          inputs.envelopeDefs.map((e) => `- ${e.name}: ${e.description ?? ''}`).join('\n'),
        ]
      : []),
    '',
    '## Gates',
    Object.entries(GATE_DESCRIPTIONS)
      .map(([gate, blurb]) => `- ${gate}: ${blurb}`)
      .join('\n'),
    '',
    '## Builtin pipelines (few-shot examples of valid shapes)',
    fewShotPipelines(),
  );
  if (inputs.ghAvailable === false) {
    parts.push(
      '',
      'GitHub is not available for this project: do not compose a PR phase; use all_phases_pass acceptance.',
    );
  }
  return parts.join('\n');
}

export function planCorrection(issues: ValidationIssue[]): string {
  return [
    'Foundry rejected your last plan. These are the validation rails a hand-built pipeline passes too:',
    '',
    ...issues.map((i) => `- [${i.level}] ${i.where}: ${i.message}`),
    '',
    'Fix the plan and reply again with the single JSON object and nothing else.',
  ].join('\n');
}

export const synthesizedAgentSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9_-]*$/, 'lowercase letters, digits, dash, underscore'),
  purpose: z.string().min(1),
  systemPrompt: z.string().min(1),
  userPrompt: z.string().min(1),
  writes: z.array(z.string()).nullable(),
  envelope: z.string().min(1),
  model: z.string().min(1).optional(),
  reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
  toolProfile: z.enum(['full', 'read-only']).optional(),
});

/** Adds the engine-owned fields the Orchestrator never chooses. */
export function hydrateSynthesizedAgents(
  agents: z.infer<typeof synthesizedAgentSchema>[],
  colorOffset = 0,
): AgentDef[] {
  return agents.map((agent, index) => ({
    name: agent.name,
    purpose: agent.purpose,
    model: agent.model ?? 'inherit',
    reasoningEffort: agent.reasoningEffort ?? 'medium',
    systemPrompt: agent.systemPrompt,
    userPrompt: agent.userPrompt,
    writes: agent.writes,
    envelope: agent.envelope,
    ...(agent.toolProfile ? { toolProfile: agent.toolProfile } : {}),
    color: SYNTH_COLORS[(colorOffset + index) % SYNTH_COLORS.length]!,
  }));
}

const planReplySchema = z.object({
  refinedRequest: z.string().min(1, 'the plan must rewrite the request into a full brief'),
  rationale: z.string().min(1, 'say why the pipeline has this shape'),
  pipeline: pipelineSchema.omit({ id: true, builtin: true, canvas: true }),
  agents: z.array(synthesizedAgentSchema),
});

export interface ParsedPlanReply {
  refinedRequest: string;
  rationale: string;
  pipeline: PipelineDef;
  agents: AgentDef[];
}

export type PlanParseResult =
  { ok: true; reply: ParsedPlanReply } | { ok: false; issues: ValidationIssue[] };

/**
 * Strict JSON, then Zod. The ids the model must not choose are assigned here:
 * the pipeline becomes `generated:<planId>` and never builtin, and synthesized
 * agents get their paint and inherit-by-default model filled in.
 */
export function parsePlanReply(text: string, planId: string): PlanParseResult {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return {
      ok: false,
      issues: [{ level: 'error', where: 'reply', message: 'the reply contained no JSON object' }],
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    return {
      ok: false,
      issues: [
        {
          level: 'error',
          where: 'reply',
          message: `the reply was not valid JSON: ${(e as Error).message}`,
        },
      ],
    };
  }
  // The model does not choose ids; parse the shape it owns, then stamp ours.
  const candidate = raw as Record<string, unknown>;
  const pipelineRaw = candidate.pipeline as Record<string, unknown> | undefined;
  const parsed = planReplySchema.safeParse({
    ...candidate,
    pipeline: pipelineRaw ? { ...pipelineRaw, id: undefined, builtin: undefined } : pipelineRaw,
  });
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        level: 'error' as const,
        where: i.path.join('.') || 'plan',
        message: i.message,
      })),
    };
  }

  const agents = hydrateSynthesizedAgents(parsed.data.agents);

  return {
    ok: true,
    reply: {
      refinedRequest: parsed.data.refinedRequest,
      rationale: parsed.data.rationale,
      pipeline: { ...parsed.data.pipeline, id: `generated-${planId}`, builtin: false },
      agents,
    },
  };
}

export interface PlanRailsInputs {
  roster: AgentDef[];
  commandNames: string[];
  knownEnvelopes: string[];
  scaffold?: boolean;
}

export type PlanRailsResult =
  { ok: true; warnings: ValidationIssue[] } | { ok: false; issues: ValidationIssue[] };

/**
 * The post-parse rails: the store's `validate()` and start-time preflight,
 * with roster = project roster ∪ synthesized agents. A synthesized agent
 * shadowing a roster name is an error here, at plan time, so `startRun`'s
 * union can never be ambiguous.
 */
export function checkPlanRails(reply: ParsedPlanReply, inputs: PlanRailsInputs): PlanRailsResult {
  const issues: ValidationIssue[] = [];
  const activeNames = new Set(inputs.roster.map((a) => a.name));
  for (const agent of reply.agents) {
    if (activeNames.has(agent.name)) {
      issues.push({
        level: 'error',
        where: `agents.${agent.name}`,
        message: `an agent is already named "${agent.name}" — synthesized agents shadow nothing`,
      });
    }
    activeNames.add(agent.name);
    issues.push(
      ...validateAgent(agent, inputs.knownEnvelopes).map((issue) => ({
        ...issue,
        where: `agents.${agent.name}.${issue.where}`,
      })),
    );
  }
  const union = [...inputs.roster, ...reply.agents];
  issues.push(
    ...validatePipeline(reply.pipeline, union, inputs.commandNames, inputs.knownEnvelopes),
    ...preflightForRun(reply.pipeline, union, inputs.commandNames, inputs.knownEnvelopes, {
      scaffold: inputs.scaffold,
    }),
  );
  const errors = issues.filter((i) => i.level === 'error');
  if (errors.length) return { ok: false, issues: errors };
  // Preflight repeats validate's warnings; the card needs each once.
  const seen = new Set<string>();
  const warnings = issues.filter((i) => {
    const key = `${i.where}|${i.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ok: true, warnings };
}

/** Assembles the confirmed shape from the parsed reply plus session facts. */
export function toGeneratedPlan(input: {
  planId: string;
  projectId: string;
  prompt: string;
  reply: ParsedPlanReply;
  warnings: ValidationIssue[];
  model: string;
  reasoningEffort: ReasoningEffort;
}): GeneratedRunPlan {
  return {
    planId: input.planId,
    projectId: input.projectId,
    prompt: input.prompt,
    refinedRequest: input.reply.refinedRequest,
    rationale: input.reply.rationale,
    pipeline: input.reply.pipeline,
    agents: input.reply.agents,
    warnings: input.warnings,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
  };
}
