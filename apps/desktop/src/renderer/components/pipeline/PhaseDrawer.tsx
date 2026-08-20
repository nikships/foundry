import { useEffect, useMemo, useState } from 'react';
import type { EnvelopeRow, EventRow, GateResultRow, PhaseRow } from '@shared/types.js';
import { api } from '../../api.js';
import { useApp } from '../../stores/app.js';
import { clockTime, duration, tokens } from '../../utils/format.js';
import { isAutoAllowPolicy, modelFor, phaseDuration, usageFor } from '../../utils/derive.js';
import StatusBadge from '../common/StatusBadge.js';
import AgentAvatar from '../media/AgentAvatar.js';
import { CodeBlock } from '../ui/CodeBlock.js';
import JsonView from '../common/JsonView.js';
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
  compaction: '⇲',
  log: '·',
  error: '✕',
};

const EVENT_CLASS: Partial<Record<EventRow['type'], string>> = {
  gate_fail: styles.failed,
  error: styles.failed,
  correction: styles.warn,
  gate_pass: styles.passed,
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
  const timelineEvents = useMemo(
    () => events.filter((event) => !isAutoAllowPolicy(event)),
    [events],
  );
  const tabs = useMemo(
    () => [
      { id: 'timeline' as Tab, label: 'Timeline', count: timelineEvents.length },
      { id: 'envelope' as Tab, label: 'Envelope', count: envelopes.length },
      { id: 'gates' as Tab, label: 'Gates', count: gates.length },
      { id: 'prompt' as Tab, label: 'Prompt' },
    ],
    [timelineEvents.length, envelopes.length, gates.length],
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
    timer = window.setInterval(() => void poll(), 150);
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
        <p className={`eyebrow ${styles.eyebrow}`}>
          <span className="index">01</span>Phase detail
        </p>
        <nav className={styles.tabs} data-testid="phase-tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`${styles.tab} ${tab === t.id ? styles.active : ''}`}
              onClick={() => setTab(t.id)}
              data-testid={`phase-tab-${t.id}`}
              aria-pressed={tab === t.id}
            >
              {t.label}
              {t.count ? <span className={styles.count}>{t.count}</span> : null}
            </button>
          ))}
        </nav>
        <div className={`${styles.body} scroll`}>
          {tab === 'timeline' && (
            <>
              <p className={`eyebrow ${styles.sectionLabel}`}>
                <span className="index">02</span>Timeline
              </p>
              {liveTailError && (
                <p className={styles.inlineError} role="alert">
                  Live tail: {liveTailError}
                </p>
              )}
              {liveTail && (
                <CodeBlock maxHeight={240} className={styles.live}>
                  {liveTail}
                  <span className={styles.liveCursor} />
                </CodeBlock>
              )}
              <ol className={styles.events}>
                {timelineEvents.map((event) => (
                  <li key={event.eventId} className={EVENT_CLASS[event.type] ?? ''}>
                    <button className={styles.event} onClick={() => toggle(event.eventId)}>
                      <span className={styles.icon}>{EVENT_ICON[event.type] ?? '·'}</span>
                      <span className={styles.eventName}>{event.name}</span>
                      <span className={styles.spacer} />
                      {event.endedAt && (
                        <span className={`mono faint ${styles.duration}`}>
                          {duration(
                            new Date(event.endedAt).getTime() - new Date(event.startedAt).getTime(),
                          )}
                        </span>
                      )}
                      <span className={`mono faint ${styles.timestamp}`}>
                        {clockTime(event.startedAt)}
                      </span>
                    </button>
                    {openEvents.has(event.eventId) && Object.keys(event.payload).length > 0 && (
                      <JsonView value={event.payload} />
                    )}
                  </li>
                ))}
              </ol>
              {!timelineEvents.length && !liveTail && !liveTailError && (
                <p className={`faint ${styles.padded}`}>Nothing recorded for this phase yet.</p>
              )}
            </>
          )}
          {tab === 'envelope' && (
            <>
              <p className={`eyebrow ${styles.sectionLabel}`}>
                <span className="index">02</span>Envelope
              </p>
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
                <p className={`faint ${styles.padded}`}>This phase did not return an envelope.</p>
              )}
            </>
          )}
          {tab === 'gates' && (
            <>
              <p className={`eyebrow ${styles.sectionLabel}`}>
                <span className="index">02</span>Gates
              </p>
              {gates.map((gate) => (
                <div key={gate.id} className={styles.blockCard}>
                  <div className={`spread ${styles.blockHead}`}>
                    <span className={`${styles.gateName} mono`}>{gate.gate}</span>
                    <StatusBadge status={gate.passed ? 'success' : 'fail'} />
                  </div>
                  <ul className={styles.checks}>
                    {gate.checks.map((check, i) => (
                      <li key={i} className={check.ok ? '' : styles.failed}>
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
                <p className={`faint ${styles.padded}`}>No gates ran on this phase.</p>
              )}
            </>
          )}
          {tab === 'prompt' && (
            <>
              <p className={`eyebrow ${styles.sectionLabel}`}>
                <span className="index">02</span>Prompt
              </p>
              {promptLoading && <p className={`faint ${styles.padded}`}>Loading prompt…</p>}
              {promptError && (
                <p className={`${styles.inlineError} ${styles.padded}`} role="alert">
                  {promptError}
                </p>
              )}
              {!promptLoading && !promptError && prompt ? <CodeBlock>{prompt}</CodeBlock> : null}
              {!promptLoading && !promptError && !prompt && (
                <p className={`faint ${styles.padded}`}>
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
