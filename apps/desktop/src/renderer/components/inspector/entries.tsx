/**
 * One renderer per transcript entry. The Inspector shows what an agent's own
 * CLI shows, formatted in the style of Claude Code: clear tool call headers,
 * explicit line-by-line diffs for edits, collapsible command outputs, and zero
 * raw JSON blocks or unformatted turn dumps.
 *
 * An entry with no endedAt is still open: the agent is mid-thought or a tool
 * is mid-run, and the block shows that rather than pretending to be finished.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { EventRow, UsageBreakdown } from '@shared/types.js';
import { clockTime, tokens } from '../../utils/format.js';
import { isAutoAllowPolicy } from '../../utils/derive.js';
import { useCollapseSignal } from './collapse.js';

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function args(event: EventRow): Record<string, unknown> {
  const value = event.payload.args;
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * The kind of work a tool call is, for display formatting.
 *
 * `payload.kind` is authoritative — pi's event mapper classifies every call it
 * emits. The name heuristics below only run when that field is missing, and
 * they cover pi's tool set. Anything else returns `other`, which renders the
 * tool's own name rather than hiding the call.
 */
function inferKind(event: EventRow): string {
  const kind = str(event.payload.kind);
  if (kind) return kind;
  if (Array.isArray(event.payload.argv)) return 'command';
  const head = event.name.split(':', 1)[0]!.toLowerCase();
  if (head === 'bash') return 'command';
  if (head === 'read') return 'read';
  if (head === 'edit' || head === 'write') return 'edit';
  if (head === 'grep' || head === 'find' || head === 'ls') return 'search';
  if (head === 'report_progress') return 'progress';
  if (head === 'submit_envelope' || head === 'read_phase_context') return 'envelope';
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

/** Whatever identifies the target after `name: `, regardless of case. */
function nameSummary(event: EventRow): string {
  const colon = event.name.indexOf(': ');
  return colon > 0 ? event.name.slice(colon + 2) : event.name;
}

/** The folder writes the full record to stream.jsonl when it caps a field. */
function TruncatedNote(): React.JSX.Element {
  return <div className="te-truncated">truncated here, full text in stream.jsonl</div>;
}

function Time({ iso }: { iso: string }): React.JSX.Element {
  return <span className="te-time">{clockTime(iso)}</span>;
}

function ExpandToggle({
  expanded,
  hiddenCount,
  onToggle,
}: {
  expanded: boolean;
  hiddenCount: number;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <button className="te-expand-btn" onClick={onToggle}>
      {expanded ? '▲ Show less' : `▼ Show ${hiddenCount} more lines`}
    </button>
  );
}

/**
 * Render monospaced text with line capping and expand/collapse button.
 * Avoids giant outputs that overflow the view.
 */
function TruncatedOutput({
  text,
  maxLines = 12,
  mono = true,
}: {
  text: string;
  maxLines?: number;
  mono?: boolean;
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => (text ? text.split('\n') : []), [text]);

  if (!text) return null;

  const hasMore = lines.length > maxLines;
  const visibleLines = expanded || !hasMore ? lines : lines.slice(0, maxLines);

  return (
    <div className="te-output-wrapper">
      <pre className={`te-output ${mono ? 'mono' : ''}`}>{visibleLines.join('\n')}</pre>
      {hasMore && (
        <ExpandToggle
          expanded={expanded}
          hiddenCount={lines.length - maxLines}
          onToggle={() => setExpanded((v) => !v)}
        />
      )}
    </div>
  );
}

// ── Diff View Component ──────────────────────────────────────────────────────

interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'hunk';
  text: string;
}

const DIFF_PREFIX: Record<DiffLine['type'], string> = {
  add: '+',
  del: '-',
  hunk: '@',
  ctx: ' ',
};

