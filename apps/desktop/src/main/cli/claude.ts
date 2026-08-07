/**
 * Anthropic's Claude Code, driven through `claude -p --output-format stream-json`.
 *
 * The closest fit of the four additions: its result object is nearly droid's,
 * down to `result` / `session_id` / `is_error`, so the parse is a rename rather
 * than a translation. `stream-json` (which requires `--verbose` in print mode)
 * prefixes that same result object with the whole conversation as JSONL, one
 * message per line, which is what the Inspector folds into a live transcript.
 *
 * Two details are load-bearing:
 *
 *  1. There is no `--cwd`. The working directory is the spawned process's cwd,
 *     which the harness already sets, and `--add-dir` is passed as well so a
 *     worktree outside the launch directory stays readable.
 *  2. `--session-id` takes a UUID and only starts a session; resuming the same
 *     conversation is `--resume <id>`. Passing `--session-id` twice starts two
 *     unrelated sessions, which reads as an agent with no memory.
 */

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AutonomyLevel, ModelInfo } from '@shared/types.js';
import type { DroidNotification, TokenUsage } from '../droid/protocol.js';
import { lastJsonObject, type CliAdapter, type ParsedTurn, type ProcessOutput } from './types.js';

/**
 * Autonomy is a permission mode. `default` is not "ask" here the way it is in a
 * terminal: with no `--permission-prompt-tool` wired up, a headless run denies
 * what it would have asked about instead of hanging, which is the right reading
 * of low autonomy for a scout or reviewer that should not be writing anyway.
 */
const PERMISSION_MODE: Record<AutonomyLevel, string> = {
  low: 'default',
  medium: 'acceptEdits',
  high: 'bypassPermissions',
};

/**
 * Claude Code publishes no model list command, so these are its documented
 * aliases and nothing else. An alias keeps resolving after a model is retired,
 * which a pinned id does not.
 */
const ALIASES: { id: string; displayName: string }[] = [
  { id: 'inherit', displayName: 'Claude Code default' },
  { id: 'opus', displayName: 'Opus (alias)' },
  { id: 'sonnet', displayName: 'Sonnet (alias)' },
  { id: 'haiku', displayName: 'Haiku (alias)' },
];

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface ClaudeResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: ClaudeUsage;
}

function toTokenUsage(u: ClaudeUsage | undefined, costUsd: number | undefined): TokenUsage | null {
  if (!u) return null;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    thinkingTokens: 0,
    // Claude Code reports dollars, and the trace's cost column is dollars for
    // every vendor but droid, whose "credits" are its own unit.
    factoryCredits: costUsd ?? 0,
  };
}

// ── stream-json folding ──────────────────────────────────────────────────────

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | { type?: string; text?: string }[];
  is_error?: boolean;
}

interface ClaudeStreamEvent {
  type?: string;
  message?: {
    id?: string;
    role?: string;
    content?: ClaudeContentBlock[];
  };
}

/**
 * Claude's tool names differ from droid's exactly where the shared folder
 * switches on them to label a call, so they are renamed at the boundary rather
 * than teaching the folder every vendor's vocabulary.
 */
const TOOL_NAME: Record<string, string> = {
  Bash: 'Execute',
  Write: 'Create',
  NotebookEdit: 'Edit',
};

function resultText(content: ClaudeContentBlock['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n');
  }
  return '';
}

/**
 * One stream-json line becomes droid-shaped notifications. Messages arrive
 * whole (one line per API response, not per token), so each content block is
 * one delta followed by its close.
 */
