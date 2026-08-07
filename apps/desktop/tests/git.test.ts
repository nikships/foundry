/**
 * The porcelain parser. Git prints warnings to the same capture runCommand
 * reads (fsmonitor hiccups, hints), and a warning must never become a path:
 * gates and the write boundary both trust this list to be real files.
 */

import { describe, expect, it } from 'vitest';
import { parseStatus } from '../src/main/engine/git.js';

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
