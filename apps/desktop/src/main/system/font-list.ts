/**
 * Installed-font enumeration for the Appearance font preference.
 *
 * Main-side only: the renderer never spawns. Primary mechanism is the
 * absolute-path `system_profiler SPFontsDataType -json` (macOS-supported,
 * no new native module, no network); a font-directory scan is the fallback.
 * Best-effort by contract: every failure mode returns `[]`, never rejects
 * across IPC. Results are cached per process — fonts rarely change
 * mid-session — and the pure parser is exported for tests.
 */

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import { spawnEnv } from './env.js';

const execFileAsync = promisify(execFile);

/** Absolute path: a GUI launch inherits launchd's PATH, not the user's. */
const SYSTEM_PROFILER = '/usr/sbin/system_profiler';
const PROFILER_TIMEOUT_MS = 10_000;
const PROFILER_MAX_BUFFER = 32 * 1024 * 1024;
/** Guards against a pathological font library; the picker cannot show more. */
const MAX_FONTS = 2000;

const FONT_DIRS = (): string[] => [
  join(homedir(), 'Library', 'Fonts'),
  '/Library/Fonts',
  '/System/Library/Fonts',
  join('/System/Library/Fonts', 'Supplemental'),
];

const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.woff', '.woff2']);

let cached: string[] | null = null;

/** Test seam: drops the per-process cache. */
export function clearFontCacheForTest(): void {
  cached = null;
}

/**
 * Pure parser for `system_profiler SPFontsDataType -json`. Tolerates shape
 * drift across macOS releases: missing keys and garbage JSON yield `[]`,
 * entries are trimmed, empties dropped, duplicates removed
 * case-insensitively keeping first-seen casing, sorted locale-aware.
 */
export function parseSystemProfiler(json: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return [];
  }
  const collected: string[] = [];
  collectFamilies(parsed, collected);
  return normalizeFamilies(collected);
}

function collectFamilies(node: unknown, out: string[]): void {
  if (node == null) return;
  if (typeof node === 'string') return;
  if (Array.isArray(node)) {
    for (const item of node) collectFamilies(item, out);
    return;
  }
  if (typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  // Preferred keys first; `_name` is what SPFontsDataType uses for the family
  // row, with individual faces nested under `_items`.
  for (const key of ['family', 'Family', 'familyName', '_name']) {
    const candidate = record[key];
    if (typeof candidate === 'string') {
      const cleaned = cleanFamilyName(candidate);
      if (cleaned) out.push(cleaned);
      break;
    }
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object') collectFamilies(value, out);
  }
}

/**
 * Strips file-path noise from a raw name: a `_name` that is really
 * `Helvetica.ttc` still identifies the Helvetica family.
 */
function cleanFamilyName(raw: string): string | null {
  let name = raw.trim();
  if (!name) return null;
  if (name.includes('/')) name = basename(name);
  name = name.trim();
  const lower = name.toLowerCase();
  for (const ext of FONT_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      name = name.slice(0, -ext.length).trim();
      break;
    }
  }
  if (!name) return null;
  if (name.includes('/') || name.includes('\0')) return null;
  return name;
}

function normalizeFamilies(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= MAX_FONTS) break;
  }
  out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return out;
}

function familyFromFileName(file: string): string | null {
  const dot = file.lastIndexOf('.');
  const stem = (dot > 0 ? file.slice(0, dot) : file).trim();
  if (!stem) return null;
  // `SomeFont-Regular` still reads as the family in a picker.
  const cleaned = stem
    .replace(/[_]+/g, ' ')
    .replace(/-Regular$/i, '')
    .trim();
  return cleaned || null;
}

async function listFromFontDirs(): Promise<string[]> {
  const collected: string[] = [];
  for (const dir of FONT_DIRS()) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const lower = entry.toLowerCase();
      const dot = lower.lastIndexOf('.');
      if (dot < 0 || !FONT_EXTENSIONS.has(lower.slice(dot))) continue;
      const family = familyFromFileName(entry);
      if (family) collected.push(family);
    }
  }
  return normalizeFamilies(collected);
}

/**
 * Lists installed font families, cached per process. Never rejects: every
 * spawn, timeout, parse, and filesystem failure degrades to the directory
 * fallback and finally to `[]`.
 */
export async function listInstalledFonts(): Promise<string[]> {
  if (cached) return cached;
  try {
    const { stdout } = await execFileAsync(SYSTEM_PROFILER, ['SPFontsDataType', '-json'], {
      timeout: PROFILER_TIMEOUT_MS,
      maxBuffer: PROFILER_MAX_BUFFER,
      env: spawnEnv(),
    });
    const parsed = parseSystemProfiler(stdout);
    if (parsed.length > 0) {
      cached = parsed;
      return cached;
    }
  } catch {
    // Fall through to the directory scan below.
  }
  try {
    cached = await listFromFontDirs();
    return cached;
  } catch {
    cached = [];
    return cached;
  }
}
