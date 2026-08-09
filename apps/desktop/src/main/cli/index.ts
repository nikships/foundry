/**
 * The CLI vendor registry.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { CliConfig, CliVendor } from '@shared/types.js';
import { spawnEnv } from '../system/env.js';
import { droidAdapter } from './droid.js';
import type { CliAdapter } from './types.js';

export * from './types.js';

const ADAPTERS: Record<CliVendor, CliAdapter> = {
  droid: droidAdapter,
};

export function adapterFor(vendor: CliVendor): CliAdapter {
  // An unknown vendor in a stored roster must not take the app down, and droid
  // is the vendor every install has configured.
  return ADAPTERS[vendor] ?? ADAPTERS.droid;
}

export function allAdapters(): CliAdapter[] {
  return Object.values(ADAPTERS);
}

/**
 * PATH lookup then well-known install locations, so a fresh machine needs no
 * configuration to find a CLI it already has. Falls back to the bare name, which
 * lets the spawn fail with a message the doctor can explain rather than a path
 * this app made up.
 */
export function findCli(vendor: CliVendor): string {
  const adapter = adapterFor(vendor);
  try {
    const which = execFileSync('/usr/bin/which', [adapter.binary], {
      encoding: 'utf8',
      // stdout alone is used so warnings/errors from PATH lookups do not pollute logs.
      stdio: ['ignore', 'pipe', 'ignore'],
      // A GUI launch inherits launchd's PATH, where none of these CLIs live.
      // Without the resolved PATH every vendor falls through to its hardcoded
      // install list, and one installed anywhere else reads as missing.
      env: spawnEnv(),
    }).trim();
    if (which) return which;
  } catch {
    // Not on PATH; fall through to the known locations.
  }
  return adapter.installPaths().find((c) => existsSync(c)) ?? adapter.binary;
}

export function defaultCliConfig(vendor: CliVendor): CliConfig {
  return { path: findCli(vendor), extraArgs: [] };
}

/** Resolves the config for a vendor, filling a gap left by an older settings file. */
export function cliConfigFor(
  clis: Partial<Record<CliVendor, CliConfig>> | undefined,
  vendor: CliVendor,
): CliConfig {
  return clis?.[vendor] ?? defaultCliConfig(vendor);
}
