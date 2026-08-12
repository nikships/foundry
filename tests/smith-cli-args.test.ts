/**
 * The helper CLI's argv and environment resolution.
 *
 * Two things carry real weight here. First, scope: an agent running in the
 * user's own terminal has no ambient project, so `--project` and
 * `$FOUNDRY_SMITH_PROJECT` are the only ways a write lands in the right roster —
 * and the flag must win. Second, the default socket path: with no app to inject
 * `$FOUNDRY_SMITH_SOCKET`, the CLI has to find the running app on its own, and a
 * wrong default is indistinguishable from "Foundry is not running".
 *
 * `args.ts` is pure on purpose (no fs, no socket, no `process.exit`), so all of
 * this is assertable without spawning anything.
 */

import { describe, expect, it } from 'vitest';
import { EXIT, defaultSocketPath, parseArgs, resolveSocketPath } from '../src/cli/args.js';

/** `parseArgs` reads the environment; pass an explicit empty one by default. */
const parse = (argv: string[], env: NodeJS.ProcessEnv = {}) => parseArgs(argv, env);

describe('the socket path the CLI targets', () => {
  it('defaults to the app support dir when the environment says nothing', () => {
    expect(defaultSocketPath('/Users/nik')).toBe(
      '/Users/nik/Library/Application Support/foundry/foundry/smith/foundry.sock',
    );
    expect(resolveSocketPath({})).toBe(defaultSocketPath());
  });

  it('lets the environment override it, for a dev app on a custom user-data dir', () => {
    expect(resolveSocketPath({ FOUNDRY_SMITH_SOCKET: '/tmp/dev/foundry.sock' })).toBe(
      '/tmp/dev/foundry.sock',
    );
  });
});

describe('parseArgs scoping', () => {
  it('takes the project from the environment when no flag is given', () => {
    const res = parse(['agent', 'list'], { FOUNDRY_SMITH_PROJECT: 'proj_env' });
    expect(res.ok && res.request.projectId).toBe('proj_env');
  });

  it('lets --project override the environment', () => {
    const res = parse(['agent', 'list', '--project', 'proj_flag'], {
      FOUNDRY_SMITH_PROJECT: 'proj_env',
    });
    expect(res.ok && res.request.projectId).toBe('proj_flag');
  });

  it('accepts --project=<id> and reads it from anywhere in the args', () => {
    const before = parse(['--project=proj_x', 'agent', 'show', 'planner']);
    expect(before.ok && before.request).toEqual({
      op: 'show',
      kind: 'agent',
      name: 'planner',
      projectId: 'proj_x',
    });
  });

  it('leaves the project undefined for global scope', () => {
    const res = parse(['envelope', 'list']);
    expect(res.ok && res.request.projectId).toBeUndefined();
  });

  it('treats a --project with no value as a usage error', () => {
    const res = parse(['agent', 'list', '--project']);
    expect(res).toMatchObject({ ok: false, code: EXIT.usage });
  });
});

describe('parseArgs commands', () => {
  it('accepts project list', () => {
    expect(parse(['project', 'list'])).toMatchObject({
      ok: true,
      request: { op: 'list', kind: 'project' },
    });
  });

  it('refuses every other project command before a round trip', () => {
    for (const argv of [
      ['project', 'show', 'proj_1'],
      ['project', 'create', '--file', '/tmp/p.json'],
      ['project', 'edit', 'proj_1', '--file', '/tmp/p.json'],
      ['project'],
    ]) {
      expect(parse(argv)).toMatchObject({ ok: false, code: EXIT.usage });
    }
  });

  it('returns the spec file for a write without reading it', () => {
    const create = parse(['agent', 'create', '--file', '/tmp/planner.json']);
    expect(create).toMatchObject({
      ok: true,
      request: { op: 'create', kind: 'agent' },
      specFile: '/tmp/planner.json',
    });
    // The parser never touches disk, so a nonexistent path still parses.
    expect(create.ok && create.request.spec).toBeUndefined();

    const edit = parse(['pipeline', 'edit', 'ship-it', '--file', '/tmp/p.json']);
    expect(edit).toMatchObject({
      ok: true,
      request: { op: 'edit', kind: 'pipeline', name: 'ship-it' },
      specFile: '/tmp/p.json',
    });
  });

  it('rejects an unknown kind, an unknown op, and the missing-argument cases', () => {
    const bad = [
      ['run', 'list'], // not an entity kind
      [], // nothing at all
      ['agent', 'destroy'], // not an op
      ['agent', 'show'], // show needs a name
      ['agent', 'create'], // create needs --file
      ['agent', 'edit', '--file', '/tmp/a.json'], // edit needs a name first
      ['agent', 'edit', 'planner'], // edit needs --file
      ['agent', 'create', '--file'], // --file needs a path
    ];
    for (const argv of bad) {
      expect(parse(argv)).toMatchObject({ ok: false, code: EXIT.usage });
    }
  });
});
