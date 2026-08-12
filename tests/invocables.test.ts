/**
 * Per-agent host-invocable isolation: inventory, defaults, migration, the
 * disabled complement, the ephemeral home overlay, and cleanup.
 *
 * Every test builds its own fake home under tmp — nothing here reads or writes a
 * real `~/.factory`, which is also the property most of these tests are about.
 */

import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  emptyInvocables,
  hiddenFromHost,
  hiddenSkillToolIds,
  needsHomeOverlay,
  needsSkillComplement,
  normalizeInvocables,
  readHostInvocables,
  selectsNothing,
} from '../src/main/droid/invocables.js';
import { createFactoryHomeOverlay } from '../src/main/droid/factory-home.js';
import type { AgentInvocables, HostInvocableInventory } from '../src/shared/types.js';

const made: string[] = [];

afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A fake home with a populated `.factory`, plus the bits a spawn needs to work. */
async function fakeHome(
  opts: {
    skills?: Record<string, string>;
    droids?: Record<string, string>;
    mcp?: string;
  } = {},
): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'foundry-fakehome-'));
  made.push(home);
  const factory = join(home, '.factory');
  await mkdir(factory, { recursive: true });

  // The things an isolated session must keep: auth, settings, session history.
  await writeFile(join(factory, 'auth.v2.file'), 'encrypted-jwt', 'utf8');
  await writeFile(join(factory, 'settings.json'), '{"customModels":[]}', 'utf8');
  await mkdir(join(factory, 'sessions'), { recursive: true });
  await writeFile(join(factory, 'sessions', 'keep.jsonl'), '{}\n', 'utf8');
  // …and something outside `.factory` that an agent's own `git` needs.
  await writeFile(join(home, '.gitconfig'), '[user]\n\tname = Test\n', 'utf8');

  if (opts.skills) {
    for (const [id, body] of Object.entries(opts.skills)) {
      await mkdir(join(factory, 'skills', id), { recursive: true });
      await writeFile(join(factory, 'skills', id, 'SKILL.md'), body, 'utf8');
    }
  }
  if (opts.droids) {
    await mkdir(join(factory, 'droids'), { recursive: true });
    for (const [id, body] of Object.entries(opts.droids)) {
      await writeFile(join(factory, 'droids', `${id}.md`), body, 'utf8');
    }
  }
  if (opts.mcp !== undefined) await writeFile(join(factory, 'mcp.json'), opts.mcp, 'utf8');
  return home;
}

const populated = {
  skills: {
    'pdf-forms': '---\nname: pdf-forms\ndescription: Fill PDF forms.\n---\n# PDF\n',
    scraper: '# Scraper\nPulls pages down.\n',
  },
  droids: { reviewer: '---\nname: reviewer\ndescription: Reviews diffs.\n---\n' },
  mcp: JSON.stringify({
    mcpServers: {
      linear: { type: 'http', url: 'https://mcp.linear.app/sse' },
      local: { command: 'node', args: ['server.js'] },
      retired: { command: 'node', disabled: true },
    },
  }),
};

function selection(partial: Partial<AgentInvocables> = {}): AgentInvocables {
  return { ...emptyInvocables(), ...partial };
}

