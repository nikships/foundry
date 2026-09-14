/**
 * Turns an edit/write tool-call row into the two file sides (or a patch)
 * Pierre's diff viewer needs. The Inspector and the run-detail timeline
 * share this so an edit never looks like JSON in one place and a diff in
 * the other.
 */

import type { EventRow } from '@shared/types.js';

export type EditFileSide = { name: string; contents: string };

export type EditDiffModel =
  | { kind: 'pair'; path: string; oldFile: EditFileSide | null; newFile: EditFileSide | null }
  | { kind: 'pairs'; path: string; pairs: { oldFile: EditFileSide; newFile: EditFileSide }[] }
  | { kind: 'patch'; path: string; patch: string }
  | { kind: 'empty' };

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function argsOf(event: EventRow): Record<string, unknown> {
  const value = event.payload.args;
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function pickString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function nameHead(event: EventRow): string {
  return event.name.split(':', 1)[0]!.toLowerCase();
}

/** True when this row is an edit or write, including unclassified name fallbacks. */
export function isEditToolEvent(event: EventRow): boolean {
  if (event.type !== 'tool_call') return false;
  const kind = str(event.payload.kind);
  // Main's toolKind maps write → edit; accept either, plus write_file aliases.
  if (kind === 'edit' || kind === 'write') return true;
  const head = nameHead(event);
  return head === 'edit' || head === 'write' || head === 'write_file';
}

function pathOf(event: EventRow, a: Record<string, unknown>): string {
  return (
    pickString(a, ['path', 'file_path', 'filePath']) ||
    (() => {
      const colon = event.name.indexOf(': ');
      return colon > 0 ? event.name.slice(colon + 2) : event.name;
    })()
  );
}

function looksLikeUnifiedDiff(text: string): boolean {
  return /^(?:diff --git |--- |\+\+\+ |@@ )/m.test(text);
}

interface Replacement {
  oldText: string;
  newText: string;
}

function replacementsOf(a: Record<string, unknown>): Replacement[] {
  if (Array.isArray(a.edits)) {
    const out: Replacement[] = [];
    for (const entry of a.edits) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      const oldText = pickString(row, ['oldText', 'old_str', 'old_string']) ?? '';
      const newText = pickString(row, ['newText', 'new_string', 'new_str']) ?? '';
      if (oldText || newText) out.push({ oldText, newText });
    }
    return out;
  }
  const oldText = pickString(a, ['oldText', 'old_str', 'old_string']);
  const newText = pickString(a, ['newText', 'new_string', 'new_str']);
  if (oldText !== undefined || newText !== undefined) {
    return [{ oldText: oldText ?? '', newText: newText ?? '' }];
  }
  return [];
}

function file(path: string, contents: string): EditFileSide {
  return { name: path, contents };
}

/**
 * Prefer the arguments the model sent (old/new text, or a write's content).
 * Fall back to a unified patch in the tool result when that is all we have.
 */
export function editDiffFromEvent(event: EventRow): EditDiffModel {
  const a = argsOf(event);
  const path = pathOf(event, a);
  const replacements = replacementsOf(a);
  const content = typeof a.content === 'string' ? a.content : undefined;
  const result = str(event.payload.result);

  if (replacements.length === 1) {
    const [only] = replacements;
    return {
      kind: 'pair',
      path,
      oldFile: file(path, only!.oldText),
      newFile: file(path, only!.newText),
    };
  }
  if (replacements.length > 1) {
    return {
      kind: 'pairs',
      path,
      pairs: replacements.map((replacement) => ({
        oldFile: file(path, replacement.oldText),
        newFile: file(path, replacement.newText),
      })),
    };
  }
  if (content !== undefined) {
    const isCreate =
      /^create:/i.test(event.name) || !pickString(a, ['oldText', 'old_str', 'old_string']);
    return {
      kind: 'pair',
      path,
      oldFile: isCreate ? null : file(path, ''),
      newFile: file(path, content),
    };
  }
  if (result && looksLikeUnifiedDiff(result)) {
    return { kind: 'patch', path, patch: result };
  }
  return { kind: 'empty' };
}
