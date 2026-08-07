/**
 * JetBrains Junie, driven through its headless one-shot form with
 * `--output-format json`.
 *
 * Junie is the one vendor whose autonomy Foundry cannot set from argv. Its
 * approval behaviour lives in brave mode, which is documented only as an
 * interactive toggle, and in `~/.junie/allowlist.json`. Rather than emit a flag
 * that may not exist on the operator's build, this adapter emits none and the
 * doctor checks for the allowlist instead, so the failure shows up as a setup
 * check rather than as a phase that hangs waiting on a prompt. An operator whose
 * build does take a flag can add it through the per-CLI extra arguments field.
 *
 * Its usage report is per-model rather than per-turn, so the parse sums the
 * `llmUsage` rows: a Junie turn can legitimately bill two models, one for the
 * work and a cheaper one for its own routing.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelInfo } from '@shared/types.js';
import type { TokenUsage } from '../droid/protocol.js';
import { lastJsonObject, type CliAdapter, type ParsedTurn, type ProcessOutput } from './types.js';

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

interface JunieResult {
  sessionId?: string;
  taskName?: string;
  result?: string;
  changes?: unknown[];
  llmUsage?: JunieUsageRow[];
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
  caveats: [
    'Mid-turn tool calls are not traced: a turn is one span, as in droid one-shot mode.',
    'Autonomy is not settable from argv. Junie takes it from ~/.junie/allowlist.json, so an unattended run needs that file.',
    'Session resume is best effort: Junie has reported the id in its JSON output and the id in its session index disagreeing.',
  ],

  turn: (req) => {
    const argv = ['--output-format', 'json', '--project', req.cwd];
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
    const parsed = lastJsonObject<JunieResult>(
      out.stdout,
      (v) => v.result !== undefined || v.sessionId !== undefined,
    );
    if (!parsed) return null;
    return {
      text: (parsed.result ?? '').trim(),
      usage: sumUsage(parsed.llmUsage),
      sessionId: parsed.sessionId ?? null,
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