describe('host inventory', () => {
  it('reads skills, droids, and MCP servers off the host', async () => {
    const home = await fakeHome(populated);
    const inventory = await readHostInvocables({ homeDir: home });

    expect(inventory.skills.map((s) => s.id)).toEqual(['pdf-forms', 'scraper']);
    // Front matter wins; a skill without it still gets a usable label.
    expect(inventory.skills[0]).toMatchObject({
      name: 'pdf-forms',
      description: 'Fill PDF forms.',
    });
    expect(inventory.skills[1]).toMatchObject({ name: 'scraper', description: 'Scraper' });
    expect(inventory.droids.map((d) => d.id)).toEqual(['reviewer']);
    expect(inventory.mcpServers.map((s) => [s.id, s.transport, s.disabled])).toEqual([
      ['linear', 'http', false],
      ['local', 'stdio', false],
      ['retired', 'stdio', true],
    ]);
    expect(inventory.warnings).toEqual([]);
  });

  it('answers empty for a host with no .factory at all', async () => {
    const home = await mkdtemp(join(tmpdir(), 'foundry-bare-'));
    made.push(home);
    const inventory = await readHostInvocables({ homeDir: home });
    expect(inventory.skills).toEqual([]);
    expect(inventory.droids).toEqual([]);
    expect(inventory.mcpServers).toEqual([]);
    expect(inventory.warnings).toEqual([]);
  });

  it('reports a hand-edited mcp.json as a warning instead of throwing', async () => {
    const home = await fakeHome({ mcp: '{ this is not json' });
    const inventory = await readHostInvocables({ homeDir: home });
    expect(inventory.mcpServers).toEqual([]);
    expect(inventory.warnings.join(' ')).toMatch(/mcp\.json could not be parsed/);
  });

  it('skips a skill directory with no SKILL.md', async () => {
    const home = await fakeHome(populated);
    await mkdir(join(home, '.factory', 'skills', 'not-a-skill'), { recursive: true });
    const inventory = await readHostInvocables({ homeDir: home });
    expect(inventory.skills.map((s) => s.id)).not.toContain('not-a-skill');
  });
});

describe('selection defaults and migration', () => {
  it('defaults to nothing enabled', () => {
    expect(selectsNothing(emptyInvocables())).toBe(true);
  });

  it('reads a roster written before the field existed as nothing enabled', () => {
    expect(normalizeInvocables(undefined)).toEqual(emptyInvocables());
    expect(selectsNothing(normalizeInvocables(undefined))).toBe(true);
  });

  it('never turns garbage into a grant', () => {
    for (const garbage of [null, 'all', 42, [], { skills: 'pdf-forms' }, { skills: [7, null] }]) {
      expect(selectsNothing(normalizeInvocables(garbage))).toBe(true);
    }
  });

  it('keeps real ids, trims them, and drops duplicates', () => {
    expect(
      normalizeInvocables({
        skills: ['pdf-forms', ' pdf-forms ', 'scraper', ''],
        droids: ['reviewer'],
        hostMcpServers: ['linear'],
        userMcpServers: ['user-1'],
      }),
    ).toEqual({
      skills: ['pdf-forms', 'scraper'],
      droids: ['reviewer'],
      hostMcpServers: ['linear'],
      userMcpServers: ['user-1'],
    });
  });
});

describe('what a selection hides', () => {
  let inventory: HostInvocableInventory | null = null;

  async function load(): Promise<HostInvocableInventory> {
    inventory ??= await readHostInvocables({ homeDir: await fakeHome(populated) });
    return inventory;
  }

  it('hides everything the agent did not name', async () => {
    const hidden = hiddenFromHost(await load(), emptyInvocables());
    expect(hidden.skills.map((s) => s.id)).toEqual(['pdf-forms', 'scraper']);
    expect(hidden.droids.map((d) => d.id)).toEqual(['reviewer']);
    // `retired` is disabled in the host file, so it is not something to hide.
    expect(hidden.mcpServers.map((s) => s.id)).toEqual(['linear', 'local']);
  });

  it('hides nothing once the agent selected everything reachable', async () => {
    const all = selection({
      skills: ['pdf-forms', 'scraper'],
      droids: ['reviewer'],
      hostMcpServers: ['linear', 'local'],
    });
    const hidden = hiddenFromHost(await load(), all);
    expect([hidden.skills, hidden.droids, hidden.mcpServers]).toEqual([[], [], []]);
    expect(needsHomeOverlay(await load(), all)).toBe(false);
    expect(needsSkillComplement(await load(), all)).toBe(false);
  });

  it('needs an overlay for a withheld droid or MCP server, but not for a skill alone', async () => {
    const loaded = await load();
    // Skills are withheld by the settings complement, not by the overlay.
    const skillsOnly = selection({ droids: ['reviewer'], hostMcpServers: ['linear', 'local'] });
    expect(needsHomeOverlay(loaded, skillsOnly)).toBe(false);
    expect(needsSkillComplement(loaded, skillsOnly)).toBe(true);

    expect(needsHomeOverlay(loaded, emptyInvocables())).toBe(true);
  });

  it('tolerates a selection naming something no longer installed', async () => {
    const stale = selection({ skills: ['uninstalled'], droids: ['gone'] });
    const hidden = hiddenFromHost(await load(), stale);
    expect(hidden.droids.map((d) => d.id)).toEqual(['reviewer']);
  });
});

