/**
 * The host's installed skills, custom Droids, and MCP servers — read, never
 * written.
 *
 * Droid discovers all three from the operator's `~/.factory`, which means a
 * Foundry agent would otherwise inherit whatever that person happens to have
 * installed: a different context bill and a different tool surface on every
 * machine, for a pipeline that is supposed to be reproducible. So Foundry reads
 * the install as an inventory, offers it per agent, and enables nothing by
 * default.
 *
 * Two hard rules live here:
 *
 *  1. **Read-only.** Nothing in this file opens a host path for writing. An
 *     agent that needs a skill turned off gets it turned off for that session
 *     (settings complement) or hidden from that session (home overlay) — the
 *     operator's install is left exactly as it was found.
 *  2. **Never throw.** A missing directory, a hand-edited `mcp.json` full of
 *     garbage, or an unreadable skill is a warning on the inventory, not a
 *     failed run. An operator with no `~/.factory` at all gets an empty
 *     inventory, which is the correct answer.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import type {
  AgentInvocables,
  HostDroidInfo,
  HostInvocableInventory,
  HostMcpServerInfo,
  HostSkillInfo,
} from '@shared/types.js';

/** The config directory droid reads. Overridable so tests never touch a real one. */
export function hostFactoryDir(home: string = homedir()): string {
  return join(home, '.factory');
}

/** An empty selection: what every agent gets until an operator opts in. */
export function emptyInvocables(): AgentInvocables {
  return { skills: [], droids: [], hostMcpServers: [], userMcpServers: [] };
}

/** An empty inventory: a host with nothing installed, and the safe default. */
export function emptyInventory(): HostInvocableInventory {
  return { skills: [], droids: [], mcpServers: [], factoryDir: '', warnings: [] };
}

/**
 * Coerce whatever a roster file holds into a selection.
 *
 * Absent, `null`, a string, a partial object, or an array of non-strings all
 * land on "nothing enabled" rather than on a crash or an accidental grant. This
 * is the migration path for every roster written before per-agent selection
 * existed: they have no `invocables` key, so they get the closed default.
 */
export function normalizeInvocables(raw: unknown): AgentInvocables {
  const empty = emptyInvocables();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  const source = raw as Record<string, unknown>;
  const list = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const entry of value) {
      if (typeof entry !== 'string') continue;
      const trimmed = entry.trim();
      if (trimmed && !out.includes(trimmed)) out.push(trimmed);
    }
    return out;
  };
  return {
    skills: list(source.skills),
    droids: list(source.droids),
    hostMcpServers: list(source.hostMcpServers),
    userMcpServers: list(source.userMcpServers),
  };
}

/** True when an agent has opted into nothing at all — the default state. */
export function selectsNothing(selection: AgentInvocables): boolean {
  return (
    selection.skills.length === 0 &&
    selection.droids.length === 0 &&
    selection.hostMcpServers.length === 0 &&
    selection.userMcpServers.length === 0
  );
}

/**
 * Strip common base indentation and fold/literal-join block scalar lines according to style.
 */
function parseBlockScalar(lines: string[], style: '>' | '|', chomping: string): string {
  let baseIndent = -1;
  for (const line of lines) {
    if (line.trim().length > 0) {
      const match = /^([ \t]+)/.exec(line);
      baseIndent = match ? match[1].length : 0;
      break;
    }
  }

  if (baseIndent === -1) return '';

  const stripped: string[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) {
      stripped.push('');
    } else {
      let spaces = 0;
      while (
        spaces < baseIndent &&
        spaces < line.length &&
        (line[spaces] === ' ' || line[spaces] === '\t')
      ) {
        spaces++;
      }
      stripped.push(line.slice(spaces));
    }
  }

  let result = '';
  if (style === '|') {
    result = stripped.join('\n');
  } else {
    for (let i = 0; i < stripped.length; i++) {
      const line = stripped[i];
      if (line === '') {
        result += '\n';
      } else {
        if (result.length > 0 && !result.endsWith('\n')) {
          if (/^[ \t]/.test(line)) {
            result += '\n' + line;
          } else {
            result += ' ' + line;
          }
        } else {
          result += line;
        }
      }
    }
  }

  if (chomping === '+') {
    return result;
  }
  return result.trimEnd();
}

/**
 * Remove matching quotes around a YAML scalar and resolve basic escapes.
 */
