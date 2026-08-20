/**
 * Environment checks with a fix-it action each, because "it does not work" is
 * not a diagnosis. Run at onboarding and available from Settings.
 */

import { existsSync } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';
import type { DoctorCheck, ModelInfo, ProjectDef } from '@shared/types.js';
import { BRIDGE_UNAVAILABLE_COPY, type BridgeUnavailable } from '@shared/ipc-contract.js';
import { withoutHiddenModels } from '@shared/model-visibility.js';
import type { BridgeProviderStatus } from '../bridge/auth.js';
import { currentBranch, isRepo, refExists, listWorktrees } from '../engine/git.js';
import { runCommand } from '../engine/commands.js';
import { resolvedEnv } from './env.js';

/** Runners a detected project command is most likely to need. */
const TOOLCHAIN_BINARIES = ['node', 'npm', 'pnpm', 'yarn', 'bun', 'cargo', 'go', 'uv', 'swift'];

/** Where a failing provider check sends the operator. */
const PROVIDERS_PANE = { kind: 'open-settings', value: 'models' } as const;

function onPath(binary: string, path: string): boolean {
  return path.split(':').some((dir) => dir && existsSync(join(dir, binary)));
}

/**
 * What the provider checks read. Injected rather than imported so a test can
 * state a machine — no Bridge binary, a Bridge that will not launch, an empty
 * catalog, an expired account — without one on disk and without a network.
 */
export interface ProviderDoctorDeps {
  /** Starts the Bridge if it is not running. Never throws. */
  ensureBridge: () => Promise<{ ok: boolean; detail: string; reason?: BridgeUnavailable }>;
  /** Providers and their accounts, read off the Bridge's auth directory. */
  bridgeProviders: () => BridgeProviderStatus[];
  /** Models an agent phase can actually run on right now. */
  agentModels: () => Promise<ModelInfo[]>;
  /** Hidden model IDs configured in settings. */
  hiddenModelIds?: () => string[];
}

/**
 * Can this install reach a model, and through what.
 *
 * Only the model check blocks. The Bridge is one way to get a credential and
 * not the only one — an operator running on their own API keys has no Bridge
 * and a working factory — so an absent binary is reported and explained rather
 * than treated as a broken setup. What does break a run is having no model at
 * all, which is why that check is the blocking one.
 */
export async function checkProviders(deps: ProviderDoctorDeps): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  const bridge = await deps.ensureBridge();
  checks.push({
    id: 'bridge',
    label: 'Provider bridge',
    ok: bridge.ok,
    detail: bridge.ok
      ? bridge.detail
      : `${bridge.reason ? BRIDGE_UNAVAILABLE_COPY[bridge.reason] : 'the Bridge is unavailable'}: ${bridge.detail}. Subscription logins are unavailable; direct API keys still work.`,
    fix: bridge.ok ? undefined : PROVIDERS_PANE,
  });

  let models: ModelInfo[] = [];
  let modelsDetail = '';
  try {
    models = await deps.agentModels();
  } catch (error) {
    modelsDetail = `the model catalog could not be read: ${error instanceof Error ? error.message : String(error)}`;
  }
  const hidden = deps.hiddenModelIds ? deps.hiddenModelIds() : [];
  const visible = withoutHiddenModels(models, hidden);
  let detail = '';
  if (models.length > 0) {
    detail =
      visible.length > 0
        ? `${models.length} model${models.length === 1 ? '' : 's'} available, including ${visible[0]!.displayName}`
        : `${models.length} model${models.length === 1 ? '' : 's'} available`;
  } else {
    detail =
      modelsDetail ||
      'no model has a working credential — connect a provider or add an API key before starting a run';
  }
  checks.push({
    id: 'agent-models',
    label: 'Usable models',
    ok: models.length > 0,
    detail,
    blocking: models.length === 0,
    fix: models.length ? undefined : PROVIDERS_PANE,
  });

  // Only providers with an account are reported. A provider nobody signed into
  // is a choice, not a fault, and five "not connected" rows would bury the one
  // account that actually expired.
  for (const provider of deps.bridgeProviders()) {
    if (!provider.accounts.length) continue;
    const expired = provider.accounts.filter((account) => account.expired);
    const disabled = provider.accounts.filter((account) => account.disabled);
    const soonest = provider.accounts
      .map((account) => account.expiresAt)
      .filter((at): at is string => !!at)
      .sort()[0];
    let detail = soonest ? `signed in, valid until ${soonest}` : 'signed in';
    if (expired.length) detail = `the sign-in expired — reconnect ${provider.label}`;
    else if (disabled.length === provider.accounts.length) {
      detail = `every ${provider.label} account is disabled`;
    }
    checks.push({
      id: `provider:${provider.id}`,
      label: `${provider.label} account`,
      ok: provider.authenticated,
      detail,
      fix: provider.authenticated ? undefined : PROVIDERS_PANE,
    });
  }

  return checks;
}

export async function runDoctor(deps: ProviderDoctorDeps): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = await checkProviders(deps);

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
  const curBranch = await currentBranch(project.path);
  const isUnborn = !baseOk && curBranch === project.baseRef;
  checks.push({
    id: 'base-ref',
    label: `Base ref "${project.baseRef}"`,
    ok: baseOk || isUnborn,
    detail: baseOk
      ? 'resolves'
      : isUnborn
        ? 'empty repository (no commits yet)'
        : `"${project.baseRef}" does not exist in this repo`,
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
  // A project created empty from Foundry has no commands because it has no code
  // yet. Reporting that as a fault would flag a brand-new repo as broken on the
  // first screen someone sees after creating it.
  const commandsOk = hasCommands || project.scaffold === true;
  checks.push({
    id: 'commands',
    label: 'Project commands',
    ok: commandsOk,
    detail: hasCommands
      ? project.commands.map((c) => c.name).join(', ')
      : project.scaffold
        ? 'none yet: this project was created empty, so test phases are skipped until it has a test command'
        : 'none configured: a pipeline with a test phase cannot run, and a placeholder test proves nothing. Detect from repo fills these in',
    fix: commandsOk ? undefined : { kind: 'open-settings', value: 'project-commands' },
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
