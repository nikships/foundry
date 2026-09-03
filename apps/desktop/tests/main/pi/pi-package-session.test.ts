/**
 * How package resources reach a session.
 *
 * This rests on one property of the pinned runtime: the `no*` discovery flags
 * drop what pi *found*, never what Foundry *named*. If that stopped holding,
 * either a repository's `.pi/` would start loading or a shipped package would
 * silently stop, and neither failure announces itself — a run would just
 * behave differently. So this suite drives the real `DefaultResourceLoader`
 * against fixtures rather than asserting on the options passed to it.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { tempDir } from '../../helpers/tmp.js';
import { foundryResourceLoader, packageToolNames } from '../../../src/main/pi/open-session.js';

const created: string[] = [];
let workspace: string;
let agentDir: string;

/** A checkout that would load its own extension if discovery were ever on. */
function seedProjectPi(root: string): string {
  const dir = join(root, '.pi', 'extensions');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'repo-owned.js');
  writeFileSync(
    path,
    "export default function extension(pi) {\n  pi.registerTool({ name: 'repo_tool' });\n}\n",
  );
  writeFileSync(
    join(root, '.pi', 'settings.json'),
    `${JSON.stringify({ packages: ['npm:whatever@1.0.0'] }, null, 2)}\n`,
  );
  mkdirSync(join(root, '.pi', 'skills', 'repo'), { recursive: true });
  writeFileSync(
    join(root, '.pi', 'skills', 'repo', 'SKILL.md'),
    '---\nname: repo\ndescription: Repository skill.\n---\n\nRepo instructions.\n',
  );
  writeFileSync(join(root, 'AGENTS.md'), 'Context file that must not be read.\n');
  return path;
}

function seedPackageResources(root: string): { extension: string; skill: string } {
  const extensions = join(root, 'pkg', 'extensions');
  mkdirSync(extensions, { recursive: true });
  const extension = join(extensions, 'tools.js');
  writeFileSync(
    extension,
    "export default function extension(pi) {\n  pi.registerTool({ name: 'package_tool' });\n}\n",
  );
  const skill = join(root, 'pkg', 'skills', 'demo');
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, 'SKILL.md'),
    '---\nname: demo\ndescription: A package skill.\n---\n\nPackage instructions.\n',
  );
  return { extension, skill };
}

function loaderFor(packageResources?: { extensionPaths: string[]; skillPaths: string[] }) {
  return foundryResourceLoader({
    cwd: workspace,
    agentDir,
    settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
    harness: 'You are a Foundry agent.',
    extensionFactory: () => ({ name: 'foundry' }) as never,
    ...(packageResources ? { packageResources } : {}),
  });
}

beforeEach(() => {
  workspace = tempDir('foundry-package-session-');
  agentDir = tempDir('foundry-package-agentdir-');
  created.push(workspace, agentDir);
});

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('a session with no packages', () => {
  it('loads nothing the checkout offers, even with a .pi directory present', async () => {
    seedProjectPi(workspace);
    const loader = loaderFor();
    await loader.reload();

    const extensions = loader
      .getExtensions()
      .extensions.filter((entry) => !entry.path.startsWith('<inline:'));
    expect(extensions).toEqual([]);
    expect(loader.getSkills().skills).toEqual([]);
    expect(packageToolNames(loader)).toEqual([]);
  });
});

describe('a session with package resources', () => {
  it('loads exactly the named paths while the checkout stays ignored', async () => {
    const repoOwned = seedProjectPi(workspace);
    const pkg = seedPackageResources(workspace);

    const loader = loaderFor({ extensionPaths: [pkg.extension], skillPaths: [pkg.skill] });
    await loader.reload();

    const paths = loader
      .getExtensions()
      .extensions.map((entry) => entry.path)
      .filter((path) => !path.startsWith('<inline:'));
    expect(paths).toEqual([pkg.extension]);
    expect(paths).not.toContain(repoOwned);

    const skills = loader.getSkills().skills.map((skill) => skill.name);
    expect(skills).toEqual(['demo']);
  });

  it('reports the package’s tool names for the allowlist, skipping Foundry’s own', async () => {
    const pkg = seedPackageResources(workspace);
    const loader = loaderFor({ extensionPaths: [pkg.extension], skillPaths: [] });
    await loader.reload();

    // Read before `createAgentSession`, because that array is the registry
    // allowlist: a package tool missing from it would load and not exist.
    expect(packageToolNames(loader)).toEqual(['package_tool']);
  });

  it('takes skills alone, which is what a read-only agent gets', async () => {
    const pkg = seedPackageResources(workspace);
    const loader = loaderFor({ extensionPaths: [], skillPaths: [pkg.skill] });
    await loader.reload();

    expect(packageToolNames(loader)).toEqual([]);
    expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(['demo']);
  });

  it('admits the tools of an extension it was given, so a cleared package is not inert', async () => {
    // Which extensions a profile may load is decided once, when its package
    // resources are resolved. A second switch at open could only disagree, and
    // disagreeing here would load a read-only-cleared package's code and then
    // withhold every tool it registered — present in the session, callable by
    // nobody, with nothing to show why.
    const pkg = seedPackageResources(workspace);
    const loader = loaderFor({ extensionPaths: [pkg.extension], skillPaths: [pkg.skill] });
    await loader.reload();

    expect(packageToolNames(loader)).toEqual(['package_tool']);
  });

  it('surfaces an extension that cannot load rather than failing the open', async () => {
    const broken = join(workspace, 'broken.js');
    writeFileSync(broken, 'this is not valid javascript {{{\n');
    const loader = loaderFor({ extensionPaths: [broken], skillPaths: [] });
    await loader.reload();

    expect(loader.getExtensions().errors.length).toBeGreaterThan(0);
    expect(packageToolNames(loader)).toEqual([]);
  });
});
