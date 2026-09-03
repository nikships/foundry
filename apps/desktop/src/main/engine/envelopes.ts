/**
 * Typed seams. Context crosses a phase boundary only as a validated envelope.
 *
 * The synced-triad problem (type <-> prompt example <-> call site) is solved by
 * construction here: `exampleFor` derives the JSON example the agent is shown
 * from the same zod schema the answer is parsed against, so the two cannot
 * drift. Custom agent fields compile into the schema and into the example on
 * the same path.
 *
 * A name resolves as: built-in kind → its schema; custom library def → generic
 * base extended with the def's fields; unknown → generic (today's fallback).
 * Agent `customFields` still layer on top either way.
 */

import { z } from 'zod';
import {
  BUILTIN_ENVELOPE_KINDS,
  PR_TITLE_MAX,
  type CustomEnvelopeField,
  type EnvelopeDef,
  type EnvelopeKind,
} from '@shared/types.js';
import { jsonSchemaWithoutDialect } from '@shared/zod-json-schema.js';

const base = {
  status: z.enum(['success', 'fail']),
  summary: z.string().default(''),
  artifacts: z.array(z.string()).default([]),
  notes_for_next_agent: z.string().default(''),
};

const reviewFinding = z.object({
  requirement: z.string(),
  met: z.boolean(),
  evidence: z.string().default(''),
});

export const schemas = {
  generic: z.object({ ...base }),
  brief: z.object({
    ...base,
    // The whole point of the phase, so an empty one is a failed phase rather
    // than a brief nobody can act on.
    improved_request: z.string().min(1),
    constraints: z.array(z.string()).min(1),
    acceptance_criteria: z.array(z.string()).min(1),
  }),
  plan: z.object({
    ...base,
    commit_message: z.string().default(''),
    files_to_touch: z.array(z.string()).min(1),
    steps: z.array(z.string()).min(1),
    verification: z.array(z.string()).min(1),
    risks: z.array(z.string()).default([]),
  }),
  build: z.object({ ...base, commit_message: z.string().default('') }),
  scout: z.object({ ...base, findings: z.array(z.string()).default([]) }),
  review: z.object({
    ...base,
    approved: z.boolean(),
    findings: z.array(reviewFinding).default([]),
    blocking: z.array(z.string()).default([]),
  }),
  document: z.object({ ...base }),
  pr: z.object({
    ...base,
    title: z.string().min(1).max(PR_TITLE_MAX),
    body: z.string().min(1),
  }),
  issue: z.object({
    ...base,
    title: z.string().min(1).max(PR_TITLE_MAX),
    body: z.string().min(1),
    labels: z.array(z.string()).default([]),
  }),
} satisfies Record<EnvelopeKind, z.ZodTypeAny>;

export type Envelope = z.infer<typeof schemas.generic> & Record<string, unknown>;

const builtinSet = new Set<string>(BUILTIN_ENVELOPE_KINDS);

/** Human-facing hints for the base fields, reused by the generated example. */
const FIELD_HINTS: Record<string, unknown> = {
  status: 'success',
  summary: 'one sentence on what you did',
  artifacts: ['relative/path/you/created.md'],
  notes_for_next_agent: 'what the next phase needs to know',
  commit_message: 'imperative subject line under 72 chars',
  files_to_touch: ['relative/path/to/touch.ts'],
  steps: ['the change to make in that file'],
  verification: ['how to prove the change works'],
  risks: ['what could go wrong'],
  improved_request: 'the rewritten request, standalone and ready to hand to the next phase',
  constraints: ['a rule the work must respect'],
  acceptance_criteria: ['how anyone can tell this is done'],
  findings: ['what you found, one per entry'],
  approved: true,
  blocking: ['a problem that must be fixed before this can ship'],
  title: 'imperative PR title, ≤72 chars, no trailing period',
  body: 'markdown PR body — follow the repo template, or the fallback headings',
  labels: ['a label that already exists in the repo'],
};

const REVIEW_FINDINGS_HINT = [
  { requirement: 'the requirement you checked', met: true, evidence: 'how you verified it' },
];

/** `pr` and `issue` share field names; the hints must name the right artifact. */
const ISSUE_FIELD_HINTS: Record<string, unknown> = {
  title: 'imperative issue title, ≤72 chars, no trailing period',
  body: 'markdown issue body — context, evidence, and what done looks like',
};

function zodForCustomType(type: CustomEnvelopeField['type']): z.ZodTypeAny {
  switch (type) {
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'string[]':
      return z.array(z.string());
    default:
      return z.string();
  }
}

