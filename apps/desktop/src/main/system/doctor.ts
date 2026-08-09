/**
 * Environment checks with a fix-it action each, because "it does not work" is
 * not a diagnosis. Run at onboarding and available from Settings.
 */

import { existsSync } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';
import type { AppSettings, CliVendor, DoctorCheck, ProjectDef } from '@shared/types.js';
import { CLI_VENDOR_IDS } from '@shared/types.js';
import { adapterFor } from '../cli/index.js';
import { cliVersion } from '../droid/catalog.js';
import { isRepo, refExists, listWorktrees } from '../engine/git.js';
import { runCommand } from '../engine/commands.js';
import { resolvedEnv } from './env.js';

/** Runners a detected project command is most likely to need. */
const TOOLCHAIN_BINARIES = ['node', 'npm', 'pnpm', 'yarn', 'bun', 'cargo', 'go', 'uv', 'swift'];

function onPath(binary: string, path: string): boolean {
  return path.split(':').some((dir) => dir && existsSync(join(dir, binary)));
}

/**
 * One pair of checks per CLI: is the binary there, and can it reach a model.
 * Every vendor is reported rather than only the configured ones, because "Junie
 * is not installed" is the answer to why Junie is missing from the roster's
 * picker, and a check that silently omits itself cannot give it.
 */
async function checkCli(
  vendor: CliVendor,
  settings: AppSettings,
  isDefault: boolean,
): Promise<DoctorCheck[]> {
  const adapter = adapterFor(vendor);
  const path = settings.clis[vendor]?.path ?? adapter.binary;
  const version = await cliVersion(path, adapter.versionArgs);
  const found: DoctorCheck = {
    id: `cli:${vendor}`,
    label: `${adapter.label} CLI`,
    ok: !!version,
    detail: version ? `found ${version} at ${path}` : `not runnable at ${path}`,
    blocking: isDefault && !version,
    fix: version ? undefined : { kind: 'open-url', value: adapter.docsUrl },
  };
  if (!version) return [found];

  // Auth lives in each CLI's own config; a key in the environment is the
  // override. Foundry never reads either, it only reports which one is present.
  const envKey = adapter.authEnvVars.find((name) => !!process.env[name]);
  const configPath = adapter.authPaths().find((p) => existsSync(p));
  const authed = !!envKey || !!configPath;
  let detail = `no credentials found: ${adapter.label} cannot reach a model`;
  if (envKey) detail = `${envKey} is set in the environment`;
  else if (configPath) detail = `signed in, config at ${configPath}`;

  return [
    found,
    {
      id: `auth:${vendor}`,
      label: `${adapter.label} authentication`,
      ok: authed,
      detail,
      blocking: isDefault && !authed,
      fix: authed ? undefined : { kind: 'open-url', value: adapter.authUrl },
    },
  ];
}

