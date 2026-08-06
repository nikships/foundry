/**
 * Environment checks with a fix-it action each, because "it does not work" is
 * not a diagnosis. Run at onboarding and available from Settings.
 */

import { existsSync } from 'node:fs';
import { release } from 'node:os';
import type { DoctorCheck, ProjectDef } from '@shared/types.js';
import { droidVersion } from '../droid/catalog.js';
import { isRepo, refExists, listWorktrees } from '../engine/git.js';
import { runCommand } from '../engine/commands.js';

export async function runDoctor(droidPath: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  const version = await droidVersion(droidPath);
  checks.push({
    id: 'droid',
    label: 'droid CLI',
    ok: !!version,
    detail: version ? `found ${version} at ${droidPath}` : `not runnable at ${droidPath}`,
    fix: version ? undefined : { kind: 'open-url', value: 'https://docs.factory.ai/droid-cli/quickstart' },
  });

  // Auth lives in droid's own config; a key in the environment is the override.
  const hasKey = !!process.env.FACTORY_API_KEY;
  const settingsPath = `${process.env.HOME ?? ''}/.factory/settings.json`;
  const hasConfig = existsSync(settingsPath);
  const authed = hasKey || hasConfig;
  let authDetail = 'no API key and no droid config: droid cannot reach a model';
  if (hasKey) authDetail = 'FACTORY_API_KEY is set in the environment';
  else if (hasConfig) authDetail = `droid config found at ${settingsPath}`;
  checks.push({
    id: 'auth',
    label: 'Factory authentication',
    ok: authed,
    detail: authDetail,
    fix: authed ? undefined : { kind: 'open-url', value: 'https://app.factory.ai/settings/api-keys' },
  });

  const git = await runCommand({ argv: ['git', '--version'], cwd: process.cwd(), timeoutMs: 10_000 });
  checks.push({
    id: 'git',
    label: 'git',
    ok: git.passed,
    detail: git.passed ? git.outputTail.trim() : 'git is not on PATH',
  });

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
    detail: clean ? 'nothing uncommitted' : 'uncommitted changes will block an automatic merge',
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
