/**
 * Resolving the packages a build ships.
 *
 * These run pi's real resolver against fixture packages laid out the way a
 * vendored one would be, because the interesting behaviour belongs to pi:
 * which paths a manifest yields, and which package a resolved path is
 * attributed to. A stubbed resolver would assert only that this file calls it.
 *
 * The user's own agent install is off limits, so the suite also proves nothing
 * appeared in `~/.pi`.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../helpers/tmp.js';
import {
  BUNDLED_PACKAGES,
  NO_PACKAGE_RESOURCES,
  packagesRoot,
  resolveBundledPackages,
} from '../../../src/main/pi/packages.js';

let support: string;
let root: string;
const created: string[] = [];

/** What the user's own agent install looks like, so a stray write is visible. */
function homeStateSnapshot(): string[] {
  const dir = join(homedir(), '.pi');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).map(String).sort();
}

/** A package in pi's conventional layout: one extension, one skill. */
function writePackage(name: string, toolName = `${name}_tool`): string {
  const dir = join(root, name);
  mkdirSync(join(dir, 'extensions'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name, version: '1.0.0', keywords: ['pi-package'] }, null, 2)}\n`,
  );
  writeFileSync(
    join(dir, 'extensions', 'tools.js'),
    `export default function extension(pi) {\n  pi.registerTool({ name: '${toolName}' });\n}\n`,
  );
  mkdirSync(join(dir, 'skills', name), { recursive: true });
  writeFileSync(
    join(dir, 'skills', name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: A fixture skill.\n---\n\nDo the fixture thing.\n`,
  );
  return dir;
}

beforeEach(() => {
  support = tempDir('foundry-bundled-support-');
  root = tempDir('foundry-bundled-root-');
  created.push(support, root);
});

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('what this build ships', () => {
  it('declares packages in source, with names that map to directories', () => {
    for (const pkg of BUNDLED_PACKAGES) {
      expect(pkg.name).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
      // A name with a separator would escape the packages root.
      expect(pkg.name).not.toContain('/');
      expect(pkg.name).not.toContain('..');
    }
    expect(new Set(BUNDLED_PACKAGES.map((pkg) => pkg.name)).size).toBe(BUNDLED_PACKAGES.length);
  });

  it('resolves nothing when the list is empty, without touching the runtime', async () => {
    expect(await resolveBundledPackages({ supportDir: support, packages: [] })).toBe(
      NO_PACKAGE_RESOURCES,
    );
  });

  it('looks beside the app when packaged and in the checkout otherwise', () => {
    expect(packagesRoot('/repo')).toBe('/repo/resources/pi-packages');
  });
});

describe('resolving a shipped package', () => {
  it('returns its extension and skill paths and leaves ~/.pi alone', async () => {
    const before = homeStateSnapshot();
    const dir = writePackage('alpha');

    const resolved = await resolveBundledPackages({
      supportDir: support,
      root,
      packages: [{ name: 'alpha' }],
    });

    expect(resolved.extensionPaths).toEqual([join(dir, 'extensions', 'tools.js')]);
    // Pi resolves a skill to its SKILL.md, not the folder holding it.
    expect(resolved.skillPaths).toEqual([join(dir, 'skills', 'alpha', 'SKILL.md')]);
    expect(homeStateSnapshot()).toEqual(before);
  });

  it('attributes each path to the package that owns it', async () => {
    const alpha = writePackage('alpha');
    writePackage('beta');

    const resolved = await resolveBundledPackages({
      supportDir: support,
      root,
      packages: [{ name: 'alpha' }, { name: 'beta' }],
    });

    expect(resolved.extensionPaths).toHaveLength(2);
    expect(resolved.skillPaths).toHaveLength(2);
    expect(resolved.extensionPaths).toContain(join(alpha, 'extensions', 'tools.js'));
  });

  it('warns and carries on when a declared package did not ship', async () => {
    writePackage('alpha');
    const warnings: string[] = [];

    const resolved = await resolveBundledPackages({
      supportDir: support,
      root,
      packages: [{ name: 'alpha' }, { name: 'absent' }],
      onWarning: (message) => warnings.push(message),
    });

    // A packaging fault must not stop a run from starting.
    expect(resolved.extensionPaths).toHaveLength(1);
    expect(warnings.join(' ')).toContain('absent');
  });

  it('resolves nothing when no declared package shipped at all', async () => {
    const warnings: string[] = [];
    const resolved = await resolveBundledPackages({
      supportDir: support,
      root,
      packages: [{ name: 'absent' }],
      onWarning: (message) => warnings.push(message),
    });
    expect(resolved).toBe(NO_PACKAGE_RESOURCES);
    expect(warnings).toHaveLength(1);
  });
});

describe('a read-only agent', () => {
  it('takes the skills and none of the extension tools', async () => {
    writePackage('alpha');

    const resolved = await resolveBundledPackages({
      supportDir: support,
      root,
      skillsOnly: true,
      packages: [{ name: 'alpha' }],
    });

    // The engine checks a reviewer wrote nothing by diffing git afterwards;
    // handing it a package's tool is what would break that check.
    expect(resolved.extensionPaths).toEqual([]);
    expect(resolved.skillPaths).toHaveLength(1);
  });

  it('keeps the extensions of a package marked safe for it', async () => {
    writePackage('alpha');

    const resolved = await resolveBundledPackages({
      supportDir: support,
      root,
      skillsOnly: true,
      packages: [{ name: 'alpha', extensionsForReadOnly: true }],
    });

    expect(resolved.extensionPaths).toHaveLength(1);
  });

  it('splits a mixed list by each package’s own marking', async () => {
    writePackage('alpha');
    const beta = writePackage('beta');

    const resolved = await resolveBundledPackages({
      supportDir: support,
      root,
      skillsOnly: true,
      packages: [{ name: 'alpha' }, { name: 'beta', extensionsForReadOnly: true }],
    });

    expect(resolved.extensionPaths).toEqual([join(beta, 'extensions', 'tools.js')]);
    // Skills are unaffected by the split: they only instruct.
    expect(resolved.skillPaths).toHaveLength(2);
  });
});