function placeholderFor(type: CustomEnvelopeField['type']): unknown {
  switch (type) {
    case 'number':
      return 0;
    case 'boolean':
      return true;
    case 'string[]':
      return ['value'];
    default:
      return 'value';
  }
}

/**
 * A field description is a hint, not a value: dropping it in as-is would show a
 * `string[]` field as a bare string and a number field as prose, so the example
 * an agent is told to copy would not satisfy the schema its copy is parsed
 * against. The hint is carried where the type can hold it and dropped where it
 * cannot.
 */
function exampleValueFor(field: CustomEnvelopeField): unknown {
  if (!field.description) return placeholderFor(field.type);
  if (field.type === 'string') return field.description;
  if (field.type === 'string[]') return [field.description];
  return placeholderFor(field.type);
}

function extendWithFields(
  built: z.ZodObject<z.ZodRawShape>,
  fields: CustomEnvelopeField[] | undefined,
): z.ZodTypeAny {
  if (!fields?.length) return built;
  const extra: Record<string, z.ZodTypeAny> = {};
  for (const f of fields) {
    const t = zodForCustomType(f.type);
    extra[f.name] = f.required ? t : t.optional();
  }
  return built.extend(extra);
}

/**
 * Resolve a kind name to its base schema and the library fields that extend it.
 * Built-ins use their own schema; custom defs extend generic; unknown falls
 * back to generic so a deleted library entry does not crash a run mid-flight.
 */
function resolveBase(
  kind: string,
  defs?: EnvelopeDef[],
): {
  baseSchema: z.ZodObject<z.ZodRawShape>;
  libraryFields: CustomEnvelopeField[];
  exampleKind: string;
} {
  if (builtinSet.has(kind)) {
    return {
      baseSchema: schemas[kind as EnvelopeKind] as z.ZodObject<z.ZodRawShape>,
      libraryFields: [],
      exampleKind: kind,
    };
  }
  const generic = schemas.generic as z.ZodObject<z.ZodRawShape>;
  const def = defs?.find((d) => d.name === kind);
  return {
    baseSchema: generic,
    libraryFields: def?.fields ?? [],
    exampleKind: 'generic',
  };
}

function mergedFields(
  library: CustomEnvelopeField[],
  custom?: CustomEnvelopeField[],
): CustomEnvelopeField[] {
  if (!library.length && !custom?.length) return [];
  // Agent customFields win on name collision so a per-agent override still works.
  const byName = new Map<string, CustomEnvelopeField>();
  for (const f of library) byName.set(f.name, f);
  for (const f of custom ?? []) byName.set(f.name, f);
  return [...byName.values()];
}

export function schemaFor(
  kind: string,
  custom?: CustomEnvelopeField[],
  defs?: EnvelopeDef[],
): z.ZodTypeAny {
  const { baseSchema, libraryFields } = resolveBase(kind, defs);
  return extendWithFields(baseSchema, mergedFields(libraryFields, custom));
}

/** Field names an agent filling this envelope must know, from the same schema. */
export function envelopeFieldNames(
  kind: string,
  custom?: CustomEnvelopeField[],
  defs?: EnvelopeDef[],
): string[] {
  const { baseSchema, libraryFields } = resolveBase(kind, defs);
  const names = Object.keys(baseSchema.shape);
  for (const field of mergedFields(libraryFields, custom)) {
    if (!names.includes(field.name)) names.push(field.name);
  }
  return names;
}

/**
 * The JSON Schema handed to the model as an output constraint, derived from the
 * very schema the reply is parsed against — the fourth leg of the synced set
 * (type, prompt example, parse, wire constraint), so none of them can drift.
 *
 * Emitted as the OUTPUT view: `.default()` fields are `required`, i.e. the
 * model is asked for strictly more than `parseEnvelope` demands (which fills
 * defaults for anything omitted). Conforming to this schema therefore always
 * parses; the text-parse fallback covers replies that do not conform.
 *
 * No `$schema` dialect is declared, and the one zod stamps on is stripped. A
 * structured-output schema crosses into whichever validator the provider runs,
 * and a Draft-07 one rejects the whole request rather than just the dialect
 * line when it cannot resolve a 2020-12 URI. Every envelope body here is
 * identical under both dialects, so declaring none is what all of them accept.
 */
export function jsonSchemaFor(
  kind: string,
  custom?: CustomEnvelopeField[],
  defs?: EnvelopeDef[],
): z.core.JSONSchema.BaseSchema {
  return jsonSchemaWithoutDialect(schemaFor(kind, custom, defs));
}

