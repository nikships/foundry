import { useState } from 'react';
import type { AgentSessionRow, EnvelopeRow, EventRow, PhaseRow } from '@shared/types.js';
import { modelLabel } from '@shared/model-label.js';
import { ArrowRight, Radio, Terminal } from 'lucide-react';
import { CollapseContext } from '../inspector/collapse.js';
import TranscriptLane from '../inspector/TranscriptLane.js';
import { usageFor } from '../../utils/derive.js';
import { tokens } from '../../utils/format.js';
import { workshopActivity } from '../../view-models/workshop-view.js';
import styles from './WorkshopFeed.module.css';

export default function WorkshopFeed({
  phase,
  events,
  envelope,
  sessions,
  model,
  live,
  now,
  onInspector,
}: {
  phase: PhaseRow | null;
  events: EventRow[];
  envelope?: EnvelopeRow;
  sessions: AgentSessionRow[];
  model: string | null;
  live: boolean;
  now: number;
  onInspector: () => void;
}): React.JSX.Element {
  const [collapse, setCollapse] = useState(0);
  const usage = usageFor(events);
  const tools = events.filter((event) => event.type === 'tool_call').length;
  const activity = workshopActivity(phase, events, live);
  return (
    <aside
      className={styles.feed}
      aria-label="Current phase live transcript"
      data-testid="workshop-feed"
    >
      <header className={styles.head}>
        <div className={styles.eyebrow}>
          <Radio size={13} /> {live ? 'Live from the floor' : 'Last on the floor'}
        </div>
        <h2>{phase?.name ?? 'Setting the stage'}</h2>
        <p className={styles.identity}>
          {phase?.kind === 'code' ? (
            <>
              <Terminal size={13} /> Command station
            </>
          ) : (
            <>
              {phase?.owner ?? 'The crew'} <span>·</span>{' '}
              {model ? modelLabel(model) : 'Model not recorded yet'}
            </>
          )}
        </p>
        <div className={styles.activity} title={activity}>
          <span data-live={live && phase?.status === 'running'} />
          <span data-testid="workshop-activity">{activity}</span>
        </div>
      </header>
      <div className={styles.metrics}>
        <div>
          <strong>{tools}</strong>
          <span>tool calls</span>
        </div>
        <div>
          <strong>{usage.turns}</strong>
          <span>turns</span>
        </div>
        <div>
          <strong>{usage.reported ? tokens(usage.totalTokens) : '—'}</strong>
          <span>tokens used</span>
        </div>
      </div>
      {phase?.error && (
        <p className={styles.error} role="alert">
          {phase.error}
        </p>
      )}
      <div className={styles.transcript}>
        {phase ? (
          <CollapseContext.Provider value={collapse}>
            <TranscriptLane
              key={phase.phaseId}
              phase={phase}
              events={events}
              envelope={envelope}
              sessions={sessions}
              now={now}
              focused={false}
            />
          </CollapseContext.Provider>
        ) : (
          <div className={styles.empty}>
            {live
              ? 'The run is preparing its worktree. The first coworker will be here shortly.'
              : 'This run has no recorded phase work.'}
          </div>
        )}
      </div>
      <footer className={styles.footer}>
        <button onClick={() => setCollapse((value) => value + 1)} disabled={!tools}>
          Collapse tools
        </button>
        <button onClick={onInspector}>
          All phases in Inspector <ArrowRight size={12} />
        </button>
      </footer>
    </aside>
  );
}
