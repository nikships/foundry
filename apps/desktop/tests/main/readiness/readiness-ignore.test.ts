import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureMarkerIgnored } from '../../../src/main/readiness/ignore.js';
import { tempDir } from '../../helpers/tmp.js';

function write(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
}

function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

describe('ensureMarkerIgnored', () => {
  it('creates .prettierignore with the marker when prettier is configured', () => {
    const root = tempDir('ready-ignore-prettier-');
    write(root, '.prettierrc.json', '{}\n');
    expect(ensureMarkerIgnored(root)).toEqual(['.prettierignore']);
    expect(read(root, '.prettierignore')).toBe('.agents/agent-ready.json\n');
  });

  it('detects prettier via a prettier.config.js', () => {
    const root = tempDir('ready-ignore-cfg-');
    write(root, 'prettier.config.js', 'export default {};\n');
    expect(ensureMarkerIgnored(root)).toEqual(['.prettierignore']);
    expect(read(root, '.prettierignore')).toContain('.agents/agent-ready.json');
  });

  it('detects prettier via a package.json devDependency', () => {
    const root = tempDir('ready-ignore-pkg-');
    write(root, 'package.json', JSON.stringify({ devDependencies: { prettier: '3.0.0' } }));
    expect(ensureMarkerIgnored(root)).toEqual(['.prettierignore']);
  });

  it('appends to an existing .prettierignore preserving prior content', () => {
    const root = tempDir('ready-ignore-existing-');
    write(root, '.prettierrc', '{}\n');
    write(root, '.prettierignore', 'coverage\n');
    ensureMarkerIgnored(root);
    expect(read(root, '.prettierignore')).toBe('coverage\n.agents/agent-ready.json\n');
  });

  it('fixes a missing trailing newline when appending', () => {
    const root = tempDir('ready-ignore-newline-');
    write(root, '.prettierrc.json', '{}\n');
    write(root, '.prettierignore', 'coverage');
    ensureMarkerIgnored(root);
    expect(read(root, '.prettierignore')).toBe('coverage\n.agents/agent-ready.json\n');
  });

  it('is idempotent across repeated calls', () => {
    const root = tempDir('ready-ignore-idem-');
    write(root, '.prettierrc.json', '{}\n');
    ensureMarkerIgnored(root);
    const first = read(root, '.prettierignore');
    expect(ensureMarkerIgnored(root)).toEqual([]);
    expect(read(root, '.prettierignore')).toBe(first);
  });

  it('treats an existing .agents/ blanket as already covered', () => {
    const root = tempDir('ready-ignore-blanket-');
    write(root, '.prettierrc.json', '{}\n');
    write(root, '.prettierignore', '.agents/\n');
    expect(ensureMarkerIgnored(root)).toEqual([]);
  });

  it('does nothing when no formatter is configured', () => {
    const root = tempDir('ready-ignore-none-');
    expect(ensureMarkerIgnored(root)).toEqual([]);
    expect(existsSync(join(root, '.prettierignore'))).toBe(false);
  });

  it('appends to an existing .eslintignore without creating .prettierignore', () => {
    const root = tempDir('ready-ignore-eslint-');
    write(root, '.eslintignore', 'dist\n');
    expect(ensureMarkerIgnored(root)).toEqual(['.eslintignore']);
    expect(read(root, '.eslintignore')).toBe('dist\n.agents/agent-ready.json\n');
    expect(existsSync(join(root, '.prettierignore'))).toBe(false);
  });
});
