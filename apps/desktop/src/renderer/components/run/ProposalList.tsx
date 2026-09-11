/**
 * Independent durable proposals: one row per `startPlan` call, each
 * actionable on its own. The composer never blocks on these rows — they
 * generate, succeed, or fail in the background while the operator keeps
 * working, navigates away, or reloads.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  GeneratedRunPlan,
  ProposalSnapshot,
  ReasoningEffort,
  ValidationIssue,
} from '@shared/types.js';
import { api } from '../../api.js';
import { useApp } from '../../stores/app.js';
import { withPhaseModel, withPhaseReasoningEffort } from '../../view-models/plan-view.js';
import PanelTranscript from '../readiness/PanelTranscript.js';
import { Button } from '../ui/Button.js';
import PlanCard from './PlanCard.js';
import styles from './ProposalList.module.css';

function effectivePlanOf(
  proposal: ProposalSnapshot,
  models: Record<string, string>,
  efforts: Record<string, ReasoningEffort>,
): GeneratedRunPlan | null {
  if (!proposal.plan) return null;
  const withModels = Object.entries(models).reduce(
    (next, [phaseName, model]) => withPhaseModel(next, phaseName, model),
    proposal.plan,
  );
  return Object.entries(efforts).reduce(
    (next, [phaseName, effort]) => withPhaseReasoningEffort(next, phaseName, effort),
    withModels,
  );
}

function ProposalRow({
  proposal,
  baseSyncing,
  focusRequested,
  onOpen,
  onRetry,
}: {
  proposal: ProposalSnapshot;
  baseSyncing: boolean;
  focusRequested: boolean;
  onOpen: (runId: string) => void;
  onRetry: (prompt: string) => void;
}): React.JSX.Element {
  const { project, refreshAll } = useApp();
  const [starting, setStarting] = useState(false);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [chatError, setChatError] = useState('');
  const [modelOverrides, setModelOverrides] = useState<Record<string, string>>({});
  const [reasoningOverrides, setReasoningOverrides] = useState<Record<string, ReasoningEffort>>({});
  const rowRef = useRef<HTMLElement | null>(null);
  const seenRevision = useRef(proposal.revision);

  useEffect(() => {
    if (proposal.revision === seenRevision.current) return;
    seenRevision.current = proposal.revision;
    setModelOverrides({});
    setReasoningOverrides({});
  }, [proposal.revision]);

  useEffect(() => {
    if (focusRequested) {
      rowRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [focusRequested]);

  const effective = useMemo(
    () => effectivePlanOf(proposal, modelOverrides, reasoningOverrides),
    [proposal, modelOverrides, reasoningOverrides],
  );
  const generating = proposal.status === 'generating' && !proposal.plan;
  const replying = proposal.status === 'generating' && proposal.plan !== null;

  const discard = (): void => {
    const discardCall = api.orchestrator.discard;
    if (discardCall) void discardCall(proposal.planId);
    else void api.orchestrator.cancel(proposal.planId);
  };

  const accept = async (): Promise<void> => {
    if (!effective || starting || baseSyncing) return;
    setStarting(true);
    setIssues([]);
    try {
      const acceptCall = api.orchestrator.accept;
      const result = acceptCall
        ? await acceptCall(proposal.planId, effective)
        : await api.runs.start({
            projectId: proposal.projectId,
            pipelineId: effective.pipeline.id,
            request: effective.refinedRequest,
            plan: effective,
          });
      if (!result.ok) {
        setIssues(result.issues);
        await refreshAll();
        return;
      }
      if (result.runId) onOpen(result.runId);
      void refreshAll();
    } catch (error) {
      setIssues([{ level: 'error', where: 'start', message: (error as Error).message }]);
    } finally {
      setStarting(false);
    }
  };

  const sendMessage = (text: string): void => {
    if (!text.trim()) return;
    setChatError('');
    void api.orchestrator
      .message(proposal.planId, text)
      .then((refused) => {
        if (refused) setChatError(refused);
      })
      .catch((error: Error) => setChatError(error.message || 'Could not send the message.'));
  };

  if (proposal.status === 'cancelled') {
    return (
      <section
        ref={rowRef}
        className={`${styles.row} card`}
        data-testid={`proposal-${proposal.planId}`}
        data-proposal-status="cancelled"
      >
        <p className={styles.muted}>Proposal discarded during planning — no run was created.</p>
        <Button size="sm" variant="ghost" onClick={discard} data-testid="proposal-dismiss">
          Dismiss
        </Button>
      </section>
    );
  }

  if (proposal.status === 'failed') {
    return (
      <section
        ref={rowRef}
        className={`${styles.row} card`}
        data-testid={`proposal-${proposal.planId}`}
        data-proposal-status="failed"
      >
        <div className={styles.failedHead}>
          <span className={styles.failedTitle}>Planning failed</span>
          <span className={styles.failedDetail}>{proposal.detail || 'The planner gave up.'}</span>
          <Button size="sm" onClick={() => onRetry(proposal.prompt)} data-testid="proposal-retry">
            Try again
          </Button>
          <Button size="sm" variant="ghost" onClick={discard} data-testid="proposal-discard">
            Discard
          </Button>
        </div>
        <PanelTranscript entries={proposal.entries} live={false} />
      </section>
    );
  }

  if (generating) {
    return (
      <section
        ref={rowRef}
        className={`${styles.row} card`}
        data-testid={`proposal-${proposal.planId}`}
        data-proposal-status="generating"
        aria-live="polite"
      >
        <div className={styles.planningHead} data-testid="planning-panel">
          <span className={styles.planningTitle}>The Orchestrator is planning</span>
          <span className={styles.planningDetail}>
            {proposal.detail || 'Opening the planning session…'}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void api.orchestrator.cancel(proposal.planId)}
            data-testid="proposal-cancel"
          >
            Cancel
          </Button>
          <Button size="sm" variant="ghost" onClick={discard} data-testid="proposal-discard">
            Discard
          </Button>
        </div>
        <PanelTranscript entries={proposal.entries} live />
      </section>
    );
  }

  if (!effective || !proposal.plan) {
    return (
      <section
        ref={rowRef}
        className={`${styles.row} card`}
        data-testid={`proposal-${proposal.planId}`}
        data-proposal-status={proposal.status}
      >
        <p className={styles.muted}>Waiting for the planning session…</p>
      </section>
    );
  }

  return (
    <div
      ref={rowRef as React.RefObject<HTMLDivElement>}
      data-testid={`proposal-${proposal.planId}`}
    >
      <PlanCard
        planId={proposal.planId}
        plan={effective}
        original={proposal.plan}
        starting={starting}
        startBlocked={baseSyncing ? `Updating ${project?.baseRef ?? 'base branch'} first` : null}
        issues={issues}
        messages={proposal.messages}
        replying={replying}
        chatError={chatError}
        onSendMessage={sendMessage}
        onPhaseModelChange={(phaseName, model) =>
          setModelOverrides((current) => ({ ...current, [phaseName]: model }))
        }
        onPhaseReasoningEffortChange={(phaseName, effort) =>
          setReasoningOverrides((current) => ({ ...current, [phaseName]: effort }))
        }
        onResetPhaseOverrides={() => {
          setModelOverrides({});
          setReasoningOverrides({});
        }}
        onStart={() => void accept()}
        onRegenerate={() => onRetry(proposal.prompt)}
        onDiscard={discard}
      />
    </div>
  );
}

/**
 * Every visible proposal for the project, newest first. Accepted and
 * discarded rows are audit history, not work: they stay out of this list.
 */
export default function ProposalList({
  proposals,
  baseSyncing,
  focusPlanId,
  onOpen,
  onRetry,
}: {
  proposals: ProposalSnapshot[];
  baseSyncing: boolean;
  focusPlanId?: string | null;
  onOpen: (runId: string) => void;
  onRetry: (prompt: string) => void;
}): React.JSX.Element | null {
  const visible = useMemo(
    () =>
      [...proposals]
        .filter(
          (proposal) =>
            proposal.status === 'generating' ||
            proposal.status === 'ready' ||
            proposal.status === 'failed' ||
            proposal.status === 'cancelled',
        )
        .sort((a, b) => b.createdAt - a.createdAt || b.planId.localeCompare(a.planId)),
    [proposals],
  );
  if (visible.length === 0) return null;
  return (
    <div className={styles.list} data-testid="proposal-list">
      {visible.map((proposal) => (
        <ProposalRow
          key={proposal.planId}
          proposal={proposal}
          baseSyncing={baseSyncing}
          focusRequested={focusPlanId === proposal.planId}
          onOpen={onOpen}
          onRetry={onRetry}
        />
      ))}
    </div>
  );
}