/** Line-level diff of old vs new text, with up to 2 lines of shared context. */
function diffStrings(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');

  if (!oldStr && newStr) return newLines.map((l) => ({ type: 'add', text: l }));
  if (!newStr && oldStr) return oldLines.map((l) => ({ type: 'del', text: l }));

  let prefixLen = 0;
  while (
    prefixLen < oldLines.length &&
    prefixLen < newLines.length &&
    oldLines[prefixLen] === newLines[prefixLen]
  ) {
    prefixLen++;
  }

  let suffixLen = 0;
  while (
    suffixLen < oldLines.length - prefixLen &&
    suffixLen < newLines.length - prefixLen &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const lines: DiffLine[] = [];
  for (let i = Math.max(0, prefixLen - 2); i < prefixLen; i++) {
    lines.push({ type: 'ctx', text: oldLines[i]! });
  }
  for (const l of oldLines.slice(prefixLen, oldLines.length - suffixLen)) {
    lines.push({ type: 'del', text: l });
  }
  for (const l of newLines.slice(prefixLen, newLines.length - suffixLen)) {
    lines.push({ type: 'add', text: l });
  }
  const ctxSuffixEnd = Math.min(oldLines.length, oldLines.length - suffixLen + 2);
  for (let i = oldLines.length - suffixLen; i < ctxSuffixEnd; i++) {
    lines.push({ type: 'ctx', text: oldLines[i]! });
  }
  return lines;
}

/** Unified-diff text as classified lines, or all-context when it is not a diff. */
function parseUnifiedDiff(rawResult: string): DiffLine[] {
  const rLines = rawResult.split('\n');
  if (!rLines.some((l) => l.startsWith('@@') || l.startsWith('+') || l.startsWith('-'))) {
    return rLines.map((l) => ({ type: 'ctx', text: l }));
  }
  const lines: DiffLine[] = [];
  for (const l of rLines) {
    if (l.startsWith('+++') || l.startsWith('---')) continue;
    if (l.startsWith('@@')) lines.push({ type: 'hunk', text: l });
    else if (l.startsWith('+')) lines.push({ type: 'add', text: l.slice(1) });
    else if (l.startsWith('-')) lines.push({ type: 'del', text: l.slice(1) });
    else lines.push({ type: 'ctx', text: l.startsWith(' ') ? l.slice(1) : l });
  }
  return lines;
}

function computeDiff(
  oldStr?: string,
  newStr?: string,
  content?: string,
  rawResult?: string,
): { lines: DiffLine[]; addCount: number; delCount: number } {
  let lines: DiffLine[] = [];
  if (oldStr !== undefined || newStr !== undefined) {
    lines = diffStrings(oldStr ?? '', newStr ?? '');
  } else if (content !== undefined) {
    lines = content.split('\n').map((l) => ({ type: 'add', text: l }));
  } else if (rawResult) {
    lines = parseUnifiedDiff(rawResult);
  }

  return {
    lines,
    addCount: lines.filter((l) => l.type === 'add').length,
    delCount: lines.filter((l) => l.type === 'del').length,
  };
}

function DiffView({
  oldStr,
  newStr,
  content,
  result,
  maxLines = 15,
}: {
  oldStr?: string;
  newStr?: string;
  content?: string;
  result?: string;
  maxLines?: number;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const { lines, addCount, delCount } = useMemo(
    () => computeDiff(oldStr, newStr, content, result),
    [oldStr, newStr, content, result],
  );

  if (lines.length === 0) return <div className="te-empty-diff">No changes</div>;

  const hasMore = lines.length > maxLines;
  const visibleLines = expanded || !hasMore ? lines : lines.slice(0, maxLines);

  return (
    <div className="te-diff-container">
      {(addCount > 0 || delCount > 0) && (
        <div className="te-diff-stat-bar">
          {addCount > 0 && <span className="te-diff-stat add">+{addCount}</span>}
          {delCount > 0 && <span className="te-diff-stat del">-{delCount}</span>}
          <span className="te-diff-line-count">{lines.length} lines changed</span>
        </div>
      )}
      <div className="te-diff-body mono">
        {visibleLines.map((line, idx) => (
          <div key={idx} className={`te-diff-line ${line.type}`}>
            <span className="te-diff-prefix">{DIFF_PREFIX[line.type]}</span>
            <span className="te-diff-text">{line.text || ' '}</span>
          </div>
        ))}
      </div>
      {hasMore && (
        <ExpandToggle
          expanded={expanded}
          hiddenCount={lines.length - maxLines}
          onToggle={() => setExpanded((v) => !v)}
        />
      )}
    </div>
  );
}

// ── Specialized Tool Blocks ──────────────────────────────────────────────────

function ThinkingBlock({ event }: { event: EventRow }): React.JSX.Element {
  const open = event.endedAt == null;
  const text = str(event.payload.text);
  const [collapsed, setCollapsed] = useState(false);
  const isLong = text.length > 300 || text.split('\n').length > 6;

  return (
    <div className={`te thinking ${open ? 'open' : ''}`}>
      <div className="te-head">
        <span className="te-tag">thought</span>
        {isLong && !open && (
          <button className="te-toggle-btn" onClick={() => setCollapsed((v) => !v)}>
            {collapsed ? 'show thought' : 'collapse thought'}
          </button>
        )}
        <Time iso={event.startedAt} />
      </div>
      {!collapsed && (
        <div className="te-thinking-body">
          {text}
          {open && <span className="te-caret" />}
        </div>
      )}
      {event.payload.truncated === true && <TruncatedNote />}
    </div>
  );
}

interface EnvelopePayload {
  status?: string;
  summary?: string;
  notes_for_next_agent?: string;
  changed_files?: string[];
  artifacts?: string[];
  commit_message?: string;
  diff_matches_claims?: boolean;
}

function parseJsonEnvelope(text: string): EnvelopePayload | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const marker =
      'status' in parsed ||
      'summary' in parsed ||
      'commit_message' in parsed ||
      'notes_for_next_agent' in parsed;
    if (!marker) return null;
    return {
      status: typeof parsed.status === 'string' ? parsed.status : undefined,
      summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
      notes_for_next_agent:
        typeof parsed.notes_for_next_agent === 'string' ? parsed.notes_for_next_agent : undefined,
      changed_files: Array.isArray(parsed.changed_files)
        ? (parsed.changed_files as string[])
        : undefined,
      artifacts: Array.isArray(parsed.artifacts) ? (parsed.artifacts as string[]) : undefined,
      commit_message: typeof parsed.commit_message === 'string' ? parsed.commit_message : undefined,
      diff_matches_claims:
        typeof parsed.diff_matches_claims === 'boolean' ? parsed.diff_matches_claims : undefined,
    };
  } catch {
    return null;
  }
}

