/**
 * Stand-in for the `glab` CLI. Same shape as fake-gh: config.json beside the
 * binary, calls.log for argv assertions, no shared process.env between tests.
 */

import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp.js';

export interface FakeGlabConfig {
  /** `glab auth status` fails when false. */
  authed?: boolean;
  /** `glab repo view` answer; a string error makes it fail with that message. */
  repoView?: { path_with_namespace: string } | { error: string };
  /** `glab mr view` answer; null makes it fail like "no merge request found". */
  mrView?: {
    iid: number;
    web_url: string;
    source_branch?: string;
    target_branch?: string;
    state?: string;
    merged_at?: string | null;
  } | null;
  createUrl?: string;
  createError?: string;
  issueUrl?: string;
  issueCreateError?: string;
  issueLabelError?: string;
  mrList?: unknown[];
  mergeError?: string;
  username?: string;
}

const SCRIPT = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = path.dirname(fs.realpathSync(process.argv[1]));
const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify(args) + '\n');

const die = (msg) => { process.stderr.write(msg + '\n'); process.exit(1); };

if (args[0] === '--version' || (args[0] === 'version')) {
  process.stdout.write('glab 1.118.0 (fake)\n');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  if (cfg.authed === false) die('Not logged in. Run glab auth login.');
  process.stdout.write('Logged in to gitlab.com\n');
  process.exit(0);
}
if (args[0] === 'api' && args[1] === 'user') {
  if (!cfg.username) die('401 Unauthorized');
  process.stdout.write(JSON.stringify({ username: cfg.username }) + '\n');
  process.exit(0);
}
if (args[0] === 'repo' && args[1] === 'view') {
  const v = cfg.repoView ?? { path_with_namespace: 'acme/widgets' };
  if (v.error) die(v.error);
  process.stdout.write(JSON.stringify(v) + '\n');
  process.exit(0);
}
if (args[0] === 'mr' && args[1] === 'view') {
  if (!cfg.mrView) die('no merge request found');
  process.stdout.write(JSON.stringify(cfg.mrView) + '\n');
  process.exit(0);
}
if (args[0] === 'mr' && args[1] === 'create') {
  if (cfg.createError) die(cfg.createError);
  process.stdout.write((cfg.createUrl ?? 'https://gitlab.com/acme/widgets/-/merge_requests/7') + '\n');
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'create') {
  if (cfg.issueCreateError) die(cfg.issueCreateError);
  if (cfg.issueLabelError && args.includes('--label')) die(cfg.issueLabelError);
  process.stdout.write((cfg.issueUrl ?? 'https://gitlab.com/acme/widgets/-/issues/9') + '\n');
  process.exit(0);
}
if (args[0] === 'mr' && args[1] === 'list') {
  process.stdout.write(JSON.stringify(cfg.mrList ?? []) + '\n');
  process.exit(0);
}
if (args[0] === 'mr' && args[1] === 'merge') {
  if (cfg.mergeError) die(cfg.mergeError);
  process.stdout.write('Merged\n');
  process.exit(0);
}
die('fake glab: unhandled command ' + args.join(' '));
`;

export interface FakeGlab {
  bin: string;
  configure(config: FakeGlabConfig): void;
  calls(): string[][];
}

export function makeFakeGlab(config: FakeGlabConfig = {}): FakeGlab {
  const dir = tempDir('fake-glab-');
  const bin = join(dir, 'glab');
  writeFileSync(bin, SCRIPT);
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, 'calls.log'), '');
  const configure = (next: FakeGlabConfig): void => {
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
