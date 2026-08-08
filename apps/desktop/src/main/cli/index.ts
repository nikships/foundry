/**
 * The vendor registry. Everything outside this directory names a `CliVendor` and
 * asks here for the adapter, so adding a sixth CLI is one file plus one entry.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { CliConfig, CliVendor } from '@shared/types.js';
import { spawnEnv } from '../system/env.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { droidAdapter } from './droid.js';
import { grokAdapter } from './grok.js';
import { junieAdapter } from './junie.js';
import type { CliAdapter } from './types.js';

export * from './types.js';

const ADAPTERS: Record<CliVendor, CliAdapter> = {
  droid: droidAdapter,
  claude: claudeAdapter,
  codex: codexAdapter,
  junie: junieAdapter,
  grok: grokAdapter,
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
      // `which` writes "no junie in ..." to stderr, and this now runs once per
      // vendor at first launch. Inheriting that prints five lines about CLIs the
      // user never asked for, so the answer is taken from stdout alone.
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