function unquoteYamlString(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    const inner = trimmed.slice(1, -1);
    return inner
      .replace(/\r?\n[ \t]*/g, ' ')
      .replace(/''/g, "'")
      .trim();
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    const inner = trimmed.slice(1, -1);
    return inner
      .replace(/\r?\n[ \t]*/g, ' ')
      .replace(/\\([\\"/nrt])/g, (_, ch: string) => {
        switch (ch) {
          case '"':
            return '"';
          case '\\':
            return '\\';
          case 'n':
            return '\n';
          case 'r':
            return '\r';
          case 't':
            return '\t';
          case '/':
            return '/';
          default:
            return ch;
        }
      })
      .trim();
  }
  return trimmed;
}

/**
 * Read `name`/`description` out of YAML front matter, supporting single-line,
 * folded (`>-`, `>`), literal (`|-`, `|`), and multiline indented scalars.
 */
export function frontMatter(text: string): { name?: string; description?: string } {
  if (!text.startsWith('---')) return {};
  const match = /^---[ \t]*(?:\r?\n([\s\S]*?))?\r?\n---(?:[ \t]*(?:\r?\n|$)|$)/.exec(text);
  if (!match || !match[1]) return {};

  const lines = match[1].split(/\r?\n/);
  const out: { name?: string; description?: string } = {};

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*(?:#.*)?$/.test(line)) {
      i++;
      continue;
    }

    const keyMatch = /^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!keyMatch) {
      i++;
      continue;
    }

    const key = keyMatch[1];
    const rawVal = keyMatch[2].trim();
    i++;

    const isTargetKey = key === 'name' || key === 'description';

    const blockMatch = /^([>|])([+-]?)([0-9]*)$/.exec(rawVal);
    if (blockMatch) {
      const style = blockMatch[1] as '>' | '|';
      const chomping = blockMatch[2];
      const blockLines: string[] = [];

      while (i < lines.length) {
        const nextLine = lines[i];
        if (nextLine.length > 0 && !/^\s/.test(nextLine)) {
          break;
        }
        blockLines.push(nextLine);
        i++;
      }

      if (isTargetKey) {
        const parsed = parseBlockScalar(blockLines, style, chomping);
        if (parsed) {
          out[key as 'name' | 'description'] = parsed;
        }
      }
      continue;
    }

    if (rawVal.startsWith('"') || rawVal.startsWith("'")) {
      const quoteChar = rawVal[0];
      let fullQuoted = rawVal;

      const isClosed = (str: string, q: string): boolean => {
        if (str.length < 2 || !str.endsWith(q)) return false;
        if (q === "'") {
          const inner = str.slice(1, -1);
          const trailingQuotes = (inner.match(/'*$/)?.[0] || '').length;
          return trailingQuotes % 2 === 0;
        } else {
          let backslashes = 0;
          for (let p = str.length - 2; p >= 0 && str[p] === '\\'; p--) {
            backslashes++;
          }
          return backslashes % 2 === 0;
        }
      };

      if (!isClosed(fullQuoted, quoteChar)) {
        while (i < lines.length) {
          const nextLine = lines[i];
          if (
            nextLine.length > 0 &&
            !/^\s/.test(nextLine) &&
            /^[a-zA-Z0-9_-]+\s*:/.test(nextLine)
          ) {
            break;
          }
          fullQuoted += '\n' + nextLine;
          i++;
          if (isClosed(fullQuoted, quoteChar)) break;
        }
      }

      if (isTargetKey) {
        const unquoted = unquoteYamlString(fullQuoted);
        if (unquoted) {
          out[key as 'name' | 'description'] = unquoted;
        }
      }
      continue;
    }

    if (rawVal === '') {
      const blockLines: string[] = [];
      while (i < lines.length) {
        const nextLine = lines[i];
        if (nextLine.length > 0 && !/^\s/.test(nextLine)) {
          break;
        }
        blockLines.push(nextLine);
        i++;
      }

      if (isTargetKey) {
        const parts: string[] = [];
        for (const bl of blockLines) {
          const t = bl.trim();
          if (t) parts.push(t);
        }
        const joined = parts.join(' ');
        if (joined) {
          out[key as 'name' | 'description'] = joined;
        }
      }
    } else {
      const continuationLines: string[] = [rawVal];
      while (i < lines.length) {
        const nextLine = lines[i];
        if (nextLine.length > 0 && !/^\s/.test(nextLine)) {
          break;
        }
        if (nextLine.trim() === '') {
          let hasMoreIndented = false;
          for (let j = i + 1; j < lines.length; j++) {
            if (lines[j].trim() === '') continue;
            if (/^\s/.test(lines[j])) hasMoreIndented = true;
            break;
          }
          if (!hasMoreIndented) break;
        }
        continuationLines.push(nextLine.trim());
        i++;
      }

      if (isTargetKey) {
        const joined = continuationLines.filter(Boolean).join(' ').trim();
        if (joined) {
          out[key as 'name' | 'description'] = joined;
        }
      }
    }
  }

  return out;
}

