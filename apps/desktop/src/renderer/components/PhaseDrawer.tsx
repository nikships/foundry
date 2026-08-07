import { useEffect, useMemo, useState } from 'react';
import type { EnvelopeRow, EventRow, GateResultRow, PhaseRow } from '@shared/types.js';
import { api } from '../api.js';
import { useApp } from '../stores/app.js';
import { clockTime, duration, tokens } from '../format.js';
import { modelFor, phaseDuration, usageFor } from '../derive.js';
import StatusBadge from './StatusBadge.js';
import AgentAvatar from './AgentAvatar.js';
import JsonView from './JsonView.js';

type Tab = 'timeline' | 'envelope' | 'gates' | 'prompt';

const EVENT_ICON: Record<string, string> = {
  phase_start: '▸',
  phase_end: '▪',
  agent_start: '◆',
  agent_end: '∑',
  tool_call: '⚙',
  handoff: '→',
  gate_pass: '⛨',
  gate_fail: '⛨',
  correction: '↻',
  interrupt: '☝',
  log: '·',
  error: '✕',
};

const EVENT_CLASS: Partial<Record<EventRow['type'], string>> = {
  gate_fail: 'bad',
  error: 'bad',
  correction: 'warn',
  gate_pass: 'good',
};

export default function PhaseDrawer({
  phase,
  events,
  envelopes,
  gates,
  live,
  now,
}: {
  phase: PhaseRow;
  events: EventRow[];
  envelopes: EnvelopeRow[];
  gates: GateResultRow[];
  live: boolean;
  now: number;
}): React.JSX.Element {
  const { projectId } = useApp();
  const [tab, setTab] = useState<Tab>('timeline');
  const [liveTail, setLiveTail] = useState('');
  const [liveTailError, setLiveTailError] = useState('');
  const [openEvents, setOpenEvents] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState('');
  const [promptError, setPromptError] = useState('');
  const [promptLoading, setPromptLoading] = useState(false);

  const usage = useMemo(() => usageFor(events), [events]);
  const model = useMemo(() => modelFor(events), [events]);
  const elapsed = useMemo(() => phaseDuration(phase, now), [phase, now]);
  const tabs = useMemo(
    () => [
      { id: 'timeline' as Tab, label: 'Timeline', count: events.length },
      { id: 'envelope' as Tab, label: 'Envelope', count: envelopes.length },
      { id: 'gates' as Tab, label: 'Gates', count: gates.length },
      { id: 'prompt' as Tab, label: 'Prompt' },
    ],
    [events.length, envelopes.length, gates.length],
  );

  useEffect(() => {
    let timer: number | null = null;
    setLiveTail('');
    setLiveTailError('');
    if (!live || phase.status !== 'running') return;
    const poll = async (): Promise<void> => {
      try {
        setLiveTail(await api.runs.liveTail(phase.phaseId));
        setLiveTailError('');
      } catch (e) {
        setLiveTailError((e as Error).message);
      }
    };
    void poll();
    timer = window.setInterval(() => void poll(), 600);
    return () => {
      if (timer !== null) window.clearInterval(timer);
    };
  }, [phase.phaseId, live, phase.status]);

  useEffect(() => {
    if (tab !== 'prompt') return;
    let cancelled = false;
    setPromptLoading(true);
    setPromptError('');
    void api.runs
      .promptFor(projectId, phase.phaseId)
      .then((text) => {
        if (!cancelled) {
          setPrompt(text);
          setPromptLoading(false);
        }
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setPrompt('');
          setPromptError(e.message);
          setPromptLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tab, phase.phaseId, projectId]);

  const toggle = (id: string): void => {
    setOpenEvents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <>
      <div className="drawer">
        <header className="head">
          {phase.kind === 'agent' && <AgentAvatar name={phase.owner} size={34} />}
          <div className="title">
            <div className="row">
              <h2>{phase.name}</h2>
              <StatusBadge status={phase.status} />
              {phase.attempt > 1 && <span className="badge attempts">attempt {phase.attempt}</span>}
            </div>
            <p className="faint sub mono">
              {phase.kind}
              {phase.owner ? ` · ${phase.owner}` : ''}
              {model ? ` · ${model}` : ''} · {duration(elapsed)}
              {usage.reported ? ` · ${tokens(usage.totalTokens)} tok` : ''}
            </p>
          </div>
        </header>
        {phase.description && <p className="desc faint">{phase.description}</p>}
        {phase.error && <p className="error-banner selectable">{phase.error}</p>}
        <nav className="tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.count ? <span className="count">{t.count}</span> : null}
            </button>
          ))}
        </nav>
        <div className="body scroll">
          {tab === 'timeline' && (
            <>
              {liveTailError && (
                <p className="inline-err" role="alert">
                  Live tail: {liveTailError}
                </p>
              )}
              {liveTail && (
                <pre className="live selectable mono">
                  {liveTail}
                  <span className="caret" />
                </pre>
              )}
              <ol className="events">
                {events.map((event) => (
                  <li key={event.eventId} className={EVENT_CLASS[event.type] ?? ''}>
                    <button className="event" onClick={() => toggle(event.eventId)}>
                      <span className="icon">{EVENT_ICON[event.type] ?? '·'}</span>
                      <span className="ev-name">{event.name}</span>
                      <span className="grow" />
                      {event.endedAt && (
                        <span className="mono faint dur">
                          {duration(
                            new Date(event.endedAt).getTime() - new Date(event.startedAt).getTime(),
                          )}
                        </span>
                      )}
                      <span className="mono faint ts">{clockTime(event.startedAt)}</span>
                    </button>
                    {openEvents.has(event.eventId) && Object.keys(event.payload).length > 0 && (
                      <JsonView value={event.payload} />
                    )}
                  </li>
                ))}
              </ol>
              {!events.length && !liveTail && !liveTailError && (
                <p className="faint pad">Nothing recorded for this phase yet.</p>
              )}
            </>
          )}
          {tab === 'envelope' && (
            <>
              {envelopes.map((envelope) => (
                <div key={envelope.envelopeId} className="block-card">
                  <div className="spread block-head">
                    <span className="mono faint">
                      attempt {envelope.attempt} · {envelope.schemaKind}
                    </span>
                    <StatusBadge
                      status={envelope.valid ? 'success' : 'fail'}
                      label={envelope.valid ? 'parsed' : 'did not parse'}
                    />
                  </div>
                  <JsonView value={envelope.payload} />
                </div>
              ))}
              {!envelopes.length && (
                <p className="faint pad">This phase did not return an envelope.</p>
              )}
            </>
          )}
          {tab === 'gates' && (
            <>
              {gates.map((gate) => (
                <div key={gate.id} className="block-card">
                  <div className="spread block-head">
                    <span className="gate-name mono">{gate.gate}</span>
                    <StatusBadge status={gate.passed ? 'success' : 'fail'} />
                  </div>
                  <ul className="checks">
                    {gate.checks.map((check, i) => (
                      <li key={i} className={check.ok ? '' : 'bad'}>
                        <span className="mark">{check.ok ? '✓' : '✕'}</span>
                        <span className="check-body">
                          <span className="mono item">{check.item}</span>
                          <em className="faint">{check.note}</em>
                        </span>
                      </li>
                    ))}
                  </ul>
                  {!gate.checks.length && (
                    <p className="faint">This gate recorded no individual checks.</p>
                  )}
                </div>
              ))}
              {!gates.length && <p className="faint pad">No gates ran on this phase.</p>}
            </>
          )}
          {tab === 'prompt' && (
            <>
              {promptLoading && <p className="faint pad">Loading prompt…</p>}
              {promptError && (
                <p className="inline-err pad" role="alert">
                  {promptError}
                </p>
              )}
              {!promptLoading && !promptError && prompt ? (
                <pre className="raw selectable">{prompt}</pre>
              ) : null}
              {!promptLoading && !promptError && !prompt && (
                <p className="faint pad">
                  {phase.kind === 'agent'
                    ? 'No prompt was recorded for this phase.'
                    : 'Only agent phases have prompts.'}
                </p>
              )}
            </>
          )}
        </div>
      </div>
      <style>{`
        .drawer { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg-panel); border-left: 1px solid var(--line); }
        .inline-err { margin: 0 var(--s5) var(--s3); padding: var(--s2) var(--s3); border-radius: var(--r-sm); background: var(--red-dim); color: var(--red); font-size: var(--text-xs); line-height: var(--leading); }
        .inline-err.pad { margin-top: var(--s3); }
        .head { display: flex; gap: var(--s3); padding: var(--s4) var(--s5) var(--s2); }
        .title h2 { font-size: var(--text-lg); font-weight: 600; }
        .title .row { display: flex; align-items: center; gap: var(--s2); }
        .sub { font-size: var(--text-xs); margin-top: 2px; }
        .attempts { background: var(--amber-dim); color: var(--amber); padding: 2px 6px; border-radius: var(--r-full); font-size: 10px; }
        .desc { padding: 0 var(--s5) var(--s3); font-size: var(--text-xs); line-height: var(--leading); }
        .error-banner { margin: 0 var(--s5) var(--s3); padding: var(--s3); border-radius: var(--r-sm); background: var(--red-dim); color: var(--red); font-size: var(--text-sm); line-height: var(--leading); white-space: pre-wrap; }
        .tabs { display: flex; gap: var(--s1); padding: 0 var(--s5); border-bottom: 1px solid var(--line-faint); }
        .tab { padding: var(--s2) var(--s3); border: none; border-bottom: 2px solid transparent; background: transparent; color: var(--text-faint); font: inherit; font-size: var(--text-sm); cursor: default; }
        .tab:hover { color: var(--text); }
        .tab.active { color: var(--text); border-bottom-color: var(--cyan); }
        .count { margin-left: var(--s1); font-size: 10px; opacity: 0.6; }
        .body { flex: 1; min-height: 0; padding: var(--s3) var(--s5) var(--s8); overflow-y: auto; }
        .pad { padding: var(--s5) 0; font-size: var(--text-sm); }
        .live { padding: var(--s3); margin-bottom: var(--s3); border-radius: var(--r-sm); background: var(--bg-void); border: 1px solid var(--cyan-dim); font-size: var(--text-xs); line-height: var(--leading); white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow-y: auto; color: var(--text-dim); }
        .caret { display: inline-block; width: 7px; height: 13px; background: var(--cyan); vertical-align: text-bottom; animation: pulse 1s steps(2) infinite; }
        .events { list-style: none; }
        .event { display: flex; align-items: center; gap: var(--s2); width: 100%; padding: var(--s2); border: none; border-radius: var(--r-sm); background: transparent; color: inherit; font: inherit; font-size: var(--text-sm); text-align: left; cursor: default; }
        .event:hover { background: var(--bg-hover); }
        .icon { width: 16px; text-align: center; color: var(--text-faint); flex: none; }
        .warn .icon { color: var(--amber); }
        .bad .icon { color: var(--red); }
        .good .icon { color: var(--green); }
        .ev-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .grow { flex: 1; }
        .dur, .ts { font-size: 10px; flex: none; }
        .block-card { margin-bottom: var(--s4); padding: var(--s3); border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--bg-raised); }
        .block-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--s2); }
        .spread { display: flex; justify-content: space-between; align-items: center; }
        .gate-name { font-size: var(--text-sm); }
        .checks { list-style: none; display: flex; flex-direction: column; gap: var(--s2); }
        .checks li { display: flex; gap: var(--s2); font-size: var(--text-xs); line-height: var(--leading); }
        .checks .mark { color: var(--green); flex: none; }
        .checks li.bad .mark { color: var(--red); }
        .check-body { min-width: 0; }
        .item { display: block; word-break: break-all; }
        .check-body em { font-style: normal; color: var(--text-faint); }
        .raw { padding: var(--s3); border-radius: var(--r-sm); background: var(--bg-void); font-family: var(--font-mono); font-size: var(--text-xs); line-height: var(--leading); white-space: pre-wrap; word-break: break-word; color: var(--text-dim); }
      `}</style>
    </>
  );
}
