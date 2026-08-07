/**
 * xAI's Grok Build, driven through `grok -p --output-format json`.
 *
 * "Grok build CLI" is xAI's own tool, whose binary is `grok`; it is not the
 * community `@vibe-kit/grok-cli`, which shares the binary name but authenticates
 * with `GROK_API_KEY` instead of `XAI_API_KEY` and prints no JSON. The doctor
 * check tells the two apart by which key is present, because installing the
 * wrong one otherwise fails on the first turn with an auth error that reads like
 * a missing subscription.
 *
 * Grok prints `ERROR worker quit ... UnexpectedContentType` to stderr on runs
 * that succeed, so `noisyStderr` keeps that line out of the trace. Success is
 * judged by exit status and a parsed result, never by stderr being empty.
 *
 * Its JSON usage block is documented as present but its field names are not
 * published, so the parse reads several spellings and reports usage as
 * unreported when it finds none, which is the honest outcome rather than a zero.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AutonomyLevel, ModelInfo } from '@shared/types.js';
import type { TokenUsage } from '../droid/protocol.js';
import {
  inheritModel,
  lastJsonObject,
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
  inputTokens?: number;
  input_tokens?: number;
  outputTokens?: number;
  output_tokens?: number;
  cachedInputTokens?: number;
  cached_input_tokens?: number;
  reasoningTokens?: number;
  reasoning_tokens?: number;
  cost?: number;
}

interface GrokResult {
  text?: string;
  stopReason?: string;
  sessionId?: string;
  requestId?: string;
  thought?: string;
  usage?: GrokUsage;
  cost?: number;
}

function pick(...values: (number | undefined)[]): number | undefined {
  return values.find((v) => typeof v === 'number');
}

function toTokenUsage(u: GrokUsage | undefined, cost: number | undefined): TokenUsage | null {
  if (!u) return null;
  const input = pick(u.inputTokens, u.input_tokens);
  const output = pick(u.outputTokens, u.output_tokens);
  const cached = pick(u.cachedInputTokens, u.cached_input_tokens);
  const reasoning = pick(u.reasoningTokens, u.reasoning_tokens);
  // An object with none of the token keys we know is not a usage report; saying
  // so beats reporting a turn that cost nothing.
  if (input === undefined && output === undefined) return null;
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    cacheCreationTokens: 0,
    cacheReadTokens: cached ?? 0,
    thinkingTokens: reasoning ?? 0,
    factoryCredits: pick(u.cost, cost) ?? 0,
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
  caveats: [
    'Mid-turn tool calls are not traced: a turn is one span, as in droid one-shot mode.',
    'Token usage field names are unpublished, so a turn Grok reports differently reads as unreported rather than as zero.',
    'The binary name is shared with the community grok-cli. Foundry expects xAI\'s own build, which authenticates with XAI_API_KEY.',
  ],

  turn: (req) => {
    const argv = ['-p', req.prompt, '--output-format', 'json', '--cwd', req.cwd];
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
    const parsed = lastJsonObject<GrokResult>(
      out.stdout,
      (v) => v.text !== undefined || v.sessionId !== undefined,
    );
    if (!parsed) return null;
    const stop = parsed.stopReason ?? 'completed';
    return {
      text: (parsed.text ?? '').trim(),
      usage: toTokenUsage(parsed.usage, parsed.cost),
      sessionId: parsed.sessionId ?? null,
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
