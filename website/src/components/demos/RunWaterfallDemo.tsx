/**
 * The Inspector waterfall.
 *
 * Replays a real Refine → Build → Ship trace: phase lanes fill left to right on
 * a shared timeline, each bar segmented into one tick per tool call and
 * coloured by what kind of call it was. The right pane streams that phase's
 * transcript, and switches to whichever phase is currently running unless you
 * pin one by clicking its lane.
 *
 * Mirrors src/renderer/components/Waterfall.tsx and
 * src/renderer/components/inspector/TranscriptLane.tsx.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { RUN, TOOL_COLOR, KIND_LABEL, agentColor, GATE_DESCRIPTIONS } from '../../data/foundry';
import type { RunPhase, ToolCall } from '../../data/foundry';
import { useInView, useRafElapsed, useReducedMotion } from '../../hooks';
import { Badge, Dot } from '../ui';

/** Wall-clock seconds it takes to replay the whole 6m51s run. */
const REPLAY_SECONDS = 9;
const HOLD_SECONDS = 2.2;

const pad = (n: number) => String(Math.floor(n)).padStart(2, '0');
const fmtDur = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${pad(s % 60)}s` : `${Math.round(s)}s`);
const fmtClock = (s: number) => `04:${pad(51 + Math.floor(s / 60))}:${pad(Math.floor(s) % 60)}`;
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

const phaseColor = (p: RunPhase): string =>
  p.kind === 'code' ? 'var(--blue)' : p.kind === 'engineer' ? 'var(--amber)' : agentColor(p.agent);

/** Tick widths inside a bar, weighted by call duration but compressed so a
 *  60s test command does not swallow the whole lane. */
function tickWeights(trace: ToolCall[]): number[] {
  const raw = trace.map((t) => Math.max(1, Math.sqrt(t.ms)));
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((w) => (w / sum) * 100);
}

const LEGEND: Array<keyof typeof TOOL_COLOR> = ['read', 'glob', 'edit', 'bash', 'gate', 'assistant'];

type Tab = 'timeline' | 'envelope' | 'gates';

export function RunWaterfallDemo() {
  const reduced = useReducedMotion();
  const [ref, inView] = useInView<HTMLDivElement>(0.2);
  const [elapsed, setElapsed] = useState(reduced ? RUN.total : 0);
  const [pinned, setPinned] = useState<number | null>(reduced ? 3 : null);
  const [tab, setTab] = useState<Tab>('timeline');

  useRafElapsed(inView && !reduced, (ms) => {
    const cycle = (REPLAY_SECONDS + HOLD_SECONDS) * 1000;
    const t = ms % cycle;
    setElapsed(Math.min((t / (REPLAY_SECONDS * 1000)) * RUN.total, RUN.total));
  });

  /* which phase is running right now */
  const activeIndex = useMemo(() => {
    const running = RUN.phases.findIndex((p) => elapsed >= p.start && elapsed < p.start + p.dur);
    if (running >= 0) return running;
    const done = RUN.phases.filter((p) => elapsed >= p.start + p.dur).length;
    return Math.max(0, Math.min(done, RUN.phases.length - 1));
  }, [elapsed]);

  const shownIndex = pinned ?? activeIndex;
  const shown = RUN.phases[shownIndex];

  /* how much of the shown phase's transcript has streamed */
  const shownProgress = Math.min(Math.max((elapsed - shown.start) / shown.dur, 0), 1);
  const rows = shown.trace.slice(0, Math.max(1, Math.round(shownProgress * shown.trace.length)));

  const streamRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows.length, shownIndex, tab]);

  const done = elapsed >= RUN.total;
  const frac = elapsed / RUN.total;
  const callsDone = RUN.phases.reduce((n, p) => {
    const local = Math.min(Math.max(elapsed - p.start, 0), p.dur);
    return n + Math.round((local / p.dur) * p.trace.length);
  }, 0);

  return (
    <div ref={ref} className="grid min-h-[460px] grid-cols-1 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      {/* ── left: header, lanes, verdict ─────────────────────────────── */}
      <div className="flex flex-col border-b border-line lg:border-b-0 lg:border-r">
        <header className="border-b border-line px-5 pb-4 pt-[18px]">
          <div className="flex flex-wrap items-center gap-[10px]">
            <Badge color={done ? 'var(--green)' : 'var(--accent)'}>
              <Dot color="currentColor" pulse={!done} />
              {done ? 'accepted' : 'running'}
            </Badge>
            <span className="text-[18px] font-semibold tracking-tight">{RUN.pipeline}</span>
            <span className="font-mono text-[12px] tabular-nums text-text-faint">
              {fmtDur(Math.round(elapsed))}
            </span>
          </div>

          <p className="mt-[10px] max-w-[60ch] text-[13.5px] leading-[1.55] text-text-dim">{RUN.request}</p>

          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-[6px] font-mono text-[11px] tabular-nums text-text-faint">
            <span>
              <b className="font-medium text-text-dim">
                {callsDone}/{RUN.calls}
              </b>{' '}
              tool calls
            </span>
            <span>
              <b className="font-medium text-text-dim">{(RUN.tokens * frac).toFixed(2)}M</b> tokens
            </span>
            <span>
              <b className="font-medium text-text-dim">${(RUN.cost * frac).toFixed(2)}</b>
            </span>
            <span className="text-accent">{RUN.branch}</span>
          </div>
        </header>

        <div className="flex-1 px-5 pb-5 pt-[14px]">
          <div className="flex justify-between pb-2 pl-[118px] font-mono text-[9px] tracking-[0.1em] text-text-ghost">
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i}>{Math.round((RUN.total / 4) * i)}s</span>
            ))}
          </div>

          {RUN.phases.map((p, i) => {
            const local = Math.min(Math.max(elapsed - p.start, 0), p.dur);
            const pct = (local / p.dur) * 100;
            const isShown = i === shownIndex;
            const started = local > 0;
            return (
              <button
                key={p.name}
                type="button"
                aria-pressed={isShown}
                onClick={() => setPinned(i)}
                className={`grid h-[34px] w-full grid-cols-[118px_minmax(0,1fr)] items-center gap-[10px] rounded-sm text-left transition-colors duration-fast ease-mech ${
                  isShown ? 'bg-bg-raised' : 'hover:bg-bg-hover'
                }`}
              >
                <span className="flex min-w-0 items-center gap-[7px] pl-2">
                  <i
                    className="h-[5px] w-[5px] flex-none rounded-full"
                    style={{ background: started ? phaseColor(p) : 'var(--text-ghost)' }}
                  />
                  <span
                    className={`truncate font-mono text-[11.5px] ${started ? 'text-text' : 'text-text-dim'}`}
                  >
                    {p.name}
                  </span>
                </span>

                <span
                  className="relative mr-2 h-[14px] rounded-[2px]"
                  style={{
                    backgroundImage:
                      'repeating-linear-gradient(to right, var(--line-faint) 0 1px, transparent 1px 10%)',
                  }}
                >
                  {/* the bar sits at its true final width and is revealed with
                      clip-path, so the ticks never rescale as it fills */}
                  <span
                    className="absolute inset-y-0 flex gap-px overflow-hidden rounded-[2px] bg-bg-raised"
                    style={{
                      left: `${(p.start / RUN.total) * 100}%`,
                      width: `${(p.dur / RUN.total) * 100}%`,
                      clipPath: `inset(0 ${(100 - pct).toFixed(2)}% 0 0)`,
                    }}
                  >
                    {tickWeights(p.trace).map((w, k) => (
                      <i
                        key={k}
                        className="min-w-px opacity-90"
                        style={{ flex: `${w} 1 0`, background: TOOL_COLOR[p.trace[k].tool] }}
                      />
                    ))}
                  </span>

                  {p.retries ? (
                    <span
                      className="absolute top-0 flex h-[14px] items-center font-mono text-[9px] text-amber"
                      style={{
                        left: `${(p.start / RUN.total) * 100}%`,
                        transform: 'translateX(calc(-100% - 4px))',
                      }}
                    >
                      ×{p.retries + 1}
                    </span>
                  ) : null}

                  <span
                    className="absolute top-0 flex h-[14px] items-center whitespace-nowrap pl-[6px] font-mono text-[9.5px] tabular-nums text-text-faint"
                    style={{ left: `${((p.start + local) / RUN.total) * 100}%` }}
                  >
                    {started ? fmtDur(local) : ''}
                  </span>
                </span>
              </button>
            );
          })}

          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-[6px] border-t border-line-faint pt-[13px]">
            {LEGEND.map((k) => (
              <span
                key={k}
                className="inline-flex items-center gap-[6px] font-mono text-[9px] uppercase tracking-label text-text-ghost"
              >
                <i className="h-[6px] w-[6px] flex-none rounded-[1px]" style={{ background: TOOL_COLOR[k] }} />
                {k}
              </span>
            ))}
          </div>
        </div>

        <div
          className={`mx-5 mb-[18px] flex items-center gap-3 rounded-sm border border-line border-l-2 border-l-green bg-bg-panel px-[14px] py-3 transition-[opacity,transform] duration-slow ease-mech ${
            done ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'
          }`}
        >
          <span className="label-sm text-green">accepted</span>
          <span className="text-[13.5px] text-text-dim">
            <b className="font-medium text-text">production_check</b> approved the work — 8 phases, 0 gate
            failures
          </span>
        </div>
      </div>

      {/* ── right: phase detail + transcript ─────────────────────────── */}
      <div className="flex min-w-0 flex-col bg-bg-panel">
        <PhaseHeader phase={shown} />

        <div className="flex gap-[2px] border-b border-line px-3">
          {(['timeline', 'envelope', 'gates'] as Tab[]).map((t) => {
            const count =
              t === 'timeline' ? shown.trace.length : t === 'gates' ? shown.gates.length : shown.envelope ? 1 : 0;
            return (
              <button
                key={t}
                type="button"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`-mb-px border-b px-[10px] py-[10px] font-mono text-[10px] uppercase tracking-label transition-colors duration-fast ease-mech ${
                  tab === t ? 'border-accent text-text' : 'border-transparent text-text-faint hover:text-text-dim'
                }`}
              >
                {t}
                {count ? <span className="ml-1 text-text-ghost">{count}</span> : null}
              </button>
            );
          })}

          <button
            type="button"
            onClick={() => setPinned(pinned === null ? shownIndex : null)}
            className={`my-auto ml-auto rounded-sm border px-2 py-[3px] font-mono text-[9px] uppercase tracking-eyebrow transition-colors duration-fast ease-mech ${
              pinned === null
                ? 'border-accent/45 bg-accent-dim text-accent'
                : 'border-line text-text-dim hover:text-text'
            }`}
          >
            {pinned === null ? 'following' : 'pinned'}
          </button>
        </div>

        {tab === 'timeline' ? (
          <div
            ref={streamRef}
            role="log"
            className="scroll max-h-[300px] min-h-[232px] flex-1 py-2 font-mono text-[11.5px] tabular-nums"
          >
            {rows.map((t, k) => (
              <TraceRow key={`${shown.name}-${k}`} call={t} at={shown.start + (shown.dur * (k + 1)) / shown.trace.length} />
            ))}
          </div>
        ) : (
          <JsonPane
            value={tab === 'envelope' ? envelopeFor(shown) : gatesFor(shown)}
          />
        )}
      </div>
    </div>
  );
}

/* ── pieces ──────────────────────────────────────────────────────────────── */

function PhaseHeader({ phase }: { phase: RunPhase }) {
  const meta = [
    KIND_LABEL[phase.kind],
    phase.agent ?? phase.command,
    phase.model,
    fmtDur(phase.dur),
    phase.tokens ? `${phase.tokens} tok` : null,
  ].filter(Boolean);

  return (
    <div className="border-b border-line px-[18px] py-4">
      <div className="flex items-center gap-[10px]">
        {phase.agent ? (
          <img
            src={`/media/agents/${phase.agent}.webp`}
            alt=""
            width={26}
            height={26}
            loading="lazy"
            className="h-[26px] w-[26px] flex-none rounded-full border border-line bg-black object-cover"
          />
        ) : null}
        <span className="font-mono text-[14px] text-text">{phase.name}</span>
        <Badge color="var(--green)">passed</Badge>
      </div>
      <div className="mt-[9px] font-mono text-[10px] uppercase tracking-label text-text-faint">
        {meta.join('  ·  ')}
      </div>
      <p className="mt-[9px] text-[13px] leading-[1.55] text-text-dim">{phase.desc}</p>
    </div>
  );
}

function TraceRow({ call, at }: { call: ToolCall; at: number }) {
  const color = TOOL_COLOR[call.tool];
  return (
    <div className="grid animate-row-in grid-cols-[10px_minmax(0,1fr)_auto_auto] items-baseline gap-2 px-3 py-[3px] text-text-dim">
      <span className="text-[9px] text-text-ghost">{call.tool === 'assistant' ? '▸' : '·'}</span>
      <span className="min-w-0 truncate">
        <b className="font-medium" style={{ color }}>
          {call.tool === 'assistant' || call.tool === 'envelope' || call.tool === 'gate'
            ? call.tool
            : `${call.tool}:`}
        </b>{' '}
        {call.arg}
      </span>
      <span className="text-[10px] text-text-ghost">{fmtMs(call.ms)}</span>
      <span className="text-[10px] text-text-ghost">{fmtClock(at)}</span>
    </div>
  );
}

function JsonPane({ value }: { value: unknown }) {
  const src = JSON.stringify(value, null, 2);
  return (
    <pre className="scroll max-h-[300px] min-h-[232px] px-[18px] py-[14px] font-mono text-[11.5px] leading-[1.7] text-text-dim">
      {src.split('\n').map((line, i) => (
        <JsonLine key={i} line={line} />
      ))}
    </pre>
  );
}

function JsonLine({ line }: { line: string }) {
  const m = /^(\s*)"([^"]+)":\s*(.*)$/.exec(line);
  if (!m) return <div className="text-text-ghost">{line}</div>;
  const [, indent, key, rest] = m;
  const isString = rest.startsWith('"');
  const isNumber = /^-?\d/.test(rest);
  return (
    <div>
      {indent}
      <span className="text-text-faint">&quot;{key}&quot;</span>
      <span className="text-text-ghost">: </span>
      <span className={isString ? 'text-green' : isNumber ? 'text-purple' : 'text-text-dim'}>{rest}</span>
    </div>
  );
}

/* ── the payloads the two non-timeline tabs show ─────────────────────────── */

function envelopeFor(p: RunPhase): Record<string, unknown> {
  if (p.kind === 'code') {
    return { phase: p.name, kind: 'command', command: p.command, exit_code: 0, duration_ms: p.dur * 1000 };
  }
  const base: Record<string, unknown> = { status: 'ok', phase: p.name, envelope: p.envelope };
  switch (p.envelope) {
    case 'brief':
      return {
        ...base,
        improved_request: 'Add a token-bucket rate limiter to every public API route.',
        constraints: ['in-process, no new dependency', 'keyed by API key', '429 with Retry-After'],
        acceptance_criteria: ['npm test passes', 'limiter covered by a test'],
      };
    case 'plan':
      return {
        ...base,
        approach: 'One middleware in src/server/middleware, wired in http.ts.',
        steps: 6,
        artifacts: ['specs/rate-limit.md'],
        commit_message: 'spec: rate limiting for the public API',
      };
    case 'build':
      return {
        ...base,
        files_changed: [
          'src/server/middleware/rate-limit.ts',
          'src/server/http.ts',
          'src/shared/types.ts',
          'tests/rate-limit.test.ts',
        ],
        commit_message: 'feat(api): token-bucket rate limiting',
      };
    case 'review':
      return {
        ...base,
        verdict: 'approved',
        findings: [{ requirement: 'Retry-After header', result: 'gap closed in this phase' }],
        blocking: [],
      };
    case 'pr':
      return {
        ...base,
        title: 'feat(api): token-bucket rate limiting for public routes',
        body: '## Summary\nAdds in-process token-bucket rate limiting to public endpoints.\n\n## Verification\n- npm test (all 703 passing)',
      };
    default:
      return base;
  }
}

function gatesFor(p: RunPhase): unknown {
  if (!p.gates.length) return { gates: [], note: 'This phase declares no gates.' };
  return p.gates.map((g) => ({ gate: g, passed: true, note: GATE_DESCRIPTIONS[g] }));
}