function EnvelopeCardBlock({
  env,
  open,
  startedAt,
}: {
  env: EnvelopePayload;
  open: boolean;
  startedAt: string;
}): React.JSX.Element {
  const isOk = env.status === 'success' || env.status === 'accepted' || !env.status;
  return (
    <div className={`te envelope ${isOk ? 'ok' : 'fail'} ${open ? 'open' : ''}`}>
      <div className="te-row-head">
        <span className="te-tag envelope">report</span>
        {env.status && <span className={`te-exec ${isOk ? 'ok' : 'fail'}`}>{env.status}</span>}
        {env.commit_message && <span className="te-path mono">{env.commit_message}</span>}
        <Time iso={startedAt} />
      </div>
      {env.summary && <div className="te-envelope-summary">{env.summary}</div>}
      {env.notes_for_next_agent && (
        <div className="te-envelope-notes">
          <span className="te-envelope-label">Notes: </span>
          {env.notes_for_next_agent}
        </div>
      )}
      {Array.isArray(env.changed_files) && env.changed_files.length > 0 && (
        <div className="te-envelope-files">
          <span className="te-envelope-label">Changed files: </span>
          {env.changed_files.join(', ')}
        </div>
      )}
    </div>
  );
}

function TextBlock({ event }: { event: EventRow }): React.JSX.Element {
  const open = event.endedAt == null;
  const rawText = str(event.payload.text);
  const envelope = useMemo(() => parseJsonEnvelope(rawText), [rawText]);

  if (envelope) {
    return <EnvelopeCardBlock env={envelope} open={open} startedAt={event.startedAt} />;
  }

  const trimmed = rawText.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      const pretty = JSON.stringify(parsed, null, 2);
      return (
        <div className={`te text json ${open ? 'open' : ''}`}>
          <div className="te-row-head">
            <span className="te-tag json">data</span>
            <Time iso={event.startedAt} />
          </div>
          <TruncatedOutput text={pretty} maxLines={12} />
        </div>
      );
    } catch {
      // Fallback to plain text
    }
  }

  return (
    <div className={`te text ${open ? 'open' : ''}`}>
      <div className="te-text-body">
        {rawText}
        {open && <span className="te-caret" />}
      </div>
      {event.payload.truncated === true && <TruncatedNote />}
    </div>
  );
}

function CommandBlock({ event }: { event: EventRow }): React.JSX.Element {
  const [expanded, setExpanded] = useCollapsible(true);
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
      {expanded && (output || open) && <TruncatedOutput text={output} maxLines={12} />}
      {expanded && event.payload.truncated === true && <TruncatedNote />}
    </div>
  );
}

