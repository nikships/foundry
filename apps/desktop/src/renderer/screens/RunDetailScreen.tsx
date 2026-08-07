import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../stores/app.js';
import { useRun } from '../stores/run.js';
import { clockTime, credits, duration, tokens } from '../format.js';
import { runDuration, usageFor } from '../derive.js';
import Waterfall from '../components/Waterfall.js';
import PhaseDrawer from '../components/PhaseDrawer.js';
import StatusBadge from '../components/StatusBadge.js';
import CostTable from '../components/CostTable.js';
import OutcomeBanner from '../components/OutcomeBanner.js';

export default function RunDetailScreen({
  runId,
  onBack,
  onOpenInspector,
}: {
  runId: string;
  onBack: () => void;
  onOpenInspector: (runId: string) => void;
}): React.JSX.Element {
  const { projectId } = useApp();
  const { view, eventsByPhase, envelopesByPhase, gatesByPhase } = useRun(projectId, runId);
  const [selectedPhaseId, setSelectedPhaseId] = useState('');
  const [showCost, setShowCost] = useState(false);
  const [worktreeBusy, setWorktreeBusy] = useState(false);
  const [worktreeMessage, setWorktreeMessage] = useState('');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = window.setInterval(() => {
      if (view.live) setNow(Date.now());
    }, 250);
    return () => window.clearInterval(id);
  }, [view.live]);

  useEffect(() => {
    if (selectedPhaseId && view.phases.some((p) => p.phaseId === selectedPhaseId)) return;
    const running = view.phases.find((p) => p.status === 'running');
    const failed = [...view.phases].reverse().find((p) => p.status === 'fail');
    setSelectedPhaseId((running ?? failed ?? view.phases[0])?.phaseId ?? '');
  }, [view.phases, selectedPhaseId]);

  const selectedPhase = useMemo(
    () => view.phases.find((p) => p.phaseId === selectedPhaseId) ?? null,
    [view.phases, selectedPhaseId],
  );
  const totalCredits = useMemo(
    () =>
      view.phases.reduce(
        (sum, phase) => sum + usageFor(eventsByPhase.get(phase.phaseId) ?? []).credits,
        0,
      ),
    [view.phases, eventsByPhase],
  );

  const kill = async (): Promise<void> => {
    await api.runs.kill(projectId, runId);
  };

  const withWorktree = async (action: () => Promise<{ detail: string }>): Promise<void> => {
    setWorktreeBusy(true);
    try {
      setWorktreeMessage((await action()).detail);
    } finally {
      setWorktreeBusy(false);
    }
  };
  const mergeWorktree = (): Promise<void> =>
    withWorktree(() => api.runs.mergeWorktree(projectId, runId));
  const discardWorktree = (): Promise<void> =>
    withWorktree(() => api.runs.discardWorktree(projectId, runId));

  return (
    <>
      <div className="screen">
        <header className="head">
          <button className="btn ghost sm back" onClick={onBack}>
            ← Runs
          </button>
          <button className="btn ghost sm" onClick={() => onOpenInspector(runId)}>
            Inspector
          </button>
          <div className="grow" />
          {view.live && (
            <button className="btn danger sm" onClick={() => void kill()}>
              Kill run
            </button>
          )}
          <button className="btn ghost sm" onClick={() => setShowCost(!showCost)}>
            {showCost ? 'Hide cost' : 'Cost'}
          </button>
        </header>
        {view.run && (
          <div className="run-head">
            <div className="row">
              <StatusBadge status={view.run.status} />
              <h1>{view.run.pipelineName}</h1>
              <span className="faint mono when">{clockTime(view.run.startedAt)}</span>
            </div>
            <p className="request selectable">{view.run.request}</p>
            <div className="facts mono faint">
              <span>{duration(runDuration(view.run, now))}</span>
              {view.run.totalTokens ? <span>{tokens(view.run.totalTokens)} tokens</span> : null}
              {totalCredits ? <span>{credits(totalCredits)} credits</span> : null}
              {view.run.branch && (
                <button
                  className="link"
                  onClick={() => void api.runs.openWorktree(projectId, runId)}
                >
                  {view.run.branch}
                </button>
              )}
            </div>
          </div>
        )}
        {view.run && view.run.status !== 'running' && (
          <OutcomeBanner
            run={view.run}
            phases={view.phases}
            worktreeBusy={worktreeBusy}
            worktreeMessage={worktreeMessage}
            onMerge={() => void mergeWorktree()}
            onDiscard={() => void discardWorktree()}
          />
        )}
        {showCost && <CostTable phases={view.phases} eventsByPhase={eventsByPhase} />}
        <div className="split">
          <div className="left scroll">
            {view.run && (
              <Waterfall
                run={view.run}
                phases={view.phases}
                eventsByPhase={eventsByPhase}
                selectedPhaseId={selectedPhaseId}
                now={now}
                onSelect={setSelectedPhaseId}
              />
            )}
          </div>
          <div className="right">
            {selectedPhase && (
              <PhaseDrawer
                key={selectedPhase.phaseId}
                phase={selectedPhase}
                events={eventsByPhase.get(selectedPhase.phaseId) ?? []}
                envelopes={envelopesByPhase.get(selectedPhase.phaseId) ?? []}
                gates={gatesByPhase.get(selectedPhase.phaseId) ?? []}
                live={view.live}
                now={now}
              />
            )}
          </div>
        </div>
      </div>
      <style>{`
        .screen { display: flex; flex-direction: column; height: 100%; min-height: 0; }
        .head { display: flex; align-items: center; gap: var(--s2); padding: calc(var(--titlebar-h) - 8px) var(--s5) 0; }
        .grow { flex: 1; }
        .run-head { padding: var(--s3) var(--s6) var(--s4); border-bottom: 1px solid var(--line-faint); }
        .run-head .row { display: flex; align-items: center; gap: var(--s3); }
        .run-head h1 { font-size: var(--text-xl); font-weight: 600; letter-spacing: -0.01em; }
        .when { font-size: var(--text-xs); }
        .request { margin-top: var(--s2); font-size: var(--text-sm); color: var(--text-dim); line-height: var(--leading); max-width: 90ch; }
        .facts { display: flex; gap: var(--s4); margin-top: var(--s3); font-size: var(--text-xs); }
        .link { border: none; background: transparent; color: var(--cyan); font: inherit; font-size: var(--text-xs); cursor: default; padding: 0; }
        .link:hover { text-decoration: underline; }
        .split { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(380px, 42%); }
        .left { min-width: 0; overflow-y: auto; }
        .right { min-width: 0; min-height: 0; }
      `}</style>
    </>
  );
}
