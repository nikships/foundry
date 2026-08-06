/**
 * Typed seams. Context crosses a phase boundary only as a validated envelope.
 *
 * The synced-triad problem (type <-> prompt example <-> call site) is solved by
 * construction here: `exampleFor` derives the JSON example the agent is shown
 * from the same zod schema the answer is parsed against, so the two cannot
 * drift. Custom agent fields compile into the schema and into the example on
 * the same path.
 */

import { z } from 'zod';
import type { CustomEnvelopeField, EnvelopeKind } from '@shared/types.js';

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
  plan: z.object({ ...base, commit_message: z.string().default('') }),
  build: z.object({
    ...base,
    changed_files: z.array(z.string()).default([]),
    commit_message: z.string().default(''),
  }),
  scout: z.object({ ...base, findings: z.array(z.string()).default([]) }),
  review: z.object({
    ...base,
    approved: z.boolean(),
    findings: z.array(reviewFinding).default([]),
    blocking: z.array(z.string()).default([]),
  }),
  document: z.object({
    ...base,
    document_path: z.string().default(''),
    documented_files: z.array(z.string()).default([]),
  }),
} satisfies Record<EnvelopeKind, z.ZodTypeAny>;

export type Envelope = z.infer<typeof schemas.generic> & Record<string, unknown>;

/** Human-facing hints for the base fields, reused by the generated example. */
const FIELD_HINTS: Record<string, unknown> = {
  status: 'success',
  summary: 'one sentence on what you did',
  artifacts: ['relative/path/you/created.md'],
  notes_for_next_agent: 'what the next phase needs to know',
  commit_message: 'imperative subject line under 72 chars',
  changed_files: ['src/file/you/edited.ts'],
  findings: ['what you found, one per entry'],
  approved: true,
  blocking: ['a problem that must be fixed before this can ship'],
  document_path: 'docs/what-you-wrote.md',
  documented_files: ['src/file/you/documented.ts'],
};

const REVIEW_FINDINGS_HINT = [
  { requirement: 'the requirement you checked', met: true, evidence: 'how you verified it' },
];

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

export function schemaFor(kind: EnvelopeKind, custom?: CustomEnvelopeField[]): z.ZodTypeAny {
  const built = schemas[kind] ?? schemas.generic;
  if (!custom?.length) return built;

  const extra: Record<string, z.ZodTypeAny> = {};
  for (const f of custom) {
    const t = zodForCustomType(f.type);
    extra[f.name] = f.required ? t : t.optional();
  }
  return (built as z.ZodObject<z.ZodRawShape>).extend(extra);
}

/**
 * The JSON example embedded in the agent's prompt, generated from the schema.
 * One source of truth for the shape the agent is asked to produce.
 */
export function exampleFor(kind: EnvelopeKind, custom?: CustomEnvelopeField[]): string {
  const shape = (schemas[kind] ?? schemas.generic) as z.ZodObject<z.ZodRawShape>;
  const example: Record<string, unknown> = {};

  for (const key of Object.keys(shape.shape)) {
    if (key === 'findings' && kind === 'review') {
      example[key] = REVIEW_FINDINGS_HINT;
    } else {
      example[key] = FIELD_HINTS[key] ?? '';
    }
  }
  for (const f of custom ?? []) {
    example[f.name] = f.description ?? placeholderFor(f.type);
  }
  return JSON.stringify(example, null, 2);
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

export function parseEnvelope(
  text: string,
  kind: EnvelopeKind,
  custom?: CustomEnvelopeField[],
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

  const result = schemaFor(kind, custom).safeParse(value);
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, problem: problems, raw: text };
  }
  return { ok: true, envelope: result.data as Envelope, raw: text };
}

/** The correction message: names the failure, restates the shape, asks again. */
export function correctionMessage(
  problem: string,
  kind: EnvelopeKind,
  custom?: CustomEnvelopeField[],
): string {
  return [
    'Your reply could not be used as an envelope.',
    '',
    `Problem: ${problem}`,
    '',
    'Reply again with ONLY this JSON object, no prose, no code fence:',
    exampleFor(kind, custom),
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