function streamLine(line: unknown): DroidNotification[] {
  const event = line as ClaudeStreamEvent;
  const message = event.message;
  if (!message?.id || !Array.isArray(message.content)) return [];
  const out: DroidNotification[] = [];

  if (event.type === 'assistant') {
    message.content.forEach((block, i) => {
      if (block.type === 'text' && block.text) {
        out.push(
          {
            type: 'assistant_text_delta',
            messageId: message.id!,
            blockIndex: i,
            textDelta: block.text,
          },
          { type: 'assistant_text_complete', messageId: message.id!, blockIndex: i },
        );
      } else if (block.type === 'thinking' && block.thinking) {
        const key = `${message.id}:${i}`;
        out.push(
          { type: 'thinking_text_delta', messageId: key, textDelta: block.thinking },
          { type: 'thinking_text_complete', messageId: key },
        );
      } else if (block.type === 'tool_use' && block.id && block.name) {
        out.push({
          type: 'tool_call',
          toolUse: {
            type: 'tool_use',
            id: block.id,
            name: TOOL_NAME[block.name] ?? block.name,
            input: block.input ?? {},
          },
        });
      }
    });
    return out;
  }

  if (event.type === 'user') {
    for (const block of message.content) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue;
      out.push({
        type: 'tool_result',
        toolUseId: block.tool_use_id,
        content: resultText(block.content),
        isError: !!block.is_error,
      });
    }
  }
  return out;
}

export const claudeAdapter: CliAdapter = {
  id: 'claude',
  label: 'Claude Code',
  binary: 'claude',
  installPaths: () => [
    join(homedir(), '.local/bin/claude'),
    join(homedir(), '.claude/local/claude'),
    join(homedir(), '.npm-global/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ],
  docsUrl: 'https://docs.anthropic.com/en/docs/claude-code/setup',
  authEnvVars: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  authPaths: () => [join(homedir(), '.claude', 'settings.json'), join(homedir(), '.claude.json')],
  authUrl: 'https://docs.anthropic.com/en/docs/claude-code/authentication',
  supportsRpc: false,
  versionArgs: ['--version'],
  stream: () => streamLine,
  caveats: [
    'Permission asks are settled by --permission-mode, so the interrupt sheet does not open for this CLI.',
  ],

  turn: (req) => {
    // stream-json needs --verbose in print mode; the final line is still the
    // same result object `json` would have printed, so parse is unchanged.
    const argv = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      PERMISSION_MODE[req.autonomy],
    ];
    if (req.model && req.model !== 'inherit') argv.push('--model', req.model);
    if (req.reasoningEffort !== 'off') argv.push('--effort', req.reasoningEffort);
    if (req.restrictTools?.length) argv.push('--allowedTools', req.restrictTools.join(','));
    if (req.disabledTools?.length) argv.push('--disallowedTools', req.disabledTools.join(','));
    // The worktree is the process cwd; --add-dir is what makes it writable when
    // the launch directory and the worktree differ, which they always do here.
    argv.push('--add-dir', req.cwd);
    if (req.sessionId) argv.push('--resume', req.sessionId);
    else argv.push('--session-id', randomUUID());
    if (req.extraArgs?.length) argv.push(...req.extraArgs);
    argv.push(req.prompt);
    return { argv };
  },

  parse: (out: ProcessOutput): ParsedTurn | null => {
    const parsed = lastJsonObject<ClaudeResult>(
      out.stdout,
      (v) => v.type === 'result' || v.result !== undefined,
    );
    if (!parsed) return null;
    return {
      text: (parsed.result ?? '').trim(),
      usage: toTokenUsage(parsed.usage, parsed.total_cost_usd),
      sessionId: parsed.session_id ?? null,
      reason: parsed.is_error ? (parsed.subtype ?? 'error') : (parsed.subtype ?? 'completed'),
      isError: !!parsed.is_error,
    };
  },

  models: async (): Promise<ModelInfo[]> =>
    ALIASES.map(({ id, displayName }) => ({
      id,
      displayName,
      provider: 'claude',
      // Claude Code's own effort levels; `off` means the flag is omitted.
      supportedReasoningEfforts: id === 'inherit' ? [] : ['low', 'medium', 'high'],
      defaultReasoningEffort: id === 'inherit' ? 'none' : 'medium',
      isCustom: false,
      deprecated: false,
    })),
};
