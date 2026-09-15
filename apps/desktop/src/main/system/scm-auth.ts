/**
 * Token env vars the forge CLIs honor for non-interactive auth, plus shared
 * doctor/UI copy for the two forge CLIs.
 *
 * Foundry never stores these; it only notices when the operator (or CI) already
 * exported one, so `auth status` failing with "run auth login" is the wrong
 * diagnosis when a token is clearly set for the CLI to use.
 */

import type { DoctorCheck } from '@shared/types.js';
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

/** One forge CLI's doctor install + auth checks (never blocking). */
export interface ForgeDoctorCli {
  id: 'gh' | 'glab';
  label: string;
  authLabel: string;
  installUrl: string;
  authLoginUrl: string;
  tokenEnvName: () => string | undefined;
  notInstalledDetail: string;
  notSignedInDetail: string;
}

export const FORGE_DOCTOR_CLIS: readonly ForgeDoctorCli[] = [
  {
    id: 'gh',
    label: 'GitHub CLI',
    authLabel: 'GitHub CLI authentication',
    installUrl: 'https://cli.github.com',
    authLoginUrl: 'https://cli.github.com/manual/gh_auth_login',
    tokenEnvName: githubTokenEnvName,
    notInstalledDetail:
      'gh is not on PATH — GitHub pull requests are unavailable (local merge still works)',
    notSignedInDetail:
      'not signed in — run `gh auth login` or set GH_TOKEN / GITHUB_TOKEN to enable pull requests',
  },
  {
    id: 'glab',
    label: 'GitLab CLI',
    authLabel: 'GitLab CLI authentication',
    installUrl: 'https://gitlab.com/gitlab-org/cli',
    authLoginUrl: 'https://gitlab.com/gitlab-org/cli/-/blob/main/docs/source/auth/login.md',
    tokenEnvName: gitlabTokenEnvName,
    notInstalledDetail:
      'glab is not on PATH — GitLab merge requests are unavailable (local merge still works)',
    notSignedInDetail:
      'not signed in — run `glab auth login` or set GITLAB_TOKEN to enable merge requests',
  },
];

export type ForgeProbe = (
  argv: string[],
  timeoutMs: number,
) => Promise<{ passed: boolean; outputTail: string }>;

/** Append install + auth DoctorCheck rows for every forge CLI. */
export async function appendForgeDoctorChecks(
  checks: DoctorCheck[],
  probe: ForgeProbe,
): Promise<void> {
  for (const cli of FORGE_DOCTOR_CLIS) {
    const installed = await probe([cli.id, '--version'], 10_000);
    checks.push({
      id: cli.id,
      label: cli.label,
      ok: installed.passed,
      detail: installed.passed
        ? (installed.outputTail.trim().split('\n')[0] ?? 'installed')
        : cli.notInstalledDetail,
      fix: installed.passed ? undefined : { kind: 'open-url', value: cli.installUrl },
    });
    if (!installed.passed) continue;
    const auth = await probe([cli.id, 'auth', 'status'], 15_000);
    const tokenEnv = cli.tokenEnvName();
    const authed = cliAuthSatisfied(auth.passed, tokenEnv);
    checks.push({
      id: `${cli.id}:auth`,
      label: cli.authLabel,
      ok: authed,
      detail: authed ? authDetail(auth.passed, tokenEnv) : cli.notSignedInDetail,
      fix: authed ? undefined : { kind: 'open-url', value: cli.authLoginUrl },
    });
  }
}