/**
 * The JSON example embedded in the agent's prompt, generated from the schema.
 * One source of truth for the shape the agent is asked to produce.
 */
export function exampleFor(
  kind: string,
  custom?: CustomEnvelopeField[],
  defs?: EnvelopeDef[],
): string {
  const { baseSchema, libraryFields, exampleKind } = resolveBase(kind, defs);
  const example: Record<string, unknown> = {};

  for (const key of Object.keys(baseSchema.shape)) {
    if (key === 'findings' && exampleKind === 'review') {
      example[key] = REVIEW_FINDINGS_HINT;
    } else if (key === 'findings' && exampleKind === 'scout') {
      example[key] = ['path + symbol + observation'];
    } else if (exampleKind === 'issue' && key in ISSUE_FIELD_HINTS) {
      example[key] = ISSUE_FIELD_HINTS[key];
    } else {
      example[key] = FIELD_HINTS[key] ?? '';
    }
  }
  for (const f of mergedFields(libraryFields, custom)) {
    example[f.name] = exampleValueFor(f);
  }
  return JSON.stringify(example, null, 2);
}

/**
 * Stands in for a phase that has not run, so a dry run can show a later prompt
 * the shape its predecessor will actually hand over. Derived from the same
 * schema as the real example rather than written out, because a fixed stub
 * would show the next agent a shape its predecessor never returns — exactly
 * the mismatch a dry run exists to rule out.
 */
export function placeholderEnvelope(
  phaseName: string,
  kind: string,
  custom?: CustomEnvelopeField[],
  defs?: EnvelopeDef[],
): Envelope {
  const stub = JSON.parse(exampleFor(kind, custom, defs)) as Envelope;
  return { ...stub, summary: `[${phaseName} envelope from a previous phase]` };
}

export interface ParseOutcome {
  ok: boolean;
  envelope?: Envelope;
  /** Names exactly what was wrong, so the correction can be specific. */
  problem?: string;
  raw: string;
}

/**
 * Agents answer with prose around their JSON more often than not. Take the last
 * balanced JSON object in the text: the final answer is what counts, and an
 * earlier code fence in an explanation must not win over it.
 */
export function extractJson(text: string): string | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  const fenced: string[] = [];
  for (const m of text.matchAll(fence)) if (m[1]) fenced.push(m[1].trim());

  const candidates = [...fenced.reverse(), ...balancedObjects(text).reverse()];
  for (const c of candidates) {
    try {
      const parsed: unknown = JSON.parse(c);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return c;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function balancedObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

/**
 * Validate a value that is already parsed — a transport's structured output —
 * against the very schema the text path validates through. A transport saying
 * its answer conforms is not conformance: this is the only authority, so a
 * schema-shaped reply that the zod schema rejects fails here exactly like a
 * malformed one pulled out of prose.
 */
export function validateEnvelope(
  value: unknown,
  kind: string,
  custom?: CustomEnvelopeField[],
  defs?: EnvelopeDef[],
): ParseOutcome {
  const raw = JSON.stringify(value ?? null);
  const result = schemaFor(kind, custom, defs).safeParse(value);
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, problem: problems, raw };
  }
  return { ok: true, envelope: result.data as Envelope, raw };
}

export function parseEnvelope(
  text: string,
  kind: string,
  custom?: CustomEnvelopeField[],
  defs?: EnvelopeDef[],
): ParseOutcome {
  const json = extractJson(text);
  if (!json) {
    return {
      ok: false,
      problem:
        'no JSON object was found in the reply — the final message must be the envelope JSON and nothing else',
      raw: text,
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (e) {
    return { ok: false, problem: `the JSON does not parse: ${(e as Error).message}`, raw: text };
  }

  return { ...validateEnvelope(value, kind, custom, defs), raw: text };
}

/** The correction message names the failure and returns the agent to the tool channel. */
export function correctionMessage(problem: string): string {
  return [
    'Your reply could not be used as an envelope.',
    '',
    `Problem: ${problem}`,
    '',
    'Correct the problem, then call submit_envelope again.',
  ].join('\n');
}

/**
 * A failed command travels back to an agent as an envelope it can read — the
 * builder cannot open a log file it was never handed, so the evidence rides
 * along in the message.
 */
export function feedbackEnvelope(input: {
  phase: string;
  command: string;
  exitCode: number | null;
  outputTail: string;
}): Envelope {
  return {
    status: 'fail',
    summary: `${input.phase} failed: ${input.command} exited ${input.exitCode ?? 'null'}`,
    artifacts: [],
    notes_for_next_agent: input.outputTail,
  };
}