describe('skill complement', () => {
  const hidden = [{ id: 'pdf-forms', name: 'pdf-forms' }];

  it('names the tool ids of hidden skills only', () => {
    const ids = hiddenSkillToolIds(
      [
        { id: 'Skill__pdf_forms', displayName: 'pdf-forms', category: 'skill' },
        { id: 'Skill__scraper', displayName: 'scraper', category: 'skill' },
        { id: 'Edit', displayName: 'Edit', category: 'file' },
        { id: 'foundry___report_progress', displayName: 'report_progress', category: 'mcp' },
      ],
      hidden,
    );
    expect(ids).toEqual(['Skill__pdf_forms']);
  });

  it('recognises a skill tool by id when the category does not say so', () => {
    const ids = hiddenSkillToolIds([{ id: 'skill:pdf-forms', displayName: '' }], hidden);
    expect(ids).toEqual(['skill:pdf-forms']);
  });

  it('subtracts nothing when the agent hid nothing', () => {
    expect(hiddenSkillToolIds([{ id: 'Skill__pdf_forms', category: 'skill' }], [])).toEqual([]);
  });

  it('never claims an ordinary tool that merely mentions a skill name', () => {
    const ids = hiddenSkillToolIds(
      [{ id: 'Bash', displayName: 'Run pdf-forms in a shell', category: 'command' }],
      hidden,
    );
    expect(ids).toEqual([]);
  });
});

