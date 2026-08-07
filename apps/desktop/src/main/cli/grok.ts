/**
 * xAI's Grok Build, driven through `grok -p --output-format streaming-json`.
 *
 * "Grok build CLI" is xAI's own tool, whose binary is `grok`; it is not the
 * community `@vibe-kit/grok-cli`, which shares the binary name but authenticates
 * with `GROK_API_KEY` instead of `XAI_API_KEY` and prints no JSON. The doctor
 * check tells the two apart by which key is present, because installing the
 * wrong one otherwise fails on the first turn with an auth error that reads like
 * a missing subscription.
 *
 * The streaming format is one JSON object per line, captured against the real
 * CLI and pinned in tests: `thought` and `text` carry per-token deltas,
 * `tool_call` / `tool_call_update` span a call, `usage` reports per request,
 * and one `end` object closes the turn with the session id, cumulative usage,
 * and cost. `available_commands` lines are noise and are ignored everywhere.
 *
 * Grok prints `ERROR worker quit ... UnexpectedContentType` to stderr on runs
 * that succeed, so `noisyStderr` keeps that line out of the trace. Success is
 * judged by exit status and a parsed result, never by stderr being empty.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AutonomyLevel, ModelInfo } from '@shared/types.js';
import type { DroidNotification, TokenUsage } from '../droid/protocol.js';
import {
  inheritModel,
  jsonLines,
  type CliAdapter,
  type ParsedTurn,
  type ProcessOutput,
} from './types.js';

/**
 * Autonomy is a sandbox profile, with approvals switched off at every tier:
 * Grok's default `ask` mode blocks on a prompt, and a blocked phase looks like a
 * hung run. `strict` confines reads to the worktree, `workspace` allows reads
 * anywhere but writes only inside it, and high autonomy lifts the sandbox and
 * leans on Foundry's own write boundary instead.
 */
const SANDBOX: Record<AutonomyLevel, string> = {
  low: 'read-only',
  medium: 'workspace',
  high: 'off',
};

interface GrokUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  reasoning_tokens?: number;
}

/** One line of the streaming-json format, as captured from the real CLI. */
interface GrokStreamLine {
  type?: string;
  /** thought and text lines carry their delta here. */
  data?: string;
  toolCallId?: string;
  title?: string;
  toolName?: string;
  status?: string | null;
  rawInput?: Record<string, unknown>;
  rawOutput?: unknown;
  content?: unknown;
  stopReason?: string;
  sessionId?: string;
  usage?: GrokUsage;
  total_cost_usd?: number;
}

function toTokenUsage(u: GrokUsage | undefined, costUsd: number | undefined): TokenUsage | null {
  if (!u) return null;
  if (u.input_tokens === undefined && u.output_tokens === undefined) return null;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    thinkingTokens: u.reasoning_tokens ?? 0,
    // Grok reports dollars on the end object, like Claude Code does.
    factoryCredits: costUsd ?? 0,
  };
}

/** Grok's tool names map onto the canonical ones the folder labels by. */
const TOOL_NAME: Record<string, string> = {
  run_terminal_command: 'Execute',
  read_file: 'Read',
  write: 'Create',
  search_replace: 'Edit',
  list_dir: 'LS',
  grep: 'Grep',
};

/**
 * rawOutput is a per-tool envelope (`{type:'ListDir', Content:{content:…}}`);
 * the displayable text lives one level down when it exists at all.
 */
