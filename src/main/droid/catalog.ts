/**
 * Droid's model and tool discovery. The catalog is advisory and the CLI is
 * authoritative: an unknown-but-typed model id is allowed with a warning;
 * failure (if any) surfaces on the first turn, in the trace, attributed to its
 * phase.
 *
 * Sources, cheapest first: `droid exec --help`, a session's `availableModels`,
 * and `~/.factory/settings.json` customModels for BYOK badges. Tools are the
 * one thing only a session can answer for, so the last session's list is kept
 * here rather than re-derived by a child process.
 *
 * Only droid publishes a table this rich. Every other vendor answers through its
 * own adapter in `cli/`, which is why the exported names here say droid: the
 * cache below is keyed to nothing, so a shared name would serve one CLI's models
 * to another.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ModelInfo, ToolInfo } from '@shared/types.js';
import type { AvailableModel } from './protocol.js';
import { spawnEnv } from '../system/env.js';

const execFileAsync = promisify(execFile);

/**
 * Every child this module has spawned. Tools refresh must leave it empty — the
 * argv shim alone only sees spawns of the configured droid path, and a
 * regression that shells out to a hard-coded binary would slip past that.
 *
 * Capped so production does not retain an unbounded argv history for the
 * lifetime of the app; tests drain via takeDiscoverySpawns before it grows.
 */
const DISCOVERY_SPAWN_CAP = 200;
let discoverySpawns: { file: string; args: string[] }[] = [];

/** Drain the spawn log. Tests assert a tools refresh leaves it empty. */
export function takeDiscoverySpawns(): { file: string; args: string[] }[] {
  const out = discoverySpawns;
  discoverySpawns = [];
  return out;
}

/**
 * Every discovery call goes through the resolved PATH: a GUI launch cannot see
 * a CLI installed under ~/.npm-global, and a catalog that comes back empty
 * reads as an unauthenticated CLI rather than an unreachable one.
 */
const exec = (
  file: string,
  args: string[],
  options: { timeout?: number; maxBuffer?: number } = {},
): Promise<{ stdout: string; stderr: string }> => {
  discoverySpawns.push({ file, args: [...args] });
  if (discoverySpawns.length > DISCOVERY_SPAWN_CAP) discoverySpawns.shift();
  return execFileAsync(file, args, { ...options, encoding: 'utf8', env: spawnEnv() });
};

export interface CustomModelEntry {
  /** droid writes the id it will accept on the wire; never re-derive one. */
  id?: string;
  model: string;
  displayName: string;
  baseUrl?: string;
  provider?: string;
  maxOutputTokens?: number;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
}

/** The two layers that cost a subprocess or a disk read, never the session one. */
let cache: { help: ModelInfo[]; custom: CustomModelEntry[]; at: number; droidPath: string } | null =
  null;
const CACHE_MS = 60_000;

/** What the last session that started said droid can reach, if any has. */
let sessionModels: AvailableModel[] = [];
let sessionTools: ToolInfo[] = [];

const EFFORT_RE =
  /^\s+-\s+(.+?):\s+supports reasoning:\s+(Yes|No);\s+supported:\s+\[(.*?)\];\s+default:\s+(\S+)/;
const MODEL_LINE_RE = /^\s{2,}(\S+)\s{2,}(.+?)\s*$/;

export function invalidateCatalog(): void {
  cache = null;
  // A different droid path is a different install: its session's models and
  // tools describe the old binary, so they are dropped with the scrape.
  sessionModels = [];
  sessionTools = [];
}

/**
 * droid's own model list for a live session, which is richer than the `--help`
 * table (deprecation, per-model efforts) and is the only place a model the org
 * enabled after this install shows up.
 *
 * An empty list means the session did not answer (or the transport could not
 * report models); the last known non-empty list is kept rather than clearing
 * the picker to blank mid-run. If clearing were intended, call
 * invalidateCatalog() explicitly.
 */
export function noteSessionModels(models: AvailableModel[]): void {
  if (models.length) sessionModels = models;
}

/**
 * The tool set a live session reports. Only a session knows it — `ToolInfo.id`
 * is the llmId a roster's allowlist names — so this replaces the discovery
 * child `droid exec --list-tools` used to spawn.
 *
 * Same empty-list semantics as noteSessionModels: keep the last known list
 * when a session reports zero tools rather than clearing droidTools() to [].
 */
export function noteSessionTools(tools: ToolInfo[]): void {
  if (tools.length) sessionTools = tools;
}

/**
 * The last session's tool set, or an empty list before any session has run.
 * Cold start is the normal case for a fresh app: nothing to enumerate is the
 * honest answer, and it costs no child process to give.
 */
export function droidTools(): Promise<ToolInfo[]> {
  return Promise.resolve(sessionTools.map((tool) => ({ ...tool })));
}

