/**
 * The roster is app state with a full editor, not a hand-edited file: agents are
 * JSON documents, so sharing one is sending a file.
 *
 * A project may keep its own copy. The lookup order is project-then-app, so a
 * project that opted in is fully independent of later app-level edits.
 */

import { join } from 'node:path';
import { z } from 'zod';
import type { AgentDef, ValidationIssue } from '@shared/types.js';
import { JsonStore } from './json-store.js';
import { BUILTIN_AGENTS } from './builtin-agents.js';

export const agentSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9_-]*$/, 'lowercase letters, digits, dash, underscore; must start with a letter'),
  purpose: z.string().min(1, 'one line on what this agent is for'),
  model: z.string().min(1),
  reasoningEffort: z.enum(['off', 'low', 'medium', 'high']),
  systemPrompt: z.string().min(1),
  userPrompt: z.string().min(1),
  writes: z.array(z.string()).nullable(),
  envelope: z.enum(['generic', 'plan', 'build', 'scout', 'review', 'document']),
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
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a hex colour like #5ad2dd'),
  emblem: z.string().optional(),
  builtin: z.boolean().optional(),
});

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
        const byName = new Map(list.map((a) => [a.name, a]));
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

  list(opts: { projectId?: string; ownRoster?: boolean } = {}): AgentDef[] {
    return this.storeFor(opts).read();
  }

  get(name: string, opts: { projectId?: string; ownRoster?: boolean } = {}): AgentDef | null {
    return this.list(opts).find((a) => a.name === name) ?? null;
  }

  save(
    agent: AgentDef,
    opts: { projectId?: string; ownRoster?: boolean } = {},
  ): { ok: true; agents: AgentDef[] } | { ok: false; issues: ValidationIssue[] } {
    const parsed = agentSchema.safeParse(agent);
    if (!parsed.success) {
      return {
        ok: false,
        issues: parsed.error.issues.map((i) => ({
          level: 'error' as const,
          where: i.path.join('.') || agent.name,
          message: i.message,
        })),
      };
    }
    const value = parsed.data as AgentDef;
    const next = this.storeFor(opts).update((current) => upsertBy(current, (a) => a.name === value.name, value));
    return { ok: true, agents: next };
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
