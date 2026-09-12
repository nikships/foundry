#!/usr/bin/env node
// Seeds the permanent local dogfood state: an isolated Electron user-data dir
// whose Settings point every model slot at Meta Muse Spark 1.3 Contributor
// and hide the non-contributor Spark model, so the reachable catalog is the
// contributor alone once the Meta key is stored.
//
// Secrets never live here or in the repo. Provider keys belong to pi's auth
// store (`<state>/foundry/pi/auth.json`) and the Gemini key to its encrypted
// credential file (`<state>/foundry/credentials/`); both are written by the
// running app when the key is saved in Settings, never by this script. The
// first launch prints which keys still need that one-time entry; every later
// launch reuses them untouched.
//
// Usage: pnpm run dogfood:seed [-- --reset]
//   --reset  rewrites settings.json even when one already exists. Credentials
//            are never touched, so saved keys survive a reset.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const stateDir =
  process.env.FOUNDRY_DOGFOOD_STATE && process.env.FOUNDRY_DOGFOOD_STATE.trim()
    ? process.env.FOUNDRY_DOGFOOD_STATE.trim()
    : join(repoRoot, '.dogfood-state');
const supportDir = join(stateDir, 'foundry');
const settingsFile = join(supportDir, 'settings.json');
const reset = process.argv.includes('--reset');

/** The only model a dogfood run may appoint. Mirrors the pinned direct provider. */
const DOGFOOD_MODEL = 'meta/muse-spark-1.3-contributor';
/**
 * Everything else the pinned pi runtime lists without any credential stored,
 * plus the sibling Spark tier: hidden so every picker, the Orchestrator's
 * cast pool, and Smith offer the contributor alone. Refresh this list when
 * the pinned runtime gains models — dump the live catalog with
 * `window.foundry.catalog.agentModels()` in a seeded app and hide the new ids.
 */
const HIDDEN_MODELS = [
  'meta/muse-spark-1.3',
  'google/deep-research-max-preview-04-2026',
  'google/deep-research-preview-04-2026',
  'google/gemini-2.5-computer-use-preview-10-2025',
  'google/gemini-2.5-flash',
  'google/gemini-2.5-flash-lite',
  'google/gemini-2.5-pro',
  'google/gemini-3-flash-preview',
  'google/gemini-3.1-flash-lite',
  'google/gemini-3.1-flash-lite-image',
  'google/gemini-3.1-flash-lite-preview',
  'google/gemini-3.1-flash-live-preview',
  'google/gemini-3.1-pro-preview',
  'google/gemini-3.1-pro-preview-customtools',
  'google/gemini-3.5-flash',
  'google/gemini-3.5-flash-lite',
  'google/gemini-3.6-flash',
  'google/gemini-3.7-flash',
  'google/gemini-flash-latest',
  'google/gemini-flash-lite-latest',
  'google/gemini-robotics-er-1.6-preview',
  'google/gemma-4-26b-a4b-it',
  'google/gemma-4-31b-it',
];

const settings = {
  theme: 'dark',
  helperModel: DOGFOOD_MODEL,
  helperReasoningEffort: 'xhigh',
  engineerName: 'dogfood',
  defaultModel: DOGFOOD_MODEL,
  defaultReasoningEffort: 'xhigh',
  healingModel: DOGFOOD_MODEL,
  healingReasoningEffort: 'xhigh',
  smithModel: DOGFOOD_MODEL,
  smithReasoningEffort: 'xhigh',
  compactionThreshold: 0.8,
  notifications: { accepted: true, rejected: true, failed: true },
  dockBadge: false,
  soundEffects: false,
  retentionDays: null,
  onboarded: true,
  hiddenModelIds: HIDDEN_MODELS,
  linearStatusMapping: { started: null, completed: null, failed: null },
};

mkdirSync(supportDir, { recursive: true });

if (existsSync(settingsFile) && !reset) {
  console.log(`dogfood:seed: keeping existing ${settingsFile} (pass -- --reset to rewrite)`);
} else {
  // Atomic write: temp sibling plus rename, the same discipline the app's own
  // JsonStore uses, so a killed seed never leaves a half-written settings file.
  const temp = `${settingsFile}.tmp`;
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(temp, settingsFile);
  console.log(`dogfood:seed: wrote ${settingsFile}`);
}

// Report which secrets still need their one-time entry inside the app. The
// files below are written by the running app when a key is saved in Settings;
// their absence here only means "not saved yet", never an error. pi creates
// an empty auth.json on first launch, so presence alone is not enough — a
// stored login adds entries to it.
const missing = [];
if (!piHasCredential(join(supportDir, 'pi', 'auth.json')))
  missing.push('Meta API key → Settings → Models & agent defaults → Meta key row');
if (!existsSync(join(supportDir, 'credentials', 'gemini-live-api-key.bin')))
  missing.push('Gemini API key → Settings → Integrations → Smith voice mode card');

/** True when pi's auth store holds at least one stored credential. */
function piHasCredential(authFile) {
  try {
    const parsed = JSON.parse(readFileSync(authFile, 'utf8'));
    return !!parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}

if (missing.length > 0) {
  console.log('dogfood:seed: one-time key entry still needed (saved keys persist afterwards):');
  for (const step of missing) console.log(`  - ${step}`);
} else {
  console.log('dogfood:seed: both keys already stored; nothing to enter.');
}
console.log(`dogfood:seed: launch with \`pnpm run dogfood\` (state: ${stateDir})`);
