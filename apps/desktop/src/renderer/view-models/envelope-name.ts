/**
 * Naming rules for a new custom envelope (report).
 *
 * The library upserts by name, so a new draft that takes an existing name
 * silently replaces that report. `commitCustomEnvelopeName` is the gate
 * `EnvelopesEditor` runs on blur/Enter before the draft identity changes.
 * Built-in kind names (`plan`, `build`, …) stay on schema validation; this
 * only covers collisions with other custom library entries.
 */

export type EnvelopeNameCommit =
  | { status: 'applied'; name: string }
  | { status: 'unchanged'; name: string }
  | { status: 'empty' }
  | { status: 'collision'; name: string };

/** Same repair `EnvelopesEditor` used inline: lowercase, safe chars, must start with a letter. */
export function sanitizeEnvelopeName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Decide whether a typed name may become the draft's identity.
 * `currentName` is the draft's name today (already unique, or just committed).
 * `existingNames` is the persisted library — the current draft is a collision
 * only when the typed name belongs to a *different* entry.
 */
export function commitCustomEnvelopeName(
  raw: string,
  currentName: string,
  existingNames: Iterable<string>,
): EnvelopeNameCommit {
  const name = sanitizeEnvelopeName(raw);
  if (!name) return { status: 'empty' };
  if (name === currentName) return { status: 'unchanged', name };
  if (new Set(existingNames).has(name)) return { status: 'collision', name };
  return { status: 'applied', name };
}
