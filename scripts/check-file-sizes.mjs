#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_STAGED_BYTES = 20 * 1024 * 1024;
const staged = process.argv.includes('--staged');

function git(args, encoding = 'utf8') {
  const result = spawnSync('git', args, {
    cwd: process.cwd(),
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    throw new Error(detail || `git ${args.join(' ')} failed`);
  }
  return result.stdout;
}

function pathsToCheck() {
  const args = staged
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
    : ['ls-files', '--cached', '--others', '--exclude-standard', '-z'];
  return git(args, 'buffer').toString('utf8').split('\0').filter(Boolean);
}

function blobSize(path) {
  if (!staged) {
    try {
      // lstat measures the link recorded by Git, not an arbitrary target outside
      // the repository. Deleted tracked paths are skipped below.
      return lstatSync(path).size;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }
  return Number(git(['cat-file', '-s', `:${path}`]).trim());
}

try {
  const files = pathsToCheck();
  const oversized = [];
  let total = 0;
  for (const path of files) {
    const bytes = blobSize(path);
    if (bytes === null) continue;
    total += bytes;
    if (bytes > MAX_FILE_BYTES) oversized.push({ path, bytes });
  }

  if (oversized.length > 0 || (staged && total > MAX_STAGED_BYTES)) {
    console.error('check-file-sizes: rejected');
    for (const { path, bytes } of oversized) {
      console.error(`  ${path}: ${(bytes / 1024 / 1024).toFixed(2)} MiB (limit 10 MiB)`);
    }
    if (staged && total > MAX_STAGED_BYTES) {
      console.error(`  staged payload: ${(total / 1024 / 1024).toFixed(2)} MiB (limit 20 MiB)`);
    }
    console.error('Store generated media outside Git or use an explicitly reviewed LFS change.');
    process.exit(1);
  }

  const scope = staged ? `${files.length} staged file(s)` : `${files.length} candidate file(s)`;
  console.log(`check-file-sizes: ok (${scope})`);
} catch (error) {
  console.error(`check-file-sizes: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