export async function runDoctor(settings: AppSettings): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // The default CLI leads, because it is the one whose failure blocks a run.
  const order = [settings.defaultCli, ...CLI_VENDOR_IDS.filter((v) => v !== settings.defaultCli)];
  for (const vendor of order) {
    checks.push(...(await checkCli(vendor, settings, vendor === settings.defaultCli)));
  }

  // A GUI launch inherits launchd's PATH, which contains no developer tooling
  // at all. That failure is invisible in every other check: a detected `npm
  // test` simply exits "No such file or directory" and reads as a wrong
  // command. Reporting the resolved PATH is what tells those two apart.
  const env = resolvedEnv();
  const reachable = TOOLCHAIN_BINARIES.filter((bin) => onPath(bin, env.path));
  checks.push({
    id: 'toolchain-path',
    label: 'Toolchain PATH',
    ok: env.via === 'login-shell',
    detail:
      env.via === 'login-shell'
        ? `resolved from your login shell; ${reachable.length ? `found ${reachable.join(', ')}` : 'no known build tool found on it'}`
        : `${env.detail ?? 'could not ask your login shell'} — project commands may not find node, npm, cargo, go or uv`,
  });

  const git = await runCommand({
    argv: ['git', '--version'],
    cwd: process.cwd(),
    timeoutMs: 10_000,
  });
  checks.push({
    id: 'git',
    label: 'git',
    ok: git.passed,
    detail: git.passed ? git.outputTail.trim() : 'git is not on PATH',
    blocking: !git.passed,
  });

  // Pull requests ride on the operator's own gh install and login; Foundry
  // holds no GitHub token. Never blocking — local merge works without it.
  const gh = await runCommand({
    argv: ['gh', '--version'],
    cwd: process.cwd(),
    timeoutMs: 10_000,
  });
  if (!gh.passed) {
    checks.push({
      id: 'gh',
      label: 'GitHub CLI',
      ok: false,
      detail: 'gh is not on PATH — pull requests are unavailable (local merge still works)',
      fix: { kind: 'open-url', value: 'https://cli.github.com' },
    });
  } else {
    checks.push({
      id: 'gh',
      label: 'GitHub CLI',
      ok: true,
      detail: gh.outputTail.trim().split('\n')[0] ?? 'installed',
    });
    const ghAuth = await runCommand({
      argv: ['gh', 'auth', 'status'],
      cwd: process.cwd(),
      timeoutMs: 15_000,
    });
    checks.push({
      id: 'gh:auth',
      label: 'GitHub CLI authentication',
      ok: ghAuth.passed,
      detail: ghAuth.passed
        ? 'signed in'
        : 'not signed in — run `gh auth login` to enable pull requests',
      fix: ghAuth.passed
        ? undefined
        : { kind: 'open-url', value: 'https://cli.github.com/manual/gh_auth_login' },
    });
  }

  // macOS 26 is the floor; the version conveniences are verified only there.
  const major = Number(release().split('.')[0] ?? 0);
  const macOsOk = major >= 25;
  checks.push({
    id: 'macos',
    label: 'macOS 26 or newer',
    ok: macOsOk,
    detail: macOsOk ? `darwin ${release()}` : `darwin ${release()} is below the supported floor`,
  });

  return checks;
}

export async function checkProject(project: ProjectDef): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  const exists = existsSync(project.path);
  checks.push({
    id: 'path',
    label: 'Project folder',
    ok: exists,
    detail: exists ? project.path : `${project.path} is gone`,
  });
  if (!exists) return checks;

  const repo = await isRepo(project.path);
  checks.push({
    id: 'repo',
    label: 'Git repository',
    ok: repo,
    detail: repo ? 'a git repository' : 'not a git repository: Foundry needs one to isolate runs',
  });
  if (!repo) return checks;

  const baseOk = await refExists(project.path, project.baseRef);
  checks.push({
    id: 'base-ref',
    label: `Base ref "${project.baseRef}"`,
    ok: baseOk,
    detail: baseOk ? 'resolves' : `"${project.baseRef}" does not exist in this repo`,
  });

  const submodules = existsSync(`${project.path}/.gitmodules`);
  checks.push({
    id: 'submodules',
    label: 'Submodules',
    ok: !submodules,
    detail: submodules
      ? 'this repo has submodules: worktrees do not populate them automatically'
      : 'none',
  });

  const dirty = await runCommand({
    argv: ['git', 'status', '--porcelain'],
    cwd: project.path,
    timeoutMs: 30_000,
  });
  const clean = dirty.outputTail.trim().length === 0;
  checks.push({
    id: 'clean',
    label: 'Base worktree is clean',
    ok: clean,
    detail: clean
      ? 'nothing uncommitted'
      : 'uncommitted changes: runs are unaffected, but a merge that touches the same files will be refused by git',
  });

  const hasCommands = project.commands.length > 0;
  checks.push({
    id: 'commands',
    label: 'Project commands',
    ok: hasCommands,
    detail: hasCommands
      ? project.commands.map((c) => c.name).join(', ')
      : 'none configured: a pipeline with a test phase cannot run, and a placeholder test proves nothing. Detect from repo fills these in',
    fix: hasCommands ? undefined : { kind: 'open-settings', value: 'project-commands' },
  });

  const worktrees = await listWorktrees(project.path);
  const leftover = worktrees.filter((w) => w.path.includes('.foundry-worktrees'));
  const leftoverCount = leftover.length;
  checks.push({
    id: 'worktrees',
    label: 'Leftover run worktrees',
    ok: leftoverCount === 0,
    detail: leftoverCount
      ? `${leftoverCount} left from earlier runs: review or sweep them in Maintenance`
      : 'none',
    fix: leftoverCount ? { kind: 'open-settings', value: 'maintenance' } : undefined,
  });

  return checks;
}
