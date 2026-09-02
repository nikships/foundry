/**
 * One resolver for the icon and identity colour of a trace event, shared by
 * the activity timeline and the transcript so the same work never wears two
 * different marks.
 *
 * Identity colours are deliberately separate from status colours: a failed
 * gate or a correction is coloured by the row's status class, and the resolver
 * leaves those rows uncoloured rather than overriding the class inline.
 */

import {
  ArrowRight,
  Blocks,
  Bot,
  Brain,
  CircleX,
  Dot,
  FilePenLine,
  FileText,
  Flag,
  Hammer,
  Hand,
  Mail,
  MessageSquareText,
  Play,
  RotateCcw,
  Search,
  SendHorizontal,
  ShieldCheck,
  ShieldX,
  Shrink,
  Sigma,
  Square,
  Terminal,
  Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { EventRow } from '@shared/types.js';

export interface EventIconSpec {
  icon: LucideIcon;
  /** Identity colour; absent when the row's status class owns the colour. */
  color?: string;
}

type IconEvent = Pick<EventRow, 'type' | 'name' | 'payload'>;

/** The head of a trace row's name: `bash: npm test` → `bash`. */
function nameHead(name: string): string {
  return name.split(':', 1)[0]!.trim().toLowerCase();
}

/**
 * The kind of work a tool call is. `payload.kind` is authoritative — the
 * event folder classifies every call pi emits. The name heuristics cover rows
 * recorded without one, notably code phases, whose rows the code runner names
 * after the phase (`build: npm run build`).
 */
function toolCallKind(event: IconEvent): string {
  const kind = event.payload.kind;
  if (typeof kind === 'string' && kind) return kind;
  const head = nameHead(event.name);
  if (head === 'build' || head === 'builder') return 'build';
  if (Array.isArray(event.payload.argv)) return 'command';
  if (head === 'bash') return 'command';
  if (head === 'read') return 'read';
  if (head === 'edit' || head === 'write') return 'edit';
  if (head === 'grep' || head === 'find' || head === 'ls') return 'search';
  if (head === 'submit_envelope' || head === 'read_phase_context') return 'envelope';
  return 'other';
}

const TOOL_SPEC: Record<string, EventIconSpec> = {
  build: { icon: Hammer, color: 'var(--accent)' },
  read: { icon: FileText, color: 'var(--blue)' },
  search: { icon: Search, color: 'var(--purple)' },
  edit: { icon: FilePenLine, color: 'var(--amber)' },
  command: { icon: Terminal },
  envelope: { icon: Mail, color: 'var(--purple)' },
  progress: { icon: Flag },
};

const EVENT_SPEC: Partial<Record<EventRow['type'], EventIconSpec>> = {
  thinking: { icon: Brain, color: 'var(--amber)' },
  assistant_text: { icon: MessageSquareText, color: 'var(--green)' },
  phase_start: { icon: Play },
  phase_end: { icon: Square },
  agent_start: { icon: Bot },
  agent_end: { icon: Sigma },
  handoff: { icon: ArrowRight },
  gate_pass: { icon: ShieldCheck },
  gate_fail: { icon: ShieldX },
  correction: { icon: RotateCcw },
  interrupt: { icon: Hand },
  compaction: { icon: Shrink },
  error: { icon: CircleX },
};

export function eventIconSpec(event: IconEvent): EventIconSpec {
  if (event.type === 'tool_call') {
    return TOOL_SPEC[toolCallKind(event)] ?? { icon: Wrench };
  }
  // The builder agent's own start/end rows get its mark rather than the
  // anonymous robot every other agent shares.
  if (
    (event.type === 'agent_start' || event.type === 'agent_end') &&
    nameHead(event.name) === 'builder'
  ) {
    return { icon: Blocks, color: 'var(--accent)' };
  }
  if (event.type === 'log' && nameHead(event.name) === 'prompt') {
    return { icon: SendHorizontal, color: 'var(--teal)' };
  }
  return EVENT_SPEC[event.type] ?? { icon: Dot };
}

export function EventIcon({
  event,
  size = 12,
}: {
  event: IconEvent;
  size?: number;
}): React.JSX.Element {
  const spec = eventIconSpec(event);
  const Icon = spec.icon;
  return (
    <Icon
      size={size}
      strokeWidth={1.75}
      aria-hidden
      style={spec.color ? { color: spec.color } : undefined}
    />
  );
}
