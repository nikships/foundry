/**
 * Shared library of named custom envelopes. App-level only: project-scoped
 * rosters and pipelines resolve against the same list, so a name means one
 * shape everywhere.
 */

import { join } from 'node:path';
import { z } from 'zod';
import { BUILTIN_ENVELOPE_KINDS, type EnvelopeDef, type ValidationIssue } from '@shared/types.js';
import { JsonStore } from './json-store.js';
import { uniqueCopyName, upsertBy } from './collections.js';

/** Base fields every envelope carries; custom fields may not collide with these. */
export const RESERVED_ENVELOPE_FIELDS = [
  'status',
  'summary',
  'artifacts',
  'notes_for_next_agent',
] as const;

const builtinNames = new Set<string>(BUILTIN_ENVELOPE_KINDS);
const reservedFields = new Set<string>(RESERVED_ENVELOPE_FIELDS);

const fieldSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, 'snake_case field name'),
  type: z.enum(['string', 'number', 'boolean', 'string[]']),
  required: z.boolean(),
  description: z.string().optional(),
});

export const envelopeDefSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(
        /^[a-z][a-z0-9_-]*$/,
        'lowercase letters, digits, dash, underscore; must start with a letter',
      ),
    description: z.string().optional(),
    fields: z.array(fieldSchema),
  })
  .superRefine((def, ctx) => {
    if (builtinNames.has(def.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['name'],
        message: `"${def.name}" is a built-in envelope kind and cannot be redefined`,
      });
    }
    const seen = new Set<string>();
    for (let i = 0; i < def.fields.length; i++) {
      const field = def.fields[i]!;
      if (reservedFields.has(field.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fields', i, 'name'],
          message: `"${field.name}" is a reserved base field`,
        });
      }
      if (seen.has(field.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fields', i, 'name'],
          message: `duplicate field name "${field.name}"`,
        });
      }
      seen.add(field.name);
    }
  });

export function validate(def: EnvelopeDef): ValidationIssue[] {
  const parsed = envelopeDefSchema.safeParse(def);
  return parsed.success ? [] : toIssues(parsed.error, def.name);
}

function toIssues(error: z.ZodError, name: string): ValidationIssue[] {
  return error.issues.map((i) => ({
    level: 'error' as const,
    where: i.path.join('.') || name || 'envelope',
    message: i.message,
  }));
}

export class EnvelopeStore {
  private readonly store: JsonStore<EnvelopeDef[]>;

  constructor(appSupportDir: string) {
    this.store = new JsonStore<EnvelopeDef[]>(join(appSupportDir, 'envelopes.json'), () => []);
  }

  list(): EnvelopeDef[] {
    return this.store.read();
  }

  get(name: string): EnvelopeDef | null {
    return this.list().find((e) => e.name === name) ?? null;
  }

  save(
    def: EnvelopeDef,
  ): { ok: true; envelopes: EnvelopeDef[] } | { ok: false; issues: ValidationIssue[] } {
    const parsed = envelopeDefSchema.safeParse(def);
    if (!parsed.success) return { ok: false, issues: toIssues(parsed.error, def.name) };
    const value = parsed.data as EnvelopeDef;
    const next = this.store.update((current) =>
      upsertBy(current, (e) => e.name === value.name, value),
    );
    return { ok: true, envelopes: next };
  }

  remove(name: string): EnvelopeDef[] {
    return this.store.update((current) => current.filter((e) => e.name !== name));
  }

  duplicate(name: string): EnvelopeDef | null {
    const source = this.get(name);
    if (!source) return null;
    const existing = new Set(this.list().map((e) => e.name));
    const copy: EnvelopeDef = {
      ...source,
      name: uniqueCopyName(name, existing),
      fields: source.fields.map((f) => ({ ...f })),
    };
    this.save(copy);
    return copy;
  }
}
