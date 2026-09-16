/**
 * Token env var names the forge CLIs honor. Kept free of other imports so
 * `env.ts` can import them at startup without a cycle through `scm-auth.ts`
 * (which needs `spawnEnv`).
 */

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

/** Every forge token env var Foundry may import from the login shell at startup. */
export const FORGE_TOKEN_ENV_VARS = [...GITHUB_TOKEN_ENV_VARS, ...GITLAB_TOKEN_ENV_VARS] as const;
