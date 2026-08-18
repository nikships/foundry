#!/usr/bin/env node
// Downloads the pinned CLIProxyAPI release that Foundry ships as the Bridge.
//
// The binary is vendored, not committed: a 58 MB Go binary in git history is a
// clone tax every contributor pays forever, and a checksum in package.json says
// exactly as much about what ships. `npm run fetch:bridge` is a packaging step,
// never part of `npm run check` — the gate must stay offline.
//
// Fail-closed is the whole point. A mismatched checksum leaves nothing
// executable on disk: the partial download is deleted and the process exits
// non-zero, so a corrupted or substituted release cannot be launched later by
// the manager, which only resolves a path it can stat.
//
// Usage: node scripts/fetch-bridge.mjs [--force]

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const cfg = pkg.config?.bridge;

if (!cfg?.version || !cfg?.archiveSha256 || !cfg?.binarySha256) {
  fail('package.json config.bridge must pin version, archiveSha256, and binarySha256');
}

const force = process.argv.includes('--force');
const destDir = join(repoRoot, cfg.dir ?? 'resources/bridge');
const destBinary = join(destDir, cfg.binary ?? 'cli-proxy-api');
const archiveName = `CLIProxyAPI_${cfg.version}_darwin_aarch64.tar.gz`;
const url = `${cfg.releaseBaseUrl}/v${cfg.version}/${archiveName}`;

if (!force && existsSync(destBinary) && sha256OfFile(destBinary) === cfg.binarySha256) {
  console.log(`bridge ${cfg.version} already present and verified: ${rel(destBinary)}`);
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), 'foundry-bridge-'));
try {
  const archive = join(work, archiveName);
  console.log(`downloading ${url}`);
  // curl rather than fetch(): retries and resume are one flag each here, and
  // this script runs in CI where a flaky release CDN is the common failure.
  execFileSync('curl', ['-fL', '--retry', '3', '--retry-delay', '5', '-o', archive, url], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  const archiveSha = sha256OfFile(archive);
  if (archiveSha !== cfg.archiveSha256) {
    fail(
      `archive checksum mismatch for ${archiveName}\n  expected ${cfg.archiveSha256}\n  actual   ${archiveSha}`,
    );
  }

  execFileSync('tar', ['-xzf', archive, '-C', work], { stdio: ['ignore', 'inherit', 'inherit'] });
  const extracted = join(work, cfg.binary ?? 'cli-proxy-api');
  if (!existsSync(extracted)) fail(`archive did not contain ${cfg.binary ?? 'cli-proxy-api'}`);

  const binarySha = sha256OfFile(extracted);
  if (binarySha !== cfg.binarySha256) {
    fail(`binary checksum mismatch\n  expected ${cfg.binarySha256}\n  actual   ${binarySha}`);
  }

  mkdirSync(destDir, { recursive: true });
  // Remove first: overwriting a running or previously signed binary in place
  // can leave a partially written file that still passes an existsSync check.
  rmSync(destBinary, { force: true });
  copyFileSync(extracted, destBinary);
  chmodSync(destBinary, 0o755);

  const size = statSync(destBinary).size;
  console.log(`bridge ${cfg.version} verified and installed: ${rel(destBinary)} (${size} bytes)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

function sha256OfFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function rel(path) {
  return path.startsWith(repoRoot) ? path.slice(repoRoot.length + 1) : path;
}

function fail(message) {
  console.error(`fetch-bridge: ${message}`);
  process.exit(1);
}
