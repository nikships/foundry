#!/usr/bin/env node
// Downloads the pinned CLIProxyAPI release that Foundry ships as the Bridge.
//
// The binary is vendored, not committed: a 58 MB Go binary in git history is a
// clone tax every contributor pays forever, and a checksum in package.json says
// exactly as much about what ships. The matching models.json is fetched from
// the same tag and written beside it, so a CLIProxyAPI bump is enough for new
// models to appear. `npm run fetch:bridge` is a packaging step, never part of
// `npm run check` — the gate must stay offline.
//
// Fail-closed is the whole point. A mismatched checksum leaves nothing
// executable on disk: the partial download is deleted and the process exits
// non-zero, so a corrupted or substituted release cannot be launched later by
// the manager, which only resolves a path it can stat.
//
// Usage:
//   node scripts/fetch-bridge.mjs [--force]
//   node scripts/fetch-bridge.mjs --bump [version]
//
// `--bump` downloads the latest (or named) release, rewrites package.json
// `config.bridge` (version + both sha256s), and installs the binary. The
// scheduled update-cliproxyapi workflow commits only the pin.

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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(repoRoot, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const cfg = pkg.config?.bridge;

if (!cfg?.version || !cfg?.archiveSha256 || !cfg?.binarySha256) {
  fail('package.json config.bridge must pin version, archiveSha256, and binarySha256');
}

const { force, bump, bumpVersion } = parseArgs(process.argv.slice(2));
const destDir = join(repoRoot, cfg.dir ?? 'resources/bridge');
const destBinary = join(destDir, cfg.binary ?? 'cli-proxy-api');
const destCatalog = join(destDir, 'models.json');
const binaryName = cfg.binary ?? 'cli-proxy-api';
const releaseBaseUrl =
  cfg.releaseBaseUrl ?? 'https://github.com/router-for-me/CLIProxyAPI/releases/download';

const targetVersion = bump ? (bumpVersion ?? resolveLatestVersion()) : cfg.version;

if (bump && !force && targetVersion === cfg.version) {
  console.log(`bridge ${targetVersion} already pinned`);
  process.exit(0);
}

if (!bump && !force && existsSync(destBinary) && sha256OfFile(destBinary) === cfg.binarySha256) {
  if (existsSync(destCatalog) && catalogLooksValid(destCatalog)) {
    console.log(`bridge ${cfg.version} already present and verified: ${rel(destBinary)}`);
    process.exit(0);
  }
  // Binary is fine; only the catalog is missing (an older fetch). Pull it
  // without re-downloading 58 MB so a bump of this script is enough.
  console.log(`bridge ${cfg.version} present; fetching models catalog`);
  mkdirSync(destDir, { recursive: true });
  fetchCatalog(cfg.version, destCatalog);
  console.log(`catalog installed: ${rel(destCatalog)}`);
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), 'foundry-bridge-'));
try {
  const fetched = downloadAndHash(work, targetVersion);
  if (!bump) {
    if (fetched.archiveSha !== cfg.archiveSha256) {
      fail(
        `archive checksum mismatch for ${archiveNameFor(targetVersion)}\n  expected ${cfg.archiveSha256}\n  actual   ${fetched.archiveSha}`,
      );
    }
    if (fetched.binarySha !== cfg.binarySha256) {
      fail(
        `binary checksum mismatch\n  expected ${cfg.binarySha256}\n  actual   ${fetched.binarySha}`,
      );
    }
  } else {
    writePin(targetVersion, fetched.archiveSha, fetched.binarySha);
  }
  install(fetched.extracted);
  fetchCatalog(targetVersion, destCatalog);
  if (bump) {
    console.log(
      `bridge pin ${cfg.version} -> ${targetVersion}\n  archiveSha256 ${fetched.archiveSha}\n  binarySha256  ${fetched.binarySha}\n  installed     ${rel(destBinary)} (${fetched.size} bytes)`,
    );
  } else {
    console.log(
      `bridge ${targetVersion} verified and installed: ${rel(destBinary)} (${fetched.size} bytes)`,
    );
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

function parseArgs(argv) {
  let forceFlag = false;
  let bumpFlag = false;
  let version = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') {
      forceFlag = true;
      continue;
    }
    if (arg === '--bump') {
      bumpFlag = true;
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        version = next;
        i += 1;
      }
      continue;
    }
    fail(`unknown argument: ${arg}`);
  }
  return { force: forceFlag, bump: bumpFlag, bumpVersion: version };
}

