/**
 * Pure list operations and validation for `CustomEnvelopeField[]`.
 *
 * Two editors write this shape — the envelope library (a whole named shape) and
 * an agent's extra fields (a per-agent extension) — so the rules live here
 * rather than twice in JSX. Vitest runs `environment: node`, which is the other
 * reason: this is the part worth testing, and it is testable without a DOM.
 *
 * The engine merges library fields and agent fields by name into one object
 * (`engine/envelopes.ts:mergedFields`) and extends the base schema with the
 * result. Two consequences drive the checks below: a duplicate name silently
 * collapses to whichever entry came last, and a name that collides with a base
 * field replaces it — a field called `status` would swap the success/fail enum
 * the engine grades a phase on for a free-form string. Neither is rejected by
 * `agentSchema`, so both are caught here, before autosave.
 */

import type { CustomEnvelopeField, ValidationIssue } from '@shared/types.js';

/** Carried by every envelope. A custom field may not take one of these names. */
export const RESERVED_FIELD_NAMES = [
  'status',
  'summary',
  'artifacts',
  'notes_for_next_agent',
] as const;

/** snake_case, matching `agentSchema.customFields` and `envelopeDefSchema`. */
export const FIELD_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

export const FIELD_TYPE_OPTIONS: { value: CustomEnvelopeField['type']; label: string }[] = [
  { value: 'string', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Yes-no' },
  { value: 'string[]', label: 'List of text' },
];

const reserved = new Set<string>(RESERVED_FIELD_NAMES);

export function fieldTypeLabel(type: CustomEnvelopeField['type']): string {
  return FIELD_TYPE_OPTIONS.find((t) => t.value === type)?.label ?? type;
}

/**
 * Coerce keystrokes toward a legal name as they are typed. Deliberately not a
 * full repair: an empty result is left empty so the rail can say why, rather
 * than the editor inventing a name the user did not choose.
 */
export function normalizeFieldName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .replace(/^[^a-z]+/, '');
}

/** First free `field`, `field_2`, … so a rapid Add never lands on a duplicate. */
export function nextFieldName(fields: readonly CustomEnvelopeField[]): string {
  const used = new Set(fields.map((f) => f.name));
  if (!used.has('field')) return 'field';
  let n = 2;
  while (used.has(`field_${n}`)) n += 1;
  return `field_${n}`;
}

export function addField(fields: readonly CustomEnvelopeField[]): CustomEnvelopeField[] {
  return [
    ...fields,
    { name: nextFieldName(fields), type: 'string', required: true, description: '' },
  ];
}

export function removeField(
  fields: readonly CustomEnvelopeField[],
  index: number,
): CustomEnvelopeField[] {
  return fields.filter((_, i) => i !== index);
}

export function patchField(
  fields: readonly CustomEnvelopeField[],
  index: number,
  patch: Partial<CustomEnvelopeField>,
): CustomEnvelopeField[] {
  return fields.map((f, i) => (i === index ? { ...f, ...patch } : f));
}

/**
 * Issues for the inline rail, in the same `where` form the roster and envelope
 * stores emit (a zod-style dotted path), so one list renders both sources.
 */
export function validateCustomFields(
  fields: readonly CustomEnvelopeField[] | undefined,
  where = 'customFields',
): ValidationIssue[] {
  if (!fields?.length) return [];
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();

  fields.forEach((field, i) => {
    const at = `${where}.${i}.name`;
    if (!field.name) {
      issues.push({ level: 'error', where: at, message: 'a field needs a name' });
    } else if (!FIELD_NAME_PATTERN.test(field.name)) {
      issues.push({
        level: 'error',
        where: at,
        message: `"${field.name}" must be snake_case: lowercase letters, digits, underscore, starting with a letter`,
      });
    } else if (reserved.has(field.name)) {
      issues.push({
        level: 'error',
        where: at,
        message: `"${field.name}" is a base field every report already carries — pick another name`,
      });
    } else if (seen.has(field.name)) {
      issues.push({
        level: 'error',
        where: at,
        message: `duplicate field name "${field.name}" — only the last one would reach the agent`,
      });
    }
    if (field.name) seen.add(field.name);
  });

  return issues;
}

/**
 * What an agent's extra fields add on top of the envelope it selected. Mirrors
 * the engine's precedence (`mergedFields`): the agent's entry wins a name
 * collision, so the editor can say which library field is being shadowed
 * instead of leaving the operator to discover it in a run.
 */
export function shadowedLibraryFields(
  agentFields: readonly CustomEnvelopeField[] | undefined,
  libraryFields: readonly CustomEnvelopeField[] | undefined,
): string[] {
  if (!agentFields?.length || !libraryFields?.length) return [];
  const library = new Set(libraryFields.map((f) => f.name));
  return agentFields.filter((f) => library.has(f.name)).map((f) => f.name);
}
