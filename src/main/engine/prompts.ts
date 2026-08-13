/**
 * Prompt rendering. The template palette a user sees in the Roster editor is
 * exactly the set of substitutions performed here, and the envelope example is
 * appended from the zod schema rather than written by hand — so the shape the
 * agent is shown always matches the shape its answer is parsed against.
 */

import type { AgentDef, EnvelopeDef, PhaseDef } from '@shared/types.js';
import { exampleFor, type Envelope } from './envelopes.js';

export interface RenderContext {
  request: string;
  runId: string;
  worktree: string;
  handoffDir: string;
  handoffFiles: string[];
  /** Isolated run branch, when the pipeline created one. */
  branch?: string | null;
  /** Project base ref the PR (if any) will target. */
  baseRef?: string;
  /** Envelopes from earlier phases, by phase name. */
  envelopes: Map<string, Envelope>;
  /** Set when a code phase sent failure evidence back to this agent. */
  feedback?: string;
  /** Shared custom envelope library; resolves non-built-in kind names. */
  envelopeDefs?: EnvelopeDef[];
}

export const TEMPLATE_VARIABLES = [
  { token: '{{request}}', description: "The engineer's original request, verbatim." },
  { token: '{{run_id}}', description: "This run's id, useful for unique file names." },
  { token: '{{worktree}}', description: 'Absolute path of the worktree this run works in.' },
  { token: '{{handoff_dir}}', description: 'Directory for files passed between phases.' },
  { token: '{{handoff_files}}', description: 'Listing of files earlier phases handed off.' },
  {
    token: '{{feedback}}',
    description: 'Failure evidence from a code phase that looped back here.',
  },
  { token: '{{envelope:plan}}', description: "A prior phase's envelope as pretty JSON." },
  { token: '{{envelope:plan.summary}}', description: 'One field from a prior envelope.' },
  { token: '{{branch}}', description: 'The isolated run branch (`foundry/<runId>`), if any.' },
  { token: '{{base_ref}}', description: 'The project base ref a pull request will target.' },
];

/** `envelope:build.commit_message` reads one field; `envelope:build` the whole. */
export function resolveEnvelopeRef(ref: string, envelopes: Map<string, Envelope>): string | null {
  const body = ref.startsWith('envelope:') ? ref.slice('envelope:'.length) : ref;
  const [phase, ...fieldPath] = body.split('.');
  if (!phase) return null;

  const envelope = envelopes.get(phase);
  if (!envelope) return null;
  if (!fieldPath.length) return JSON.stringify(envelope, null, 2);

  let value: unknown = envelope;
  for (const key of fieldPath) {
    if (!value || typeof value !== 'object' || !(key in (value as Record<string, unknown>))) {
      return null;
    }
    value = (value as Record<string, unknown>)[key];
  }
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

export function renderTemplate(template: string, ctx: RenderContext): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, rawToken: string) => {
    const token = rawToken.trim();
    switch (token) {
      case 'request':
        return ctx.request;
      case 'run_id':
        return ctx.runId;
      case 'worktree':
        return ctx.worktree;
      case 'handoff_dir':
        return ctx.handoffDir;
      case 'handoff_files':
        return ctx.handoffFiles.length
          ? ctx.handoffFiles.map((f) => `- ${f}`).join('\n')
          : '(none yet)';
      case 'feedback':
        return ctx.feedback ?? '(no feedback)';
      case 'branch':
        return ctx.branch ?? '(none)';
      case 'base_ref':
        return ctx.baseRef ?? '(none)';
      default:
        if (token.startsWith('envelope:')) {
          return resolveEnvelopeRef(token, ctx.envelopes) ?? '(not available)';
        }
        return `{{${token}}}`;
    }
  });
}

export interface RenderedPrompt {
  system: string;
  user: string;
}

function appendMissingInputs(
  agent: AgentDef,
  phase: PhaseDef,
  ctx: RenderContext,
  user: string,
): string {
  const inputs = phase.prompt?.inputs ?? [];
  const missing: string[] = [];

  for (const input of inputs) {
    if (agent.userPrompt.includes(`{{${input}}}`)) continue;
    if (input === 'request') {
      missing.push(`## Request\n\n${ctx.request}`);
    } else if (input === 'handoff_files') {
      const listing = ctx.handoffFiles.map((f) => `- ${f}`).join('\n') || '(none)';
      missing.push(`## Handoff files\n\n${listing}`);
    } else if (input === 'feedback' && ctx.feedback) {
      missing.push(`## Feedback from a failed check\n\n${ctx.feedback}`);
    } else {
      const resolved = resolveEnvelopeRef(input, ctx.envelopes);
      if (resolved) missing.push(`## ${input}\n\n\`\`\`json\n${resolved}\n\`\`\``);
    }
  }

  const feedbackAlreadyCovered =
    agent.userPrompt.includes('{{feedback}}') || inputs.includes('feedback');
  if (ctx.feedback && !feedbackAlreadyCovered) {
    missing.push(`## A check failed after your last attempt\n\n${ctx.feedback}`);
  }

  return missing.length ? `${user}\n\n${missing.join('\n\n')}` : user;
}

/**
 * The user prompt gets the declared inputs appended when the template does not
 * already reference them, so an input listed in the pipeline is never silently
 * dropped because someone edited the prompt.
 */
export function renderPrompt(agent: AgentDef, phase: PhaseDef, ctx: RenderContext): RenderedPrompt {
  const system = renderTemplate(agent.systemPrompt, ctx);
  let user = renderTemplate(agent.userPrompt, ctx);
  user = appendMissingInputs(agent, phase, ctx, user);

  const kind = phase.envelope ?? agent.envelope;
  user = [
    user,
    '',
    '## Report',
    '',
    'Reply with ONLY this JSON object and nothing else, no prose and no code fence:',
    '',
    exampleFor(kind, agent.customFields, ctx.envelopeDefs),
  ].join('\n');

  return { system, user };
}

/**
 * droid takes the system prompt as an append rather than a replacement, so the
 * agent's persona is passed with the turn instead of pretending to own the
 * whole system prompt.
 */
export function combineForTurn(rendered: RenderedPrompt): string {
  return [rendered.system, '', '---', '', rendered.user].join('\n');
}