/** First markdown heading or first non-empty prose line, as a fallback label. */
export function firstProse(text: string): string {
  let body = text;
  if (text.startsWith('---')) {
    const match = /^---[ \t]*(?:\r?\n[\s\S]*?)?\r?\n---(?:[ \t]*(?:\r?\n|$)|$)/.exec(text);
    if (match) {
      body = text.slice(match[0].length);
    }
  }
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) return trimmed.replace(/^#+\s*/, '').trim();
    return trimmed;
  }
  return '';
}

/** One line, short enough for a roster row. */
function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Skills are directories with a `SKILL.md`. A directory without one is not a
 * skill and is skipped silently — droid ignores it too.
 */
async function readSkills(factoryDir: string, warnings: string[]): Promise<HostSkillInfo[]> {
  const root = join(factoryDir, 'skills');
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const out: HostSkillInfo[] = [];
  for (const id of entries.sort()) {
    if (id.startsWith('.')) continue;
    const dir = join(root, id);
    try {
      if (!(await stat(dir)).isDirectory()) continue;
      const text = await readFile(join(dir, 'SKILL.md'), 'utf8');
      const meta = frontMatter(text);
      out.push({
        id,
        name: meta.name || id,
        description: oneLine(meta.description || firstProse(text)),
        location: dir,
      });
    } catch (e) {
      // A skill directory with no readable SKILL.md is not offered, but the
      // operator is told why rather than left wondering where it went.
      if (isMissing(e)) continue;
      warnings.push(`skill "${id}" could not be read: ${message(e)}`);
    }
  }
  return out;
}

/** Custom Droids are markdown files (`~/.factory/droids/<id>.md`). */
async function readDroids(factoryDir: string, warnings: string[]): Promise<HostDroidInfo[]> {
  const root = join(factoryDir, 'droids');
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const out: HostDroidInfo[] = [];
  for (const file of entries.sort()) {
    if (file.startsWith('.') || extname(file).toLowerCase() !== '.md') continue;
    const path = join(root, file);
    const id = basename(file, extname(file));
    try {
      const text = await readFile(path, 'utf8');
      const meta = frontMatter(text);
      out.push({
        id,
        name: meta.name || id,
        description: oneLine(meta.description || firstProse(text)),
        location: path,
      });
    } catch (e) {
      if (isMissing(e)) continue;
      warnings.push(`droid "${id}" could not be read: ${message(e)}`);
    }
  }
  return out;
}

/**
 * `~/.factory/mcp.json` holds `{ mcpServers: { <name>: {...} } }`. The file is
 * hand-edited often enough that every field is treated as untrusted: an entry
 * that makes no sense is still listed (so the operator sees it) with an
 * `unknown` transport, and a file that will not parse becomes one warning.
 */
