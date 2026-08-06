/**
 * Model and tool discovery. The catalog is advisory and droid is authoritative:
 * an unknown-but-typed model id is allowed with a warning; failure (if any)
 * surfaces on the first turn, in the trace, attributed to its phase.
 *
 * Sources, cheapest first: `droid exec --help`, a session's `availableModels`,
 * and `~/.factory/settings.json` customModels for BYOK badges.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ModelInfo, ToolInfo } from '@shared/types.js';
import type { AvailableModel } from './protocol.js';

const exec = promisify(execFile);

export interface CustomModelEntry {
  model: string;
  displayName: string;
  baseUrl?: string;
  provider?: string;
  maxOutputTokens?: number;
}

let cache: { models: ModelInfo[]; at: number } | null = null;
const CACHE_MS = 60_000;

const EFFORT_RE =
  /^\s+-\s+(.+?):\s+supports reasoning:\s+(Yes|No);\s+supported:\s+\[(.*?)\];\s+default:\s+(\S+)/;
const MODEL_LINE_RE = /^\s{2,}(\S+)\s{2,}(.+?)\s*$/;

export function invalidateCatalog(): void {
  cache = null;
}

export async function droidVersion(droidPath: string): Promise<string | null> {
  try {
    const { stdout } = await exec(droidPath, ['--version'], { timeout: 20_000 });
    return stdout.trim();
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
        supported: detail[3]!.split(',').map((s) => s.trim()).filter(Boolean),
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
  if (s.includes('kimi') || s.includes('moonshot')) return 'kimi';
  if (s.includes('glm') || s.includes('zai') || s.includes('z.ai')) return 'zai';
  return 'openai';
}

export async function loadCatalog(droidPath: string, force = false): Promise<ModelInfo[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.models;

  const fromHelp = await modelsFromHelp(droidPath);
  const custom = await customModels();
  const byId = new Map(fromHelp.map((m) => [m.id, m]));

  for (const [index, c] of custom.entries()) {
    const id = `custom:${c.displayName.replace(/\s+/g, '-')}-${index}`;
    if (byId.has(id)) continue;
    byId.set(id, {
      id,
      displayName: c.displayName,
      provider: providerOf(c.model, c.displayName),
      supportedReasoningEfforts: [],
      defaultReasoningEffort: 'none',
      isCustom: true,
      deprecated: false,
    });
  }

  const models = [...byId.values()];
  cache = { models, at: Date.now() };
  return models;
}

export async function loadTools(droidPath: string, model?: string): Promise<ToolInfo[]> {
  const args = ['exec', '--list-tools', '--output-format', 'json'];
  if (model) args.push('-m', model);
  try {
    const { stdout } = await exec(droidPath, args, {
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as { tools?: ToolInfo[] } | ToolInfo[];
    const tools = Array.isArray(parsed) ? parsed : (parsed.tools ?? []);
    return tools.map(({ id, llmId, displayName, description, category, defaultAllowed }) => ({
      id,
      llmId,
      displayName,
      description,
      category,
      defaultAllowed,
    }));
  } catch {
    return [];
  }
}

export function isKnownModel(models: ModelInfo[], id: string): boolean {
  return models.some((m) => m.id === id);
}