function archiveNameFor(version) {
  return `CLIProxyAPI_${version}_darwin_aarch64.tar.gz`;
}

function downloadAndHash(work, version) {
  const archiveName = archiveNameFor(version);
  const url = `${releaseBaseUrl}/v${version}/${archiveName}`;
  const archive = join(work, archiveName);
  console.log(`downloading ${url}`);
  // curl rather than fetch(): retries and resume are one flag each here, and
  // this script runs in CI where a flaky release CDN is the common failure.
  execFileSync('curl', ['-fL', '--retry', '3', '--retry-delay', '5', '-o', archive, url], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  const archiveSha = sha256OfFile(archive);
  execFileSync('tar', ['-xzf', archive, '-C', work], { stdio: ['ignore', 'inherit', 'inherit'] });
  const extracted = join(work, binaryName);
  if (!existsSync(extracted)) fail(`archive did not contain ${binaryName}`);

  const size = statSync(extracted).size;
  if (size < 1024 * 1024) fail(`extracted binary is too small (${size} bytes)`);

  return { archiveSha, binarySha: sha256OfFile(extracted), extracted, size };
}

function install(extracted) {
  mkdirSync(destDir, { recursive: true });
  // Remove first: overwriting a running or previously signed binary in place
  // can leave a partially written file that still passes an existsSync check.
  rmSync(destBinary, { force: true });
  copyFileSync(extracted, destBinary);
  chmodSync(destBinary, 0o755);
}

/**
 * The model catalog that ships with this CLIProxyAPI tag.
 *
 * Foundry does not keep its own model list. This file is what a Claude or
 * Antigravity login expands into, so a version bump is enough for new models
 * to appear. The path is the one this tag embeds; it is not the live
 * router-for-me/models tip, which can run ahead of the binary.
 */
function fetchCatalog(version, dest) {
  const url = `https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/v${version}/internal/registry/models/models.json`;
  const tmp = `${dest}.${process.pid}.tmp`;
  console.log(`downloading ${url}`);
  const args = ['-fL', '--retry', '3', '--retry-delay', '5'];
  if (process.env.GH_TOKEN) {
    args.push('-H', `Authorization: Bearer ${process.env.GH_TOKEN}`);
  }
  args.push('-o', tmp, url);
  try {
    execFileSync('curl', args, { stdio: ['ignore', 'inherit', 'inherit'] });
    if (!catalogLooksValid(tmp)) {
      rmSync(tmp, { force: true });
      fail(`catalog for v${version} was not a CLIProxyAPI models.json`);
    }
    rmSync(dest, { force: true });
    copyFileSync(tmp, dest);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function catalogLooksValid(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return ['claude', 'antigravity', 'xai', 'kimi', 'codex-pro'].some((key) =>
      Array.isArray(parsed[key]),
    );
  } catch {
    return false;
  }
}

function writePin(version, archiveSha256, binarySha256) {
  pkg.config.bridge.version = version;
  pkg.config.bridge.archiveSha256 = archiveSha256;
  pkg.config.bridge.binarySha256 = binarySha256;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

function resolveLatestVersion() {
  const args = [
    '-fsSL',
    '--retry',
    '3',
    '--retry-delay',
    '2',
    '-H',
    'Accept: application/vnd.github+json',
    '-H',
    'User-Agent: foundry-fetch-bridge',
  ];
  if (process.env.GH_TOKEN) {
    args.push('-H', `Authorization: Bearer ${process.env.GH_TOKEN}`);
  }
  args.push('https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest');
  let body;
  try {
    body = execFileSync('curl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  } catch {
    fail('could not resolve latest CLIProxyAPI release');
  }
  let tag;
  try {
    tag = JSON.parse(body).tag_name;
  } catch {
    fail('latest CLIProxyAPI release response was not JSON');
  }
  if (!tag || tag === 'null') fail('could not resolve latest CLIProxyAPI release');
  return String(tag).replace(/^v/, '');
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
