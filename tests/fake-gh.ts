/**
 * Stand-in for the `gh` CLI. Behaviour is driven by a config.json next to the
 * binary rather than env vars, so parallel tests never fight over process.env,
 * and every invocation is appended to calls.log so a test can assert what gh
 * was actually asked to do (and in what order).
 */

import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp.js';

export interface FakeGhConfig {
  /** `gh auth status` fails when false. */
  authed?: boolean;
  /** `gh repo view` answer; a string error makes it fail with that message. */
  repoView?: { nameWithOwner: string } | { error: string };
  /** `gh pr view` answer; null makes it fail like "no pull requests found". */
  prView?: {
    number: number;
    url: string;
    headRefName?: string;
    baseRefName?: string;
    state?: string;
    mergedAt?: string | null;
  } | null;
  /** `gh pr create` prints this URL; a `createError` makes it fail instead. */
  createUrl?: string;
  createError?: string;
  /** `gh issue create` prints this URL; an `issueCreateError` makes it fail instead. */
  issueUrl?: string;
  issueCreateError?: string;
  /** `gh issue create` fails with this message only when `--label` is present. */
  issueLabelError?: string;
  /** `gh pr list` prints this JSON verbatim. */
  prList?: unknown[];
  /** `gh pr merge` fails with this message when set. */
  mergeError?: string;
  /** `gh api user` login; unset means the call fails like a broken token. */
  login?: string;
  /** `gh api user/orgs` answer. */
  orgs?: string[];
  /** `gh repo create` fails with this message when set. */
  repoCreateError?: string;
  /**
   * `gh repo create --clone` exits 0 but leaves no directory, which is what a
   * created repo whose clone step failed looks like from the outside.
   */
  cloneSilentlyFails?: boolean;
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
if (args[0] === 'api' && args[1] === 'user') {
  if (!cfg.login) die('HTTP 401: Bad credentials');
  process.stdout.write(JSON.stringify({ login: cfg.login }) + '\n');
  process.exit(0);
}
if (args[0] === 'api' && args[1] === 'user/orgs') {
  process.stdout.write(JSON.stringify((cfg.orgs ?? []).map((login) => ({ login }))) + '\n');
  process.exit(0);
}
if (args[0] === 'repo' && args[1] === 'create') {
  if (cfg.repoCreateError) die(cfg.repoCreateError);
  const target = args[2];
  const name = target.includes('/') ? target.split('/')[1] : target;
  // --clone is what makes this real: the flow reads the working tree it lands
  // in, so the fake has to produce a repo with a commit, exactly as the README
  // flag does. A cloneless fake would pass while the real one broke isolation.
  if (args.includes('--clone') && !cfg.cloneSilentlyFails) {
    const dest = path.join(process.cwd(), name);
    const { execFileSync } = require('node:child_process');
    const run = (argv) => execFileSync(argv[0], argv.slice(1), { cwd: dest, stdio: 'ignore' });
    fs.mkdirSync(dest, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', dest], { stdio: 'ignore' });
    run(['git', 'config', 'user.email', 'test@foundry.local']);
    run(['git', 'config', 'user.name', 'Foundry Test']);
    if (args.includes('--add-readme')) {
      fs.writeFileSync(path.join(dest, 'README.md'), '# ' + name + '\n');
      run(['git', 'add', '-A']);
      run(['git', 'commit', '-qm', 'Initial commit']);
    }
  }
  process.stdout.write('https://github.com/' + (target.includes('/') ? target : 'me/' + target) + '\n');
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
if (args[0] === 'issue' && args[1] === 'create') {
  if (cfg.issueCreateError) die(cfg.issueCreateError);
  if (cfg.issueLabelError && args.includes('--label')) die(cfg.issueLabelError);
  process.stdout.write((cfg.issueUrl ?? 'https://github.com/acme/widgets/issues/9') + '\n');
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
  const dir = tempDir('fake-gh-');
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
