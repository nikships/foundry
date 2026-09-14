/**
 * Turns a tool_call event into the labeled fields and preview text the
 * Inspector and run-detail timeline share. Keeps bash/read/grep/etc. from
 * dumping the whole payload as JSON by default.
 */

import type { EventRow } from '@shared/types.js';

export type ToolField = { label: string; value: string };

export type ToolPayloadModel = {
  kind: string;
  toolName: string;
  summary: string;
  fields: ToolField[];
  result: string;
  truncated: boolean;
  failed: boolean;
  /** Full payload for an explicit "raw" expand — never the default view. */
  raw: Record<string, unknown>;
};

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function argsOf(event: EventRow): Record<string, unknown> {
  const value = event.payload.args;
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function nameHead(event: EventRow): string {
  return event.name.split(':', 1)[0]!.toLowerCase();
}

function nameSummary(event: EventRow): string {
  const colon = event.name.indexOf(': ');
  return colon > 0 ? event.name.slice(colon + 2) : event.name;
}

/** Same classification the Inspector uses for specialized blocks. */
export function inferToolKind(event: EventRow): string {
  const kind = str(event.payload.kind);
  if (kind) return kind;
  const head = nameHead(event);
  if (head === 'build' || head === 'builder') return 'build';
  if (Array.isArray(event.payload.argv)) return 'command';
  if (head === 'bash') return 'command';
  if (head === 'read') return 'read';
  if (head === 'edit' || head === 'write' || head === 'write_file') return 'edit';
  if (head === 'grep' || head === 'find' || head === 'ls') return 'search';
  if (head === 'report_progress') return 'progress';
  if (head === 'submit_envelope' || head === 'read_phase_context') return 'envelope';
  if (head === 'todo' || head === 'todowrite' || head === 'todo_write') return 'todo';
  if (head === 'task') return 'task';
  if (head === 'ask' || head === 'askuserquestion') return 'ask';
  return 'other';
}

function pickString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function formatScalar(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.length > 240 ? `${trimmed.slice(0, 237)}…` : trimmed;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (!value.length) return null;
    if (value.every((entry) => typeof entry === 'string')) {
      const joined = (value as string[]).join(', ');
      return joined.length > 240 ? `${joined.slice(0, 237)}…` : joined;
    }
    return `${value.length} items`;
  }
  if (typeof value === 'object') return null;
  return String(value);
}

const PREFERRED_KEYS = [
  'command',
  'path',
  'file_path',
  'filePath',
  'pattern',
  'query',
  'glob',
  'include',
  'description',
  'summary',
  'prompt',
  'questionnaire',
  'subagent_type',
  'offset',
  'limit',
  'status',
] as const;

const SKIP_KEYS = new Set([
  'content',
  'oldText',
  'newText',
  'old_str',
  'new_string',
  'old_string',
  'new_str',
  'edits',
  'todos',
]);

function fieldsFromArgs(a: Record<string, unknown>, kind: string): ToolField[] {
  const fields: ToolField[] = [];
  const seen = new Set<string>();

  const push = (label: string, value: unknown): void => {
    const formatted = formatScalar(value);
    if (!formatted) return;
    const key = label.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    fields.push({ label, value: formatted });
  };

  if (kind === 'command' || kind === 'build') {
    push(
      'command',
      pickString(a, ['command']) ??
        (Array.isArray(a.argv) ? (a.argv as string[]).join(' ') : undefined),
    );
  }
  if (kind === 'read' || kind === 'edit') {
    push('path', pickString(a, ['path', 'file_path', 'filePath']));
  }
  if (kind === 'search') {
    push('pattern', pickString(a, ['pattern', 'query']));
    push('path', pickString(a, ['path', 'file_path', 'filePath']));
    push('glob', pickString(a, ['glob', 'include']));
  }

  for (const key of PREFERRED_KEYS) {
    if (SKIP_KEYS.has(key)) continue;
    if (!(key in a)) continue;
    push(key.replace(/_/g, ' '), a[key]);
  }

  for (const [key, value] of Object.entries(a)) {
    if (SKIP_KEYS.has(key)) continue;
    if ((PREFERRED_KEYS as readonly string[]).includes(key)) continue;
    push(key.replace(/_/g, ' '), value);
  }

  return fields.slice(0, 8);
}

function commandOf(event: EventRow, a: Record<string, unknown>): string {
  const fromArgs = str(a.command);
  if (fromArgs) return fromArgs;
  if (Array.isArray(event.payload.argv)) return (event.payload.argv as string[]).join(' ');
  return nameSummary(event);
}

function summaryFor(event: EventRow, kind: string, a: Record<string, unknown>): string {
  if (kind === 'command' || kind === 'build') return commandOf(event, a);
  if (kind === 'read' || kind === 'edit') {
    return pickString(a, ['path', 'file_path', 'filePath']) || nameSummary(event);
  }
  if (kind === 'search') {
    return (
      pickString(a, ['pattern', 'query', 'path', 'file_path', 'filePath']) || nameSummary(event)
    );
  }
  const colon = event.name.indexOf(': ');
  if (colon > 0) return event.name.slice(colon + 2);
  for (const field of fieldsFromArgs(a, kind)) {
    if (field.label !== 'command') return field.value;
  }
  return nameSummary(event);
}

/**
 * Structured view-model for a tool_call row. Callers render fields + result
 * and only offer `raw` behind an explicit expand.
 */
export function toolPayloadFromEvent(event: EventRow): ToolPayloadModel {
  const a = argsOf(event);
  const kind = inferToolKind(event);
  const colon = event.name.indexOf(': ');
  const toolName = colon > 0 ? event.name.slice(0, colon) : event.name;
  const result = str(event.payload.result);
  return {
    kind,
    toolName,
    summary: summaryFor(event, kind, a),
    fields: fieldsFromArgs(a, kind),
    result,
    truncated: event.payload.truncated === true,
    failed: event.payload.isError === true || event.payload.passed === false,
    raw: event.payload,
  };
}
