/**
 * The pi packages Foundry can load: shipped ones and operator-enabled ones.
 *
 * Shipped packages are part of the application: the list below is source, the
 * directories are vendored under `resources/`, and a package arrives on a
 * machine the same way any other code does — someone adds it here, it is
 * reviewed, and a release goes out.
 *
 * Optional packages are still named in source — the exact npm spec below is
 * the only thing an enable can download — but the bytes arrive only after the
 * operator explicitly confirms the download in Settings. A repository or an
 * agent still cannot add one: the list is code, the install path is one fixed
 * Settings action, and the spec is exact-pinned.
 *
 * A package supplies extensions (tools an agent can call) and skills
 * (instructions only). Both reach a session through pi's additional-path
 * options, which are honoured while every discovery flag stays off — so what
 * loads is exactly these lists, and never a `.pi/` directory belonging to
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

/**
 * One optional package: named and pinned in source, downloaded only after the
 * operator confirms in Settings, installed under Foundry's own support
 * directory rather than `~/.pi`.
 */
export interface OptionalPackage extends BundledPackage {
  /** The exact npm spec an enable downloads; never a range, never an input. */
  readonly npmSpec: string;
  /** The npm package name, which is its path under `node_modules/`. */
  readonly npmName: string;
}

/**
 * Every package an operator may opt into. Enabling one is a confirmed
 * download in Settings, not a source change — but the spec itself is source,
 * so what can arrive is exactly this list.
 */
export const OPTIONAL_PACKAGES: readonly OptionalPackage[] = [
  {
    name: 'tavily',
    npmSpec: '@tavily/pi-extension@0.1.2',
    npmName: '@tavily/pi-extension',
    // web_search and web_fetch only read the network; a reviewer that can
    // search cannot dirty the worktree, so the post-call git diff stays valid.
    extensionsForReadOnly: true,
  },
];

/** Where operator-enabled packages install: under support, never `~/.pi`. */
export function optionalPackagesRoot(supportDir: string): string {
  return join(supportDir, 'pi-packages');
}

/** The npm-install prefix an enable writes into (holds `node_modules/`). */
export function optionalPackageInstallDir(supportDir: string, pkg: OptionalPackage): string {
  return join(optionalPackagesRoot(supportDir), pkg.name);
}

/** The package directory pi resolves, once the install exists. */
export function optionalPackageDir(supportDir: string, pkg: OptionalPackage): string {
  return join(
    optionalPackageInstallDir(supportDir, pkg),
    'node_modules',
    ...pkg.npmName.split('/'),
  );
}

/**
 * The optional packages whose installs exist right now. Presence on disk is
 * the enable switch: a removed directory is a disabled package, and a session
 * opened after either action sees the change without any second flag.
 */
export function installedOptionalPackages(
  supportDir: string,
): { pkg: BundledPackage; dir: string }[] {
  return OPTIONAL_PACKAGES.flatMap((pkg) => {
    const dir = optionalPackageDir(supportDir, pkg);
    return existsSync(dir) ? [{ pkg, dir }] : [];
  });
}

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
  /** Operator-enabled installs; defaults to what exists under support. */
  optional?: readonly { pkg: BundledPackage; dir: string }[];
  root?: string;
  onWarning?: (message: string) => void;
}): Promise<PackageResources> {
  const declared = opts.packages ?? BUNDLED_PACKAGES;
  const optional = opts.optional ?? installedOptionalPackages(opts.supportDir);
  if (declared.length === 0 && optional.length === 0) return NO_PACKAGE_RESOURCES;

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
  // Optional packages are already presence-checked: an absent install is a
  // disabled package, not a fault worth warning about.
  present.push(...optional);
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
