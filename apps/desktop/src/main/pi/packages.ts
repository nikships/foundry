/**
 * The pi packages Foundry ships.
 *
 * These are part of the application, not something an operator installs: the
 * list below is source, the directories are vendored under `resources/`, and a
 * package arrives on a machine the same way any other code does — someone adds
 * it here, it is reviewed, and a release goes out. There is no install path,
 * no settings entry, and no way for a repository or an agent to add one.
 *
 * A package supplies extensions (tools an agent can call) and skills
 * (instructions only). Both reach a session through pi's additional-path
 * options, which are honoured while every discovery flag stays off — so what
 * loads is exactly this list, and never a `.pi/` directory belonging to
 * whatever repository happens to be open.
 */

import { DefaultPackageManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { ResolvedPaths, ResolvedResource } from '@earendil-works/pi-coding-agent';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { piStateDir } from './pi-paths.js';

/** One shipped package: a directory under `resources/pi-packages/`. */
export interface BundledPackage {
  /** Directory name under `resources/pi-packages/`, and the log label. */
  readonly name: string;
  /**
   * Withhold this package's extensions from a read-only agent.
   *
   * A skill only instructs, so it is harmless to a reviewer. An extension
   * gives that reviewer a tool, and a read-only phase is expected to have
   * written nothing — the engine's post-call git diff is checked against that
   * expectation, so a write tool reaching a reviewer breaks the check
   * regardless of how well behaved the package is.
   */
  readonly extensionsForReadOnly?: boolean;
}

/**
 * Every package this build ships. Empty is a valid state and the current one.
 *
 * To add one: vendor the package directory at `resources/pi-packages/<name>/`
 * in pi's layout (`extensions/*.js`, `skills/<name>/SKILL.md`, or a `pi`
 * manifest in its `package.json`), then add an entry here.
 */
export const BUNDLED_PACKAGES: readonly BundledPackage[] = [];

/** Resolved paths for the sessions that are allowed to load them. */
export interface PackageResources {
  extensionPaths: string[];
  skillPaths: string[];
}

export const NO_PACKAGE_RESOURCES: PackageResources = Object.freeze({
  extensionPaths: [],
  skillPaths: [],
});

/**
 * Where the shipped packages live.
 *
 * Packaged, they sit beside the app's other resources; in a dev run they are
 * in the checkout. They are deliberately *not* inside `app.asar`: pi loads an
 * extension through jiti, which reads the file from disk, and a path inside
 * the archive is not a file. This is the same reason the Bridge binary and
 * `assets/` are copied out via `extraResources`.
 */
export function packagesRoot(repoRoot = process.cwd()): string {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const packaged = resources ? join(resources, 'pi-packages') : null;
  if (packaged && existsSync(packaged)) return packaged;
  return join(repoRoot, 'resources', 'pi-packages');
}

/**
 * Resolve the shipped packages into the paths a session loads.
 *
 * Pi's own resolver is used rather than a directory walk so a package can
 * carry a `pi` manifest and be laid out however its author intended. Sources
 * are absolute local paths, so this touches no network and installs nothing:
 * `skip` on a missing package means a build where a directory failed to ship
 * opens sessions without it instead of trying to fetch it.
 */
export async function resolveBundledPackages(opts: {
  supportDir: string;
  /** Withhold extensions and take skills only. */
  skillsOnly?: boolean;
  packages?: readonly BundledPackage[];
  root?: string;
  onWarning?: (message: string) => void;
}): Promise<PackageResources> {
  const declared = opts.packages ?? BUNDLED_PACKAGES;
  if (declared.length === 0) return NO_PACKAGE_RESOURCES;

  const root = opts.root ?? packagesRoot();
  const present: { pkg: BundledPackage; dir: string }[] = [];
  for (const pkg of declared) {
    const dir = join(root, pkg.name);
    // A declared package with no directory is a packaging fault, not an
    // operator error. Say so and carry on; a run must not fail to start
    // because a resource did not ship.
    if (!existsSync(dir)) {
      opts.onWarning?.(`bundled package ${pkg.name} is missing at ${dir}`);
      continue;
    }
    present.push({ pkg, dir });
  }
  if (present.length === 0) return NO_PACKAGE_RESOURCES;

  const eligible = present.filter(
    ({ pkg }) => !opts.skillsOnly || pkg.extensionsForReadOnly === true,
  );
  const paths = await resolvePaths(
    opts.supportDir,
    present.map(({ dir }) => dir),
  );
  if (!paths) {
    opts.onWarning?.('bundled packages could not be resolved');
    return NO_PACKAGE_RESOURCES;
  }

  const extensionSources = new Set(eligible.map(({ dir }) => dir));
  return {
    extensionPaths: enabledPaths(paths.extensions, extensionSources),
    skillPaths: enabledPaths(paths.skills, new Set(present.map(({ dir }) => dir))),
  };
}

function enabledPaths(resources: ResolvedResource[], sources: Set<string>): string[] {
  return resources
    .filter((resource) => resource.enabled && sources.has(resource.metadata.source))
    .map((resource) => resource.path);
}

async function resolvePaths(supportDir: string, sources: string[]): Promise<ResolvedPaths | null> {
  // `cwd` is the support directory rather than a checkout: project-scope
  // resolution looks for `<cwd>/.pi`, and pointing it at a repository is how a
  // clone's settings would start contributing resources.
  const settings = SettingsManager.inMemory({}, { projectTrusted: false });
  settings.setPackages(sources);
  const manager = new DefaultPackageManager({
    cwd: supportDir,
    agentDir: piStateDir(supportDir),
    settingsManager: settings,
  });
  try {
    return await manager.resolve(() => Promise.resolve('skip'));
  } catch {
    return null;
  }
}
