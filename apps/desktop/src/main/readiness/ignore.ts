/**
 * The marker file is written by Foundry after verification, so CI is the first
 * gate that ever sees it. A formatter/linter that rejects it turns the
 * readiness PR red even though every real criterion passes. This deterministically
 * exempts the marker from the repo's ignore files, in the same commit that adds
 * the marker — no agent turn required (the agent never runs when the repo is
 * already ready).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AGENT_READY_PATH } from './marker.js';

const PRETTIER_CONFIGS = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  '.prettierrc.toml',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
];

function readPkg(root: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hasPrettier(root: string): boolean {
  if (existsSync(join(root, '.prettierignore'))) return true;
  if (PRETTIER_CONFIGS.some((name) => existsSync(join(root, name)))) return true;
  const pkg = readPkg(root);
  if (pkg) {
    const deps = {
      ...((pkg.dependencies as Record<string, unknown> | undefined) ?? {}),
      ...((pkg.devDependencies as Record<string, unknown> | undefined) ?? {}),
    };
    if ('prettier' in deps) return true;
  }
  return false;
}

/**
 * Append `entry` to a gitignore-style ignore file, creating it if needed.
 * Idempotent: a no-op (returns false) when the entry, or a `.agents/` blanket,
 * is already present. Preserves existing content and trailing newline.
 */
function appendToIgnore(file: string, entry: string): boolean {
  let existing = '';
  try {
    existing = readFileSync(file, 'utf8');
  } catch {
    // file does not exist yet — we will create it
  }
  const lines = existing
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.some((l) => l === entry || l === '.agents/')) return false;
  const prefix = existing.length && !existing.endsWith('\n') ? '\n' : '';
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${existing}${prefix}${entry}\n`);
  return true;
}

/**
 * Exempt `.agents/agent-ready.json` from the repo's formatter/linter ignore
 * files. Returns the relative paths of files that were created or modified.
 *
 * - `.prettierignore` is created/appended when Prettier is in use (config,
 *   devDependency, or an existing `.prettierignore`). Prettier is the gate that
 *   reflows JSON, so this is the one that matters.
 * - `.eslintignore` is appended only when it already exists; ESLint's flat
 *   config uses inline `ignores` and ESLint does not lint JSON by default, so
 *   we never create one.
 *
 * Other formatters (Biome, ruff, spell/license-header checks) are handled by
 * the readiness agent prompt when a remediation turn actually runs; this path
 * covers the common already-ready case where no agent runs.
 */
export function ensureMarkerIgnored(root: string): string[] {
  const touched: string[] = [];
  if (hasPrettier(root)) {
    if (appendToIgnore(join(root, '.prettierignore'), AGENT_READY_PATH)) {
      touched.push('.prettierignore');
    }
  }
  const eslintIgnore = join(root, '.eslintignore');
  if (existsSync(eslintIgnore)) {
    if (appendToIgnore(eslintIgnore, AGENT_READY_PATH)) touched.push('.eslintignore');
  }
  return touched;
}