describe('ephemeral home overlay', () => {
  it('builds nothing when there is nothing to withhold', async () => {
    const home = await fakeHome(populated);
    const inventory = await readHostInvocables({ homeDir: home });
    const overlay = await createFactoryHomeOverlay({
      inventory,
      selection: selection({ droids: ['reviewer'], hostMcpServers: ['linear', 'local'] }),
      homeDir: home,
      tmpRoot: tmpdir(),
    });
    expect(overlay).toBeNull();
  });

  it('exposes only the selected droid and MCP server, and keeps auth reachable', async () => {
    const home = await fakeHome(populated);
    const inventory = await readHostInvocables({ homeDir: home });
    const overlay = await createFactoryHomeOverlay({
      inventory,
      selection: selection({ hostMcpServers: ['linear'] }),
      homeDir: home,
      tmpRoot: tmpdir(),
    });
    expect(overlay).not.toBeNull();
    if (!overlay) return;
    made.push(overlay.dir);

    // The child resolves ~/.factory inside the overlay.
    expect(overlay.env.HOME).toBe(overlay.dir);
    expect(overlay.hidden).toEqual({ droids: ['reviewer'], mcpServers: ['local'] });

    const factory = join(overlay.dir, '.factory');
    const mcp = JSON.parse(await readFile(join(factory, 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(mcp.mcpServers)).toEqual(['linear']);
    // The kept entry is copied verbatim rather than re-serialised from a model.
    expect(mcp.mcpServers.linear).toEqual({ type: 'http', url: 'https://mcp.linear.app/sse' });

    // No selected droids: the overlay's droids dir exists and is empty, so the
    // CLI finds a directory with nothing in it rather than the host's.
    expect(await readdir(join(factory, 'droids'))).toEqual([]);

    // Auth, settings and session history still resolve — through symlinks, so a
    // resume after cleanup still finds its history in the real location.
    expect(await readFile(join(factory, 'auth.v2.file'), 'utf8')).toBe('encrypted-jwt');
    expect(await readFile(join(factory, 'sessions', 'keep.jsonl'), 'utf8')).toBe('{}\n');
    expect((await lstat(join(factory, 'sessions'))).isSymbolicLink()).toBe(true);
    // And so does everything outside .factory that an agent's own tools need.
    expect(await readFile(join(overlay.dir, '.gitconfig'), 'utf8')).toContain('name = Test');
  });

  it('grants a selected droid', async () => {
    const home = await fakeHome(populated);
    const inventory = await readHostInvocables({ homeDir: home });
    const overlay = await createFactoryHomeOverlay({
      inventory,
      selection: selection({ droids: ['reviewer'] }),
      homeDir: home,
      tmpRoot: tmpdir(),
    });
    if (!overlay) throw new Error('expected an overlay');
    made.push(overlay.dir);
    expect(await readdir(join(overlay.dir, '.factory', 'droids'))).toEqual(['reviewer.md']);
    expect(
      await readFile(join(overlay.dir, '.factory', 'droids', 'reviewer.md'), 'utf8'),
    ).toContain('Reviews diffs.');
  });

  it('writes an explicit empty server map when the host file is unreadable', async () => {
    const home = await fakeHome({ droids: populated.droids, mcp: '{ broken' });
    const inventory = await readHostInvocables({ homeDir: home });
    const overlay = await createFactoryHomeOverlay({
      inventory,
      selection: emptyInvocables(),
      homeDir: home,
      tmpRoot: tmpdir(),
    });
    if (!overlay) throw new Error('expected an overlay');
    made.push(overlay.dir);
    const mcp = JSON.parse(
      await readFile(join(overlay.dir, '.factory', 'mcp.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(mcp.mcpServers).toEqual({});
  });

  it('leaves the host install byte-identical, and cleanup takes only the overlay', async () => {
    const home = await fakeHome(populated);
    const factory = join(home, '.factory');
    const before = {
      mcp: await readFile(join(factory, 'mcp.json'), 'utf8'),
      droids: await readdir(join(factory, 'droids')),
      skills: await readdir(join(factory, 'skills')),
      auth: await readFile(join(factory, 'auth.v2.file'), 'utf8'),
    };

    const inventory = await readHostInvocables({ homeDir: home });
    const overlay = await createFactoryHomeOverlay({
      inventory,
      selection: emptyInvocables(),
      homeDir: home,
      tmpRoot: tmpdir(),
    });
    if (!overlay) throw new Error('expected an overlay');
    await overlay.cleanup();

    expect(await readFile(join(factory, 'mcp.json'), 'utf8')).toBe(before.mcp);
    expect(await readdir(join(factory, 'droids'))).toEqual(before.droids);
    expect(await readdir(join(factory, 'skills'))).toEqual(before.skills);
    expect(await readFile(join(factory, 'auth.v2.file'), 'utf8')).toBe(before.auth);
    await expect(readdir(overlay.dir)).rejects.toThrow();
    // Cleanup is idempotent: close() and kill() can both reach it.
    await expect(overlay.cleanup()).resolves.toBeUndefined();
  });

  it('builds its overlay under the identifiable prefix that guards cleanup', async () => {
    const home = await fakeHome(populated);
    const inventory = await readHostInvocables({ homeDir: home });
    const overlay = await createFactoryHomeOverlay({
      inventory,
      selection: emptyInvocables(),
      homeDir: home,
      tmpRoot: tmpdir(),
    });
    if (!overlay) throw new Error('expected an overlay');
    made.push(overlay.dir);
    // Cleanup refuses any path without this marker, so a directory that is not
    // an overlay can never be removed by it.
    expect(overlay.dir).toContain('foundry-home-');
  });

  it('does not follow symlinks out of the overlay when cleaning up', async () => {
    const home = await fakeHome(populated);
    const inventory = await readHostInvocables({ homeDir: home });
    const overlay = await createFactoryHomeOverlay({
      inventory,
      selection: emptyInvocables(),
      homeDir: home,
      tmpRoot: tmpdir(),
    });
    if (!overlay) throw new Error('expected an overlay');
    // An extra link straight at the host's skills, to prove rm removes links.
    await symlink(join(home, '.factory', 'skills'), join(overlay.dir, 'extra-link'));
    await overlay.cleanup();
    expect(await readdir(join(home, '.factory', 'skills'))).toEqual(['pdf-forms', 'scraper']);
  });
});
