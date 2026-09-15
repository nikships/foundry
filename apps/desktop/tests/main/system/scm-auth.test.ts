import { afterEach, describe, expect, it } from 'vitest';
import {
  cliAuthSatisfied,
  githubTokenEnvName,
  gitlabTokenEnvName,
} from '../../../src/main/system/scm-auth.js';

const GITHUB_KEYS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
] as const;
const GITLAB_KEYS = ['GITLAB_TOKEN', 'GITLAB_ACCESS_TOKEN', 'OAUTH_TOKEN'] as const;

const saved: Record<string, string | undefined> = {};

function clearTokens(): void {
  for (const key of [...GITHUB_KEYS, ...GITLAB_KEYS]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
}

function restoreTokens(): void {
  for (const key of [...GITHUB_KEYS, ...GITLAB_KEYS]) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(restoreTokens);

describe('scm-auth token detection', () => {
  it('prefers GH_TOKEN over GITHUB_TOKEN', () => {
    clearTokens();
    process.env.GITHUB_TOKEN = 'second';
    process.env.GH_TOKEN = 'first';
    expect(githubTokenEnvName()).toBe('GH_TOKEN');
  });

  it('ignores blank GitHub token values', () => {
    clearTokens();
    process.env.GH_TOKEN = '   ';
    expect(githubTokenEnvName()).toBeUndefined();
    expect(cliAuthSatisfied(false, githubTokenEnvName())).toBe(false);
  });

  it('prefers GITLAB_TOKEN for glab', () => {
    clearTokens();
    process.env.OAUTH_TOKEN = 'oauth';
    process.env.GITLAB_TOKEN = 'pat';
    expect(gitlabTokenEnvName()).toBe('GITLAB_TOKEN');
    expect(cliAuthSatisfied(false, gitlabTokenEnvName())).toBe(true);
  });

  it('requires either auth status or a token', () => {
    clearTokens();
    expect(cliAuthSatisfied(true, undefined)).toBe(true);
    expect(cliAuthSatisfied(false, undefined)).toBe(false);
    expect(cliAuthSatisfied(false, 'GH_TOKEN')).toBe(true);
  });
});
