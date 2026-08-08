import { useEffect, useMemo, useState } from 'react';
import type { EnvelopeRow, EventRow, GateResultRow, PhaseRow } from '@shared/types.js';
import { api } from '../api.js';
import { useApp } from '../stores/app.js';
import { clockTime, duration, tokens } from '../format.js';
import { modelFor, phaseDuration, usageFor } from '../derive.js';
import StatusBadge from './StatusBadge.js';
import AgentAvatar from './AgentAvatar.js';
import JsonView from './JsonView.js';
import styles from './PhaseDrawer.module.css';

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
  gate_fail: styles.bad,
  error: styles.bad,
  correction: styles.warn,
  gate_pass: styles.good,
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
      <div className={styles.drawer}>
        <header className={styles.head}>
          {phase.kind === 'agent' && <AgentAvatar name={phase.owner} size={34} />}
          <div className={styles.title}>
            <div className="row">
              <h2>{phase.name}</h2>
              <StatusBadge status={phase.status} />
              {phase.attempt > 1 && (
                <span className={`badge ${styles.attempts}`}>attempt {phase.attempt}</span>
              )}
            </div>
            <p className={`faint ${styles.sub} mono`}>
              {phase.kind}
              {phase.owner ? ` · ${phase.owner}` : ''}
              {model ? ` · ${model}` : ''} · {duration(elapsed)}
              {usage.reported ? ` · ${tokens(usage.totalTokens)} tok` : ''}
            </p>
          </div>
        </header>
        {phase.description && <p className={`${styles.desc} faint`}>{phase.description}</p>}
        {phase.error && <p className={`${styles.errorBanner} selectable`}>{phase.error}</p>}
        <nav className={styles.tabs}>
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`${styles.tab} ${tab === t.id ? styles.active : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.count ? <span className={styles.count}>{t.count}</span> : null}
            </button>
          ))}
        </nav>
        <div className={`${styles.body} scroll`}>
          {tab === 'timeline' && (
            <>
              {liveTailError && (
                <p className={styles.inlineErr} role="alert">
                  Live tail: {liveTailError}
                </p>
              )}
              {liveTail && (
                <pre className={`${styles.live} selectable mono`}>
                  {liveTail}
                  <span className={styles.caret} />
                </pre>
              )}
              <ol className={styles.events}>
                {events.map((event) => (
                  <li key={event.eventId} className={EVENT_CLASS[event.type] ?? ''}>
                    <button className={styles.event} onClick={() => toggle(event.eventId)}>
                      <span className={styles.icon}>{EVENT_ICON[event.type] ?? '·'}</span>
                      <span className={styles.evName}>{event.name}</span>
                      <span className={styles.grow} />
                      {event.endedAt && (
                        <span className={`mono faint ${styles.dur}`}>
                          {duration(
                            new Date(event.endedAt).getTime() - new Date(event.startedAt).getTime(),
                          )}
                        </span>
                      )}
                      <span className={`mono faint ${styles.ts}`}>
                        {clockTime(event.startedAt)}
                      </span>
                    </button>
                    {openEvents.has(event.eventId) && Object.keys(event.payload).length > 0 && (
                      <JsonView value={event.payload} />
                    )}
                  </li>
                ))}
              </ol>
              {!events.length && !liveTail && !liveTailError && (
                <p className={`faint ${styles.pad}`}>Nothing recorded for this phase yet.</p>
              )}
            </>
          )}
          {tab === 'envelope' && (
            <>
              {envelopes.map((envelope) => (
                <div key={envelope.envelopeId} className={styles.blockCard}>
                  <div className={`spread ${styles.blockHead}`}>
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
                <p className={`faint ${styles.pad}`}>This phase did not return an envelope.</p>
              )}
            </>
          )}
          {tab === 'gates' && (
            <>
              {gates.map((gate) => (
                <div key={gate.id} className={styles.blockCard}>
                  <div className={`spread ${styles.blockHead}`}>
                    <span className={`${styles.gateName} mono`}>{gate.gate}</span>
                    <StatusBadge status={gate.passed ? 'success' : 'fail'} />
                  </div>
                  <ul className={styles.checks}>
                    {gate.checks.map((check, i) => (
                      <li key={i} className={check.ok ? '' : styles.bad}>
                        <span className={styles.mark}>{check.ok ? '✓' : '✕'}</span>
                        <span className={styles.checkBody}>
                          <span className={`mono ${styles.item}`}>{check.item}</span>
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
              {!gates.length && (
                <p className={`faint ${styles.pad}`}>No gates ran on this phase.</p>
              )}
            </>
          )}
          {tab === 'prompt' && (
            <>
              {promptLoading && <p className={`faint ${styles.pad}`}>Loading prompt…</p>}
              {promptError && (
                <p className={`${styles.inlineErr} ${styles.pad}`} role="alert">
                  {promptError}
                </p>
              )}
              {!promptLoading && !promptError && prompt ? (
                <pre className={`${styles.raw} selectable`}>{prompt}</pre>
              ) : null}
              {!promptLoading && !promptError && !prompt && (
                <p className={`faint ${styles.pad}`}>
                  {phase.kind === 'agent'
                    ? 'No prompt was recorded for this phase.'
                    : 'Only agent phases have prompts.'}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
