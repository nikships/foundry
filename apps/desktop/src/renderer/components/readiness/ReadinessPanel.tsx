import type {
  ReadinessCriterion,
  ReadinessInspectResult,
  ReadinessPhase,
  ReadinessState,
} from '@shared/types.js';
import {
  READINESS_CRITERION_LABELS,
  isReadinessLive,
  readinessScore,
} from '../../view-models/readiness-view.js';
import { Button } from '../ui/Button.js';
import PanelTranscript from '../readiness/PanelTranscript.js';
import styles from './ReadinessPanel.module.css';

function statusMark(status: ReadinessCriterion['status']): string {
  if (status === 'pass') return '✓';
  if (status === 'fail') return '✕';
  return '–';
}

function statusClass(status: ReadinessCriterion['status']): string {
  if (status === 'pass') return styles.pass;
  if (status === 'fail') return styles.fail;
  return styles.na;
}

function stepOf(phase: ReadinessPhase): string {
  switch (phase) {
    case 'remediating':
      return 'Fix';
    case 'verifying':
    case 'needs_continue':
      return 'Verify';
    case 'pr_ready':
      return 'PR';
    case 'awaiting_merge':
    case 'confirming_merge':
    case 'finalizing':
    case 'complete':
      return 'Merge';
    default:
      return 'Check';
  }
}

function headlineFor(session: ReadinessState | null, ready: boolean): string {
  const phase = session?.phase;
  switch (phase) {
    case 'complete':
      return 'This repository is agent-ready';
    case 'skipped':
      return 'Readiness skipped';
    case 'failed':
      return 'Readiness check failed';
    case 'needs_continue':
      return 'The agent still has work to do';
    case 'awaiting_merge':
    case 'confirming_merge':
      return 'The PR is ready — merge it, then confirm';
    case 'pr_ready':
      return 'Opening the pull request';
    case 'finalizing':
      return 'Finishing up';
    case 'remediating':
      return 'Making it ready';
    case 'verifying':
      return 'Verifying the fix';
    case 'evaluating':
    case 'inspecting':
      return 'Checking readiness';
    case 'not_ready':
      return ready ? 'Ready to write the marker' : 'This repository is not ready yet';
    default:
      return ready ? 'This repository is agent-ready' : 'Agent readiness';
  }
}

function resumeLabel(failedPhase?: ReadinessPhase): string {
  if (failedPhase === 'pr_ready') return 'Open PR again';
  if (failedPhase === 'finalizing') return 'Check merge again';
  if (failedPhase === 'remediating') return 'Try the agent again';
  return 'Continue';
}

function ScoreBar({ percent }: { percent: number | null }): React.JSX.Element {
  if (percent == null) {
    return <p className={styles.noScore}>Run a check to score this repository.</p>;
  }
  return (
    <div className={styles.scoreRow}>
      <div
        className={styles.scoreTrack}
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Agent readiness score"
        data-testid="readiness-score-bar"
      >
        <div className={styles.scoreFill} style={{ width: `${percent}%` }} />
      </div>
      <span className={styles.scoreValue} data-testid="readiness-score-value">
        {percent}%
      </span>
    </div>
  );
}

interface PanelActions {
  onCheck: () => void;
  onFix: () => void;
  onRetry: () => void;
  onContinue: () => void;
  onConfirmMerge: () => void;
  onCancel: () => void;
  onSkip: () => void;
  onOpenPr: (url: string) => void;
}

function actionVisibility(
  phase: ReadinessPhase,
  opts: { ready: boolean; live: boolean; hasSession: boolean; hasInspect: boolean },
): {
  check: boolean;
  fix: boolean;
  cont: boolean;
  retry: boolean;
  confirmMerge: boolean;
  cancel: boolean;
  skip: boolean;
} {
  const { ready, live, hasSession, hasInspect } = opts;
  return {
    check: !ready && !live && (phase === 'idle' || phase === 'confirming'),
    fix: !live && (phase === 'not_ready' || (!hasSession && !ready && hasInspect)),
    cont: !live && phase === 'needs_continue',
    retry: !live && (phase === 'failed' || phase === 'skipped'),
    confirmMerge: !live && (phase === 'awaiting_merge' || phase === 'confirming_merge'),
    cancel: live,
    skip: !live && phase !== 'complete' && phase !== 'skipped' && phase !== 'awaiting_merge',
  };
}

