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
import SmithRunPlanDesign, { EarlierPlanDiscussion } from '../smith/SmithRunPlanDesign.js';
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

export function ProposalRow({
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
  onRetry: (planId: string, prompt: string) => void;
}): React.JSX.Element {
  const { project, refreshAll } = useApp();
  const [starting, setStarting] = useState(false);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
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

  const readCurrent = async (): Promise<ProposalSnapshot> => {
    const row = await api.compose.get?.(proposal.planId);
    if (!row) throw new Error('This proposal is unavailable. This card is a snapshot.');
    return row;
  };

  const act = (action: (row: ProposalSnapshot) => Promise<unknown> | void): void => {
    void readCurrent()
      .then(action)
      .catch((error: Error) => {
        setIssues([{ level: 'error', where: 'proposal', message: error.message }]);
      });
  };

  const discard = (): void => {
    act((row) => api.compose.discard?.(row.planId));
  };

  const accept = async (): Promise<void> => {
    if (!effective || starting || baseSyncing) return;
    setStarting(true);
    setIssues([]);
    try {
      const row = await readCurrent();
      if (row.status !== 'ready' || row.revision !== proposal.revision) {
        throw new Error('The proposal changed. Review the current card before starting.');
      }
      const currentPlan = effectivePlanOf(row, modelOverrides, reasoningOverrides);
      if (!currentPlan || !api.compose.accept) throw new Error('Proposal cannot be started.');
      const result = await api.compose.accept(row.planId, currentPlan);
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

  if (proposal.status === 'cancelled') {
    return (
      <section
        ref={rowRef}
        className={`${styles.row} card`}
        data-testid={`proposal-${proposal.planId}`}
        data-proposal-status="cancelled"
      >
        <p className={styles.muted}>Proposal discarded during planning — no run was created.</p>
        <EarlierPlanDiscussion messages={proposal.messages} />
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
          <Button
            size="sm"
            onClick={() => act((row) => onRetry(row.planId, row.prompt))}
            data-testid="proposal-retry"
          >
            Try again
          </Button>
          <Button size="sm" variant="ghost" onClick={discard} data-testid="proposal-discard">
            Discard
          </Button>
        </div>
        <PanelTranscript entries={proposal.entries} live={false} />
        <EarlierPlanDiscussion messages={proposal.messages} />
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
          <span className={styles.planningTitle}>Smith is composing…</span>
          <span className={styles.planningDetail}>
            {proposal.detail || 'Opening the planning session…'}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => act((row) => api.compose.cancel(row.planId))}
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
      <SmithRunPlanDesign
        planId={proposal.planId}
        plan={effective}
        original={proposal.plan}
        starting={starting}
        startBlocked={
          proposal.status !== 'ready'
            ? proposal.status
            : baseSyncing
              ? `Updating ${project?.baseRef ?? 'base branch'} first`
              : null
        }
        issues={issues}
        messages={proposal.messages}
        onPhaseModelChange={(phaseName, model) =>
          act((row) => {
            if (row.status === 'ready' && row.revision === proposal.revision)
              setModelOverrides((current) => ({ ...current, [phaseName]: model }));
          })
        }
        onPhaseReasoningEffortChange={(phaseName, effort) =>
          act((row) => {
            if (row.status === 'ready' && row.revision === proposal.revision)
              setReasoningOverrides((current) => ({ ...current, [phaseName]: effort }));
          })
        }
        onResetPhaseOverrides={() => {
          setModelOverrides({});
          setReasoningOverrides({});
        }}
        onStart={() => void accept()}
        onRegenerate={() => act((row) => onRetry(row.planId, row.prompt))}
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
  onRetry: (planId: string, prompt: string) => void;
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
