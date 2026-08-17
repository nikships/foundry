/**
 * The roster is app state with a full editor, not a hand-edited file: agents are
 * JSON documents, so sharing one is sending a file.
 *
 * A project may keep its own copy. The lookup order is project-then-app, so a
 * project that opted in is fully independent of later app-level edits.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { BUILTIN_ENVELOPE_KINDS, type AgentDef, type ValidationIssue } from '@shared/types.js';
import { JsonStore } from './json-store.js';
import { BUILTIN_AGENTS } from './builtin-agents.js';

export const agentSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(
      /^[a-z][a-z0-9_-]*$/,
      'lowercase letters, digits, dash, underscore; must start with a letter',
    ),
  purpose: z.string().min(1, 'one line on what this agent is for'),
  // Unknown or legacy CLI values coerce to droid.
  cli: z.preprocess(
    (val) => (typeof val === 'string' && val !== 'droid' ? 'droid' : val),
    z.enum(['droid']).optional(),
  ),
  model: z.string().min(1),
  reasoningEffort: z.enum(['off', 'low', 'medium', 'high', 'xhigh', 'max']),
  inheritDefaults: z.boolean().optional(),
  systemPrompt: z.string().min(1),
  userPrompt: z.string().min(1),
  writes: z.array(z.string()).nullable(),
  // Built-in kind or a custom envelope library name.
  envelope: z.string().min(1),
  customFields: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z][a-z0-9_]*$/, 'snake_case field name'),
        type: z.enum(['string', 'number', 'boolean', 'string[]']),
        required: z.boolean(),
        description: z.string().optional(),
      }),
    )
    .optional(),
  tools: z.array(z.string()).optional(),
  disabledTools: z.array(z.string()).optional(),
  // Absent reads as `full`, so every built-in and every pre-profile roster keeps
  // the tool surface it had. An unknown value is rejected rather than coerced:
  // guessing which profile an operator meant is how least privilege gets wider.
  toolProfile: z.enum(['full', 'read-only', 'review', 'custom']).optional(),
  // Host invocables are opt-in per agent. The whole object is optional and each
  // list defaults to empty, so a roster written before this field existed reads
  // as "nothing enabled" — the closed default, not a silent grant.
  invocables: z
    .object({
      skills: z.array(z.string()).default([]),
      droids: z.array(z.string()).default([]),
      hostMcpServers: z.array(z.string()).default([]),
      userMcpServers: z.array(z.string()).default([]),
    })
    .optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a hex colour like #5ad2dd'),
  // Absent / `monogram` = initial; a library id or shipped portrait token;
  // `image:<file>` = a user upload. Empty string is treated as absent.
  emblem: z.preprocess(
    (val) => (val === '' ? undefined : val),
    z
      .string()
      .regex(
        /^(monogram|[a-z][a-z0-9_-]*|image:[a-z0-9]+\.(png|jpg|webp|gif|svg))$/,
        'monogram, a library or portrait id, or image:<file>',
      )
      .optional(),
  ),
  builtin: z.boolean().optional(),
});

/** Edit-time rail: same rules save uses, so the designer learns before clicking Save. */
export function validate(agent: AgentDef, knownEnvelopes: string[] = []): ValidationIssue[] {
  const parsed = agentSchema.safeParse(agent);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => ({
      level: 'error' as const,
      where: i.path.join('.') || agent.name || 'agent',
      message: i.message,
    }));
  }
  const known = new Set([...BUILTIN_ENVELOPE_KINDS, ...knownEnvelopes]);
  if (agent.envelope && !known.has(agent.envelope)) {
    return [
      {
        level: 'warning',
        where: 'envelope',
        message: `envelope "${agent.envelope}" is not in the library — runs will fall back to generic`,
      },
    ];
  }
  return [];
}

export class RosterStore {
  private readonly appStore: JsonStore<AgentDef[]>;
  private readonly projectStores = new Map<string, JsonStore<AgentDef[]>>();

  constructor(private readonly appSupportDir: string) {
    this.appStore = new JsonStore<AgentDef[]>(
      join(appSupportDir, 'roster.json'),
      () => BUILTIN_AGENTS.map((a) => ({ ...a })),
      (raw) => {
        const list = Array.isArray(raw) ? (raw as AgentDef[]) : [];
        // A roster missing a shipped agent would break the built-in pipelines
        // that name it, so absent built-ins are restored rather than assumed.
        const shipped = new Set(BUILTIN_AGENTS.map((a) => a.name));
        // An agent forked off a built-in used to inherit `builtin: true`, which
        // hides its own Delete button. The flag says where an agent came from,
        // so a name that was never shipped cannot legitimately carry it.
        const sanitize = (a: AgentDef): AgentDef => ({
          ...a,
          cli: a.cli && a.cli !== 'droid' ? 'droid' : a.cli,
        });
        const byName = new Map(
          list.map((a) => [
            a.name,
            shipped.has(a.name) ? sanitize(a) : { ...sanitize(a), builtin: false },
          ]),
        );
        for (const builtin of BUILTIN_AGENTS) {
          if (!byName.has(builtin.name)) byName.set(builtin.name, { ...builtin });
        }
        return [...byName.values()];
      },
    );
  }

