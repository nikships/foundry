/**
 * Factory's droid, the vendor Foundry was built against.
 *
 * This adapter is the extraction of what `oneshot.ts` already did, unchanged on
 * the wire. Droid is the only vendor with `supportsRpc`, so it is also the only
 * one that reaches `droid/client.ts` and therefore the only one whose permission
 * asks can still open the interrupt sheet mid-turn.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelInfo, ToolInfo } from '@shared/types.js';
import type { TokenUsage } from '../droid/protocol.js';
import { loadDroidCatalog, loadDroidTools } from '../droid/catalog.js';
import { lastJsonObject, type CliAdapter, type ParsedTurn, type ProcessOutput } from './types.js';

interface DroidResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  usage?: TokenUsage;
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

  turn: (req) => {
    const argv = ['exec', '--output-format', 'json', '--cwd', req.cwd, '--auto', req.autonomy];
    if (req.model && req.model !== 'inherit') {
      argv.push('-m', req.model);
      if (req.reasoningEffort !== 'off') argv.push('-r', req.reasoningEffort);
    }
    if (req.restrictTools?.length) argv.push('--restrict-tools', req.restrictTools.join(','));
    if (req.disabledTools?.length) argv.push('--disabled-tools', req.disabledTools.join(','));
    if (req.sessionId) argv.push('--session-id', req.sessionId);
    if (req.extraArgs?.length) argv.push(...req.extraArgs);
    argv.push(req.prompt);
    return { argv };
  },

  parse: (out: ProcessOutput): ParsedTurn | null => {
    const parsed = lastJsonObject<DroidResult>(
      out.stdout,
      (v) => v.type === 'result' || v.result !== undefined,
    );
    if (!parsed) return null;
    return {
      text: (parsed.result ?? '').trim(),
      usage: parsed.usage ?? null,
      sessionId: parsed.session_id ?? null,
      reason: parsed.is_error ? 'error' : (parsed.subtype ?? 'completed'),
      isError: !!parsed.is_error,
    };
  },

  models: (binPath: string): Promise<ModelInfo[]> => loadDroidCatalog(binPath),
  tools: (binPath: string, model?: string): Promise<ToolInfo[]> => loadDroidTools(binPath, model),
};