function PanelActionRow({
  visible,
  busy,
  skipped,
  failedPhase,
  actions,
}: {
  visible: ReturnType<typeof actionVisibility>;
  busy: boolean;
  skipped: boolean;
  failedPhase?: ReadinessPhase;
  actions: PanelActions;
}): React.JSX.Element {
  return (
    <div className={styles.actions}>
      {visible.cancel && (
        <Button variant="ghost" disabled={busy} onClick={actions.onCancel}>
          Cancel
        </Button>
      )}
      {visible.skip && (
        <Button
          variant="ghost"
          disabled={busy}
          onClick={actions.onSkip}
          title="Skipping means the first pipeline run may fail mid-flight."
        >
          Skip for now
        </Button>
      )}
      {visible.check && (
        <Button
          variant="primary"
          disabled={busy}
          onClick={actions.onCheck}
          data-testid="readiness-check"
        >
          {busy ? 'Checking…' : skipped ? 'Re-run readiness' : 'Check readiness'}
        </Button>
      )}
      {visible.fix && (
        <Button
          variant="primary"
          disabled={busy}
          onClick={actions.onFix}
          data-testid="readiness-fix"
        >
          {busy ? 'Working…' : 'Make agent-ready'}
        </Button>
      )}
      {visible.cont && (
        <Button
          variant="primary"
          disabled={busy}
          onClick={actions.onContinue}
          data-testid="readiness-continue"
        >
          {busy ? 'Working…' : resumeLabel(failedPhase)}
        </Button>
      )}
      {visible.confirmMerge && (
        <Button
          variant="primary"
          disabled={busy}
          onClick={actions.onConfirmMerge}
          data-testid="readiness-confirm-merge"
        >
          {busy ? 'Checking…' : 'I have merged the PR'}
        </Button>
      )}
      {visible.retry && (
        <Button disabled={busy} onClick={actions.onRetry} data-testid="readiness-retry">
          Start over
        </Button>
      )}
    </div>
  );
}

/**
 * The Agent Readiness tab body: the score breakdown plus the one button that
 * moves the flow forward. One click starts the check and the fix; the session
 * polls itself and every action re-inspects the marker so the tab glow and
 * this panel can never disagree.
 */
export default function ReadinessPanel({
  header,
  projectId,
  inspect,
  session,
  busy,
  error,
  onCheck,
  onFix,
  onRetry,
  onContinue,
  onConfirmMerge,
  onCancel,
  onSkip,
  onOpenPr,
}: {
  header: React.ReactNode;
  projectId: string;
  inspect: ReadinessInspectResult | null;
  session: ReadinessState | null;
  busy: boolean;
  error: string;
} & PanelActions): React.JSX.Element {
  const criteria = session?.evaluation?.criteria ?? inspect?.marker?.criteria ?? [];
  const score = readinessScore(criteria);
  const phase = session?.phase ?? (inspect?.ready ? 'complete' : 'idle');
  const live = session != null && isReadinessLive(session.phase);
  const ready = Boolean(inspect?.ready);
  const headline = headlineFor(session, ready);
  const detail = session?.detail || inspect?.markerDetail || '';
  const visible = actionVisibility(phase, {
    ready,
    live,
    hasSession: session != null,
    hasInspect: inspect != null,
  });

  return (
    <div className={styles.column}>
      <section className={`${styles.card} card`} data-testid="readiness-panel">
        {header}
        <p className={styles.eyebrow}>
          <span className={styles.index}>●</span>Agent readiness
        </p>
        <h1 className={styles.title}>{headline}</h1>
        {detail && <p className={styles.lead}>{detail}</p>}

        <ScoreBar percent={score.percent} />
        <p className={styles.counts} data-testid="readiness-counts">
          {score.total === 0
            ? 'No checklist yet.'
            : score.fail > 0
              ? `${score.fail} of ${score.total} still need work`
              : `${score.pass} of ${score.total} pass or N/A`}
        </p>

        {criteria.length > 0 && (
          <ul className={styles.criteria} data-testid="readiness-criteria">
            {criteria.map((c) => (
              <li
                key={c.id}
                className={`${styles.criterion} ${statusClass(c.status)}`}
                title={c.notes}
                data-status={c.status}
              >
                <span className={styles.mark} aria-hidden>
                  {statusMark(c.status)}
                </span>
                <div className={styles.criterionBody}>
                  <strong>{READINESS_CRITERION_LABELS[c.id] ?? c.id}</strong>
                  <p className={styles.notes}>{c.notes}</p>
                </div>
              </li>
            ))}
          </ul>
        )}

        {session && session.entries.length > 0 && (
          <div className={styles.transcriptWrap}>
            <p className={styles.sectionLabel}>
              {live ? `Working · ${stepOf(session.phase)}` : 'Last run'}
            </p>
            <PanelTranscript entries={session.entries} live={live} />
          </div>
        )}

        {session?.pr && (
          <div className={styles.pr} data-testid="readiness-pr">
            <div className={styles.prRow}>
              <strong>PR #{session.pr.number}</strong>
              <span className={`${styles.prState} ${session.pr.merged ? styles.merged : ''}`}>
                {session.pr.merged ? 'Merged' : 'Open'}
              </span>
            </div>
            <button
              type="button"
              className={styles.prUrl}
              title={session.pr.url}
              onClick={() => onOpenPr(session.pr!.url)}
            >
              {session.pr.url}
            </button>
            {session.mergeDetail && <p className={styles.prNote}>{session.mergeDetail}</p>}
          </div>
        )}

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        <PanelActionRow
          visible={visible}
          busy={busy}
          skipped={Boolean(inspect?.skipped)}
          failedPhase={session?.failedPhase}
          actions={{
            onCheck,
            onFix,
            onRetry,
            onContinue,
            onConfirmMerge,
            onCancel,
            onSkip,
            onOpenPr,
          }}
        />
        <p className={styles.hint} data-testid="readiness-project">
          Project {projectId} · the marker committed on the base ref is the only truth.
        </p>
      </section>
    </div>
  );
}
