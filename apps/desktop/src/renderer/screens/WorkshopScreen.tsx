import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Clock3,
  Pause,
  Play,
  Radio,
  Terminal,
  X,
} from 'lucide-react';
import { useRun } from '../stores/run.js';
import { useWorkshopMotion, useWorkshopPlan } from '../hooks/useWorkshop.js';
import { workshopActivity, workshopFocus, workshopStations } from '../view-models/workshop-view.js';
import { duration } from '../utils/format.js';
import { runDuration } from '../utils/derive.js';
import WorkshopGame from '../components/workshop/WorkshopGame.js';
import WorkshopFeed from '../components/workshop/WorkshopFeed.js';
import type { WorkshopGameState } from '../components/workshop/game/game-types.js';
import styles from './WorkshopScreen.module.css';

export default function WorkshopScreen({
  projectId,
  runId,
  onDetail,
  onInspector,
  onExit,
}: {
  projectId: string;
  runId: string;
  onDetail: () => void;
  onInspector: () => void;
  onExit: () => void;
}): React.JSX.Element {
  const { view, eventsByPhase, envelopesByPhase, refresh } = useRun(projectId, runId);
  const pipeline = useWorkshopPlan(projectId, runId, view.run?.amendments);
  const { paused, toggle } = useWorkshopMotion();
  const [now, setNow] = useState(Date.now());
  const [logOpen, setLogOpen] = useState(false);
  const [camera, setCamera] = useState<{ phaseId?: string; nonce: number }>({ nonce: 0 });
  const logButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const live = view.live && view.run?.status === 'running';
  const focus = useMemo(() => workshopFocus(view.phases), [view.phases]);
  const stations = useMemo(
    () => workshopStations(view.phases, view.events, view.sessions, pipeline),
    [view.phases, view.events, view.sessions, pipeline],
  );
  const model = stations.find((station) => station.phase.phaseId === focus?.phaseId)?.model ?? null;
  const events = focus ? (eventsByPhase.get(focus.phaseId) ?? []) : [];
  const envelope = focus ? envelopesByPhase.get(focus.phaseId)?.at(-1) : undefined;
  const activity = workshopActivity(focus, events, live);
  const latestText = events.findLast(
    (event) =>
      (event.type === 'assistant_text' || event.type === 'thinking') &&
      typeof event.payload.text === 'string',
  );
  const excerpt = typeof latestText?.payload.text === 'string' ? latestText.payload.text : '';
  const completed = view.phases.filter((phase) => phase.status === 'success').length;
  const state: WorkshopGameState = useMemo(
    () => ({
      stations,
      activeId: focus?.phaseId,
      live,
      paused: paused || !!view.error,
      activity,
      revision: view.cursor,
      failed: focus?.status === 'fail',
    }),
    [stations, focus?.phaseId, focus?.status, live, paused, view.error, activity, view.cursor],
  );

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  useEffect(() => {
    if (logOpen) closeButton.current?.focus();
  }, [logOpen]);

  const closeLog = (): void => {
    setLogOpen(false);
    logButton.current?.focus();
  };
  return (
    <div
      className={styles.workshop}
      data-testid="workshop-screen"
      data-phase-id={focus?.phaseId}
      data-motion={state.paused ? 'paused' : 'playing'}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && logOpen) {
          event.stopPropagation();
          closeLog();
        }
      }}
    >
      <WorkshopGame state={state} focusId={camera.phaseId} focusNonce={camera.nonce} />
      <div className={styles.vignette} aria-hidden />
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.emblem}>
            <Terminal size={20} />
          </span>
          <div>
            <strong>
              FOUNDRY<span>AFTER HOURS</span>
            </strong>
            <small>The work goes on. The world comes alive.</small>
          </div>
        </div>
        <nav className={styles.modes} aria-label="Run view">
          <button onClick={onDetail} data-testid="workshop-open-detail">
            Detail
          </button>
          <button onClick={onInspector} data-testid="workshop-open-inspector">
            Inspector
          </button>
          <span aria-current="page">The workshop</span>
        </nav>
        <div className={styles.actions}>
          <button
            onClick={toggle}
            aria-label={paused ? 'Resume motion' : 'Pause motion'}
            aria-pressed={paused}
            title="Pause the world, not your run"
            data-testid="workshop-motion"
          >
            {paused ? <Play size={15} /> : <Pause size={15} />}
          </button>
          <button onClick={onExit} data-testid="workshop-exit">
            <ArrowLeft size={14} /> Exit <kbd>esc</kbd>
          </button>
        </div>
      </header>
      <div className={styles.runCaption}>
        <div className={styles.live} data-live={live && !view.error}>
          <i />
          {live ? 'LIVE RUN' : (view.run?.status.toUpperCase() ?? 'CONNECTING')}
          <span>{view.run?.pipelineName}</span>
        </div>
        <h1>{view.run?.request ?? 'Opening the workshop…'}</h1>
        {!live && view.run?.outcomeDetail && (
          <p data-testid="workshop-outcome">{view.run.outcomeDetail}</p>
        )}
      </div>
      {view.error && (
        <div className={styles.error} role="alert">
          Live updates interrupted: {view.error}
          <button onClick={() => void refresh()}>Retry</button>
        </div>
      )}
      {logOpen && (
        <section className={styles.logPanel} aria-label="Live phase log">
          <div className={styles.logBar}>
            <span>
              <Radio size={12} /> CURRENT PHASE / FULL TRACE
            </span>
            <button ref={closeButton} onClick={closeLog} aria-label="Close live log">
              <X size={15} />
            </button>
          </div>
          <WorkshopFeed
            phase={focus}
            events={events}
            envelope={envelope}
            sessions={view.sessions}
            model={model}
            live={live}
            now={now}
            onInspector={onInspector}
          />
        </section>
      )}
      <footer className={styles.dock}>
        <div className={styles.signal}>
          <div className={styles.signalIcon}>
            <Radio size={18} />
          </div>
          <div className={styles.signalText}>
            <div>
              <strong>{focus?.name ?? 'Preparing the worktree'}</strong>
              <span data-testid="workshop-activity">{activity}</span>
            </div>
            <p title={excerpt}>
              {excerpt ||
                (live
                  ? 'Waiting for the next signal from the crew…'
                  : 'Open the live log to inspect this phase’s recorded work.')}
            </p>
          </div>
          <button
            ref={logButton}
            className={styles.logToggle}
            onClick={() => setLogOpen((open) => !open)}
            aria-expanded={logOpen}
            data-testid="workshop-toggle-log"
          >
            <Terminal size={13} /> Live log <ArrowUpRight size={12} />
          </button>
        </div>
        <div className={styles.pipeline}>
          <span className={styles.count}>
            <strong>{completed}</strong> / {view.phases.length} PASSED
          </span>
          <ol aria-label="Pipeline progress">
            {stations.map(({ phase, color }) => (
              <li key={phase.phaseId}>
                <button
                  onClick={() => setCamera({ phaseId: phase.phaseId, nonce: camera.nonce + 1 })}
                  aria-current={phase.phaseId === focus?.phaseId ? 'step' : undefined}
                  title={`Look at ${phase.name}, ${phase.status}`}
                  style={{ '--station-color': color } as CSSProperties}
                >
                  <span data-status={phase.status}>
                    {phase.status === 'success' ? <Check size={10} /> : phase.seq + 1}
                  </span>
                  {phase.name}
                </button>
              </li>
            ))}
          </ol>
          <span className={styles.elapsed}>
            <Clock3 size={11} />
            {view.run ? duration(runDuration(view.run, now)) : '—'}
          </span>
        </div>
      </footer>
    </div>
  );
}
