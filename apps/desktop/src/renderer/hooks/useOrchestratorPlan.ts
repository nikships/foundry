/**
 * Per-composer Orchestrator controller over durable, parallel proposals.
 *
 * Each `submit()` opens one independent proposal and returns immediately —
 * it never cancels or replaces siblings, and the composer stays usable for
 * the next prompt. Proposal ownership lives in main (the DB row), not in
 * this hook: navigating away, switching projects, or unmounting never
 * cancels generation, and a remount re-reads durable state via
 * `useProposals`. Live `orchestrator-progress` pushes patch the single row;
 * `proposals-changed` reconciles with the DB.
 *
 * The singular `stage`/`planning`/`plan` fields describe the selected
 * proposal (newest actionable by default) so single-card composers keep
 * working; multi-card surfaces read `proposals` directly.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  GeneratedRunPlan,
  PlanImageAttachment,
  ProposalSnapshot,
  ReasoningEffort,
} from '@shared/types.js';
import type { OrchestratorState, PlanChatMessage } from '@shared/ipc-contract.js';
import { api } from '../api.js';
import type { OrchestratorChoice } from '../components/run/OrchestratorPicker.js';
import { withPhaseModel, withPhaseReasoningEffort } from '../view-models/plan-view.js';
import { useProposals } from './useProposals.js';

export type OrchestratorStage = 'compose' | 'planning' | 'ready';

export interface OrchestratorPlanController {
  stage: OrchestratorStage;
  planning: OrchestratorState | null;
  planningLive: boolean;
  requestingPlan: boolean;
  planError: string;
  plan: GeneratedRunPlan | null;
  original: GeneratedRunPlan | null;
  images: PlanImageAttachment[];
  /** The back-and-forth about the accepted plan, in order. */
  messages: PlanChatMessage[];
  /** True while the Orchestrator is considering a follow-up message. */
  replying: boolean;
  chatError: string;
  /** Every durable proposal for the project, newest first. */
  proposals: ProposalSnapshot[];
  proposalsLoading: boolean;
  proposalsError: string;
  /** Explicit selection for the singular fields; null follows the newest actionable. */
  selectedPlanId: string | null;
  selectPlan: (planId: string | null) => void;
  refreshProposals: () => Promise<void>;
  addImages(images: readonly PlanImageAttachment[]): void;
  removeImage(index: number): void;
  /** Opens one independent proposal; resolves with its planId (null when refused). */
  submit(prompt: string): Promise<string | null>;
  /** One follow-up message about the accepted plan. */
  sendMessage(text: string): Promise<void>;
  sendMessageTo(planId: string, text: string): Promise<void>;
  cancel(): void;
  discard(): void;
  cancelPlan(planId: string): void;
  discardPlan(planId: string): void;
  setPhaseModel(phaseName: string, model: string): void;
  setPhaseReasoningEffort(phaseName: string, reasoningEffort: ReasoningEffort): void;
  resetPhaseOverrides(): void;
}

function isActionable(proposal: ProposalSnapshot): boolean {
  return (
    proposal.status === 'generating' || proposal.status === 'ready' || proposal.status === 'failed'
  );
}

function toLiveState(proposal: ProposalSnapshot): OrchestratorState {
  const status =
    proposal.status === 'generating'
      ? 'running'
      : proposal.status === 'ready'
        ? 'done'
        : proposal.status === 'failed'
          ? 'failed'
          : proposal.status === 'cancelled'
            ? 'cancelled'
            : 'done';
  return {
    planId: proposal.planId,
    projectId: proposal.projectId,
    status,
    model: proposal.model,
    reasoningEffort: proposal.reasoningEffort,
    prompt: proposal.prompt,
    entries: proposal.entries,
    plan: proposal.plan,
    rawReply: proposal.rawReply,
    detail: proposal.detail,
    startedAt: proposal.createdAt,
    ...(proposal.endedAt !== undefined ? { endedAt: proposal.endedAt } : {}),
    messages: proposal.messages,
    revision: proposal.revision,
  };
}

