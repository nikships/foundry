import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GeneratedRunPlan, ReasoningEffort } from '@shared/types.js';
import type { OrchestratorState } from '@shared/ipc-contract.js';
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
  submit(prompt: string): Promise<void>;
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
  const [modelOverrides, setModelOverrides] = useState<Record<string, string>>({});
  const [reasoningOverrides, setReasoningOverrides] = useState<Record<string, ReasoningEffort>>({});
  const progressRef = useRef(new Map<string, OrchestratorState>());
  const planIdRef = useRef('');
  const requestGenerationRef = useRef(0);

  useEffect(
    () =>
      api.on('orchestrator-progress', (data) => {
        const state = data as OrchestratorState | undefined;
        if (!state) return;
        progressRef.current.set(state.planId, state);
        if (state.planId === planIdRef.current) setPlanning(state);
      }),
    [],
  );

  useEffect(() => {
    requestGenerationRef.current += 1;
    setPlanning(null);
    setRequestingPlan(false);
    setPlanError('');
    setModelOverrides({});
    setReasoningOverrides({});
    return () => {
      requestGenerationRef.current += 1;
      const planId = planIdRef.current;
      planIdRef.current = '';
      if (planId) void api.orchestrator.cancel(planId);
    };
  }, [projectId]);

  const original = planning?.status === 'done' ? planning.plan : null;
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

  const submit = useCallback(
    async (prompt: string): Promise<void> => {
      if (!prompt.trim() || !projectId || requestingPlan) return;
      const generation = ++requestGenerationRef.current;
      planIdRef.current = '';
      setRequestingPlan(true);
      setPlanError('');
      setModelOverrides({});
      setReasoningOverrides({});
      setPlanning(null);
      try {
        const result = await api.orchestrator.plan(
          projectId,
          prompt,
          choice.model,
          choice.reasoningEffort,
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
    [choice, projectId, requestingPlan],
  );

  const cancel = useCallback((): void => {
    requestGenerationRef.current += 1;
    const planId = planIdRef.current;
    planIdRef.current = '';
    if (planId) void api.orchestrator.cancel(planId);
    setRequestingPlan(false);
    setPlanning(null);
    setPlanError('');
    setModelOverrides({});
    setReasoningOverrides({});
  }, []);

  const discard = useCallback((): void => {
    requestGenerationRef.current += 1;
    planIdRef.current = '';
    setRequestingPlan(false);
    setPlanning(null);
    setPlanError('');
    setModelOverrides({});
    setReasoningOverrides({});
  }, []);

  return {
    stage,
    planning,
    planningLive,
    requestingPlan,
    planError,
    plan,
    original,
    submit,
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
