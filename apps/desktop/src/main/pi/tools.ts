/**
 * Foundry's own tools, registered directly on the agent session.
 *
 * With the agent running in this process there is no MCP server to stand up, no
 * wire-prefixed ids (`foundry___report_progress`), and no second schema dialect
 * to keep in sync. A tool is a plain object with a JSON Schema and a function.
 *
 * Four run tools, and none of them writes the worktree:
 * - `report_progress` traces a line for the Inspector timeline.
 * - `read_phase_context` reads back the validated envelope chain.
 * - `git_diff` returns the run's accumulated patch, bounded.
 * - `submit_envelope` is how a phase answers. Its schema is the phase's own
 *   envelope schema, so a conforming call always parses.
 *
 * A one-shot may additionally receive `submit_result`, whose caller supplies
 * the schema. It captures arguments in memory and has no run or trace.
 *
 * `submit_envelope` accepts the answer but does not decide anything: the phase
 * still fails until code validates the envelope and the gates pass. Agents
 * propose; code disposes.
 */

import { isAbsolute } from 'node:path';
import type { ToolProfile } from '@shared/types.js';
import { boundPatch, diffPatch } from '../engine/git.js';
import type { Envelope } from '../engine/envelopes.js';
import { defineTool, type ToolDefinition } from './tool-definition.js';
import type { FoundryToolContext } from './transport.js';

export const FOUNDRY_TOOL_NAMES = [
  'report_progress',
  'read_phase_context',
  'git_diff',
  'submit_envelope',
] as const;
export type FoundryToolName = (typeof FOUNDRY_TOOL_NAMES)[number];
/** Schema-bound answer channel for one-shot helpers such as the Orchestrator. */
export const ONESHOT_OUTPUT_TOOL_NAME = 'submit_result';

/** Pi's built-ins. A phase runs all of them; none of them prompts a human. */
export const BUILTIN_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] as const;

/**
 * The read-only subset, and the whole of what a detection or a setup session
 * gets. The tool list is the allowlist: an editing or shell tool is not merely
 * denied by policy, it is absent from the registry, so a session that runs
 * against the operator's own checkout has nothing that could write to it.
 */
export const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'] as const;

/**
 * The whole allowlist a run session is opened with, for one agent's profile.
 *
 * Foundry's own tools are named alongside the built-ins because the list given
 * to `createAgentSession` *is* the registry. A `read-only` agent gets the read
 * subset: `edit`, `write`, and `bash` do not exist for it, which is the only
 * form of read-only this directory recognises.
 *
 * Foundry's tools are in both profiles, `git_diff` included. It reads history
 * the agent could already read through `read`, cannot run anything else, and is
 * strictly narrower than the `bash` a full-surface agent already has.
 */
export function runToolsFor(profile: ToolProfile | undefined): string[] {
  const builtins = profile === 'read-only' ? READ_ONLY_TOOLS : BUILTIN_TOOLS;
  return [...builtins, ...FOUNDRY_TOOL_NAMES];
}

/** One entry of the chain `read_phase_context` returns. */
export interface PhaseContextEntry {
  phase: string;
  envelope: Envelope;
}

// `ToolDefinition`'s `TSchema` is an empty interface, so any JSON Schema object
// satisfies it structurally — but `Static<TSchema>` then degrades to `unknown`,
// which is why every `execute` below narrows its params by hand instead of
// trusting inference.

/** A tool answer is content plus details; Foundry's tools return plain text. */
function text(value: string): { content: [{ type: 'text'; text: string }]; details: undefined } {
  return { content: [{ type: 'text', text: value }], details: undefined };
}

function field(params: unknown, name: string): unknown {
  return params && typeof params === 'object'
    ? (params as Record<string, unknown>)[name]
    : undefined;
}

export function reportProgressTool(ctx: FoundryToolContext): ToolDefinition {
  return defineTool({
    name: 'report_progress',
    label: 'Progress',
    description:
      'Record a short progress update for the current Foundry phase. The update is traced for the operator; it does not affect phase acceptance.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One line describing what just happened.' },
      },
      required: ['summary'],
      additionalProperties: false,
    },
    execute: (_id, params) => {
      const raw = field(params, 'summary');
      const summary = typeof raw === 'string' ? raw : String(raw ?? '');
      ctx.tracer.event({
        runId: ctx.runId,
        phaseId: ctx.phaseId(),
        type: 'log',
        name: `${ctx.agentName}: progress`,
        payload: { message: summary, summary },
      });
      return Promise.resolve(text('recorded'));
    },
  });
}

export function readPhaseContextTool(ctx: FoundryToolContext): ToolDefinition {
  return defineTool({
    name: 'read_phase_context',
    label: 'Phase context',
    description:
      'Return the validated envelope chain for the current Foundry run as JSON. Read-only; does not change any phase state.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => {
      const chain: PhaseContextEntry[] = [];
      for (const [phase, envelope] of ctx.envelopes()) chain.push({ phase, envelope });
      return Promise.resolve(text(JSON.stringify(chain)));
    },
  });
}

/**
 * How much patch one `git_diff` answer may carry.
 *
 * 60 KB is roughly 15k tokens: a normal Foundry run's whole diff fits, and even
 * at the cap it leaves the bulk of a modern context window for the request, the
 * prior envelopes, and the reply. It is deliberately far above the 4 KB the
 * prompt's `--stat` block gets, because a stat is a file list while a patch has
 * to carry the hunks that answer "what changed". Past the cap the answer names
 * the files it dropped and says to re-call with `path`, so the ceiling costs
 * completeness in one reply rather than correctness.
 */