function EditBlock({ event }: { event: EventRow }): React.JSX.Element {
  const [expanded, setExpanded] = useCollapsible(true);
  const open = event.endedAt == null;
  const a = args(event);
  const path = str(a.file_path) || str(a.path) || nameSummary(event);
  const isCreate = /^create:/i.test(event.name) || Boolean(a.content && !a.old_str);
  const oldStr = typeof a.old_str === 'string' ? a.old_str : undefined;
  const newStr = typeof a.new_string === 'string' ? a.new_string : undefined;
  const content = typeof a.content === 'string' ? a.content : undefined;
  const rawResult = str(event.payload.result);

  return (
    <div className={`te edit ${open ? 'open' : ''}`}>
      <button className="te-row-head" onClick={() => setExpanded((v) => !v)}>
        <span className={`te-tag ${isCreate ? 'create' : 'edit'}`}>
          {isCreate ? 'create' : 'edit'}
        </span>
        <span className="te-path mono">{path}</span>
        {open && <span className="te-exec running">writing</span>}
        <Time iso={event.startedAt} />
      </button>
      {expanded && (
        <DiffView
          oldStr={oldStr}
          newStr={newStr}
          content={content}
          result={rawResult}
          maxLines={15}
        />
      )}
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
  const [expanded, setExpanded] = useCollapsible(false);
  const open = event.endedAt == null;
  const a = args(event);
  const target =
    str(a.file_path) || str(a.pattern) || str(a.query) || str(a.path) || nameSummary(event);
  const result = str(event.payload.result);
  const offset = typeof a.offset === 'number' ? a.offset : undefined;
  const limit = typeof a.limit === 'number' ? a.limit : undefined;
  const rangeInfo =
    offset !== undefined || limit !== undefined
      ? ` (lines ${offset ?? 1}-${(offset ?? 1) + (limit ?? 0)})`
      : '';

  return (
    <div className={`te read ${open ? 'open' : ''}`}>
      <button className="te-row-head" onClick={() => setExpanded((v) => !v)}>
        <span className={`te-tag ${verb}`}>{verb}</span>
        <span className="te-path mono">
          {target}
          {rangeInfo}
        </span>
        {open && (
          <span className="te-exec running">{str(event.payload.execPhase) || 'running'}</span>
        )}
        <Time iso={event.startedAt} />
      </button>
      {expanded && result && <TruncatedOutput text={result} maxLines={14} />}
      {expanded && event.payload.truncated === true && <TruncatedNote />}
    </div>
  );
}

interface TodoItem {
  id: number;
  status: 'completed' | 'in_progress' | 'pending';
  text: string;
}

function parseTodos(todosStr: string): TodoItem[] {
  if (!todosStr) return [];
  const lines = todosStr.split('\n');
  const items: TodoItem[] = [];
  for (const line of lines) {
    const match = line.match(/^(\d+)\.\s*\[(completed|in_progress|pending)\]\s*(.*)$/);
    if (match) {
      items.push({
        id: parseInt(match[1]!, 10),
        status: match[2] as 'completed' | 'in_progress' | 'pending',
        text: match[3]!.trim(),
      });
    }
  }
  return items;
}

function TodoBlock({ event }: { event: EventRow }): React.JSX.Element {
  const [expanded, setExpanded] = useCollapsible(true);
  const open = event.endedAt == null;
  const a = args(event);
  const todosStr = str(a.todos);
  const items = useMemo(() => parseTodos(todosStr), [todosStr]);
  const completedCount = items.filter((i) => i.status === 'completed').length;

  return (
    <div className={`te todo ${open ? 'open' : ''}`}>
      <button className="te-row-head" onClick={() => setExpanded((v) => !v)}>
        <span className="te-tag todo">todo</span>
        <span className="te-path mono">
          {items.length > 0
            ? `${completedCount}/${items.length} tasks completed`
            : 'Update task list'}
        </span>
        {open && <span className="te-exec running">updating</span>}
        <Time iso={event.startedAt} />
      </button>
      {expanded && items.length > 0 && (
        <div className="te-todo-list">
          {items.map((item) => (
            <div key={item.id} className={`te-todo-item ${item.status}`}>
              <span className={`te-todo-icon ${item.status}`}>
                {item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '●' : '○'}
              </span>
              <span className="te-todo-text">{item.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TaskBlock({ event }: { event: EventRow }): React.JSX.Element {
  const [expanded, setExpanded] = useCollapsible(true);
  const open = event.endedAt == null;
  const a = args(event);
  const description = str(a.description) || nameSummary(event);
  const subagentType = str(a.subagent_type) || 'subagent';
  const prompt = str(a.prompt);
  const result = str(event.payload.result);

  return (
    <div className={`te task ${open ? 'open' : ''}`}>
      <button className="te-row-head" onClick={() => setExpanded((v) => !v)}>
        <span className="te-tag task">task</span>
        <span className="te-subagent-badge">{subagentType}</span>
        <span className="te-path mono">{description}</span>
        {open && <span className="te-exec running">running</span>}
        <Time iso={event.startedAt} />
      </button>
      {expanded && (
        <div className="te-task-body">
          {prompt && <div className="te-task-prompt">{prompt}</div>}
          {result && <TruncatedOutput text={result} maxLines={10} />}
        </div>
      )}
    </div>
  );
}

function AskBlock({ event }: { event: EventRow }): React.JSX.Element {
  const [expanded, setExpanded] = useCollapsible(true);
  const open = event.endedAt == null;
  const a = args(event);
  const questionnaire = str(a.questionnaire);
  const result = str(event.payload.result);

  return (
    <div className={`te ask ${open ? 'open' : ''}`}>
      <button className="te-row-head" onClick={() => setExpanded((v) => !v)}>
        <span className="te-tag ask">ask user</span>
        <span className="te-path mono">Questionnaire prompt</span>
        {open && <span className="te-exec running">waiting</span>}
        <Time iso={event.startedAt} />
      </button>
      {expanded && (
        <div className="te-ask-body">
          {questionnaire && <div className="te-ask-q">{questionnaire}</div>}
          {result && <div className="te-ask-a">Answer: {result}</div>}
        </div>
      )}
    </div>
  );
}

function formatArgsSummary(a: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(a)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (!trimmed) continue;
      parts.push(`${k}: "${trimmed.length > 35 ? trimmed.slice(0, 32) + '…' : trimmed}"`);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      parts.push(`${k}: ${v}`);
    }
  }
  return parts.slice(0, 3).join(' · ');
}

function GenericToolBlock({ event }: { event: EventRow }): React.JSX.Element {
  const [expanded, setExpanded] = useCollapsible(false);
  const open = event.endedAt == null;
  const result = str(event.payload.result);
  const a = args(event);
  const colon = event.name.indexOf(': ');
  const toolName = colon > 0 ? event.name.slice(0, colon) : event.name;
  const summary = colon > 0 ? event.name.slice(colon + 2) : formatArgsSummary(a);

  return (
    <div className={`te tool ${open ? 'open' : ''}`}>
      <button className="te-row-head" onClick={() => setExpanded((v) => !v)}>
        <span className="te-tag tool">{toolName}</span>
        <span className="te-path mono">{summary}</span>
        {open && (
          <span className="te-exec running">{str(event.payload.execPhase) || 'running'}</span>
        )}
        <Time iso={event.startedAt} />
      </button>
      {expanded && result && <TruncatedOutput text={result} maxLines={12} />}
    </div>
  );
}

function ToolBlock({ event }: { event: EventRow }): React.JSX.Element {
  switch (inferKind(event)) {
    case 'command':
      return <CommandBlock event={event} />;
    case 'edit':
      return <EditBlock event={event} />;
    case 'read':
      return <ReadBlock event={event} verb="read" />;
    case 'search':
      return <ReadBlock event={event} verb="search" />;
    case 'todo':
      return <TodoBlock event={event} />;
    case 'task':
      return <TaskBlock event={event} />;
    case 'ask':
      return <AskBlock event={event} />;
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
  compaction: 'info',
};

/**
 * A compaction row names the act rather than the agent: it is recorded under
 * the agent's name, and the lane header already says whose transcript this is.
 */
const BANNER_NAME: Record<string, string> = {
  compaction: 'context compacted',
};

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** How full a window was, as the percentage the lane's context meter shows. */
function occupancy(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;
  const stats = value as Record<string, unknown>;
  const used = num(stats.used);
  const limit = num(stats.limit);
  if (used == null || !limit) return null;
  return Math.min(100, Math.round((used / limit) * 100));
}

/**
 * What a compaction cost and what it bought. The after-stats are optional: the
 * engine records the event even when the follow-up occupancy read failed, and a
 * compaction that happened must still be visible.
 */
function compactionDetail(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  const removed = num(payload.removedCount);
  if (removed != null) parts.push(`${removed} message${removed === 1 ? '' : 's'} removed`);
  const before = occupancy(payload.before);
  const after = occupancy(payload.after);
  if (before != null && after != null) parts.push(`${before}% → ${after}% of context`);
  else if (before != null) parts.push(`from ${before}% of context`);
  return parts.join(' · ');
}

function Banner({ event }: { event: EventRow }): React.JSX.Element {
  const kind = BANNER_KIND[event.type] ?? 'info';
  const p = event.payload;
  const detail =
    event.type === 'compaction'
      ? compactionDetail(p)
      : str(p.detail) ||
        str(p.question) ||
        str(p.reason) ||
        (event.type === 'correction'
          ? `retry ${String(p.attempt ?? '')} of ${String(p.budget ?? '')}`
          : '') ||
        str(p.to) ||
        str(p.gate);
  return (
    <div className={`te banner ${kind}`}>
      <span className="te-banner-name">{BANNER_NAME[event.type] ?? event.name}</span>
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
        <span className="te-banner-detail">usage unreported by this model</span>
        <Time iso={event.startedAt} />
      </div>
    );
  }
  const total = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens;
  const parts = [`${tokens(total)} tokens`];
  if (usage.thinkingTokens) parts.push(`${tokens(usage.thinkingTokens)} thinking`);
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
    // A type missing from this switch falls to the default and vanishes from the
    // timeline with nothing to show it was ever recorded, so every addition to
    // `EventType` needs a case here — Banner is the default home for one.
    case 'interrupt':
      if (isAutoAllowPolicy(event)) return null;
      return <Banner event={event} />;
    case 'gate_pass':
    case 'gate_fail':
    case 'correction':
    case 'error':
    case 'handoff':
    case 'compaction':
      return <Banner event={event} />;
    case 'agent_end':
      return <UsageRow event={event} />;
    case 'log':
      return <LogRow event={event} />;
    case 'agent_start':
    case 'phase_start':
    case 'phase_end':
      return null;
    default:
      return null;
  }
}

/**
 * A collapse that leaves the user's re-expands intact: `initial` is the open
 * default; a global collapse flips every adopter to closed. Because individual
 * toggles use the returned setter, anything expanded after a collapse survives
 * until the next collapse. Newly mounted entries (live tail) do not inherit a
 * past collapse — they render at their natural `initial`.
 */
function useCollapsible(
  initial: boolean,
): [boolean, React.Dispatch<React.SetStateAction<boolean>>] {
  const signal = useCollapseSignal();
  const [value, setValue] = useState(initial);
  const seenSignal = useRef(signal);
  useEffect(() => {
    // Incrementing `signal` is the operator's collapse; zero is "never."
    if (signal > 0 && signal !== seenSignal.current) {
      seenSignal.current = signal;
      setValue(false);
    }
  }, [signal]);
  return [value, setValue];
}

export function transcriptStyles(): string {
  return `
    /* Agent output is for reading and copying — opt out of the app-wide
     * body { user-select: none } so click-and-drag feels native. Inline
     * chrome (tags, times, toggles) stays non-selectable so a copy is clean. */
    .te-text-body, .te-thinking-body, .te-output, .te-diff-body, .te-todo-list, .te-task-body, .te-ask-body, .te-envelope-summary, .te-envelope-notes, .te-envelope-files, .te-ask-q, .te-ask-a, .te-banner-detail, .te-log-detail { user-select: text; -webkit-user-select: text; cursor: text; }
    .te { margin: 4px 0; }
    .te-head, .te-row-head, .te-cmd-head { display: flex; align-items: center; gap: var(--s2); width: 100%; border: none; background: none; padding: 4px 6px; font: inherit; color: inherit; text-align: left; cursor: default; border-radius: var(--r-sm); transition: background var(--fast) var(--ease); }
    button.te-row-head:hover, button.te-cmd-head:hover { background: var(--bg-hover); }
    .te-time { margin-left: auto; font-family: var(--font-mono); font-size: 10px; color: var(--text-ghost); flex: none; font-variant-numeric: tabular-nums; letter-spacing: 0.04em; }
    .te-tag { flex: none; font-family: var(--font-mono); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; padding: 1px 6px; border-radius: var(--r-sm); background: var(--bg-raised); color: var(--text-faint); border: 1px solid transparent; }
    .te-tag.edit { color: var(--amber); background: var(--amber-dim); border-color: color-mix(in srgb, var(--amber) 14%, transparent); }
    .te-tag.create { color: var(--green); background: var(--green-dim); border-color: color-mix(in srgb, var(--green) 14%, transparent); }
    .te-tag.read { color: var(--accent); background: var(--accent-dim); border-color: color-mix(in srgb, var(--accent) 14%, transparent); }
    .te-tag.search { color: var(--purple); background: var(--purple-dim); border-color: color-mix(in srgb, var(--purple) 14%, transparent); }
    .te-tag.todo { color: var(--green); background: var(--green-dim); border-color: color-mix(in srgb, var(--green) 14%, transparent); }
    .te-tag.task { color: var(--blue); background: var(--blue-dim); border-color: color-mix(in srgb, var(--blue) 14%, transparent); }
    .te-tag.ask { color: var(--purple); background: var(--purple-dim); border-color: color-mix(in srgb, var(--purple) 14%, transparent); }
    .te-tag.envelope { color: var(--purple); background: var(--purple-dim); border-color: color-mix(in srgb, var(--purple) 14%, transparent); }
    .te-tag.json { color: var(--blue); background: var(--blue-dim); border-color: color-mix(in srgb, var(--blue) 14%, transparent); }
    .te-tag.tool { color: var(--text-dim); background: var(--bg-raised); border-color: var(--line); }

    .te-subagent-badge { font-family: var(--font-mono); font-size: 10px; font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; padding: 1px 6px; border-radius: var(--r-sm); background: var(--blue-dim); color: var(--blue); border: 1px solid color-mix(in srgb, var(--blue) 14%, transparent); }

    .te-thinking-body { margin: 2px 0 4px; padding: 4px 10px; border-left: 2px solid var(--line); color: var(--text-faint); font-size: 12.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; font-style: italic; }
    .te.thinking.open .te-thinking-body { border-left-color: var(--accent); }
    .te-toggle-btn { border: none; background: none; color: var(--text-faint); font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; cursor: default; text-decoration: underline; margin-left: 6px; }

    .te-text-body { font-size: var(--text-sm); line-height: 1.6; white-space: pre-wrap; word-break: break-word; padding: 4px 6px; color: var(--text); }
    .te-caret { display: inline-block; width: 7px; height: 13px; margin-left: 3px; vertical-align: -2px; background: var(--accent); animation: te-blink 1s steps(2) infinite; }
    @keyframes te-blink { 50% { opacity: 0; } }

    .te-cmd { font-family: var(--font-mono); font-size: 12px; color: var(--text); word-break: break-all; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .te-prompt { color: var(--green); font-family: var(--font-mono); font-weight: 700; flex: none; }

    .te-exec { flex: none; font-family: var(--font-mono); font-size: 10px; font-weight: 500; letter-spacing: 0.04em; text-transform: uppercase; padding: 1px 7px; border-radius: var(--r-sm); border: 1px solid transparent; }
    .te-exec.ok { color: var(--green); background: var(--green-dim); border-color: color-mix(in srgb, var(--green) 14%, transparent); }
    .te-exec.fail { color: var(--red); background: var(--red-dim); border-color: color-mix(in srgb, var(--red) 14%, transparent); }
    .te-exec.running { color: var(--accent); background: var(--accent-dim); border-color: color-mix(in srgb, var(--accent) 14%, transparent); animation: pulse 1.4s var(--ease) infinite; }

    .te-output-wrapper { margin: 4px 0 6px; }
    .te-output { margin: 0; padding: 8px 10px; background: var(--bg-input); border: 1px solid var(--line-faint); border-radius: var(--r-sm); font-family: var(--font-mono); font-size: 11.5px; line-height: 1.5; color: var(--text-dim); white-space: pre-wrap; word-break: break-word; overflow-x: auto; }
    .te.command.failed .te-output { border-color: color-mix(in srgb, var(--red) 22%, transparent); }

    .te-expand-btn { display: block; width: 100%; margin-top: 2px; padding: 4px 0; border: none; background: var(--bg-raised); color: var(--text-faint); font-family: var(--font-mono); font-size: 10px; font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; cursor: default; border-radius: 0 0 var(--r-sm) var(--r-sm); text-align: center; transition: color var(--fast) var(--ease), background var(--fast) var(--ease); }
    .te-expand-btn:hover { color: var(--text); background: var(--bg-hover); }

    .te-path { font-family: var(--font-mono); font-size: 11px; color: var(--text-dim); word-break: break-all; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .te-truncated { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--amber); margin: 2px 0 6px; }

    /* ── Diff styling ── */
    .te-diff-container { margin: 4px 0 6px; border: 1px solid var(--line); border-radius: var(--r-sm); overflow: hidden; background: var(--bg-input); }
    .te-diff-stat-bar { display: flex; align-items: center; gap: var(--s2); padding: 4px 10px; background: var(--bg-raised); border-bottom: 1px solid var(--line); font-family: var(--font-mono); font-size: 10px; font-weight: 500; letter-spacing: 0.04em; text-transform: uppercase; }
    .te-diff-stat { font-weight: 600; font-family: var(--font-mono); padding: 0 4px; border-radius: var(--r-sm); font-size: 10px; letter-spacing: 0.04em; }
    .te-diff-stat.add { color: var(--green); background: var(--green-dim); border: 1px solid color-mix(in srgb, var(--green) 14%, transparent); }
    .te-diff-stat.del { color: var(--red); background: var(--red-dim); border: 1px solid color-mix(in srgb, var(--red) 14%, transparent); }
    .te-diff-line-count { color: var(--text-faint); font-size: 10px; margin-left: auto; text-transform: none; letter-spacing: 0; }
    .te-diff-body { padding: 4px 0; font-family: var(--font-mono); font-size: 11.5px; line-height: 1.45; overflow-x: auto; }
    .te-diff-line { display: flex; padding: 1px 8px; white-space: pre-wrap; word-break: break-word; }
    .te-diff-prefix { width: 16px; flex: none; user-select: none; font-weight: bold; }
    .te-diff-text { flex: 1; min-width: 0; }
    .te-diff-line.add { background: color-mix(in srgb, var(--green) 10%, transparent); color: var(--green); }
    .te-diff-line.add .te-diff-prefix { color: var(--green); }
    .te-diff-line.del { background: color-mix(in srgb, var(--red) 10%, transparent); color: var(--red); }
    .te-diff-line.del .te-diff-prefix { color: var(--red); }
    .te-diff-line.ctx { color: var(--text-dim); }
    .te-diff-line.hunk { color: var(--accent); background: var(--accent-dim); font-style: italic; }
    .te-empty-diff { padding: 8px 10px; font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-faint); }

    /* ── Todo list styling ── */
    .te-todo-list { margin: 4px 0 6px; padding: 6px 10px; background: var(--bg-input); border: 1px solid var(--line); border-radius: var(--r-sm); display: flex; flex-direction: column; gap: 4px; }
    .te-todo-item { display: flex; align-items: baseline; gap: var(--s2); font-size: var(--text-xs); }
    .te-todo-icon { font-weight: bold; flex: none; font-size: 11px; }
    .te-todo-icon.completed { color: var(--green); }
    .te-todo-icon.in_progress { color: var(--accent); animation: pulse 1.4s var(--ease) infinite; }
    .te-todo-icon.pending { color: var(--text-faint); }
    .te-todo-item.completed .te-todo-text { color: var(--text-faint); text-decoration: line-through; }
    .te-todo-item.in_progress .te-todo-text { color: var(--text); font-weight: 500; }
    .te-todo-item.pending .te-todo-text { color: var(--text-dim); }

    /* ── Task & Ask styling ── */
    .te-task-body, .te-ask-body { margin: 4px 0 6px; padding: 8px 10px; background: var(--bg-input); border: 1px solid var(--line); border-radius: var(--r-sm); font-size: var(--text-xs); line-height: var(--leading); }
    .te-task-prompt, .te-ask-q { color: var(--text-dim); margin-bottom: 6px; line-height: 1.5; white-space: pre-wrap; }
    .te-ask-a { color: var(--green); font-weight: 500; }

    /* ── Envelope & JSON styling ── */
    .te.envelope { margin: 4px 0 6px; padding: 6px 10px; background: var(--bg-input); border: 1px solid var(--line); border-radius: var(--r-sm); }
    .te.envelope.ok { border-color: color-mix(in srgb, var(--green) 22%, transparent); }
    .te.envelope.fail { border-color: color-mix(in srgb, var(--red) 22%, transparent); }
    .te-envelope-summary { font-size: var(--text-sm); color: var(--text); margin-top: 4px; line-height: 1.5; font-weight: 500; }
    .te-envelope-notes { font-size: var(--text-xs); color: var(--text-dim); margin-top: 4px; line-height: 1.45; }
    .te-envelope-files { font-size: var(--text-xs); color: var(--text-faint); margin-top: 4px; font-family: var(--font-mono); }
    .te-envelope-label { font-family: var(--font-mono); font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-faint); }

    .te.banner { display: flex; align-items: baseline; gap: var(--s2); margin: 6px 0; padding: 6px 10px; border-radius: var(--r-sm); border: 1px solid transparent; font-size: var(--text-xs); line-height: var(--leading); }
    .te.banner.ok { background: var(--green-dim); color: var(--green); border-color: color-mix(in srgb, var(--green) 14%, transparent); }
    .te.banner.fail { background: var(--red-dim); color: var(--red); border-color: color-mix(in srgb, var(--red) 14%, transparent); }
    .te.banner.warn { background: var(--amber-dim); color: var(--amber); border-color: color-mix(in srgb, var(--amber) 14%, transparent); }
    .te.banner.info { background: var(--accent-dim); color: var(--accent); border-color: color-mix(in srgb, var(--accent) 14%, transparent); }
    .te-banner-name { font-family: var(--font-mono); font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }
    .te-banner-detail { opacity: 0.9; word-break: break-word; font-size: var(--text-xs); }
    .te.banner .te-time, .te.usage .te-time { color: inherit; opacity: 0.6; }
    .te.usage { display: flex; align-items: baseline; gap: var(--s2); margin: 4px 0; font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-faint); }
    .te.logrow { display: flex; align-items: baseline; gap: var(--s2); margin: 2px 0; font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.02em; color: var(--text-faint); }
    .te-log-name { font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }
    .te-log-detail { opacity: 0.8; word-break: break-word; text-transform: none; letter-spacing: 0; font-family: var(--font); }
  `;
}
