import { useEffect, useMemo, useState } from 'react';
import type { GhStatus } from '@shared/types.js';
import { api } from '../api.js';
import { useConfirmAction } from '../hooks/useConfirmAction.js';
import { useApp } from '../stores/app.js';
import { useRun } from '../stores/run.js';
import { clockTime, credits, duration, tokens } from '../format.js';
import { runDuration, usageFor } from '../derive.js';
import Waterfall from '../components/Waterfall.js';
import PhaseDrawer from '../components/PhaseDrawer.js';
import StatusBadge from '../components/StatusBadge.js';
import CostTable from '../components/CostTable.js';
import OutcomeBanner from '../components/OutcomeBanner.js';
import { Button } from '../components/ui/Button.js';
import styles from './RunDetailScreen.module.css';

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
  const [gh, setGh] = useState<GhStatus | null>(null);
  /** A refused local merge is what the agent repair path exists for. */
  const [mergeRefused, setMergeRefused] = useState(false);

  // Probe gh only once a finished run could actually use it: the check shells
  // out and may touch the network, so it never runs for live runs.
  const wantsGh =
    !!view.run && view.run.status !== 'running' && !!view.run.worktreePath && !view.run.merged;
  useEffect(() => {
    if (!wantsGh || gh) return;
    let cancelled = false;
    void api.prs.status(projectId).then((status) => {
      if (!cancelled) setGh(status);
    });
    return () => {
      cancelled = true;
    };
  }, [wantsGh, gh, projectId]);

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
    setGh(null);
    setMergeRefused(false);
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

  const kill = useConfirmAction(
    'Kill this run? In-flight agent turns stop; the worktree branch is kept.',
    async (): Promise<void> => {
      if (killing) return;
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
    },
  );

  const withWorktree = async (
    label: string,
    action: () => Promise<{ ok?: boolean; detail: string }>,
    busyNote = '',
  ): Promise<{ ok?: boolean; detail: string } | undefined> => {
    setWorktreeBusy(true);
    setWorktreeError(false);
    setWorktreeMessage(busyNote);
    setActionError('');
    try {
      const result = await action();
      setWorktreeMessage(result.detail || label);
      setWorktreeError(result.ok === false);
      return result;
    } catch (e) {
      setWorktreeMessage((e as Error).message);
      setWorktreeError(true);
      return undefined;
    } finally {
      setWorktreeBusy(false);
    }
  };

  const mergeWorktree = useConfirmAction(
    'Merge this run’s branch into the project base ref? Uncommitted work in the worktree is included only if the merge path commits it first.',
    async (): Promise<void> => {
      if (worktreeBusy) return;
      const result = await withWorktree('Merged.', () => api.runs.mergeWorktree(projectId, runId));
      setMergeRefused(result?.ok === false);
    },
  );

  const fixMerge = useConfirmAction(
    'Have an agent rebase this run’s branch onto the base and merge it? The agent works only inside the run’s worktree, and a repair that doesn’t verify is rolled back.',
    async (): Promise<void> => {
      if (worktreeBusy) return;
      const result = await withWorktree(
        'Fixed and merged.',
        () => api.runs.fixMerge(projectId, runId),
        'The agent is rebasing the run branch onto the base…',
      );
      if (result?.ok) setMergeRefused(false);
    },
  );

  const discardWorktree = useConfirmAction(
    'Discard this run’s worktree and branch? Uncommitted work in it is deleted and cannot be undone.',
    async (): Promise<void> => {
      if (worktreeBusy) return;
      await withWorktree('Discarded.', () => api.runs.discardWorktree(projectId, runId));
    },
  );

  const createPr = async (title: string, body: string): Promise<void> => {
    if (worktreeBusy) return;
    await withWorktree('Pull request opened.', () => api.prs.create(projectId, runId, title, body));
  };

  const openUrl = (url: string): void => {
    void api.app.openExternal(url);
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

  const pipelineLabel = view.run?.pipelineName?.trim() || '';
  const shortId = runId.slice(0, 7);

  return (
    <div className={styles.screen}>
      <header className={styles.head}>
        <Button variant="ghost" size="sm" className="back" onClick={onBack} data-testid="run-back">
          ← Runs
        </Button>
        <span className={styles.headSep} aria-hidden />
        <span className={styles.headTitle} title={pipelineLabel || shortId}>
          <span className={styles.headIndex}>Run</span>
          {pipelineLabel ? (
            <>
              <span className={styles.headName}>{pipelineLabel}</span>
              <span className={styles.headDot}>·</span>
              <span className={styles.headId}>{shortId}</span>
            </>
          ) : (
            <span className={styles.headId}>{shortId}</span>
          )}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className={styles.inspectorBtn}
          onClick={() => onOpenInspector(runId)}
          title="Open live transcript in Inspector"
          data-testid="run-open-inspector"
        >
          Inspector{' '}
          <span className={styles.inspectorExt} aria-hidden>
            ↗
          </span>
        </Button>
        <div className={styles.grow} />
        {(view.live || showCost) && <span className={styles.actionSep} aria-hidden />}
        {view.live && (
          <Button
            variant="danger"
            size="sm"
            disabled={killing}
            title={killing ? 'Killing…' : 'Stop the run without deleting its branch'}
            onClick={() => void kill()}
          >
            {killing ? 'Killing…' : 'Kill run'}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => setShowCost(!showCost)}>
          {showCost ? 'Hide cost' : 'Cost'}
        </Button>
      </header>
      {bannerError && (
        <p className={styles.actionErr} role="alert">
          {bannerError}
        </p>
      )}
      {view.run && (
        <div className={styles.runHead}>
          <div className="row">
            <StatusBadge status={view.run.status} />
            <h1>{view.run.pipelineName}</h1>
            <span className={`faint mono ${styles.when}`}>{clockTime(view.run.startedAt)}</span>
          </div>
          <p className={`${styles.request} selectable`}>{view.run.request}</p>
          <div className={`${styles.facts} mono faint`}>
            <span>{duration(runDuration(view.run, now))}</span>
            {view.run.totalTokens ? <span>{tokens(view.run.totalTokens)} tokens</span> : null}
            {totalCredits ? <span>{credits(totalCredits)} credits</span> : null}
            {view.run.branch && (
              <button className={styles.link} onClick={() => void openWorktree()}>
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
          envelopes={view.envelopes}
          worktreeBusy={worktreeBusy}
          worktreeMessage={worktreeMessage}
          worktreeError={worktreeError}
          gh={gh}
          canFix={mergeRefused}
          onMerge={() => void mergeWorktree()}
          onFixMerge={() => void fixMerge()}
          onDiscard={() => void discardWorktree()}
          onCreatePr={(title, body) => void createPr(title, body)}
          onOpenUrl={openUrl}
        />
      )}
      {showCost && <CostTable phases={view.phases} eventsByPhase={eventsByPhase} />}
      <div className={styles.split}>
        <div className={`${styles.left} scroll`}>
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
        <div className={styles.right}>
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
  );
}
