import { afterEach, describe, expect, it } from 'vitest';
import {
  appendForgeDoctorChecks,
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

describe('appendForgeDoctorChecks', () => {
  it('emits install + auth rows for both forge CLIs', async () => {
    const checks: { id: string; label: string; ok: boolean; detail: string }[] = [];
    await appendForgeDoctorChecks(checks, async (argv) => {
      if (argv[0] === 'gh' && argv[1] === '--version') {
        return { passed: true, outputTail: 'gh version 2.0.0' };
      }
      if (argv[0] === 'gh' && argv[1] === 'auth') {
        return { passed: true, outputTail: 'logged in' };
      }
      if (argv[0] === 'glab' && argv[1] === '--version') {
        return { passed: false, outputTail: '' };
      }
      return { passed: false, outputTail: '' };
    });
    expect(checks.map((c) => c.id)).toEqual(['gh', 'gh:auth', 'glab']);
    expect(checks.find((c) => c.id === 'gh:auth')?.ok).toBe(true);
    expect(checks.find((c) => c.id === 'glab')?.ok).toBe(false);
  });
});