/** A CLI's own version string, or null when the binary is not runnable. */
export async function cliVersion(
  binPath: string,
  args: string[] = ['--version'],
): Promise<string | null> {
  try {
    const { stdout } = await exec(binPath, args, { timeout: 20_000 });
    // Some CLIs print a banner under the version; the first line is the version.
    return stdout.trim().split('\n')[0]?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * `droid exec --help` prints the model table — the only discovery path that
 * needs no session and no network of our own.
 */
export async function modelsFromHelp(droidPath: string): Promise<ModelInfo[]> {
  let text = '';
  try {
    const { stdout } = await exec(droidPath, ['exec', '--help'], {
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    text = stdout;
  } catch {
    return [];
  }

  const efforts = new Map<string, { supported: string[]; def: string }>();
  const pending: { id: string; displayName: string; isCustom: boolean }[] = [];
  let section: 'none' | 'models' | 'custom' = 'none';

  for (const line of text.split('\n')) {
    const detail = line.match(EFFORT_RE);
    if (detail) {
      efforts.set(detail[1]!.trim(), {
        supported: detail[3]!
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        def: detail[4]!.trim(),
      });
      continue;
    }

    if (/^Available Models:/.test(line)) {
      section = 'models';
      continue;
    }
    if (/^Custom Models:/.test(line)) {
      section = 'custom';
      continue;
    }
    if (/^Model details:/.test(line)) {
      section = 'none';
      continue;
    }
    if (section === 'none') continue;

    const m = line.match(MODEL_LINE_RE);
    if (!m) continue;
    const id = m[1]!;
    const displayName = m[2]!.replace(/\s*\(default\)\s*$/, '').trim();
    pending.push({
      id,
      displayName,
      isCustom: section === 'custom' || id.startsWith('custom:'),
    });
  }

  return pending.map(({ id, displayName, isCustom }) => {
    const effort = efforts.get(displayName);
    return {
      id,
      displayName,
      provider: providerOf(id, displayName),
      supportedReasoningEfforts: effort?.supported ?? [],
      defaultReasoningEffort: effort?.def ?? 'none',
      isCustom,
      deprecated: false,
    };
  });
}

export function mergeSessionModels(base: ModelInfo[], session: AvailableModel[]): ModelInfo[] {
  const byId = new Map(base.map((m) => [m.id, m]));
  for (const s of session) {
    byId.set(s.id, {
      id: s.id,
      displayName: s.displayName,
      provider: s.modelProvider || providerOf(s.id, s.displayName),
      supportedReasoningEfforts: s.supportedReasoningEfforts ?? [],
      defaultReasoningEffort: s.defaultReasoningEffort ?? 'none',
      isCustom: !!s.isCustom || s.id.startsWith('custom:'),
      deprecated: !!s.deprecated,
    });
  }
  return [...byId.values()];
}

export async function customModels(): Promise<CustomModelEntry[]> {
  try {
    const raw = await readFile(join(homedir(), '.factory', 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw) as { customModels?: CustomModelEntry[] };
    return parsed.customModels ?? [];
  } catch {
    return [];
  }
}

/** Provider identity drives the icon in the picker; the id is the only signal. */
export function providerOf(id: string, displayName = ''): string {
  const s = `${id} ${displayName}`.toLowerCase();
  if (
    s.includes('claude') ||
    s.includes('opus') ||
    s.includes('sonnet') ||
    s.includes('haiku') ||
    s.includes('fable')
  ) {
    return 'claude';
  }
  if (s.includes('gpt') || s.includes('codex') || s.includes('openai')) return 'openai';
  if (s.includes('gemini')) return 'gemini';
  if (s.includes('gemma')) return 'gemma';
  if (s.includes('palm')) return 'palm';
  if (s.includes('kimi') || s.includes('moonshot')) return 'kimi';
  if (s.includes('glm') || s.includes('zai') || s.includes('z.ai') || s.includes('zhipu')) {
    return 'zai';
  }
  if (s.includes('deepseek')) return 'deepseek';
  if (s.includes('minimax')) return 'minimax';
  if (s.includes('nemotron')) return 'nvidia';
  if (s.includes('grok')) return 'grok';
  if (s.includes('meta') || s.includes('llama')) return 'meta';
  // Inkling and Auto are Factory's own Droid-Core models, not a third lab, so
  // they take the Factory mark rather than the OpenAI fallback below.
  if (s.includes('inkling') || s.includes('auto model')) return 'droid';
  return 'openai';
}

/**
 * settings.json is a source of metadata for models droid already lists, never a
 * source of ids. An id derived from the display name (`custom:DroidProxy:-Opus-5-2`
 * for `custom:droidproxy:opus-5`) is accepted by update_session_settings and then
 * yields empty turns, which reads as a broken agent rather than a bad id.
 */
export function mergeCustomModels(base: ModelInfo[], custom: CustomModelEntry[]): ModelInfo[] {
  const byId = new Map(base.map((m) => [m.id, m]));
  for (const c of custom) {
    const id = c.id?.trim();
    if (!id) continue;
    const existing = byId.get(id);
    // `Model details:` in --help covers built-ins only, so a custom model's
    // efforts are known only here. Without them every effort looks unsupported
    // and is dropped before the session settings call.
    byId.set(id, {
      id,
      displayName: c.displayName || existing?.displayName || id,
      provider: existing?.provider ?? providerOf(c.model, c.displayName),
      supportedReasoningEfforts:
        c.supportedReasoningEfforts ?? existing?.supportedReasoningEfforts ?? [],
      defaultReasoningEffort:
        c.defaultReasoningEffort ?? existing?.defaultReasoningEffort ?? 'none',
      isCustom: true,
      deprecated: existing?.deprecated ?? false,
    });
  }
  return [...byId.values()];
}

/**
 * The picker's list. Three layers, cheapest first and each allowed to correct
 * the one under it: the session-free `--help` scrape, then whatever a live
 * session has since reported, then settings.json — which stays on top because
 * it is the only source of a custom model's reasoning efforts.
 *
 * Only the two subprocess/disk layers are cached; a session that starts after a
 * refresh must still reach the next reader.
 */
export async function loadDroidCatalog(droidPath: string, force = false): Promise<ModelInfo[]> {
  if (force || !cache || cache.droidPath !== droidPath || Date.now() - cache.at >= CACHE_MS) {
    cache = {
      help: await modelsFromHelp(droidPath),
      custom: await customModels(),
      at: Date.now(),
      droidPath,
    };
  }
  return mergeCustomModels(mergeSessionModels(cache.help, sessionModels), cache.custom);
}

export function isKnownModel(models: ModelInfo[], id: string): boolean {
  return models.some((m) => m.id === id);
}