function toolOutputText(line: GrokStreamLine): string {
  const raw = line.rawOutput as { Content?: { content?: unknown }; content?: unknown } | null;
  if (raw && typeof raw === 'object') {
    const content = raw.Content?.content ?? raw.content;
    if (typeof content === 'string') return content;
    return JSON.stringify(raw);
  }
  if (Array.isArray(line.content)) {
    return (line.content as { text?: string }[])
      .map((b) => b?.text ?? '')
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Folds one streaming-json line into droid-shaped notifications. Stateful on
 * purpose: grok emits thought and text as bare deltas with no message id, so
 * consecutive deltas of one kind form one block, and a line of the other kind
 * (or a tool call) closes it. Hence the factory: two runs sharing the adapter
 * must not share segment counters.
 */
function streamFactory(): (line: unknown) => DroidNotification[] {
  let segment = 0;
  let openThought: string | null = null;
  let openText: string | null = null;

  const closeThought = (): DroidNotification[] => {
    if (!openThought) return [];
    const out: DroidNotification[] = [{ type: 'thinking_text_complete', messageId: openThought }];
    openThought = null;
    return out;
  };
  const closeText = (): DroidNotification[] => {
    if (!openText) return [];
    const out: DroidNotification[] = [
      { type: 'assistant_text_complete', messageId: openText, blockIndex: 0 },
    ];
    openText = null;
    return out;
  };

  return (line) => {
    const e = line as GrokStreamLine;
    switch (e.type) {
      case 'thought': {
        const out = closeText();
        if (!openThought) openThought = `grok-thought-${++segment}`;
        out.push({ type: 'thinking_text_delta', messageId: openThought, textDelta: e.data ?? '' });
        return out;
      }
      case 'text': {
        const out = closeThought();
        if (!openText) openText = `grok-text-${++segment}`;
        out.push({
          type: 'assistant_text_delta',
          messageId: openText,
          blockIndex: 0,
          textDelta: e.data ?? '',
        });
        return out;
      }
      case 'tool_call': {
        const out = [...closeThought(), ...closeText()];
        if (!e.toolCallId) return out;
        const rawName = e.toolName ?? e.title ?? 'tool';
        out.push({
          type: 'tool_call',
          toolUse: {
            type: 'tool_use',
            id: e.toolCallId,
            name: TOOL_NAME[rawName] ?? rawName,
            input: e.rawInput ?? {},
          },
        });
        return out;
      }
      case 'tool_call_update': {
        // status null means "still running"; only a terminal status closes the span.
        if (!e.toolCallId || (e.status !== 'completed' && e.status !== 'failed')) return [];
        return [
          {
            type: 'tool_result',
            toolUseId: e.toolCallId,
            content: toolOutputText(e),
            isError: e.status !== 'completed',
          },
        ];
      }
      default:
        return [];
    }
  };
}

export const grokAdapter: CliAdapter = {
  id: 'grok',
  label: 'Grok Build',
  binary: 'grok',
  installPaths: () => [
    join(homedir(), '.grok/bin/grok'),
    join(homedir(), '.local/bin/grok'),
    join(homedir(), '.npm-global/bin/grok'),
    '/opt/homebrew/bin/grok',
    '/usr/local/bin/grok',
  ],
  docsUrl: 'https://docs.x.ai/build/overview',
  authEnvVars: ['XAI_API_KEY'],
  authPaths: () => [join(homedir(), '.grok', 'auth.json')],
  authUrl: 'https://docs.x.ai/build/overview',
  supportsRpc: false,
  versionArgs: ['--version'],
  noisyStderr: /worker quit|UnexpectedContentType/i,
  stream: streamFactory,
  caveats: [
    "The binary name is shared with the community grok-cli. Foundry expects xAI's own build, which authenticates with XAI_API_KEY.",
  ],

  turn: (req) => {
    const argv = ['-p', req.prompt, '--output-format', 'streaming-json', '--cwd', req.cwd];
    argv.push('--sandbox', SANDBOX[req.autonomy], '--always-approve');
    if (req.model && req.model !== 'inherit') argv.push('-m', req.model);
    if (req.reasoningEffort !== 'off') argv.push('--effort', req.reasoningEffort);
    if (req.sessionId) argv.push('-r', req.sessionId);
    if (req.restrictTools?.length) {
      // Grok's rules are one flag per rule, tool-scoped.
      for (const tool of req.restrictTools) argv.push('--allow', tool);
    }
    if (req.disabledTools?.length) {
      for (const tool of req.disabledTools) argv.push('--deny', tool);
    }
    // No update prompt and no fullscreen takeover: neither survives a pipe.
    argv.push('--no-auto-update', '--no-alt-screen');
    if (req.extraArgs?.length) argv.push(...req.extraArgs);
    return { argv };
  },

  parse: (out: ProcessOutput): ParsedTurn | null => {
    const lines = jsonLines<GrokStreamLine>(out.stdout);
    // The end object is the turn's summary; the answer is the text deltas
    // folded in order, which is exactly what the live transcript showed.
    const end = [...lines].reverse().find((l) => l.type === 'end');
    if (!end) return null;
    const text = lines
      .filter((l) => l.type === 'text')
      .map((l) => l.data ?? '')
      .join('');
    const stop = end.stopReason ?? 'completed';
    return {
      text: text.trim(),
      usage: toTokenUsage(end.usage, end.total_cost_usd),
      sessionId: end.sessionId ?? null,
      reason: stop,
      isError: /error|fail/i.test(stop),
    };
  },

  // `grok models` lists what the account can reach, but prints a table whose
  // columns are not specified, and a mis-parsed id is worse than no list.
  models: async (): Promise<ModelInfo[]> => [
    inheritModel('grok', 'Grok default (type an id to override)'),
  ],
};
