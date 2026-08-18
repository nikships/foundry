/**
 * Factory's droid, described rather than driven.
 *
 * Nothing here builds argv or parses stdout any more: no code path spawns
 * `droid exec`. What remains is what Settings and the doctor ask — where the
 * binary is, whether it is signed in, and which models it publishes.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelInfo, ToolInfo } from '@shared/types.js';
import { droidTools, loadDroidCatalog } from '../droid/catalog.js';
import type { CliAdapter } from './types.js';

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

  models: (binPath: string): Promise<ModelInfo[]> => loadDroidCatalog(binPath),
  // Tools are whatever the last live session reported. Enumerating them used to
  // cost a `droid exec --list-tools` child per request, for a list only a
  // session can answer for correctly anyway.
  tools: (): Promise<ToolInfo[]> => droidTools(),
};