/** One independent Orchestrator planning session, reusable by any request source. */
export function useOrchestratorPlan(
  projectId: string,
  choice: OrchestratorChoice,
): OrchestratorPlanController {
  const {
    proposals,
    loading: proposalsLoading,
    error: proposalsError,
    refresh,
  } = useProposals(projectId);
  const [requestingPlan, setRequestingPlan] = useState(false);
  const [planError, setPlanError] = useState('');
  const [chatError, setChatError] = useState('');
  const [images, setImages] = useState<PlanImageAttachment[]>([]);
  const [modelOverrides, setModelOverrides] = useState<Record<string, string>>({});
  const [reasoningOverrides, setReasoningOverrides] = useState<Record<string, ReasoningEffort>>({});
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const seenRevisionRef = useRef(0);
  const choiceRef = useRef(choice);
  useEffect(() => {
    choiceRef.current = choice;
  }, [choice]);

  // Project switch resets composer-local state only. Generation keeps
  // running in main; the new scope's mount refresh restores its rows.
  // Unmount and navigation never cancel: there is no cleanup cancel here
  // by design (FOU-349).
  useEffect(() => {
    setSelectedPlanId(null);
    setPlanError('');
    setChatError('');
    setModelOverrides({});
    setReasoningOverrides({});
    seenRevisionRef.current = 0;
    setImages([]);
    setRequestingPlan(false);
  }, [projectId]);

  const selected = useMemo((): ProposalSnapshot | null => {
    if (selectedPlanId) {
      const pinned = proposals.find((p) => p.planId === selectedPlanId) ?? null;
      if (pinned) return pinned;
    }
    return proposals.find(isActionable) ?? proposals[0] ?? null;
  }, [proposals, selectedPlanId]);

  useEffect(() => {
    if (!selected || selected.revision === seenRevisionRef.current) return;
    seenRevisionRef.current = selected.revision;
    setModelOverrides({});
    setReasoningOverrides({});
  }, [selected]);

  const planning = useMemo(() => (selected ? toLiveState(selected) : null), [selected]);
  const original = selected?.plan ?? null;
  const plan = useMemo(() => {
    if (!original) return null;
    const withModels = Object.entries(modelOverrides).reduce(
      (next, [phaseName, model]) => withPhaseModel(next, phaseName, model),
      original,
    );
    return Object.entries(reasoningOverrides).reduce(
      (next, [phaseName, effort]) => withPhaseReasoningEffort(next, phaseName, effort),
      withModels,
    );
  }, [original, modelOverrides, reasoningOverrides]);
  const stage: OrchestratorStage = plan
    ? 'ready'
    : requestingPlan || planning?.status === 'running' || planning?.status === 'failed'
      ? 'planning'
      : 'compose';
  const planningLive = requestingPlan || planning?.status === 'running';
  const replying = planning?.status === 'running' && planning.plan !== null;

  const addImages = useCallback((next: readonly PlanImageAttachment[]): void => {
    if (next.length === 0) return;
    setImages((current) => [...current, ...next]);
  }, []);

  const removeImage = useCallback((index: number): void => {
    setImages((current) => current.filter((_, i) => i !== index));
  }, []);

  const submit = useCallback(
    async (prompt: string): Promise<string | null> => {
      const currentImages = images;
      if ((!prompt.trim() && currentImages.length === 0) || !projectId) return null;
      // No sibling cancel, no requestingPlan gate: concurrent submits open
      // concurrent proposals. requestingPlan only tracks this invoke.
      setRequestingPlan(true);
      setPlanError('');
      try {
        const active = choiceRef.current;
        const result = await api.orchestrator.plan(
          projectId,
          prompt,
          active.model,
          active.reasoningEffort,
          currentImages.length ? currentImages : undefined,
        );
        if ('error' in result) {
          setPlanError(result.error);
          return null;
        }
        setSelectedPlanId(result.planId);
        setImages([]);
        void refresh();
        return result.planId;
      } catch (error) {
        setPlanError((error as Error).message || 'Could not open the planning session.');
        return null;
      } finally {
        setRequestingPlan(false);
      }
    },
    [images, projectId, refresh],
  );

  const sendMessageTo = useCallback(async (planId: string, text: string): Promise<void> => {
    if (!planId || !text.trim()) return;
    setChatError('');
    try {
      const refused = await api.orchestrator.message(planId, text);
      if (refused) setChatError(refused);
    } catch (error) {
      setChatError((error as Error).message || 'Could not send the message.');
    }
  }, []);

  const sendMessage = useCallback(
    async (text: string): Promise<void> => {
      if (selected) await sendMessageTo(selected.planId, text);
    },
    [selected, sendMessageTo],
  );

  const cancelPlan = useCallback(
    (planId: string): void => {
      if (!planId) return;
      void api.orchestrator.cancel(planId);
      void refresh();
    },
    [refresh],
  );

  const discardPlan = useCallback(
    (planId: string): void => {
      if (!planId) return;
      const discard = api.orchestrator.discard;
      if (discard) void discard(planId).finally(() => void refresh());
      else void api.orchestrator.cancel(planId).finally(() => void refresh());
      if (selectedPlanId === planId) setSelectedPlanId(null);
      void refresh();
    },
    [refresh, selectedPlanId],
  );

  const cancel = useCallback((): void => {
    if (selected) cancelPlan(selected.planId);
    setRequestingPlan(false);
  }, [selected, cancelPlan]);

  const discard = useCallback((): void => {
    if (selected) discardPlan(selected.planId);
    else {
      setRequestingPlan(false);
      setPlanError('');
      setChatError('');
    }
    setImages([]);
  }, [selected, discardPlan]);

  const selectPlan = useCallback((planId: string | null): void => {
    setSelectedPlanId(planId);
    setChatError('');
  }, []);

  return {
    stage,
    planning,
    planningLive,
    requestingPlan,
    planError,
    plan,
    original,
    images,
    messages: planning?.messages ?? [],
    replying,
    chatError,
    proposals,
    proposalsLoading,
    proposalsError,
    selectedPlanId: selected?.planId ?? null,
    selectPlan,
    refreshProposals: refresh,
    addImages,
    removeImage,
    submit,
    sendMessage,
    sendMessageTo,
    cancel,
    discard,
    cancelPlan,
    discardPlan,
    setPhaseModel: (phaseName, model) =>
      setModelOverrides((current) => ({ ...current, [phaseName]: model })),
    setPhaseReasoningEffort: (phaseName, reasoningEffort) =>
      setReasoningOverrides((current) => ({ ...current, [phaseName]: reasoningEffort })),
    resetPhaseOverrides: () => {
      setModelOverrides({});
      setReasoningOverrides({});
    },
  };
}
