/**
 * The porcelain parser. Git prints warnings to the same capture runCommand
 * reads (fsmonitor hiccups, hints), and a warning must never become a path:
 * gates and the write boundary both trust this list to be real files.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { currentBranch, headSha, parseStatus, refExists } from '../src/main/engine/git.js';

function sh(cwd: string, argv: string[]): string {
  return execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8' });
}

describe('parseStatus', () => {
  it('parses rows of every status flavour', () => {
    const text = [
      ' M src/a.ts',
      'M  staged.ts',
      '?? new file.txt',
      'A  added.ts',
      '!! ignored.bin',
      'D  gone.ts',
    ].join('\n');
    expect(parseStatus(text)).toEqual([
      { path: 'src/a.ts', code: ' M' },
      { path: 'staged.ts', code: 'M ' },
      { path: 'new file.txt', code: '??' },
      { path: 'added.ts', code: 'A ' },
      { path: 'ignored.bin', code: '!!' },
      { path: 'gone.ts', code: 'D ' },
    ]);
  });

  it('drops git chatter that is not a status row', () => {
    // The fsmonitor failure mode that prompted the parser: the warning merges
    // into the capture and used to surface as a file named after the message.
    const text = [
      'error: could not read IPC response',
      'hint: some advice',
      '?? made.txt',
      '',
    ].join('\n');
    expect(parseStatus(text)).toEqual([{ path: 'made.txt', code: '??' }]);
  });

  it('reports the destination of a rename and strips quoting', () => {
    expect(parseStatus('R  old.ts -> new.ts')).toEqual([{ path: 'new.ts', code: 'R ' }]);
    expect(parseStatus('?? "dir with space/f.ts"')).toEqual([
      { path: 'dir with space/f.ts', code: '??' },
    ]);
  });

  it('ignores blank lines and truncated fragments', () => {
    expect(parseStatus('\n\n M \n??')).toEqual([]);
  });
});

describe('git inspection helpers', () => {
  it('detects branch on an empty repository with no commits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foundry-git-test-'));
    sh(dir, ['git', 'init', '-q', '-b', 'main']);

    expect(await currentBranch(dir)).toBe('main');
    expect(await headSha(dir)).toBe('');
    expect(await refExists(dir, 'main')).toBe(false);
    expect(await refExists(dir, 'HEAD')).toBe(false);
  });

  it('detects branch and sha on a normal repository with commits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foundry-git-test-'));
    sh(dir, ['git', 'init', '-q', '-b', 'main']);
    sh(dir, ['git', 'config', 'user.email', 'test@foundry.local']);
    sh(dir, ['git', 'config', 'user.name', 'Foundry Test']);
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    sh(dir, ['git', 'add', '-A']);
    sh(dir, ['git', 'commit', '-qm', 'initial']);

    expect(await currentBranch(dir)).toBe('main');
    const sha = await headSha(dir);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await refExists(dir, 'main')).toBe(true);
    expect(await refExists(dir, 'HEAD')).toBe(true);
  });

  it('detects detached HEAD state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foundry-git-test-'));
    sh(dir, ['git', 'init', '-q', '-b', 'main']);
    sh(dir, ['git', 'config', 'user.email', 'test@foundry.local']);
    sh(dir, ['git', 'config', 'user.name', 'Foundry Test']);
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    sh(dir, ['git', 'add', '-A']);
    sh(dir, ['git', 'commit', '-qm', 'initial']);
    const sha = await headSha(dir);
    sh(dir, ['git', 'checkout', '-q', sha]);

    expect(await currentBranch(dir)).toBe('HEAD');
  });
});