export const GIT_DIFF_MAX_CHARS = 60_000;

/** Tells the model its answer is partial and how to get the rest. */
export const GIT_DIFF_TRUNCATED_MARKER = '[truncated: patch exceeded the per-call limit]';

/**
 * Why a `path` was refused. Returned to the model as its tool result, so it can
 * correct the argument rather than treating the call as broken.
 */
function rejectPath(path: string, reason: string): string {
  return `refused path "${path}": ${reason}. Pass a repository-relative path inside the run worktree, or omit it for the whole diff.`;
}

/**
 * Validates the one argument the model controls.
 *
 * A pathspec cannot leave the repository, but it can still name something
 * outside this run's scope, and an absolute path would silently read another
 * checkout. Both are refused here rather than normalised: guessing what the
 * model meant is how a scope check stops being one.
 */
function validateDiffPath(
  raw: unknown,
): { ok: true; path?: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== 'string') return { ok: false, error: rejectPath(String(raw), 'not a string') };

  const path = raw.trim();
  if (!path) return { ok: true };
  if (path.startsWith('-')) {
    return { ok: false, error: rejectPath(path, 'a path may not begin with "-"') };
  }
  if (isAbsolute(path) || /^[a-zA-Z]:[\\/]/.test(path)) {
    return { ok: false, error: rejectPath(path, 'absolute paths are not allowed') };
  }
  // Checked on the literal argument, not on a resolved path: `..` is refused
  // outright, so there is no "resolves back inside" case to reason about.
  if (path.split(/[\\/]/).some((segment) => segment === '..')) {
    return { ok: false, error: rejectPath(path, '".." may not appear in the path') };
  }
  return { ok: true, path };
}

/**
 * The read-only diff affordance: the accumulated patch for this run.
 *
 * It exists because `read-only` removes `bash`, and a reviewer or PR writer
 * without a shell could otherwise see only the `--stat` in its prompt — a file
 * list, which cannot answer what changed. The tool takes no argv, no flags, and
 * no ref: the only input is an optional path filter, and the base is whatever
 * the engine resolved as this run's branch point.
 */
export function gitDiffTool(ctx: FoundryToolContext): ToolDefinition {
  return defineTool({
    name: 'git_diff',
    label: 'Git diff',
    description:
      "Return this run's accumulated changes as a unified diff, against the commit the run branched from. Covers committed and unstaged changes to tracked files. Read-only: it runs no other git command and changes nothing. Pass `path` to narrow a large diff to one file or directory.",
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Optional repository-relative file or directory to limit the diff to. No absolute paths, no "..".',
        },
      },
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      const validated = validateDiffPath(field(params, 'path'));
      if (!validated.ok) return text(validated.error);

      const scope = ctx.diff();
      const raw = await diffPatch(scope.cwd, scope.branchPointSha, validated.path);
      const bounded = boundPatch(raw, GIT_DIFF_MAX_CHARS);
      if (!bounded.text) {
        return text(
          validated.path
            ? `no changes against the branch point under "${validated.path}"`
            : 'no changes against the branch point',
        );
      }
      if (!bounded.omitted.length) return text(bounded.text);

      return text(
        [
          bounded.text,
          '',
          GIT_DIFF_TRUNCATED_MARKER,
          'These changed files are not shown above. Call git_diff again with `path`',
          'set to one of them to read its patch:',
          ...bounded.omitted.map((path) => `- ${path}`),
        ].join('\n'),
      );
    },
  });
}

/** A schema-bound submission tool plus the arguments last accepted through it. */
export interface SubmissionTool {
  definition: ToolDefinition;
  /** The most recent submission, or null when the turn never called the tool. */
  submitted(): Record<string, unknown> | null;
}

function submissionTool(input: {
  name: string;
  label: string;
  description: string;
  schema: Record<string, unknown>;
  confirmation: string;
}): SubmissionTool {
  let captured: Record<string, unknown> | null = null;
  const definition = defineTool({
    name: input.name,
    label: input.label,
    description: input.description,
    parameters: input.schema,
    execute: (_id, params) => {
      captured = params && typeof params === 'object' ? (params as Record<string, unknown>) : null;
      return Promise.resolve(text(input.confirmation));
    },
  });
  return { definition, submitted: () => captured };
}

/**
 * The phase's answer channel, schema-constrained to that phase's envelope.
 *
 * The schema comes from `jsonSchemaFor` — the same schema the reply is parsed
 * against — so the tool call, the prompt example, and the parse cannot drift.
 * A call that conforms is a structured answer no text parse has to guess at;
 * `parseEnvelope` stays as the fallback for a turn that answers in prose.
 *
 * Built fresh per turn on purpose. pi-ai caches compiled validators in a
 * WeakMap keyed on the schema object's identity, so a phase-specific schema has
 * to arrive as a new definition object; mutating `parameters` in place would
 * keep the previous phase's validator.
 */
export function submitEnvelopeTool(schema: Record<string, unknown>): SubmissionTool {
  return submissionTool({
    name: 'submit_envelope',
    label: 'Submit envelope',
    description: "Submit this phase's result envelope.",
    schema,
    confirmation: 'envelope received',
  });
}

/** Schema-bound answer channel for a one-shot that must not rely on prose JSON. */
export function submitResultTool(schema: Record<string, unknown>): SubmissionTool {
  return submissionTool({
    name: ONESHOT_OUTPUT_TOOL_NAME,
    label: 'Submit result',
    description: 'Submit the complete structured result for this one-shot task.',
    schema,
    confirmation: 'structured result received',
  });
}
