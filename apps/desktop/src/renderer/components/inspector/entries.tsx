/**
 * One renderer per transcript entry. The Inspector shows what an agent's own
 * CLI shows, so the vocabulary is the CLI's: a thought, a paragraph, a command
 * with its output, an edit, a search. Everything else (gates, corrections,
 * interrupts) is a banner, because those come from Foundry, not the agent.
 *
 * An entry with no endedAt is still open: the agent is mid-thought or a tool
 * is mid-run, and the block shows that rather than pretending to be finished.
 */

import { useState } from 'react';
import type { EventRow, UsageBreakdown } from '@shared/types.js';
import { clockTime, credits, tokens } from '../../format.js';

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function args(event: EventRow): Record<string, unknown> {
  const value = event.payload.args;
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * Rows written before the folder stamped `kind` still name themselves
 * `bash: …` / `grep: …`, and code phases record their command span with an
 * argv payload. Infer the kind so history renders with the same blocks as a
 * live run instead of falling through to the generic row.
 */
function inferKind(event: EventRow): string {
  const kind = str(event.payload.kind);
  if (kind) return kind;
  if (Array.isArray(event.payload.argv)) return 'command';
  const head = event.name.split(':', 1)[0]!.toLowerCase();
  if (head === 'bash' || head === 'execute') return 'command';
  if (head === 'read') return 'read';
  if (head === 'edit' || head === 'create' || head === 'write' || head === 'multiedit')
    return 'edit';
  if (head === 'grep' || head === 'glob' || head === 'ls' || head === 'search') return 'search';
  return 'other';
}

/** The command a span ran, however the row was recorded. */
function commandOf(event: EventRow): string {
  const fromArgs = str(args(event).command);
  if (fromArgs) return fromArgs;
  if (Array.isArray(event.payload.argv)) return (event.payload.argv as string[]).join(' ');
  return event.name.replace(/^\w+: /, '');
}

function failedOf(event: EventRow): boolean {
  return event.payload.isError === true || event.payload.passed === false;
}

/** The folder writes the full record to stream.jsonl when it caps a field. */
function TruncatedNote(): React.JSX.Element {
  return <div className="te-truncated">truncated here, full text in the run's stream.jsonl</div>;
}

function Time({ iso }: { iso: string }): React.JSX.Element {
  return <span className="te-time">{clockTime(iso)}</span>;
}

function ThinkingBlock({ event }: { event: EventRow }): React.JSX.Element {
  const open = event.endedAt == null;
  const text = str(event.payload.text);
  return (
    <div className={`te thinking ${open ? 'open' : ''}`}>
      <div className="te-head">
        <span className="te-tag">thought</span>
        <Time iso={event.startedAt} />
      </div>
      <div className="te-thinking-body">
        {text}
        {open && <span className="te-caret" />}
      </div>
      {event.payload.truncated === true && <TruncatedNote />}
    </div>
  );
}

function TextBlock({ event }: { event: EventRow }): React.JSX.Element {
  const open = event.endedAt == null;
  return (
    <div className={`te text ${open ? 'open' : ''}`}>
      <div className="te-text-body">
        {str(event.payload.text)}
        {open && <span className="te-caret" />}
      </div>
      {event.payload.truncated === true && <TruncatedNote />}
    </div>
  );
}

function CommandBlock({ event }: { event: EventRow }): React.JSX.Element {
  const [expanded, setExpanded] = useState(true);
  const open = event.endedAt == null;
  const command = commandOf(event);
  const output = str(event.payload.result);
  const failed = failedOf(event);
  return (
    <div className={`te command ${failed ? 'failed' : ''} ${open ? 'open' : ''}`}>
      <button className="te-cmd-head" onClick={() => setExpanded((v) => !v)}>
        <span className="te-prompt">$</span>
        <span className="te-cmd mono">{command}</span>
        {open ? (
          <span className="te-exec running">{str(event.payload.execPhase) || 'running'}</span>
        ) : (
          <span className={`te-exec ${failed ? 'fail' : 'ok'}`}>{failed ? 'failed' : 'ok'}</span>
        )}
        <Time iso={event.startedAt} />
      </button>
      {expanded && (output || open) && (
        <pre className="te-output mono">
          {output}
          {open && <span className="te-caret" />}
        </pre>
      )}
      {expanded && event.payload.truncated === true && <TruncatedNote />}
    </div>
  );
}

/** Whatever identifies the target after `name: `, regardless of case. */
function nameSummary(event: EventRow): string {
  const colon = event.name.indexOf(': ');
  return colon > 0 ? event.name.slice(colon + 2) : event.name;
}

function EditBlock({ event }: { event: EventRow }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const open = event.endedAt == null;
  const a = args(event);
  const path = str(a.file_path) || str(a.path) || nameSummary(event);
  const body = str(a.new_string) || str(a.content) || str(a.input) || str(event.payload.result);
  const isCreate = /^create:/i.test(event.name);
  return (
    <div className={`te edit ${open ? 'open' : ''}`}>
      <button className="te-row-head" onClick={() => setExpanded((v) => !v)}>
        <span className="te-tag edit">{isCreate ? 'create' : 'edit'}</span>
        <span className="te-path mono">{path}</span>
        {open && <span className="te-exec running">writing</span>}
        <Time iso={event.startedAt} />
      </button>
      {expanded && body && <pre className="te-output mono">{body}</pre>}
      {expanded && event.payload.truncated === true && <TruncatedNote />}
    </div>
  );
}

function ReadBlock({
  event,
  verb,
}: {
  event: EventRow;
  verb: 'read' | 'search';
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const open = event.endedAt == null;
  const a = args(event);
  const target =
    str(a.file_path) || str(a.pattern) || str(a.query) || str(a.path) || nameSummary(event);
  const result = str(event.payload.result);
  return (
    <div className={`te read ${open ? 'open' : ''}`}>
      <button className="te-row-head" onClick={() => setExpanded((v) => !v)}>
        <span className="te-tag read">{verb}</span>
        <span className="te-path mono">{target}</span>
        {open && (
          <span className="te-exec running">{str(event.payload.execPhase) || 'running'}</span>
        )}
        <Time iso={event.startedAt} />
      </button>
      {expanded && result && <pre className="te-output mono">{result}</pre>}
      {expanded && event.payload.truncated === true && <TruncatedNote />}
    </div>
  );
}

function GenericToolBlock({ event }: { event: EventRow }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const open = event.endedAt == null;
  const result = str(event.payload.result);
  // The tag is the tool's name; the summary (after the colon) wraps.
  const colon = event.name.indexOf(': ');
  const toolName = colon > 0 ? event.name.slice(0, colon) : event.name;
  const summary = colon > 0 ? event.name.slice(colon + 2) : JSON.stringify(args(event));
  return (
    <div className={`te tool ${open ? 'open' : ''}`}>
      <button className="te-row-head" onClick={() => setExpanded((v) => !v)}>
        <span className="te-tag tool">{toolName}</span>
        <span className="te-path mono">{summary === '{}' ? '' : summary}</span>
        {open && (
          <span className="te-exec running">{str(event.payload.execPhase) || 'running'}</span>
        )}
        <Time iso={event.startedAt} />
      </button>
      {expanded && result && <pre className="te-output mono">{result}</pre>}
    </div>
  );
}

function ToolBlock({ event }: { event: EventRow }): React.JSX.Element {
  // A one-shot CLI without a stream normaliser yields one honest span for the
  // whole turn; it renders as a command block with the prompt as its args.
  switch (inferKind(event)) {
    case 'command':
      return <CommandBlock event={event} />;
    case 'edit':
      return <EditBlock event={event} />;
    case 'read':
      return <ReadBlock event={event} verb="read" />;
    case 'search':
      return <ReadBlock event={event} verb="search" />;
    default:
      return <GenericToolBlock event={event} />;
  }
}

const BANNER_KIND: Record<string, string> = {
  gate_pass: 'ok',
  gate_fail: 'fail',
  correction: 'warn',
  interrupt: 'warn',
  error: 'fail',
  handoff: 'info',
};

function Banner({ event }: { event: EventRow }): React.JSX.Element {
  const kind = BANNER_KIND[event.type] ?? 'info';
  const p = event.payload;
  const detail =
    str(p.detail) ||
    str(p.question) ||
    (event.type === 'correction'
      ? `retry ${String(p.attempt ?? '')} of ${String(p.budget ?? '')}`
      : '') ||
    str(p.to) ||
    str(p.gate);
  return (
    <div className={`te banner ${kind}`}>
      <span className="te-banner-name">{event.name}</span>
      {detail && <span className="te-banner-detail">{detail}</span>}
      <Time iso={event.startedAt} />
    </div>
  );
}

function LogRow({ event }: { event: EventRow }): React.JSX.Element {
  const detail =
    str(event.payload.detail) ||
    str(event.payload.skipped) ||
    str(event.payload.text) ||
    str(event.payload.message);
  return (
    <div className="te logrow">
      <span className="te-log-name">{event.name}</span>
      {detail && <span className="te-log-detail">{detail}</span>}
      <Time iso={event.startedAt} />
    </div>
  );
}

function UsageRow({ event }: { event: EventRow }): React.JSX.Element | null {
  const usage = event.payload.usage as UsageBreakdown | undefined;
  if (!usage) return null;
  if (!usage.reported) {
    return (
      <div className="te usage">
        <span className="te-tag">turn</span>
        <span className="te-banner-detail">usage unreported by this CLI</span>
        <Time iso={event.startedAt} />
      </div>
    );
  }
  const total = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens;
  const parts = [`${tokens(total)} tokens`];
  if (usage.thinkingTokens) parts.push(`${tokens(usage.thinkingTokens)} thinking`);
  if (usage.credits) parts.push(`${credits(usage.credits)} credits`);
  return (
    <div className="te usage">
      <span className="te-tag">turn</span>
      <span className="te-banner-detail">{parts.join(' · ')}</span>
      <Time iso={event.startedAt} />
    </div>
  );
}

/** Renders one trace row as the transcript entry it represents. */
export function TranscriptEntry({ event }: { event: EventRow }): React.JSX.Element | null {
  switch (event.type) {
    case 'thinking':
      return <ThinkingBlock event={event} />;
    case 'assistant_text':
      return <TextBlock event={event} />;
    case 'tool_call':
      return <ToolBlock event={event} />;
    case 'gate_pass':
    case 'gate_fail':
    case 'correction':
    case 'interrupt':
    case 'error':
    case 'handoff':
      return <Banner event={event} />;
    case 'agent_end':
      return <UsageRow event={event} />;
    case 'log':
      return <LogRow event={event} />;
    case 'agent_start':
    case 'phase_start':
    case 'phase_end':
      // The lane header already says who is running; envelopes get a card.
      return null;
    default:
      return null;
  }
}

export function transcriptStyles(): string {
  return `
    .te { margin: 2px 0; }
    .te-head, .te-row-head, .te-cmd-head { display: flex; align-items: baseline; gap: 8px; width: 100%; border: none; background: none; padding: 2px 0; font: inherit; color: inherit; text-align: left; cursor: default; }
    button.te-row-head, button.te-cmd-head { cursor: pointer; }
    .te-time { margin-left: auto; font-size: 10px; color: var(--text-ghost, var(--text-faint)); flex: none; }
    .te-tag { flex: none; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-faint); }
    .te-tag.edit { color: var(--amber); }
    .te-tag.read { color: var(--cyan); }
    .te-tag.tool { color: var(--text-dim); }
    .te-thinking-body { margin: 2px 0 4px; padding-left: 10px; border-left: 2px solid var(--line); color: var(--text-faint); font-size: 12.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
    .te.thinking.open .te-thinking-body { border-left-color: var(--cyan); }
    .te-text-body { font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
    .te-caret { display: inline-block; width: 7px; height: 13px; margin-left: 3px; vertical-align: -2px; background: var(--cyan); animation: te-blink 1s steps(2) infinite; }
    @keyframes te-blink { 50% { opacity: 0; } }
    .te-cmd { font-size: 12.5px; color: var(--text); word-break: break-all; }
    .te-prompt { color: var(--green); font-family: var(--font-mono); flex: none; }
    .te-exec { flex: none; font-size: 10px; padding: 1px 7px; border-radius: var(--r-full); }
    .te-exec.ok { color: var(--green); background: var(--green-dim); }
    .te-exec.fail { color: var(--red); background: var(--red-dim); }
    .te-exec.running { color: var(--cyan); background: var(--cyan-dim); animation: pulse 1.4s var(--ease) infinite; }
    .te-output { margin: 4px 0 6px; padding: 8px 10px; max-height: 320px; overflow: auto; background: var(--bg-void); border: 1px solid var(--line-faint); border-radius: var(--r-sm); font-size: 11.5px; line-height: 1.5; color: var(--text-dim); white-space: pre-wrap; word-break: break-word; }
    .te.command.failed .te-output { border-color: color-mix(in srgb, var(--red) 30%, transparent); }
    .te-path { font-size: 12px; color: var(--text-dim); word-break: break-all; }
    .te-truncated { font-size: 10.5px; color: var(--amber); margin: 2px 0 6px; }
    .te.banner { display: flex; align-items: baseline; gap: 8px; margin: 6px 0; padding: 6px 10px; border-radius: var(--r-sm); font-size: 12px; }
    .te.banner.ok { background: var(--green-dim); color: var(--green); }
    .te.banner.fail { background: var(--red-dim); color: var(--red); }
    .te.banner.warn { background: var(--amber-dim); color: var(--amber); }
    .te.banner.info { background: var(--cyan-dim); color: var(--cyan); }
    .te-banner-name { font-weight: 600; }
    .te-banner-detail { opacity: 0.85; word-break: break-word; }
    .te.banner .te-time, .te.usage .te-time { color: inherit; opacity: 0.6; }
    .te.usage { display: flex; align-items: baseline; gap: 8px; margin: 4px 0; font-size: 11px; color: var(--text-faint); }
    .te.logrow { display: flex; align-items: baseline; gap: 8px; margin: 2px 0; font-size: 11px; color: var(--text-faint); }
    .te-log-name { font-weight: 500; }
    .te-log-detail { opacity: 0.8; word-break: break-word; }
  `;
}
