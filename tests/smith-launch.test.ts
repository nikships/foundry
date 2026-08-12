/**
 * The Smith launcher's resolvers and the terminal handoff.
 *
 * What actually breaks here is quoting. The bootstrap line is pasted into a real
 * shell by a real person, so a project path with a space or an apostrophe must
 * survive verbatim — a mis-quoted path silently runs the wrong thing, or nothing.
 * The path resolvers matter for the packaged case, where anything still pointing
 * inside `app.asar` is not a file on disk at all.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TERMINAL_APPS } from '../src/shared/types.js';
import { resolveFromMainDir, shellQuote, smithBootstrap } from '../src/main/smith/launch.js';
import {
  openDirectoryInTerminal,
  terminalFor,
  terminalInstalled,
} from '../src/main/system/terminal.js';

describe('shellQuote', () => {
  it('wraps a plain value', () => {
    expect(shellQuote('/Users/nik/code/foundry')).toBe("'/Users/nik/code/foundry'");
  });

  it('survives spaces without splitting into two words', () => {
    expect(shellQuote('/Applications/My Foundry.app/cli.js')).toBe(
      "'/Applications/My Foundry.app/cli.js'",
    );
  });

  it('closes, escapes, and reopens around an apostrophe — the one case that breaks naive quoting', () => {
    // sh sees: 'Nik' + \' + 's code' → the literal Nik's code
    expect(shellQuote("/Users/Nik's code/cli.js")).toBe(`'/Users/Nik'\\''s code/cli.js'`);
  });

  it('leaves shell metacharacters inert rather than escaping them individually', () => {
    expect(shellQuote('/tmp/$HOME `whoami` "x"')).toBe('\'/tmp/$HOME `whoami` "x"\'');
  });
});

describe('smithBootstrap', () => {
  it('defines foundry-cli as a function that forwards its arguments', () => {
    const line = smithBootstrap({ cliPath: '/app/out/main/foundry-cli.js' });
    expect(line).toBe(`foundry-cli() { node '/app/out/main/foundry-cli.js' "$@"; }`);
  });

  it('exports the project scope when there is one, so --project is not needed per call', () => {
    const line = smithBootstrap({ cliPath: '/app/cli.js', projectId: 'proj_1a2b' });
    expect(line.split('\n')).toEqual([
      `foundry-cli() { node '/app/cli.js' "$@"; }`,
      `export FOUNDRY_SMITH_PROJECT='proj_1a2b'`,
    ]);
  });

  it('omits the export entirely for global scope, rather than exporting empty', () => {
    expect(smithBootstrap({ cliPath: '/app/cli.js' })).not.toContain('FOUNDRY_SMITH_PROJECT');
    expect(smithBootstrap({ cliPath: '/app/cli.js', projectId: '' })).not.toContain(
      'FOUNDRY_SMITH_PROJECT',
    );
  });

  it('quotes a path that would otherwise break the function body', () => {
    expect(smithBootstrap({ cliPath: '/Applications/My Foundry.app/cli.js' })).toContain(
      `node '/Applications/My Foundry.app/cli.js'`,
    );
  });
});

describe('resolveFromMainDir', () => {
  // Where main.js sits in each case. The resolver is given this explicitly so
  // the packaged layout is assertable from a machine that cannot package.
  const DEV = '/Users/nik/code/foundry/out/main';
  const PACKAGED = '/Applications/Foundry.app/Contents/Resources/app.asar/out/main';

  it('finds the CLI beside the main bundle', () => {
    expect(resolveFromMainDir(DEV, 'foundry-cli.js')).toBe(
      '/Users/nik/code/foundry/out/main/foundry-cli.js',
    );
  });

  it('walks out/main up to the root that holds skills/', () => {
    expect(resolveFromMainDir(DEV, '..', '..', 'skills', 'foundry-smith')).toBe(
      '/Users/nik/code/foundry/skills/foundry-smith',
    );
  });

  it('rewrites app.asar to app.asar.unpacked, since nothing outside the app can read an asar', () => {
    expect(resolveFromMainDir(PACKAGED, 'foundry-cli.js')).toBe(
      '/Applications/Foundry.app/Contents/Resources/app.asar.unpacked/out/main/foundry-cli.js',
    );
    expect(resolveFromMainDir(PACKAGED, '..', '..', 'skills', 'foundry-smith')).toBe(
      '/Applications/Foundry.app/Contents/Resources/app.asar.unpacked/skills/foundry-smith',
    );
  });

  it('leaves a dev path alone — there is no asar to rewrite', () => {
    expect(resolveFromMainDir(DEV, 'foundry-cli.js')).not.toContain('unpacked');
  });

  it('lands on the skill directory that really exists in this checkout', () => {
    // The same walk the packaged app performs, anchored at this repo's out/main.
    const root = join(import.meta.dirname, '..');
    const resolved = resolveFromMainDir(
      join(root, 'out', 'main'),
      '..',
      '..',
      'skills',
      'foundry-smith',
    );
    expect(resolved).toBe(join(root, 'skills', 'foundry-smith'));
    expect(existsSync(join(resolved, 'SKILL.md'))).toBe(true);
  });
});

describe('terminal selection', () => {
  it('resolves every catalogued id to its macOS application name', () => {
    for (const terminal of TERMINAL_APPS) {
      expect(terminalFor(terminal.id)).toEqual(terminal);
    }
  });

  it('falls back to Terminal.app for an id from a settings file we no longer know', () => {
    // Settings is user-editable JSON; an unknown id must not leave `open -a`
    // holding undefined.
    expect(terminalFor('nonsense' as never).appName).toBe('Terminal');
  });

  it('reports an obviously absent application as not installed', () => {
    expect(terminalInstalled('NoSuchTerminalApp-9f3a')).toBe(false);
  });
});

describe('openDirectoryInTerminal', () => {
  // The launch button turns a rejection into a line on screen, so these have to
  // reject — not throw synchronously, and not resolve silently.
  it('rejects a directory that is not there, naming it', async () => {
    await expect(
      openDirectoryInTerminal('/tmp/definitely-not-here-8c21', 'Terminal'),
    ).rejects.toThrow(/Directory does not exist: \/tmp\/definitely-not-here-8c21/);
  });

  it('rejects an empty path instead of opening the emulator at nothing', async () => {
    await expect(openDirectoryInTerminal('', 'Terminal')).rejects.toThrow('No directory to open');
  });
});
