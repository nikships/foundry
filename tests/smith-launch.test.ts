/**
 * The Smith launcher's resolvers and the terminal handoff.
 *
 * What actually breaks here is quoting. The bootstrap line is pasted into a real
 * shell by a real person, so a project path with a space or an apostrophe must
 * survive verbatim — a mis-quoted path silently runs the wrong thing, or nothing.
 * The path resolvers matter for the packaged case, where anything still pointing
 * inside `app.asar` is not a file on disk at all.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CODING_AGENTS, TERMINAL_APPS, codingAgentFor } from '../src/shared/types.js';
import {
  resolveFromMainDir,
  shellQuote,
  smithAgentArgv,
  smithBootstrap,
  smithPrompt,
  smithSessionScript,
  smithShimScript,
} from '../src/main/smith/launch.js';
import { prepareSession } from '../src/main/smith/session.js';
import {
  openDirectoryInTerminal,
  preparedTerminalArgv,
  runCommandInTerminal,
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

describe('smithShimScript', () => {
  it('is an executable script, not a function definition — an agent spawns its own shells', () => {
    const script = smithShimScript('/app/out/main/foundry-cli.js');
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect(script).toContain(`exec node '/app/out/main/foundry-cli.js' "$@"`);
    expect(script).not.toContain('foundry-cli()');
  });

  it('quotes a path with a space so the shim does not exec two words', () => {
    expect(smithShimScript('/Applications/My Foundry.app/cli.js')).toContain(
      `node '/Applications/My Foundry.app/cli.js'`,
    );
  });
});

describe('smithPrompt', () => {
  it('points at the shipped SKILL.md by absolute path, since the user may not have it installed', () => {
    const prompt = smithPrompt({ skillDir: '/app/skills/foundry-smith' });
    expect(prompt).toContain('/app/skills/foundry-smith/SKILL.md');
    expect(prompt).toContain('Smith persona');
  });

  it('states the scope as settled, so the agent does not re-ask what the launcher exported', () => {
    const prompt = smithPrompt({ skillDir: '/skills', projectName: 'foundry' });
    expect(prompt).toContain('"foundry" project');
    expect(prompt).toContain('do not ask which project');
  });

  it('says global scope when no project is selected rather than naming nothing', () => {
    const prompt = smithPrompt({ skillDir: '/skills' });
    expect(prompt).toContain('global scope');
    expect(prompt).not.toContain('FOUNDRY_SMITH_PROJECT is already exported');
  });
});

describe('smithSessionScript', () => {
  const base = {
    binDir: '/support/smith/bin',
    projectPath: '/repos/foundry',
    socketPath: '/support/smith/foundry.sock',
    agentArgv: ['/usr/local/bin/droid', 'Read /skills/SKILL.md and become Smith.'],
    shell: '/bin/zsh',
    projectId: 'proj_1a2b',
  };

  it('puts the shim ahead of the inherited PATH so foundry-cli resolves to ours', () => {
    expect(smithSessionScript(base).split('\n')[0]).toBe(
      `export PATH='/support/smith/bin':"$PATH"`,
    );
  });

  it('pins the socket and the scope, so a dev instance is reached and --project is not needed', () => {
    const lines = smithSessionScript(base).split('\n');
    expect(lines).toContain(`export FOUNDRY_SMITH_SOCKET='/support/smith/foundry.sock'`);
    expect(lines).toContain(`export FOUNDRY_SMITH_PROJECT='proj_1a2b'`);
  });

  it('omits the scope export in global scope rather than exporting empty', () => {
    const script = smithSessionScript({ ...base, projectId: undefined });
    expect(script).not.toContain('FOUNDRY_SMITH_PROJECT');
  });

  it('exits rather than continuing in the wrong directory when cd fails', () => {
    expect(smithSessionScript(base)).toContain(`cd '/repos/foundry' || exit 1`);
  });

  it('passes the prompt as one quoted argument, apostrophes and all', () => {
    const script = smithSessionScript({
      ...base,
      agentArgv: ['/usr/local/bin/droid', "Smith's job"],
    });
    expect(script).toContain(`'/usr/local/bin/droid' 'Smith'\\''s job'`);
  });

  it('quotes every argv word, so agent flags stay attached to their values', () => {
    const script = smithSessionScript({
      ...base,
      agentArgv: ['/usr/local/bin/pi', '--skill', '/app/skills/foundry-smith', "Smith's job"],
    });
    expect(script).toContain(
      `'/usr/local/bin/pi' '--skill' '/app/skills/foundry-smith' 'Smith'\\''s job'`,
    );
  });

  it('ends by exec-ing an interactive shell, so a failed agent leaves its error on screen', () => {
    const lines = smithSessionScript(base).split('\n');
    expect(lines.at(-1)).toBe(`exec '/bin/zsh' -i`);
  });
});

describe('prepareSession', () => {
  const dirs: string[] = [];
  const makeDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'smith-session-'));
    dirs.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  const prepare = (sessionDir: string) =>
    prepareSession({
      sessionDir,
      cliPath: '/app/out/main/foundry-cli.js',
      agentArgv: ['/usr/local/bin/droid', 'become Smith'],
      projectPath: '/repos/foundry',
      socketPath: join(sessionDir, 'foundry.sock'),
      shell: '/bin/zsh',
      projectId: 'proj_1a2b',
    });

  it('writes the shim with the exec bit, since PATH lookup executes it rather than sourcing it', () => {
    const session = prepare(makeDir());
    const shim = join(session.binDir, 'foundry-cli');
    expect(existsSync(shim)).toBe(true);
    expect(statSync(shim).mode & 0o111).toBeGreaterThan(0);
  });

  it('writes a script that references the shim directory it just created', () => {
    const session = prepare(makeDir());
    expect(readFileSync(session.scriptPath, 'utf8')).toContain(shellQuote(session.binDir));
  });

  it('rewrites rather than accumulates, so a moved app cannot leave a stale shim', () => {
    const dir = makeDir();
    prepare(dir);
    const second = prepareSession({
      sessionDir: dir,
      cliPath: '/moved/foundry-cli.js',
      agentArgv: ['/usr/local/bin/droid', 'become Smith'],
      projectPath: '/repos/foundry',
      socketPath: join(dir, 'foundry.sock'),
      shell: '/bin/zsh',
    });
    const shim = readFileSync(join(second.binDir, 'foundry-cli'), 'utf8');
    expect(shim).toContain('/moved/foundry-cli.js');
    expect(shim).not.toContain('/app/out/main/foundry-cli.js');
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

describe('coding agent selection', () => {
  it('resolves every catalogued id to its PATH binary', () => {
    for (const agent of CODING_AGENTS) {
      expect(codingAgentFor(agent.id)).toEqual(agent);
    }
  });

  it('falls back to Droid for an id from a settings file we no longer know', () => {
    expect(codingAgentFor('nonsense' as never).binary).toBe('droid');
  });
});

describe('smithAgentArgv', () => {
  const input = {
    agentPath: '/usr/local/bin/agent',
    prompt: 'Read /skills/SKILL.md and become Smith.',
    skillDir: '/app/skills/foundry-smith',
  };

  it('starts Droid with the prompt as the only argument — its documented interactive form', () => {
    expect(smithAgentArgv({ ...input, id: 'droid' })).toEqual([
      '/usr/local/bin/agent',
      input.prompt,
    ]);
  });

  it('gives Claude Code --add-dir so it can read the shipped skill outside the project', () => {
    expect(smithAgentArgv({ ...input, id: 'claude' })).toEqual([
      '/usr/local/bin/agent',
      '--add-dir',
      input.skillDir,
      input.prompt,
    ]);
  });

  it('gives Codex --add-dir for the same reason', () => {
    expect(smithAgentArgv({ ...input, id: 'codex' })).toEqual([
      '/usr/local/bin/agent',
      '--add-dir',
      input.skillDir,
      input.prompt,
    ]);
  });

  it('starts OpenCode with --prompt, because a positional is a project path, not a message', () => {
    expect(smithAgentArgv({ ...input, id: 'opencode' })).toEqual([
      '/usr/local/bin/agent',
      '--prompt',
      input.prompt,
    ]);
  });

  it("loads the skill through Pi's first-class --skill flag", () => {
    expect(smithAgentArgv({ ...input, id: 'pi' })).toEqual([
      '/usr/local/bin/agent',
      '--skill',
      input.skillDir,
      input.prompt,
    ]);
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

  it('finds Terminal.app, which lives only under /System/Applications/Utilities', () => {
    // The fallback emulator reporting as missing is worse than a wrong label:
    // it is the one app every macOS install has.
    expect(terminalInstalled('Terminal')).toBe(true);
  });

  it('flags only emulators with a documented command flag as prepared', () => {
    // Adding `prepared` to one without it means opening a window that ignores
    // the session entirely, so the catalog is pinned rather than described.
    expect(TERMINAL_APPS.filter((t) => t.prepared).map((t) => t.id)).toEqual(['ghostty']);
  });
});

describe('preparedTerminalArgv', () => {
  const argv = preparedTerminalArgv({
    appName: 'Ghostty',
    directoryPath: '/repos/foundry',
    command: ['/bin/sh', '/support/smith/session.sh'],
  });

  it('passes -n, without which a running instance ignores --args and opens a bare window', () => {
    expect(argv[0]).toBe('-na');
    expect(argv[1]).toBe('Ghostty.app');
  });

  it('puts -e last, since everything after it is taken as the command', () => {
    expect(argv.slice(-3)).toEqual(['-e', '/bin/sh', '/support/smith/session.sh']);
  });

  it('sets the working directory so the agent starts in the project, not $HOME', () => {
    expect(argv).toContain('--working-directory=/repos/foundry');
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

describe('runCommandInTerminal', () => {
  // Same contract as the directory handoff: reject so the launcher can say why,
  // and check before spawning so no window is ever opened at a bad session.
  it('rejects a directory that is not there', async () => {
    await expect(
      runCommandInTerminal({
        appName: 'Ghostty',
        directoryPath: '/tmp/definitely-not-here-8c21',
        command: ['/bin/sh', '/tmp/session.sh'],
      }),
    ).rejects.toThrow(/Directory does not exist/);
  });

  it('rejects an empty command rather than opening a window with nothing in it', async () => {
    await expect(
      runCommandInTerminal({ appName: 'Ghostty', directoryPath: tmpdir(), command: [] }),
    ).rejects.toThrow('No command to run');
  });
});
