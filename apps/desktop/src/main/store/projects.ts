/**
 * Projects: per-repo settings, stored app-side so the repo needs no gitignore
 * hygiene for Foundry to work, with an optional export to
 * `{repo}/.foundry/project.json` for people who do want it in the tree.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { ProjectDef, ValidationIssue } from '@shared/types.js';
import { JsonStore } from './json-store.js';

export const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  baseRef: z.string().min(1),
  isolation: z.boolean(),
  mergePolicy: z.enum(['auto', 'ask', 'never']),
  commands: z.array(z.object({ name: z.string().min(1), argv: z.array(z.string().min(1)).min(1) })),
  protectedPaths: z.array(z.string()),
  ownRoster: z.boolean(),
  ownPipelines: z.boolean(),
  scaffold: z.boolean().optional(),
  addedAt: z.string(),
});

export function projectIdFor(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 16);
}

export function defaultProject(path: string): ProjectDef {
  return {
    id: projectIdFor(path),
    name: basename(path),
    path,
    baseRef: 'main',
    isolation: true,
    mergePolicy: 'ask',
    commands: [],
    protectedPaths: [],
    ownRoster: false,
    ownPipelines: false,
    addedAt: new Date().toISOString(),
  };
}

export class ProjectStore {
  private readonly store: JsonStore<ProjectDef[]>;

  constructor(appSupportDir: string) {
    this.store = new JsonStore<ProjectDef[]>(join(appSupportDir, 'projects.json'), () => []);
  }

  list(): ProjectDef[] {
    return this.store.read();
  }

  get(id: string): ProjectDef | null {
    return this.list().find((p) => p.id === id) ?? null;
  }

  add(path: string, baseRef?: string, opts: { scaffold?: boolean } = {}): ProjectDef {
    const existing = this.list().find((p) => p.path === path);
    if (existing) return existing;
    const project = defaultProject(path);
    if (baseRef) project.baseRef = baseRef;
    if (opts.scaffold) project.scaffold = true;
    this.store.update((current) => [...current, project]);
    return project;
  }

  save(
    project: ProjectDef,
  ): { ok: true; projects: ProjectDef[] } | { ok: false; issues: ValidationIssue[] } {
    const parsed = projectSchema.safeParse(project);
    if (!parsed.success) {
      return {
        ok: false,
        issues: parsed.error.issues.map((i) => ({
          level: 'error' as const,
          where: i.path.join('.'),
          message: i.message,
        })),
      };
    }
    const next = this.store.update((current) => {
      const index = current.findIndex((p) => p.id === project.id);
      if (index < 0) return [...current, parsed.data];
      const copy = [...current];
      copy[index] = parsed.data;
      return copy;
    });
    return { ok: true, projects: next };
  }

  remove(id: string): ProjectDef[] {
    return this.store.update((current) => current.filter((p) => p.id !== id));
  }

  export(project: ProjectDef): string {
    const dir = join(project.path, '.foundry');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'project.json');
    writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);
    return file;
  }

  exists(project: ProjectDef): boolean {
    return existsSync(project.path);
  }
}
