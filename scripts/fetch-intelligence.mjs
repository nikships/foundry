#!/usr/bin/env node
// Refreshes the vendored Artificial Analysis Intelligence Index scores.
//
// The scores are read from OpenRouter's public model endpoint, which
// redistributes Artificial Analysis' published indices under
// `benchmarks.artificial_analysis`. That endpoint needs no key, which is what
// makes it usable here: Artificial Analysis' own API requires one, and their
// terms say not to ship it in client code — a desktop app cannot hold it.
//
// The result is committed as JSON rather than fetched at runtime, for the same
// reason the Bridge binary is pinned: planning must work on a plane. A run that
// reached for a score over the network would either block the planning rail on
// a third-party host or fail closed on a fact that is only advisory.
//
// Attribution is required by Artificial Analysis' terms and is carried in the
// generated file's `source` field; keep it there.
//
// Usage:
//   node scripts/fetch-intelligence.mjs [--check]
//
// `--check` writes nothing and exits non-zero when the vendored file is stale,
// which is what the scheduled workflow uses to decide whether to open a PR.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(repoRoot, 'apps/desktop/src/shared/model-intelligence.json');
const SOURCE_URL = 'https://openrouter.ai/api/v1/models';
const check = process.argv.slice(2).includes('--check');

/**
 * Bridge and provider ids carry decorations that no public catalog uses: a
 * date stamp, a `-preview` tag, and the effort suffixes CLIProxyAPI mints to
 * expose one model at several thinking levels. Strip them so `gemini-3.5-flash`
 * and `gemini-3.5-flash-extra-low` resolve to the same measured model, and fold
 * `4-5` to `4.5` because providers disagree about that separator.
 */
const EFFORT_SUFFIXES = [
  '-non-reasoning',
  '-reasoning',
  '-extra-low',
  '-highspeed',
  '-thinking',
  '-medium',
  '-agent',
  '-high',
  '-fast',
  '-low',
  '-256k',
];

export function normalizeModelId(id) {
  let value = id.toLowerCase().split('/').pop() ?? '';
  value = value.split(':')[0];
  value = value.replace(/-20\d{6}/g, '');
  value = value.replace(/-(preview|latest|exp)\b/g, '');
  for (;;) {
    const hit = EFFORT_SUFFIXES.find((suffix) => value.endsWith(suffix));
    if (!hit) break;
    value = value.slice(0, -hit.length);
  }
  value = value.replace(/(\d)[-_](\d)/g, '$1.$2');
  return value.replace(/[^a-z0-9.]+/g, '');
}

const response = await fetch(SOURCE_URL, { headers: { accept: 'application/json' } });
if (!response.ok) fail(`${SOURCE_URL} answered ${response.status}`);
const body = await response.json();
if (!Array.isArray(body?.data)) fail('response had no data array');
const models = body.data;

/** Highest score wins a collision: variants of one model differ by effort. */
const scores = {};
for (const model of models) {
  const score = model?.benchmarks?.artificial_analysis?.intelligence_index;
  if (typeof score !== 'number' || !Number.isFinite(score)) continue;
  const key = normalizeModelId(String(model.id ?? ''));
  if (!key) continue;
  scores[key] = Math.max(scores[key] ?? 0, Math.round(score * 10) / 10);
}
if (Object.keys(scores).length === 0) fail('no model carried an intelligence index');

const generated = {
  source: 'Artificial Analysis (https://artificialanalysis.ai), via openrouter.ai/api/v1/models',
  scores: Object.fromEntries(Object.entries(scores).sort(([a], [b]) => a.localeCompare(b))),
};
const serialized = `${JSON.stringify(generated, null, 2)}\n`;
const current = readOrNull(dest);

if (current === serialized) {
  console.log(`model-intelligence.json is current (${Object.keys(scores).length} models)`);
  process.exit(0);
}
if (check) {
  console.error('model-intelligence.json is stale; run npm run fetch:intelligence');
  process.exit(1);
}

writeFileSync(dest, serialized);
console.log(`wrote ${Object.keys(scores).length} scores to ${dest}`);

function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function fail(message) {
  console.error(`fetch-intelligence: ${message}`);
  process.exit(1);
}
