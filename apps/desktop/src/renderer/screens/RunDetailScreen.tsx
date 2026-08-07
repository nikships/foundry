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
  const [worktreeError, setWorktreeError] = useState(false);
  const [killing, setKilling] = useState(false);
  const [actionError, setActionError] = useState('');
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

  // A different run must not inherit the last one's kill/worktree toast.
  useEffect(() => {
    setWorktreeMessage('');
    setWorktreeError(false);
    setActionError('');
    setKilling(false);
    setWorktreeBusy(false);
  }, [runId]);

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
    if (killing) return;
    if (
      !window.confirm('Kill this run? In-flight agent turns stop; the worktree branch is kept.')
    ) {
      return;
    }
    setKilling(true);
    setActionError('');
    try {
      const ok = await api.runs.kill(projectId, runId);
      if (!ok) setActionError('Could not kill the run. It may have already finished.');
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setKilling(false);
    }
  };

  const withWorktree = async (
    label: string,
    action: () => Promise<{ ok?: boolean; detail: string }>,
  ): Promise<void> => {
    setWorktreeBusy(true);
    setWorktreeError(false);
    setWorktreeMessage('');
    setActionError('');
    try {
      const result = await action();
      setWorktreeMessage(result.detail || label);
      setWorktreeError(result.ok === false);
    } catch (e) {
      setWorktreeMessage((e as Error).message);
      setWorktreeError(true);
    } finally {
      setWorktreeBusy(false);
    }
  };

  const mergeWorktree = async (): Promise<void> => {
    if (worktreeBusy) return;
    if (
      !window.confirm(
        'Merge this run’s branch into the project base ref? Uncommitted work in the worktree is included only if the merge path commits it first.',
      )
    ) {
      return;
    }
    await withWorktree('Merged.', () => api.runs.mergeWorktree(projectId, runId));
  };

  const discardWorktree = async (): Promise<void> => {
    if (worktreeBusy) return;
    if (
      !window.confirm(
        'Discard this run’s worktree and branch? Uncommitted work in it is deleted and cannot be undone.',
      )
    ) {
      return;
    }
    await withWorktree('Discarded.', () => api.runs.discardWorktree(projectId, runId));
  };

  const openWorktree = async (): Promise<void> => {
    setActionError('');
    try {
      await api.runs.openWorktree(projectId, runId);
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

  const bannerError = actionError || view.error;

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
            <button
              className="btn danger sm"
              disabled={killing}
              title="Stop the run without deleting its branch"
              onClick={() => void kill()}
            >
              {killing ? 'Killing…' : 'Kill run'}
            </button>
          )}
          <button className="btn ghost sm" onClick={() => setShowCost(!showCost)}>
            {showCost ? 'Hide cost' : 'Cost'}
          </button>
        </header>
        {bannerError && (
          <p className="action-err" role="alert">
            {bannerError}
          </p>
        )}
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
                <button className="link" onClick={() => void openWorktree()}>
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
            worktreeError={worktreeError}
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
        .action-err { margin: var(--s3) var(--s6) 0; padding: var(--s3); border-radius: var(--r-sm); background: var(--red-dim); color: var(--red); font-size: var(--text-sm); line-height: var(--leading); }
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
