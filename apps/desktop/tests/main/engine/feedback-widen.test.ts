import { describe, expect, it } from 'vitest';
import {
  feedbackWidenPlan,
  outOfBoundProofPaths,
  repoPathsNamedInLog,
  widenWriteBoundary,
} from '../../../src/main/engine/feedback-widen.js';

describe('repoPathsNamedInLog', () => {
  it('extracts relative file paths with extensions, including tests and snapshots', () => {
    const log = [
      'FAIL tests/foo.test.ts:12',
      '  + Received',
      ' › src/parser.ts',
      'Snapshot: src/__snapshots__/parser.test.ts.snap',
    ].join('\n');
    expect(repoPathsNamedInLog(log)).toEqual([
      'tests/foo.test.ts',
      'src/parser.ts',
      'src/__snapshots__/parser.test.ts.snap',
    ]);
  });

  it('strips cwd-absolute paths down to repo-relative and ignores URLs and node_modules', () => {
    const cwd = '/tmp/work';
    const log = [
      `${cwd}/tests/bar.spec.ts:3:1 FAIL`,
      'https://example.com/docs/guide.ts',
      'node_modules/vitest/dist/index.js',
    ].join('\n');
    expect(repoPathsNamedInLog(log, cwd)).toEqual(['tests/bar.spec.ts']);
  });
});

describe('outOfBoundProofPaths', () => {
  it('keeps only named paths the owner cannot write', () => {
    const log = 'FAIL tests/foo.test.ts\n  at src/parser.ts:10';
    expect(outOfBoundProofPaths(log, ['src/**'])).toEqual(['tests/foo.test.ts']);
    expect(outOfBoundProofPaths(log, null)).toEqual([]);
    expect(outOfBoundProofPaths(log, [])).toEqual(['tests/foo.test.ts', 'src/parser.ts']);
  });
});

describe('widenWriteBoundary', () => {
  it('appends extra paths the allowlist does not already cover', () => {
    expect(widenWriteBoundary(['src/**'], ['tests/foo.test.ts', 'src/parser.ts'])).toEqual([
      'src/**',
      'tests/foo.test.ts',
    ]);
    expect(widenWriteBoundary(null, ['tests/foo.test.ts'])).toBeNull();
    expect(widenWriteBoundary([], ['tests/foo.test.ts'])).toEqual([]);
  });
});

describe('feedbackWidenPlan', () => {
  it('widens a tight owner and skips a read-only one', () => {
    const log = 'FAIL tests/foo.test.ts';
    expect(feedbackWidenPlan({ writes: ['src/**'], log })).toEqual({
      action: 'feedback',
      extra: ['tests/foo.test.ts'],
    });
    expect(feedbackWidenPlan({ writes: [], log })).toEqual({
      action: 'skip',
      reason: 'owner is read-only and cannot write paths named by the proof log',
    });
    expect(feedbackWidenPlan({ writes: ['src/**'], log: 'exit 1 with no paths' })).toEqual({
      action: 'feedback',
      extra: [],
    });
  });
});