  private projectStore(projectId: string): JsonStore<AgentDef[]> {
    let store = this.projectStores.get(projectId);
    if (!store) {
      store = new JsonStore<AgentDef[]>(
        join(this.appSupportDir, 'project-overrides', projectId, 'roster.json'),
        () => this.appStore.read().map((a) => ({ ...a })),
      );
      this.projectStores.set(projectId, store);
    }
    return store;
  }

  private storeFor(opts: { projectId?: string; ownRoster?: boolean } = {}): JsonStore<AgentDef[]> {
    return opts.projectId && opts.ownRoster ? this.projectStore(opts.projectId) : this.appStore;
  }

  /**
   * Whether this project already has a roster file on disk. Turning `ownRoster`
   * off leaves the copy in place, so re-enabling restores that older copy
   * instead of seeding a fresh one — the UI has to say which is about to
   * happen, and only the file's existence distinguishes them.
   */
  hasProjectCopy(projectId: string): boolean {
    return existsSync(this.projectStore(projectId).filePath);
  }

  list(opts: { projectId?: string; ownRoster?: boolean } = {}): AgentDef[] {
    return this.storeFor(opts).read();
  }

  get(name: string, opts: { projectId?: string; ownRoster?: boolean } = {}): AgentDef | null {
    return this.list(opts).find((a) => a.name === name) ?? null;
  }

  save(
    agent: AgentDef,
    opts: { projectId?: string; ownRoster?: boolean } = {},
    knownEnvelopes: string[] = [],
  ): { ok: true; agents: AgentDef[] } | { ok: false; issues: ValidationIssue[] } {
    const issues = validate(agent, knownEnvelopes);
    // Warnings (unknown envelope name) must not block autosave.
    if (issues.some((i) => i.level === 'error')) return { ok: false, issues };
    const value = agentSchema.parse(agent) as AgentDef;
    const next = this.storeFor(opts).update((current) =>
      upsertBy(current, (a) => a.name === value.name, value),
    );
    return { ok: true, agents: next };
  }

  /**
   * A rename is not a save under a new key: `save` upserts by name, so it would
   * append a second agent and leave the original behind.
   *
   * A shipped agent forks instead of moving, because `migrate` restores any
   * absent built-in on the next read — renaming one in place would bring the
   * old name back on the next launch, silently, as a duplicate.
   */
  rename(
    from: string,
    to: string,
    opts: { projectId?: string; ownRoster?: boolean } = {},
  ): { ok: true; agents: AgentDef[]; forked: boolean } | { ok: false; issues: ValidationIssue[] } {
    const source = this.get(from, opts);
    if (!source) {
      return {
        ok: false,
        issues: [{ level: 'error', where: 'name', message: `no agent named "${from}"` }],
      };
    }
    if (to === from) return { ok: true, agents: this.list(opts), forked: false };

    const named = agentSchema.shape.name.safeParse(to);
    if (!named.success) {
      return {
        ok: false,
        issues: named.error.issues.map((i) => ({
          level: 'error' as const,
          where: 'name',
          message: i.message,
        })),
      };
    }
    if (this.get(to, opts)) {
      return {
        ok: false,
        issues: [
          { level: 'error', where: 'name', message: `an agent named "${to}" already exists` },
        ],
      };
    }

    const forked = source.builtin === true;
    const renamed: AgentDef = { ...source, name: to, builtin: false };
    const agents = this.storeFor(opts).update((current) =>
      forked ? [...current, renamed] : current.map((a) => (a.name === from ? renamed : a)),
    );
    return { ok: true, agents, forked };
  }

  remove(name: string, opts: { projectId?: string; ownRoster?: boolean } = {}): AgentDef[] {
    return this.storeFor(opts).update((current) => current.filter((a) => a.name !== name));
  }

  duplicate(name: string, opts: { projectId?: string; ownRoster?: boolean } = {}): AgentDef | null {
    const source = this.get(name, opts);
    if (!source) return null;
    const existing = new Set(this.list(opts).map((a) => a.name));
    const copy: AgentDef = {
      ...source,
      name: uniqueCopyName(name, existing),
      builtin: false,
    };
    this.save(copy, opts);
    return copy;
  }

  resetToBuiltins(): AgentDef[] {
    return this.appStore.write(BUILTIN_AGENTS.map((a) => ({ ...a })));
  }
}

function upsertBy<T>(list: T[], match: (item: T) => boolean, value: T): T[] {
  const index = list.findIndex(match);
  if (index < 0) return [...list, value];
  const copy = [...list];
  copy[index] = value;
  return copy;
}

function uniqueCopyName(base: string, existing: Set<string>): string {
  let candidate = `${base}-copy`;
  let n = 2;
  while (existing.has(candidate)) candidate = `${base}-copy-${n++}`;
  return candidate;
}
