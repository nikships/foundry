/**
 * Stand-in for the `gh` CLI. Behaviour is driven by a config.json next to the
 * binary rather than env vars, so parallel tests never fight over process.env,
 * and every invocation is appended to calls.log so a test can assert what gh
 * was actually asked to do (and in what order).
 */

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FakeGhConfig {
  /** `gh auth status` fails when false. */
  authed?: boolean;
  /** `gh repo view` answer; a string error makes it fail with that message. */
  repoView?: { nameWithOwner: string } | { error: string };
  /** `gh pr view` answer; null makes it fail like "no pull requests found". */
  prView?: {
    number: number;
    url: string;
    headRefName: string;
    baseRefName: string;
  } | null;
  /** `gh pr create` prints this URL; a `createError` makes it fail instead. */
  createUrl?: string;
  createError?: string;
  /** `gh pr list` prints this JSON verbatim. */
  prList?: unknown[];
  /** `gh pr merge` fails with this message when set. */
  mergeError?: string;
}

const SCRIPT = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = path.dirname(fs.realpathSync(process.argv[1]));
const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify(args) + '\n');

const die = (msg) => { process.stderr.write(msg + '\n'); process.exit(1); };

if (args[0] === '--version') {
  process.stdout.write('gh version 2.62.0 (fake)\n');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  if (cfg.authed === false) die('You are not logged into any GitHub hosts.');
  process.stdout.write('Logged in to github.com\n');
  process.exit(0);
}
if (args[0] === 'repo' && args[1] === 'view') {
  const v = cfg.repoView ?? { nameWithOwner: 'acme/widgets' };
  if (v.error) die(v.error);
  process.stdout.write(JSON.stringify(v) + '\n');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'view') {
  if (!cfg.prView) die('no pull requests found for branch');
  process.stdout.write(JSON.stringify(cfg.prView) + '\n');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'create') {
  if (cfg.createError) die(cfg.createError);
  process.stdout.write((cfg.createUrl ?? 'https://github.com/acme/widgets/pull/7') + '\n');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'list') {
  process.stdout.write(JSON.stringify(cfg.prList ?? []) + '\n');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'merge') {
  if (cfg.mergeError) die(cfg.mergeError);
  process.stdout.write('Merged pull request\n');
  process.exit(0);
}
die('fake gh: unhandled command ' + args.join(' '));
`;

export interface FakeGh {
  bin: string;
  /** Replace the whole scenario; unset keys fall back to happy defaults. */
  configure(config: FakeGhConfig): void;
  /** Every argv gh was invoked with, oldest first. */
  calls(): string[][];
}

export function makeFakeGh(config: FakeGhConfig = {}): FakeGh {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'));
  const bin = join(dir, 'gh');
  writeFileSync(bin, SCRIPT);
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, 'calls.log'), '');
  const configure = (next: FakeGhConfig): void => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify(next));
  };
  configure(config);
  return {
    bin,
    configure,
    calls: () =>
      readFileSync(join(dir, 'calls.log'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
  };
}
