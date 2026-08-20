/**
 * What a packaged launch needs from the agent runtime.
 *
 * Two things break only after signing, which is the worst place to find them:
 * a native binding loaded from inside `app.asar` (a path, not a file, so
 * `dlopen` fails), and a runtime that reaches the network on import (a launch
 * that hangs before a window appears). Neither shows up in a dev run, so both
 * are asserted here against the real package rather than a mock.
 *
 * `PI_OFFLINE=1` is the runtime's own switch for the second: it is read in
 * `ModelRuntime`'s constructor, so setting it is what keeps a first launch on a
 * captive network from waiting on a catalog fetch.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '../../../../..');

/**
 * Import the runtime in a fresh child, with every native binding made
 * unresolvable, and report what survived. A child is the only honest way to
 * ask: this suite has already imported half the app by the time a test runs.
 *
 * Blocking `process.dlopen` is how an asar is simulated. A path inside the
 * archive is not a file, so `dlopen` fails there exactly the way it fails here,
 * and a runtime that only loads a binding behind a try/catch comes through both
 * the same way.
 */
function importUnderAsarConditions(): { ok: boolean; hasModelRuntime: boolean; error?: string } {
  const script = `
    process.dlopen = () => { throw new Error('asar: not a real file'); };
    let result = { ok: false, hasModelRuntime: false };
    try {
      const mod = await import('@earendil-works/pi-coding-agent');
      result = { ok: true, hasModelRuntime: typeof mod.ModelRuntime === 'function' };
    } catch (err) {
      result = { ok: false, hasModelRuntime: false, error: String(err) };
    }
    console.log(JSON.stringify(result));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: repoRoot,
    env: { ...process.env, PI_OFFLINE: '1' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as {
    ok: boolean;
    hasModelRuntime: boolean;
    error?: string;
  };
}

describe('the agent runtime under a packaged launch', () => {
  it('imports offline even when no native binding can be opened', () => {
    // Pi reaches for an optional clipboard binding at import. It is guarded, so
    // an unopenable one leaves clipboard support null rather than failing the
    // import — which is what makes the package safe inside the asar without an
    // unpack entry. A future unguarded binding fails here, not in a DMG.
    const result = importUnderAsarConditions();
    expect(result.error ?? '').toBe('');
    expect(result.ok).toBe(true);
    expect(result.hasModelRuntime).toBe(true);
  });

  it('unpacks the one native dependency the app does load', () => {
    // better-sqlite3 is loaded by the Tracer on every launch, and a native
    // binding cannot be opened from inside an asar archive.
    const builder = readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8');
    expect(builder).toContain("'**/node_modules/better-sqlite3/**'");
  });

  it('keeps the runtime package out of the bundle rather than inlining it', () => {
    // electron-vite's externalizeDepsPlugin leaves every `dependencies` entry
    // as a runtime require, which is what lets electron-builder ship pi as real
    // files. Bundling it would inline a package that reads its own files by
    // path relative to itself.
    const config = readFileSync(join(repoRoot, 'electron.vite.config.ts'), 'utf8');
    expect(config).toContain('externalizeDepsPlugin()');
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies['@earendil-works/pi-coding-agent']).toBeTruthy();
  });

  it('depends on no agent runtime but pi', () => {
    // A second runtime reintroduced as a dependency fails here rather than
    // in review.
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const all = [...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)];
    expect(all.filter((name) => name.startsWith('@factory/'))).toEqual([]);
  });
});
