/**
 * Where the Bridge's binary, config, and OAuth material live.
 *
 * Two rules the rest of this directory depends on:
 *
 * - The binary is resolved, never assumed. A packaged app finds it under
 *   `process.resourcesPath/bridge/`; a dev run finds the checkout's
 *   `resources/bridge/`. Both are *checked* — `bridgeBinaryPath()` returns null
 *   when the fetch script never ran or its checksum failed, and the manager
 *   reports that as an unavailable Bridge rather than spawning a path that does
 *   not exist.
 * - Auth material lives under Foundry's own support directory, never
 *   `~/.cli-proxy-api`. The user may run CLIProxyAPI themselves;
 *   an app that logged into their directory would silently rewrite the accounts
 *   their own tools use.
 */

import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Directory holding every Bridge-owned file for this support dir. */
export function bridgeStateDir(supportDir: string): string {
  return join(supportDir, 'bridge');
}

/** CLIProxyAPI's `auth-dir`: one JSON file per authenticated account. */
export function bridgeAuthDir(supportDir: string): string {
  return join(bridgeStateDir(supportDir), 'auth');
}

/** The merged config the child is started with. Regenerated on every start. */
export function bridgeConfigPath(supportDir: string): string {
  return join(bridgeStateDir(supportDir), 'config.yaml');
}

/**
 * Candidate locations for the vendored binary, packaged first.
 *
 * `process.resourcesPath` is undefined outside Electron (tests, scripts), which
 * is why it is read defensively rather than destructured at module scope.
 */
export function bridgeBinaryCandidates(repoRoot = process.cwd()): string[] {
  const candidates: string[] = [];
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resources) candidates.push(join(resources, 'bridge', 'cli-proxy-api'));
  candidates.push(join(repoRoot, 'resources', 'bridge', 'cli-proxy-api'));
  return candidates;
}

/**
 * The first candidate that is an executable file, or null.
 *
 * Null is a normal state, not an error: a checkout that has not run
 * `npm run fetch:bridge` has no Bridge, and a checksum failure deliberately
 * leaves nothing behind. Callers surface it as "the Bridge is unavailable".
 */
export function bridgeBinaryPath(repoRoot = process.cwd()): string | null {
  for (const candidate of bridgeBinaryCandidates(repoRoot)) {
    if (!existsSync(candidate)) continue;
    try {
      const stats = statSync(candidate);
      // The fetch script chmods 0755. A non-executable file here means someone
      // copied it by hand, and spawning it would fail with EACCES at run time.
      if (stats.isFile() && (stats.mode & 0o111) !== 0) return candidate;
    } catch {
      // Unreadable candidate: try the next one.
    }
  }
  return null;
}

/**
 * CLIProxyAPI's models.json, vendored next to the binary by `fetch:bridge`.
 *
 * Same candidate order as the binary so a packaged app and a dev checkout
 * resolve a matching pair. Null when `fetch:bridge` has not run (or failed
 * to write the catalog), which `loadBridgeCatalog` treats as empty.
 */
export function bridgeCatalogPath(repoRoot = process.cwd()): string | null {
  for (const binary of bridgeBinaryCandidates(repoRoot)) {
    const catalog = join(dirname(binary), 'models.json');
    if (existsSync(catalog)) return catalog;
  }
  return null;
}
