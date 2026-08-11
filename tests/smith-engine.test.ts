/**
 * The strings the Ghostty engine hands to the vendored addon. `ghosttyConfig`
 * and `ghosttyCommand` are pure, so these pin what actually reaches ghostty:
 * the config isolation posture (only our lines, blink off, no shell
 * integration), the theme mapping, and the shell wrapper that carries
 * per-session env vars into droid (the engine's utilityProcess env is fixed
 * at fork, so the command line is the only road in).
 */

import { describe, expect, it } from 'vitest';
import { ghosttyCommand, ghosttyConfig } from '../src/main/smith/engine-config.js';

describe('ghosttyConfig', () => {
  it('always disables cursor blink so frames mean output (busy dot honesty)', () => {
    expect(ghosttyConfig()).toContain('cursor-style-blink = false');
  });

  it('never injects shell integration into droid', () => {
    expect(ghosttyConfig()).toContain('shell-integration = none');
  });

  it('maps the renderer palette to ghostty keys and ANSI slots', () => {
    const config = ghosttyConfig({
      colors: {
        background: '#020202',
        foreground: '#eeeeee',
        cursor: '#ee6018',
        red: '#ef4444',
        brightWhite: '#ffffff',
      },
    });
    expect(config).toContain('background = #020202');
    expect(config).toContain('foreground = #eeeeee');
    expect(config).toContain('cursor-color = #ee6018');
    expect(config).toContain('palette = 1=#ef4444');
    expect(config).toContain('palette = 15=#ffffff');
  });

  it('drops non-hex values rather than risking a config parse error', () => {
    const config = ghosttyConfig({
      colors: { background: 'rgba(255,255,255,0.18)', foreground: '#eeeeee' },
    });
    expect(config).not.toContain('rgba');
    expect(config).toContain('foreground = #eeeeee');
  });

  it('ignores unknown color names instead of emitting junk keys', () => {
    const config = ghosttyConfig({ colors: { chartreuse: '#aabbcc' } });
    expect(config).not.toContain('#aabbcc');
  });
});

describe('ghosttyCommand', () => {
  it('wraps the invocation in the demo-proven /bin/sh -c pattern', () => {
    const command = ghosttyCommand('/usr/local/bin/droid', [], {});
    expect(command).toBe(`/bin/sh -c 'exec "/usr/local/bin/droid"'`);
  });

  it('carries env assignments ahead of the exec', () => {
    const command = ghosttyCommand('/bin/droid', ['--resume', 'abc'], {
      FOUNDRY_SMITH_SOCKET: '/tmp/foundry.sock',
      FOUNDRY_CLI: '/app/foundry-cli.js',
    });
    expect(command).toBe(
      `/bin/sh -c 'FOUNDRY_SMITH_SOCKET="/tmp/foundry.sock" FOUNDRY_CLI="/app/foundry-cli.js" ` +
        `exec "/bin/droid" "--resume" "abc"'`,
    );
  });

  it('double-quotes paths with spaces (Application Support lives there)', () => {
    const command = ghosttyCommand('/bin/droid', [], {
      FOUNDRY_CLI: '/Users/nik/Library/Application Support/Foundry/foundry-cli.js',
    });
    expect(command).toContain('"/Users/nik/Library/Application Support/Foundry/foundry-cli.js"');
  });

  it('escapes shell-active characters inside double quotes', () => {
    const command = ghosttyCommand('/bin/droid', ['--flag', 'a"b$c`d\\e'], {});
    expect(command).toContain('"a\\"b\\$c\\`d\\\\e"');
  });

  it('refuses a single quote loudly rather than corrupting the outer quoting', () => {
    expect(() => ghosttyCommand("/pa'th/droid", [], {})).toThrow(/single quote/);
  });
});
