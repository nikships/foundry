/**
 * Token env vars the forge CLIs honor for non-interactive auth.
 *
 * Foundry never stores these; it only notices when the operator (or CI) already
 * exported one, so `auth status` failing with "run auth login" is the wrong
 * diagnosis when a token is clearly set for the CLI to use.
 */

import { spawnEnv } from './env.js';

/** `gh` docs: GH_TOKEN then GITHUB_TOKEN; enterprise hosts use the _ENTERPRISE_ pair. */
export const GITHUB_TOKEN_ENV_VARS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
] as const;

/** `glab` docs: GITLAB_TOKEN, then GITLAB_ACCESS_TOKEN, then OAUTH_TOKEN. */
export const GITLAB_TOKEN_ENV_VARS = [
  'GITLAB_TOKEN',
  'GITLAB_ACCESS_TOKEN',
  'OAUTH_TOKEN',
] as const;

function firstSetName(names: readonly string[], env: NodeJS.ProcessEnv): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (typeof value === 'string' && value.trim()) return name;
  }
  return undefined;
}

/** Name of the first non-empty GitHub token env var, if any. */
export function githubTokenEnvName(env: NodeJS.ProcessEnv = spawnEnv()): string | undefined {
  return firstSetName(GITHUB_TOKEN_ENV_VARS, env);
}

/** Name of the first non-empty GitLab token env var, if any. */
export function gitlabTokenEnvName(env: NodeJS.ProcessEnv = spawnEnv()): string | undefined {
  return firstSetName(GITLAB_TOKEN_ENV_VARS, env);
}

/**
 * `auth status` succeeded, or a token env var the CLI honors is clearly set.
 * Presence is enough: an invalid token fails later on the API call, and telling
 * the operator to run `auth login` would be the wrong fix.
 */
export function cliAuthSatisfied(authStatusOk: boolean, tokenEnvName: string | undefined): boolean {
  return authStatusOk || Boolean(tokenEnvName);
}

export function authDetail(signedInViaStatus: boolean, tokenEnvName: string | undefined): string {
  if (signedInViaStatus) return 'signed in';
  if (tokenEnvName) return `authenticated via ${tokenEnvName}`;
  return 'not signed in';
}
