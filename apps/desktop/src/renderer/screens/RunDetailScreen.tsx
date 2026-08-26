import { useEffect, useMemo, useState } from 'react';
import type { EventRow, GeneratedRunPlan, GhStatus } from '@shared/types.js';
import { api } from '../api.js';
import { useConfirmAction } from '../hooks/useConfirmAction.js';
import { useApp } from '../stores/app.js';
import { useRun } from '../stores/run.js';
import { clockTime, duration, tokens } from '../utils/format.js';
import { runDuration } from '../utils/derive.js';
import Waterfall from '../components/run/Waterfall.js';
import PhaseDrawer from '../components/pipeline/PhaseDrawer.js';
import StatusBadge from '../components/common/StatusBadge.js';
import OutcomeBanner from '../components/run/OutcomeBanner.js';
import ExportPlanSheet from '../components/run/ExportPlanSheet.js';
import { Button } from '../components/ui/Button.js';
import { planHasActiveFailure } from '../view-models/plan-view.js';
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
  const [worktreeBusy, setWorktreeBusy] = useState(false);
  const [worktreeMessage, setWorktreeMessage] = useState('');
  const [worktreeError, setWorktreeError] = useState(false);
  const [killing, setKilling] = useState(false);
  const [actionError, setActionError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [gh, setGh] = useState<GhStatus | null>(null);
  const [plan, setPlan] = useState<GeneratedRunPlan | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
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
    setPlan(null);
    setExportOpen(false);
    if (!view.run?.orchestrated || view.run.status === 'running') return;
    let cancelled = false;
    void api.runs
      .plan(projectId, runId)
      .then((loaded) => {
        if (!cancelled) setPlan(loaded);
      })
      .catch(() => {
        if (!cancelled) setPlan(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, runId, view.run?.orchestrated, view.run?.status]);

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

  const withDriftNote = (base: string): string => {
    const extra = commandDriftConfirm(view.events);
    return extra ? `${base}\n\n${extra}` : base;
  };

  const mergeWorktree = useConfirmAction(
    () =>
      withDriftNote(
        'Merge this run’s branch into the project base ref? Uncommitted work in the worktree is included only if the merge path commits it first.',
      ),
    async (): Promise<void> => {
      if (worktreeBusy) return;
      const result = await withWorktree('Merged.', () => api.runs.mergeWorktree(projectId, runId));
      setMergeRefused(result?.ok === false);
    },
  );

  const fixMerge = useConfirmAction(
    () =>
      withDriftNote(
        'Have an agent rebase this run’s branch onto the base and merge it? The agent works only inside the run’s worktree, and a repair that doesn’t verify is rolled back.',
      ),
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

  const resumeRun = async (): Promise<void> => {
    if (worktreeBusy) return;
    await withWorktree(
      'Continuing run.',
      () => api.runs.resume(projectId, runId),
      'Reopening the failed phase…',
    );
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

  const bannerError = actionError || view.run?.sourceSyncError || view.error;

  const pipelineLabel = view.run?.pipelineName?.trim() || '';
  const linearSource = view.run?.source?.kind === 'linear' ? view.run.source : null;
  const shortId = runId.slice(0, 7);
  const hasActiveFailure = view.run?.orchestrated
    ? Boolean(plan && planHasActiveFailure(plan, view.phases))
    : view.phases.some((phase) => phase.status === 'fail');

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
        {plan && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExportOpen(true)}
            data-testid="run-export-plan"
          >
            Export…
          </Button>
        )}
        <div className={styles.grow} />
        {view.live && <span className={styles.actionSep} aria-hidden />}
        {view.live && (
          <Button
            variant="danger"
            size="sm"
            disabled={killing}
            title={killing ? 'Killing…' : 'Stop the run without deleting its branch'}
            onClick={() => void kill()}
            data-testid="run-kill"
          >
            {killing ? 'Killing…' : 'Kill run'}
          </Button>
        )}
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
            {view.run.amendments > 0 && (
              <span className={styles.amendmentBadge}>amended ×{view.run.amendments}</span>
            )}
            <span className={`faint mono ${styles.when}`}>{clockTime(view.run.startedAt)}</span>
          </div>
          <p className={`${styles.request} selectable`}>{view.run.request}</p>
          <div className={`${styles.facts} mono faint`}>
            <span>{duration(runDuration(view.run, now))}</span>
            {view.run.totalTokens ? <span>{tokens(view.run.totalTokens)} tokens</span> : null}
            {linearSource && (
              <button className={styles.link} onClick={() => openUrl(linearSource.url)}>
                Linear · {linearSource.snapshot.identifier}
              </button>
            )}
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
          canResume={
            (view.run.status === 'rejected' || view.run.status === 'failed') &&
            !!view.run.worktreePath &&
            hasActiveFailure
          }
          canFix={mergeRefused}
          onResume={() => void resumeRun()}
          onMerge={() => void mergeWorktree()}
          onFixMerge={() => void fixMerge()}
          onDiscard={() => void discardWorktree()}
          onCreatePr={(title, body) => void createPr(title, body)}
          onOpenUrl={openUrl}
          onExport={plan ? () => setExportOpen(true) : undefined}
        />
      )}
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
      {plan && (
        <ExportPlanSheet
          open={exportOpen}
          projectId={projectId}
          runId={runId}
          plan={plan}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
  );
}

function commandDriftConfirm(events: EventRow[]): string {
  const argv = (value: unknown): string =>
    Array.isArray(value) ? value.filter((a): a is string => typeof a === 'string').join(' ') : '?';
  const drifts = events.filter((event) => event.name === 'command_drift');
  if (!drifts.length) return '';
  const lines = drifts.map((event) => {
    const name = typeof event.payload.name === 'string' ? event.payload.name : 'command';
    return `${name}: ${argv(event.payload.from)} → ${argv(event.payload.to)}`;
  });
  return `This will also update project commands to match the worktree:\n${lines.join('\n')}`;
}
