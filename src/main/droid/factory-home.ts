/**
 * An ephemeral `$HOME` that contains only the invocables one agent selected.
 *
 * Skills can be taken away after the session exists (`disabledToolIds`), but
 * custom Droids and MCP servers are read off disk while the CLI starts: by the
 * time Foundry could ask for them to be dropped, their tools are attached and
 * their tokens are already on the context bill. The only supported way to
 * withhold one is to have the CLI start somewhere that does not contain it.
 *
 * So the overlay is a directory of symlinks:
 *
 *     <tmp>/foundry-home-<id>/            → every entry of the real home, linked
 *     <tmp>/foundry-home-<id>/.factory/   → every entry of the real .factory,
 *                                            linked, EXCEPT:
 *                                              droids/   → only selected, linked
 *                                              mcp.json  → rewritten subset
 *
 * Linking the rest of the home matters as much as filtering the two: an agent
 * runs `git` and `gh`, so a child with a synthetic empty home would lose
 * `.gitconfig`, `.ssh` and every credential helper and fail in ways that look
 * nothing like a policy decision. Linking `.factory`'s other entries matters
 * for the same reason — `auth.v2.*` keeps the session signed in, `settings.json`
 * keeps custom models, and `sessions/` resolves through the link to the real
 * directory so `--resume` still finds its history after the overlay is gone.
 *
 * Nothing here writes through a link. The only file this module creates is the
 * overlay's own `mcp.json`, inside the temp directory. The host install is read
 * and never modified — which is the whole acceptance criterion, so it is worth
 * saying twice.
 *
 * `HOME` is the load-bearing mechanism: droid is a Node CLI and Node's
 * `os.homedir()` returns `$HOME` on POSIX, so a child spawned with `HOME` set to
 * the overlay resolves `~/.factory` inside it.
 */

import { mkdtemp, readdir, readFile, rm, symlink, mkdir, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentInvocables, HostInvocableInventory } from '@shared/types.js';

/** Prefix for every overlay, so a leftover directory is identifiable and safe to sweep. */
const PREFIX = 'foundry-home-';

export interface FactoryHomeOverlay {
  /** The directory to use as `$HOME` for children of this session. */
  dir: string;
  /** Env overrides to merge into the spawn env. */
  env: Record<string, string>;
  /** What the overlay withheld, for the trace row. */
  hidden: { droids: string[]; mcpServers: string[] };
  /** Removes the overlay. Safe to call more than once; never throws. */
  cleanup(): Promise<void>;
}

export interface CreateOverlayOptions {
  inventory: HostInvocableInventory;
  selection: AgentInvocables;
  /** Real home to mirror. Injected by tests so nothing reads a developer's home. */
  homeDir?: string;
  /** Where the overlay directory is created. Defaults to the OS temp dir. */
  tmpRoot?: string;
}

/**
 * Build the overlay. Returns null when the host has nothing this agent needs
 * withheld, so the caller spawns exactly as it does on main.
 */
export async function createFactoryHomeOverlay(
  opts: CreateOverlayOptions,
): Promise<FactoryHomeOverlay | null> {
  const home = opts.homeDir ?? homedir();
  const hostFactory = join(home, '.factory');
  const keepDroids = new Set(opts.selection.droids);
  const keepMcp = new Set(opts.selection.hostMcpServers);

  const hiddenDroids = opts.inventory.droids.filter((d) => !keepDroids.has(d.id)).map((d) => d.id);
  const hiddenMcp = opts.inventory.mcpServers
    .filter((s) => !s.disabled && !keepMcp.has(s.id))
    .map((s) => s.id);
  if (!hiddenDroids.length && !hiddenMcp.length) return null;

  const dir = await mkdtemp(join(opts.tmpRoot ?? tmpdir(), PREFIX));
  const overlay: FactoryHomeOverlay = {
    dir,
    env: { HOME: dir },
    hidden: { droids: hiddenDroids, mcpServers: hiddenMcp },
    cleanup: () => cleanup(dir),
  };

  try {
    // The real home, minus .factory — which is rebuilt one level down so the
    // two filtered entries can be replaced without shadowing anything else.
    await linkAll(home, dir, (name) => name !== '.factory');

    const overlayFactory = join(dir, '.factory');
    await mkdir(overlayFactory, { recursive: true });
    await linkAll(hostFactory, overlayFactory, (name) => name !== 'droids' && name !== 'mcp.json');

    if (opts.inventory.droids.length) {
      const overlayDroids = join(overlayFactory, 'droids');
      await mkdir(overlayDroids, { recursive: true });
      for (const droid of opts.inventory.droids) {
        if (!keepDroids.has(droid.id)) continue;
        await symlink(droid.location, join(overlayDroids, `${droid.id}.md`)).catch(() => undefined);
      }
    }

    await writeMcpSubset(hostFactory, overlayFactory, keepMcp);
    return overlay;
  } catch (e) {
    // A half-built overlay must never be handed to a spawn: a missing link
    // would read as "not installed" for something the agent was granted.
    await overlay.cleanup();
    throw e;
  }
}

/**
 * Symlink each entry of `from` into `to`. Individual failures are skipped: a
 * dangling entry or a socket in the home directory is not a reason to refuse to
 * run, and the entries that matter (`.gitconfig`, `.ssh`, `auth.v2.*`) are
 * ordinary files.
 */
async function linkAll(from: string, to: string, keep: (name: string) => boolean): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(from);
  } catch {
    // No real home or no host .factory: an empty overlay is still correct, and
    // is in fact maximum isolation.
    return;
  }
  for (const name of entries) {
    if (!keep(name)) continue;
    await symlink(join(from, name), join(to, name)).catch(() => undefined);
  }
}

/**
 * Write the overlay's `mcp.json` with only the selected servers, preserving each
 * kept entry's configuration verbatim — Foundry does not know what a given
 * server needs, so it copies rather than re-serialising from its own model.
 *
 * When nothing is selected, the file is written as an explicit empty map rather
 * than left absent: an absent file is indistinguishable from "not configured
 * yet", and a future CLI that treats that as "go look somewhere else" would
 * quietly undo the isolation.
 */
async function writeMcpSubset(
  hostFactory: string,
  overlayFactory: string,
  keep: Set<string>,
): Promise<void> {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(await readFile(join(hostFactory, 'mcp.json'), 'utf8'));
  } catch {
    // No readable host file: still write the empty map, for the reason above.
  }
  const root = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const servers = root.mcpServers;
  const source =
    servers && typeof servers === 'object' && !Array.isArray(servers)
      ? (servers as Record<string, unknown>)
      : {};
  const kept: Record<string, unknown> = {};
  for (const [name, config] of Object.entries(source)) {
    if (keep.has(name)) kept[name] = config;
  }
  // Everything else in the host file (unknown top-level keys) is carried over so
  // a future field is not silently dropped for an isolated session.
  const out = { ...root, mcpServers: kept };
  await writeFile(join(overlayFactory, 'mcp.json'), `${JSON.stringify(out, null, 2)}\n`, 'utf8');
}

/**
 * Remove the overlay. `rm -rf` on a tree of symlinks removes the links, not
 * their targets, so this cannot reach the host install — and the path is
 * checked against the prefix before anything is removed, so a caller that
 * passes the wrong string cannot turn this into a delete of something real.
 */
async function cleanup(dir: string): Promise<void> {
  if (!dir.includes(PREFIX)) return;
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
