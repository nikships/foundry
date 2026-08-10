/**
 * Factory's droid, the vendor Foundry was built against.
 *
 * This adapter is the extraction of what `oneshot.ts` already did, unchanged on
 * the wire. Droid is the only vendor with `supportsRpc`, so it is also the only
 * one with an SDK transport (`droid/sdk/session.ts`); every vendor, droid
 * included, comes back through here whenever a session runs one-shot.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelInfo, ToolInfo } from '@shared/types.js';
import { AUTONOMY_LEVEL, type DroidNotification, type TokenUsage } from '../droid/protocol.js';
import { loadDroidCatalog, loadDroidTools } from '../droid/catalog.js';
import { lastJsonObject, type CliAdapter, type ParsedTurn, type ProcessOutput } from './types.js';

interface DroidResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  usage?: DroidWireUsage;
  /** `stream-json` ends with `completion`/`finalText` where `json` says `result`. */
  finalText?: string;
}

/**
 * `droid exec` prints snake_case token counts while the RPC surface sends the
 * camelCase `TokenUsage` the engine speaks. Both are read: passing the wire
 * object straight through left every one-shot droid turn reporting zero tokens,
 * because `toUsageBreakdown` looks for `inputTokens` and found `input_tokens`.
 */
interface DroidWireUsage extends TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  factory_credits?: number;
}

function toUsage(usage: DroidWireUsage | undefined): TokenUsage | null {
  if (!usage) return null;
  return {
    inputTokens: usage.inputTokens ?? usage.input_tokens,
    outputTokens: usage.outputTokens ?? usage.output_tokens,
    cacheReadTokens: usage.cacheReadTokens ?? usage.cache_read_input_tokens,
    cacheCreationTokens: usage.cacheCreationTokens ?? usage.cache_creation_input_tokens,
    factoryCredits: usage.factoryCredits ?? usage.factory_credits,
  };
}

/** One `-o stream-json` line, as the CLI actually prints it. */
interface DroidStreamLine {
  type?: string;
  role?: string;
  id?: string;
  text?: string;
  toolId?: string;
  toolName?: string;
  parameters?: Record<string, unknown>;
  isError?: boolean;
  value?: string;
}

/**
 * Maps droid's `stream-json` lines onto the droid-shaped notifications the
 * shared EventFolder already understands.
 *
 * Unlike the RPC surface this is not token-by-token: one line carries a whole
 * assistant message, so each becomes a delta immediately followed by its
 * complete. Shapes are pinned in tests against real captured output.
 */
function streamLine(line: unknown): DroidNotification[] {
  const event = line as DroidStreamLine;

  if (event.type === 'message' && event.role === 'assistant' && event.id && event.text) {
    return [
      { type: 'assistant_text_delta', messageId: event.id, blockIndex: 0, textDelta: event.text },
      { type: 'assistant_text_complete', messageId: event.id, blockIndex: 0 },
    ];
  }

  if (event.type === 'tool_call' && event.id) {
    return [
      {
        type: 'tool_call',
        toolUse: {
          type: 'tool_use',
          id: event.id,
          name: event.toolName ?? event.toolId ?? 'tool',
          input: event.parameters ?? {},
        },
      },
    ];
  }

  if (event.type === 'tool_result' && event.id) {
    return [
      {
        type: 'tool_result',
        toolUseId: event.id,
        content: event.value ?? '',
        isError: !!event.isError,
      },
    ];
  }

  // `system`/`init` and `completion` carry no mid-turn event; parse() owns the
  // final text and usage.
  return [];
}

export const droidAdapter: CliAdapter = {
  id: 'droid',
  label: 'Factory droid',
  binary: 'droid',
  installPaths: () => [
    join(homedir(), '.npm-global/bin/droid'),
    '/opt/homebrew/bin/droid',
    '/usr/local/bin/droid',
    join(homedir(), '.local/bin/droid'),
  ],
  docsUrl: 'https://docs.factory.ai/droid-cli/quickstart',
  authEnvVars: ['FACTORY_API_KEY'],
  authPaths: () => [join(homedir(), '.factory', 'settings.json')],
  authUrl: 'https://app.factory.ai/settings/api-keys',
  supportsRpc: true,
  versionArgs: ['--version'],
  caveats: [],
  stream: () => streamLine,

  turn: (req) => {
    // stream-json prints the same terminal object json does (under a different
    // discriminator, which parse() accepts) and adds the mid-turn lines the
    // live view folds, so there is nothing to lose by always streaming.
    const argv = [
      'exec',
      '--output-format',
      'stream-json',
      '--cwd',
      req.cwd,
      '--auto',
      AUTONOMY_LEVEL,
    ];
    if (req.model && req.model !== 'inherit') {
      argv.push('-m', req.model);
    }
    if (req.reasoningEffort !== 'off') {
      argv.push('-r', req.reasoningEffort);
    }
    if (req.restrictTools?.length) argv.push('--restrict-tools', req.restrictTools.join(','));
    if (req.disabledTools?.length) argv.push('--disabled-tools', req.disabledTools.join(','));
    if (req.sessionId) argv.push('--session-id', req.sessionId);
    if (req.extraArgs?.length) argv.push(...req.extraArgs);
    argv.push(req.prompt);
    return { argv };
  },

  // `-o json` ends with {"type":"result","result":...}; `-o stream-json` ends
  // with {"type":"completion","finalText":...}. Both are accepted so the output
  // format can be chosen per call site without changing the turn contract.
  parse: (out: ProcessOutput): ParsedTurn | null => {
    const parsed = lastJsonObject<DroidResult>(
      out.stdout,
      (v) =>
        v.type === 'result' ||
        v.result !== undefined ||
        v.type === 'completion' ||
        v.finalText !== undefined,
    );
    if (!parsed) return null;
    const text = parsed.result ?? parsed.finalText ?? '';
    return {
      text: text.trim(),
      usage: toUsage(parsed.usage),
      sessionId: parsed.session_id ?? null,
      reason: parsed.is_error ? 'error' : (parsed.subtype ?? 'completed'),
      isError: !!parsed.is_error,
    };
  },

  models: (binPath: string): Promise<ModelInfo[]> => loadDroidCatalog(binPath),
  tools: (binPath: string, model?: string): Promise<ToolInfo[]> => loadDroidTools(binPath, model),
};
