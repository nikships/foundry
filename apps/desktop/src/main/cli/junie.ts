/**
 * JetBrains Junie, driven through its headless one-shot form with
 * `--output-format json-stream`.
 *
 * Junie is the one vendor whose autonomy Foundry cannot set from argv. Its
 * approval behaviour lives in brave mode, which is documented only as an
 * interactive toggle, and in `~/.junie/allowlist.json`. Rather than emit a flag
 * that may not exist on the operator's build, this adapter emits none and the
 * doctor checks for the allowlist instead, so the failure shows up as a setup
 * check rather than as a phase that hangs waiting on a prompt. An operator whose
 * build does take a flag can add it through the per-CLI extra arguments field.
 *
 * The stream format is one JSON object per line, captured against the real CLI
 * and pinned in tests: a `session` line carries the id, `step` lines report
 * actions as they complete (a name plus free-text details, no structured input
 * or output), and the closing `result` line carries the answer, the changes
 * list, and — under the misnomer `errorCode` — the per-model usage rows that
 * the plain `json` format calls `llmUsage`. Both spellings are read, because
 * both are in the wild. Usage is summed across rows: a Junie turn can
 * legitimately bill two models, one for the work and a cheaper one for its own
 * routing.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelInfo } from '@shared/types.js';
import type { DroidNotification, TokenUsage } from '../droid/protocol.js';
import { jsonLines, type CliAdapter, type ParsedTurn, type ProcessOutput } from './types.js';

/**
 * Junie's documented aliases. They are aliases rather than ids on purpose: the
 * model behind `sonnet` moves, and an alias keeps resolving when it does.
 */
const ALIASES: { id: string; displayName: string; provider: string }[] = [
  { id: 'inherit', displayName: 'Junie default', provider: 'junie' },
  { id: 'sonnet', displayName: 'Sonnet (alias)', provider: 'claude' },
  { id: 'opus', displayName: 'Opus (alias)', provider: 'claude' },
  { id: 'gpt', displayName: 'GPT (alias)', provider: 'openai' },
  { id: 'gpt-codex', displayName: 'GPT Codex (alias)', provider: 'openai' },
  { id: 'gemini-pro', displayName: 'Gemini Pro (alias)', provider: 'gemini' },
  { id: 'gemini-flash', displayName: 'Gemini Flash (alias)', provider: 'gemini' },
  { id: 'grok', displayName: 'Grok (alias)', provider: 'openai' },
];

interface JunieUsageRow {
  model?: string;
  calls?: number;
  cost?: number;
  inputTokens?: number;
  cacheInputTokens?: number;
  cacheCreateTokens?: number;
  outputTokens?: number;
}

/** One line of the json-stream format, as captured from the real CLI. */
interface JunieStreamLine {
  type?: string;
  timestamp?: number;
  sessionId?: string;
  name?: string;
  details?: string;
  result?: string;
  changes?: unknown[];
  llmUsage?: JunieUsageRow[];
  /** json-stream's result line carries the usage rows under this key instead. */
  errorCode?: JunieUsageRow[] | unknown;
}

function sumUsage(rows: JunieUsageRow[] | undefined): TokenUsage | null {
  if (!rows?.length) return null;
  const total: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    thinkingTokens: 0,
    factoryCredits: 0,
  };
  for (const row of rows) {
    total.inputTokens = (total.inputTokens ?? 0) + (row.inputTokens ?? 0);
    total.outputTokens = (total.outputTokens ?? 0) + (row.outputTokens ?? 0);
    total.cacheCreationTokens = (total.cacheCreationTokens ?? 0) + (row.cacheCreateTokens ?? 0);
    total.cacheReadTokens = (total.cacheReadTokens ?? 0) + (row.cacheInputTokens ?? 0);
    total.factoryCredits = (total.factoryCredits ?? 0) + (row.cost ?? 0);
  }
  return total;
}

function usageRowsOf(line: JunieStreamLine): JunieUsageRow[] | undefined {
  if (Array.isArray(line.llmUsage)) return line.llmUsage;
  // errorCode is an array of usage rows on the streaming result line, despite
  // the name; anything else under that key is not usage and stays unreported.
  if (Array.isArray(line.errorCode)) return line.errorCode as JunieUsageRow[];
  return undefined;
}

