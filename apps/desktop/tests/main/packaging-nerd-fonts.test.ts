/**
 * Bounded Nerd Fonts packaging: one SymbolsOnly woff2, licenses in the
 * extraResources tree, checksum pins, and a hard cap so the full collection
 * cannot sneak into the signed app.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '../../../..');
const woff2Rel = 'apps/desktop/src/renderer/design/fonts/SymbolsNerdFontMono-Regular.woff2';
const fetchRel = 'scripts/fetch-nerd-fonts.sh';
const MAX_FACE_BYTES = 5 * 1024 * 1024;
const FULL_COLLECTION = [
  'HackNerdFont',
  'JetBrainsMonoNL',
  'FiraCodeNerdFont',
  'MesloLGS',
  'SauceCodePro',
  'NerdFontsSymbolsOnly.zip',
];

const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8');

function pin(script: string, name: string): string {
  const match = script.match(new RegExp(`^${name}="([^"]+)"`, 'm'));
  if (!match?.[1]) throw new Error(`fetch-nerd-fonts.sh is missing pin ${name}`);
  return match[1];
}

/** Filter entries for one extraResources `from:` block (later `to:` overwrites). */
function extraResourceFilter(builder: string, from: string): string[] {
  const marker = `from: ${from}`;
  const start = builder.indexOf(marker);
  if (start < 0) throw new Error(`missing extraResource from: ${from}`);
  const rest = builder.slice(start);
  const next = rest.search(/\n\s*- from:/);
  const block = next === -1 ? rest : rest.slice(0, next);
  return [...block.matchAll(/^\s+- '([^']+)'\s*$/gm)].map((match) => match[1]);
}

describe('bounded set', () => {
  it('ships exactly one Nerd face and names it in packaging', () => {
    const builder = read('electron-builder.yml');
    expect(builder).toContain('files:');
    expect(builder).toContain('out/**/*');
    expect(builder).toContain('from: apps/desktop/src/renderer/design/fonts');
    expect(builder).toContain('to: fonts');
    expect(builder).toContain('SymbolsNerdFontMono-Regular.woff2');
    expect(builder).toContain('from: resources/fonts');
    expect(builder).toContain('OFL.txt');
    expect(builder).toContain('LICENSE');
    expect(builder).toContain('APACHE');
    for (const name of FULL_COLLECTION) {
      expect(builder, name).not.toContain(name);
    }
    // Geist already rides the Vite bundle; do not extraResource it again.
    expect(builder).not.toContain('Geist-Variable');
    expect(builder).not.toContain('GeistMono-Variable');
  });

  it('does not extraResource a catch-all nerd-fonts dump', () => {
    const builder = read('electron-builder.yml');
    expect(builder).not.toMatch(/from:\s*resources\/nerd-fonts\b/);
    expect(builder).not.toMatch(/NerdFonts[^S]/);
    expect(builder).not.toContain('patched-fonts');
  });

  it('does not let the resources/fonts README overwrite the full attribution table', () => {
    const builder = read('electron-builder.yml');
    const design = extraResourceFilter(builder, 'apps/desktop/src/renderer/design/fonts');
    const pack = extraResourceFilter(builder, 'resources/fonts');
    expect(design).toContain('SymbolsNerdFontMono-Regular.woff2');
    expect(design).toContain('LICENSE');
    expect(design).toContain('OFL.txt');
    expect(design).toContain('APACHE');
    expect(design).toContain('README.md');
    expect(pack).toContain('LICENSE');
    expect(pack).toContain('OFL.txt');
    expect(pack).toContain('APACHE');
    expect(pack).not.toContain('README.md');
    expect(pack).not.toContain('SymbolsNerdFontMono-Regular.woff2');
  });
});

describe('binary and pins', () => {
  it('commits a woff2 under 5 MB whose sha256 matches the fetch-script pin', () => {
    const script = read(fetchRel);
    const expected = pin(script, 'WOFF2_SHA256');
    expect(pin(script, 'NERD_FONTS_VERSION')).toBe('v3.4.0');
    expect(pin(script, 'FAMILY_NAME')).toBe('Symbols Nerd Font Mono');
    expect(existsSync(join(repoRoot, woff2Rel))).toBe(true);
    const bytes = readFileSync(join(repoRoot, woff2Rel));
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('wOF2');
    expect(bytes.byteLength).toBeGreaterThan(200 * 1024);
    expect(bytes.byteLength).toBeLessThanOrEqual(MAX_FACE_BYTES);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected);
    expect(statSync(join(repoRoot, woff2Rel)).size).toBe(bytes.byteLength);
  });

  it('keeps the fetch script fail-closed and offline-checkable', () => {
    const script = read(fetchRel);
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('--check');
    expect(script).toContain('ARCHIVE_SHA256');
    expect(script).toContain('NerdFontsSymbolsOnly.zip');
    expect(script).toContain('refusing to install woff2');
    const output = execFileSync('bash', [join(repoRoot, fetchRel), '--check'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(output).toContain('ok v3.4.0');
  });
});

describe('licensing', () => {
  it('vendors the Nerd MIT wrapper and the SIL OFL next to the face', () => {
    const license = read('apps/desktop/src/renderer/design/fonts/LICENSE');
    const ofl = read('apps/desktop/src/renderer/design/fonts/OFL.txt');
    const readme = read('apps/desktop/src/renderer/design/fonts/README.md');
    expect(license).toContain('MIT License');
    expect(license).toContain('Ryan L McIntyre');
    expect(ofl).toContain('SIL OPEN FONT LICENSE');
    expect(ofl).toContain('Version 1.1');
    expect(readme).toContain('v3.4.0');
    expect(readme).toContain(pin(read(fetchRel), 'WOFF2_SHA256'));
    expect(readme).toContain('CC BY 4.0');
    expect(readme).toContain('Font Awesome');
    expect(readme).toContain('Codicons');
    expect(readme).toContain('`APACHE`');
  });

  it('vendors the Apache-2.0 text for Material Design Icons next to the face', () => {
    const design = read('apps/desktop/src/renderer/design/fonts/APACHE');
    const pack = read('resources/fonts/APACHE');
    expect(design).toBe(pack);
    expect(design).toContain('Apache License');
    expect(design).toContain('Version 2.0, January 2004');
    expect(design).toContain('http://www.apache.org/licenses/');
    expect(design).toContain('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION');
    expect(design).toContain('Material Design Icons');
    expect(design).toContain('Pictogrammers');
  });

  it('copies license texts into resources/fonts for the signed bundle', () => {
    const license = read('resources/fonts/LICENSE');
    const ofl = read('resources/fonts/OFL.txt');
    const apache = read('resources/fonts/APACHE');
    const readme = read('resources/fonts/README.md');
    expect(license).toContain('MIT License');
    expect(ofl).toContain('SIL OPEN FONT LICENSE');
    expect(apache).toContain('Apache License');
    expect(apache).toContain('Version 2.0');
    expect(readme).toContain('Symbols Nerd Font Mono');
    expect(readme).toContain('APACHE');
    expect(readme).not.toContain('HackNerdFont');
  });
});
