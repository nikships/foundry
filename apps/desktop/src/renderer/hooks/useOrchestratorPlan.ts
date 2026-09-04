import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GeneratedRunPlan, PlanImageAttachment, ReasoningEffort } from '@shared/types.js';
import type { OrchestratorState, PlanChatMessage } from '@shared/ipc-contract.js';
import { api } from '../api.js';
import type { OrchestratorChoice } from '../components/run/OrchestratorPicker.js';
import { withPhaseModel, withPhaseReasoningEffort } from '../view-models/plan-view.js';

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
  addImages(images: readonly PlanImageAttachment[]): void;
  removeImage(index: number): void;
  submit(prompt: string): Promise<void>;
  /** One follow-up message about the accepted plan. */
  sendMessage(text: string): Promise<void>;
  cancel(): void;
  discard(): void;
  setPhaseModel(phaseName: string, model: string): void;
  setPhaseReasoningEffort(phaseName: string, reasoningEffort: ReasoningEffort): void;
  resetPhaseOverrides(): void;
}

/** One independent Orchestrator planning session, reusable by any request source. */
export function useOrchestratorPlan(
  projectId: string,
  choice: OrchestratorChoice,
): OrchestratorPlanController {
  const [planning, setPlanning] = useState<OrchestratorState | null>(null);
  const [requestingPlan, setRequestingPlan] = useState(false);
  const [planError, setPlanError] = useState('');
  const [chatError, setChatError] = useState('');
  const [images, setImages] = useState<PlanImageAttachment[]>([]);
  const [modelOverrides, setModelOverrides] = useState<Record<string, string>>({});
  const [reasoningOverrides, setReasoningOverrides] = useState<Record<string, ReasoningEffort>>({});
  const progressRef = useRef(new Map<string, OrchestratorState>());
  const planIdRef = useRef('');
  const requestGenerationRef = useRef(0);
  // A revision replaces the proposal, so operator re-casts of the old one
  // would silently patch phases the new pipeline may not even have.
  const seenRevisionRef = useRef(0);

  const resetPlanningFields = useCallback((): void => {
    setPlanning(null);
    setPlanError('');
    setChatError('');
    setModelOverrides({});
    setReasoningOverrides({});
    seenRevisionRef.current = 0;
  }, []);

  const clearImages = useCallback((): void => {
    setImages([]);
  }, []);

  useEffect(
    () =>
      api.on('orchestrator-progress', (data) => {
        const state = data as OrchestratorState | undefined;
        if (!state) return;
        progressRef.current.set(state.planId, state);
        if (state.planId !== planIdRef.current) return;
        if (state.revision !== seenRevisionRef.current) {
          seenRevisionRef.current = state.revision;
          setModelOverrides({});
          setReasoningOverrides({});
        }
        setPlanning(state);
      }),
    [],
  );

  useEffect(() => {
    requestGenerationRef.current += 1;
    setRequestingPlan(false);
    resetPlanningFields();
    clearImages();
    return () => {
      requestGenerationRef.current += 1;
      const planId = planIdRef.current;
      planIdRef.current = '';
      if (planId) void api.orchestrator.cancel(planId);
    };
  }, [projectId, resetPlanningFields, clearImages]);

  // The accepted plan stands while a follow-up reply is being considered, so
  // the card never vanishes mid-conversation.
  const original = planning?.plan ?? null;
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
  const planningLive = requestingPlan || (planning?.status === 'running' && !planning.plan);
  const replying = planning?.status === 'running' && planning.plan !== null;

  const addImages = useCallback((next: readonly PlanImageAttachment[]): void => {
    if (next.length === 0) return;
    setImages((current) => [...current, ...next]);
  }, []);

  const removeImage = useCallback((index: number): void => {
    setImages((current) => current.filter((_, i) => i !== index));
  }, []);

  const submit = useCallback(
    async (prompt: string): Promise<void> => {
      if ((!prompt.trim() && images.length === 0) || !projectId || requestingPlan) return;
      const generation = ++requestGenerationRef.current;
      // A regenerate may land mid-conversation; the replaced session must not
      // keep an Orchestrator turn running for a proposal no one can see.
      const previous = planIdRef.current;
      if (previous) void api.orchestrator.cancel(previous);
      planIdRef.current = '';
      setRequestingPlan(true);
      resetPlanningFields();
      try {
        const result = await api.orchestrator.plan(
          projectId,
          prompt,
          choice.model,
          choice.reasoningEffort,
          images.length ? images : undefined,
        );
        if (generation !== requestGenerationRef.current) {
          if (!('error' in result)) void api.orchestrator.cancel(result.planId);
          return;
        }
        if ('error' in result) {
          setPlanError(result.error);
          return;
        }
        planIdRef.current = result.planId;
        setPlanning(
          progressRef.current.get(result.planId) ?? {
            planId: result.planId,
            projectId,
            status: 'running',
            model: choice.model,
            reasoningEffort: choice.reasoningEffort,
            prompt,
            entries: [],
            plan: null,
            rawReply: '',
            detail: 'Opening the planning session…',
            startedAt: Date.now(),
            messages: [],
            revision: 0,
          },
        );
      } catch (error) {
        if (generation === requestGenerationRef.current) {
          setPlanError((error as Error).message || 'Could not open the planning session.');
        }
      } finally {
        if (generation === requestGenerationRef.current) setRequestingPlan(false);
      }
    },
    [choice, images, projectId, requestingPlan, resetPlanningFields],
  );

  const sendMessage = useCallback(async (text: string): Promise<void> => {
    const planId = planIdRef.current;
    if (!planId || !text.trim()) return;
    setChatError('');
    try {
      const refused = await api.orchestrator.message(planId, text);
      if (refused && planId === planIdRef.current) setChatError(refused);
    } catch (error) {
      if (planId === planIdRef.current) {
        setChatError((error as Error).message || 'Could not send the message.');
      }
    }
  }, []);

  const cancel = useCallback((): void => {
    requestGenerationRef.current += 1;
    const planId = planIdRef.current;
    planIdRef.current = '';
    if (planId) void api.orchestrator.cancel(planId);
    setRequestingPlan(false);
    resetPlanningFields();
  }, [resetPlanningFields]);

  const discard = useCallback((): void => {
    requestGenerationRef.current += 1;
    const planId = planIdRef.current;
    planIdRef.current = '';
    if (planId) void api.orchestrator.cancel(planId);
    setRequestingPlan(false);
    resetPlanningFields();
    clearImages();
  }, [resetPlanningFields, clearImages]);

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
    addImages,
    removeImage,
    submit,
    sendMessage,
    cancel,
    discard,
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