async function readHostMcpServers(
  factoryDir: string,
  warnings: string[],
): Promise<HostMcpServerInfo[]> {
  const path = join(factoryDir, 'mcp.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    warnings.push(`mcp.json could not be parsed: ${message(e)}`);
    return [];
  }
  const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return [];
  const out: HostMcpServerInfo[] = [];
  for (const [id, value] of Object.entries(servers as Record<string, unknown>)) {
    const entry = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    const command = typeof entry.command === 'string' ? entry.command : '';
    const url = typeof entry.url === 'string' ? entry.url : '';
    const declared = typeof entry.type === 'string' ? entry.type.toLowerCase() : '';
    const transport: HostMcpServerInfo['transport'] =
      declared === 'stdio' || declared === 'http' || declared === 'sse'
        ? declared
        : command
          ? 'stdio'
          : url
            ? 'http'
            : 'unknown';
    out.push({
      id,
      name: id,
      transport,
      detail: oneLine(command || url || 'no command or url'),
      disabled: entry.disabled === true,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The whole inventory. Cheap enough to call per run start; not cached, because a
 * stale inventory is how an operator ends up toggling something that is no
 * longer installed.
 */
export async function readHostInvocables(
  opts: { homeDir?: string } = {},
): Promise<HostInvocableInventory> {
  const factoryDir = hostFactoryDir(opts.homeDir);
  const warnings: string[] = [];
  const [skills, droids, mcpServers] = await Promise.all([
    readSkills(factoryDir, warnings),
    readDroids(factoryDir, warnings),
    readHostMcpServers(factoryDir, warnings),
  ]);
  return { skills, droids, mcpServers, factoryDir, warnings };
}

/**
 * Which host entries this agent is hiding.
 *
 * A selection can name something that is no longer installed — the operator
 * uninstalled it, or the roster came from another machine. That is not an error:
 * the id simply does not appear in the inventory, so it cannot be hidden and it
 * cannot be reached either.
 */
export function hiddenFromHost(
  inventory: HostInvocableInventory,
  selection: AgentInvocables,
): { skills: HostSkillInfo[]; droids: HostDroidInfo[]; mcpServers: HostMcpServerInfo[] } {
  const skills = new Set(selection.skills);
  const droids = new Set(selection.droids);
  const mcp = new Set(selection.hostMcpServers);
  return {
    skills: inventory.skills.filter((s) => !skills.has(s.id)),
    droids: inventory.droids.filter((d) => !droids.has(d.id)),
    // A host entry the file itself disables is already unreachable; it is not
    // something this policy has to hide, so it never counts as isolation work.
    mcpServers: inventory.mcpServers.filter((s) => !s.disabled && !mcp.has(s.id)),
  };
}

/**
 * Whether this agent needs a home overlay at all.
 *
 * Droids and host MCP servers are loaded by the CLI from disk before Foundry
 * can say anything about them, so the only way to withhold one is to spawn
 * against a config directory that does not contain it. When there is nothing to
 * withhold — a clean host, or an agent that opted into everything — no overlay
 * is built and the spawn path is exactly what it is on main today.
 */
export function needsHomeOverlay(
  inventory: HostInvocableInventory,
  selection: AgentInvocables,
): boolean {
  const hidden = hiddenFromHost(inventory, selection);
  return hidden.droids.length > 0 || hidden.mcpServers.length > 0;
}

/**
 * Whether this agent needs the settings complement to hide host skills.
 *
 * Skills are not withheld by the overlay: droid resolves them per session and
 * the supported way to take one away is `disabledToolIds`. That needs a tool
 * list, which is why a transport that cannot enumerate tools has to fail closed
 * (see `AgentSession`) instead of running an agent with skills it never got.
 */
export function needsSkillComplement(
  inventory: HostInvocableInventory,
  selection: AgentInvocables,
): boolean {
  return hiddenFromHost(inventory, selection).skills.length > 0;
}

/**
 * The tool ids that carry the host skills this agent did not select.
 *
 * The wire id for a skill tool is not documented and has changed shape before,
 * so this matches structurally rather than by format: a tool counts as a skill
 * tool when its category says skill, and it belongs to a hidden skill when the
 * skill's id or name appears in its id or display name. Anything that is not
 * recognisably a skill tool is left alone — this function only ever subtracts
 * skills, and never the Foundry MCP tools or an ordinary builtin.
 */
export function hiddenSkillToolIds(
  tools: { id: string; displayName?: string; category?: string }[],
  hiddenSkills: { id: string; name: string }[],
): string[] {
  if (!hiddenSkills.length) return [];
  const keys = new Set<string>();
  for (const skill of hiddenSkills) {
    keys.add(normalizeKey(skill.id));
    keys.add(normalizeKey(skill.name));
  }
  keys.delete('');
  const out = new Set<string>();
  for (const tool of tools) {
    if (!isSkillTool(tool)) continue;
    const haystacks = [normalizeKey(tool.id), normalizeKey(tool.displayName ?? '')];
    for (const key of keys) {
      if (haystacks.some((h) => h === key || h.includes(key))) {
        out.add(tool.id);
        break;
      }
    }
  }
  return [...out].sort();
}

/** A tool is a skill tool when it says so — by category, or by an id prefix. */
function isSkillTool(tool: { id: string; category?: string }): boolean {
  if ((tool.category ?? '').toLowerCase().includes('skill')) return true;
  return /(^|[^a-z])skill([^a-z]|$)/i.test(tool.id);
}

/** Compare ids and names without punctuation, which the wire format varies. */
function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isMissing(e: unknown): boolean {
  return (e as { code?: string })?.code === 'ENOENT';
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
