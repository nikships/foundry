/**
 * OpenAI's Codex CLI, driven through `codex exec --json`.
 *
 * The only vendor here that streams JSONL rather than printing one summary
 * object, so the parse folds an event list: `thread.started` carries the id to
 * resume with, the last `agent_message` item is the answer, and `turn.completed`
 * carries usage.
 *
 * Two shapes are tolerated on purpose. Codex has been through a TypeScript to
 * Rust rewrite and its item discriminator appears as both `type` and `item_type`
 * depending on build, and the assistant item as both `agent_message` and
 * `assistant_message`. Accepting all four costs two lines and turns a silent
 * empty turn into a working one.
 *
 * Resuming is a subcommand (`codex exec resume <id>`), not a flag, so the argv
 * shape differs between the first turn and the rest.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AutonomyLevel, ModelInfo } from '@shared/types.js';
import type { TokenUsage } from '../droid/protocol.js';
import {
  inheritModel,
  jsonLines,
  type CliAdapter,
  type ParsedTurn,
  type ProcessOutput,
} from './types.js';

/**
 * Autonomy is the sandbox, and approvals are always `never`: `untrusted` and
 * `on-request` both wait on a human who is not there. `danger-full-access` is
 * never used at any tier, because the run is already isolated in a worktree and
 * turning the sandbox off would remove the only guardrail without buying
 * anything. High autonomy differs from medium by network access, not by reach
 * into the filesystem.
 */
const SANDBOX: Record<AutonomyLevel, string> = {
  low: 'read-only',
  medium: 'workspace-write',
  high: 'workspace-write',
};

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

interface CodexItem {
  id?: string;
  type?: string;
  /** Older builds name the discriminator this instead. */
  item_type?: string;
  text?: string;
  message?: string;
}

interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: CodexUsage;
  error?: { message?: string };
  message?: string;
}

function itemKind(item: CodexItem | undefined): string {
  return item?.type ?? item?.item_type ?? '';
}

function toTokenUsage(u: CodexUsage | undefined): TokenUsage | null {
  if (!u) return null;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheCreationTokens: u.cache_write_input_tokens ?? 0,
    cacheReadTokens: u.cached_input_tokens ?? 0,
    thinkingTokens: u.reasoning_output_tokens ?? 0,
    // Codex reports tokens only. A zero here is honest; the trace shows tokens
    // and leaves cost blank rather than inventing a rate.
    factoryCredits: 0,
  };
}

export const codexAdapter: CliAdapter = {
  id: 'codex',
  label: 'OpenAI Codex',
  binary: 'codex',
  installPaths: () => [
    join(homedir(), '.npm-global/bin/codex'),
    join(homedir(), '.local/bin/codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ],
  docsUrl: 'https://developers.openai.com/codex/cli',
  // OPENAI_API_KEY is deliberately absent: Codex stopped reading it from the
  // environment in 0.36, so treating it as proof of auth would report a working
  // setup that fails on the first turn.
  authEnvVars: ['CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'],
  authPaths: () => [join(homedir(), '.codex', 'auth.json')],
  authUrl: 'https://developers.openai.com/codex/cli',
  supportsRpc: false,
  versionArgs: ['--version'],
  caveats: [
    'Mid-turn tool calls are not traced: a turn is one span, as in droid one-shot mode.',
    'Per-agent tool restrictions are ignored: Codex scopes tools by sandbox, not by an allow list.',
    'Cost is not reported, only tokens, so the run cost reads as unreported for this CLI.',
  ],

  turn: (req) => {
    const argv = ['exec'];
    // Resume is a subcommand and has to precede the flags it applies to.
    if (req.sessionId) argv.push('resume', req.sessionId);
    argv.push('--json', '--cd', req.cwd, '--sandbox', SANDBOX[req.autonomy], '--ask-for-approval', 'never');
    if (req.autonomy === 'high') argv.push('-c', 'sandbox_workspace_write.network_access=true');
    if (req.model && req.model !== 'inherit') argv.push('-m', req.model);
    if (req.reasoningEffort !== 'off') {
      // The value is parsed as TOML, so the quotes are part of the token.
      argv.push('-c', `model_reasoning_effort="${req.reasoningEffort}"`);
    }
    if (req.extraArgs?.length) argv.push(...req.extraArgs);
    argv.push(req.prompt);
    return { argv };
  },

  parse: (out: ProcessOutput): ParsedTurn | null => {
    const events = jsonLines<CodexEvent>(out.stdout);
    if (!events.length) return null;

    let text = '';
    let sessionId: string | null = null;
    let usage: TokenUsage | null = null;
    let reason = 'completed';
    let isError = false;

    for (const event of events) {
      switch (event.type) {
        case 'thread.started':
          sessionId = event.thread_id ?? sessionId;
          break;
        case 'item.completed': {
          const kind = itemKind(event.item);
          // The last assistant item wins: a turn can restate its answer.
          if (kind === 'agent_message' || kind === 'assistant_message') {
            text = event.item?.text ?? text;
          } else if (kind === 'error') {
            isError = true;
            reason = 'error';
            text = event.item?.message ?? text;
          }
          break;
        }
        case 'turn.completed':
          usage = toTokenUsage(event.usage) ?? usage;
          break;
        case 'turn.failed':
          isError = true;
          reason = 'error';
          text = event.error?.message ?? text;
          break;
        case 'error':
          isError = true;
          reason = 'error';
          text = event.message ?? text;
          break;
        default:
          break;
      }
    }

    return { text: text.trim(), usage, sessionId, reason, isError };
  },

  // Codex publishes no model list command and its ids move with the platform, so
  // the catalog offers its default and lets a typed id through untouched.
  models: async (): Promise<ModelInfo[]> => [
    inheritModel('codex', 'Codex default (type an id to override)'),
  ],
};