/**
 * Steps have no structured input or output, just a human-readable name and
 * details, so each becomes a completed generic span: the folder labels unknown
 * tools by their summary, which is exactly the step name. `TASK RESULT`
 * duplicates the result line's text and is skipped here; the result itself
 * lands as the assistant text so the lane ends with the answer.
 */
function streamLine(line: unknown): DroidNotification[] {
  const e = line as JunieStreamLine;
  if (e.type === 'step' && e.name && e.name.trim() !== 'TASK RESULT') {
    const id = `junie-step-${e.timestamp ?? e.name}`;
    return [
      {
        type: 'tool_call',
        toolUse: { type: 'tool_use', id, name: 'step', input: { summary: e.name.trim() } },
      },
      { type: 'tool_result', toolUseId: id, content: e.details ?? '', isError: false },
    ];
  }
  if (e.type === 'result' && typeof e.result === 'string' && e.result.trim()) {
    return [
      { type: 'assistant_text_delta', messageId: 'junie-result', blockIndex: 0, textDelta: e.result },
      { type: 'assistant_text_complete', messageId: 'junie-result', blockIndex: 0 },
    ];
  }
  return [];
}

export const junieAdapter: CliAdapter = {
  id: 'junie',
  label: 'JetBrains Junie',
  binary: 'junie',
  installPaths: () => [
    join(homedir(), '.local/bin/junie'),
    join(homedir(), '.npm-global/bin/junie'),
    '/opt/homebrew/bin/junie',
    '/usr/local/bin/junie',
  ],
  docsUrl: 'https://junie.jetbrains.com/docs/junie-cli.html',
  authEnvVars: ['JUNIE_API_KEY'],
  authPaths: () => [join(homedir(), '.junie', 'config.json')],
  authUrl: 'https://junie.jetbrains.com/cli',
  supportsRpc: false,
  versionArgs: ['--version'],
  stream: () => streamLine,
  caveats: [
    'Steps stream as they complete, but the answer text arrives only at turn end: Junie publishes no per-token stream.',
    'Autonomy is not settable from argv. Junie takes it from ~/.junie/allowlist.json, so an unattended run needs that file.',
    'Session resume is best effort: Junie has reported the id in its JSON output and the id in its session index disagreeing.',
  ],

  turn: (req) => {
    const argv = ['--output-format', 'json-stream', '--project', req.cwd];
    if (req.model && req.model !== 'inherit') argv.push('--model', req.model);
    if (req.reasoningEffort !== 'off') argv.push('--effort', req.reasoningEffort);
    if (req.sessionId) argv.push('--session-id', req.sessionId);
    // A background harness must never sit on an update prompt.
    argv.push('--skip-update-check');
    if (req.extraArgs?.length) argv.push(...req.extraArgs);
    argv.push(req.prompt);
    return { argv };
  },

  parse: (out: ProcessOutput): ParsedTurn | null => {
    const lines = jsonLines<JunieStreamLine>(out.stdout);
    // The result line is the turn's summary. The plain json format printed the
    // same object without a type discriminator, so both spellings are accepted.
    const result = [...lines]
      .reverse()
      .find((l) => l.type === 'result' || (l.type === undefined && l.result !== undefined));
    if (!result) return null;
    // json-stream moves the session id to its own opening line.
    const session = lines.find((l) => l.type === 'session' && l.sessionId);
    return {
      text: (result.result ?? '').trim(),
      usage: sumUsage(usageRowsOf(result)),
      sessionId: session?.sessionId ?? result.sessionId ?? null,
      reason: 'completed',
      isError: false,
    };
  },

  models: async (): Promise<ModelInfo[]> =>
    ALIASES.map(({ id, displayName, provider }) => ({
      id,
      displayName,
      provider,
      // Junie accepts more tiers than Foundry exposes; these are the shared four.
      supportedReasoningEfforts: id === 'inherit' ? [] : ['low', 'medium', 'high'],
      defaultReasoningEffort: id === 'inherit' ? 'none' : 'medium',
      isCustom: false,
      deprecated: false,
    })),
};
