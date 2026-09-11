#!/usr/bin/env node
// The full local gate is intentionally concurrent. Every command below reads
// source independently; test coverage and the build write only their own
// ignored output directories. Running them together keeps high-core developer
// Macs busy without weakening or selecting a subset of checks.

import { spawn } from 'node:child_process';

const checks = [
  'typecheck',
  'lint',
  'format:check',
  'knip',
  'test:coverage',
  'build',
  'check:css',
  'check:docs',
  'check:files',
  'check:duplicate',
  'audit:deps',
];

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const results = await Promise.all(checks.map(run));
const failures = results.filter(({ code, signal, error }) => code !== 0 || signal || error);

if (failures.length > 0) {
  console.error(`\ncheck: ${failures.map(({ name }) => name).join(', ')} failed`);
  process.exitCode = 1;
}

function run(name) {
  return new Promise((resolve) => {
    const child = spawn(npm, ['run', name], { stdio: 'inherit' });
    child.once('error', (error) => resolve({ name, code: null, signal: null, error }));
    child.once('exit', (code, signal) => resolve({ name, code, signal, error: null }));
  });
}
