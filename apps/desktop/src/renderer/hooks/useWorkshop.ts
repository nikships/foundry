import { useEffect, useState } from 'react';
import type { PipelineDef } from '@shared/types.js';
import { api } from '../api.js';

export function useWorkshopPlan(
  projectId: string,
  runId: string,
  amendments?: number,
): PipelineDef | undefined {
  const [pipeline, setPipeline] = useState<PipelineDef>();
  useEffect(() => {
    let disposed = false;
    setPipeline(undefined);
    void api.runs
      .plan(projectId, runId)
      .then((plan) => {
        if (!disposed) setPipeline(plan?.pipeline);
      })
      .catch(() => {
        // Older/manual runs have no saved plan. Never guess a queued phase's model.
      });
    return () => {
      disposed = true;
    };
  }, [projectId, runId, amendments]);
  return pipeline;
}

export function useWorkshopMotion(): { paused: boolean; toggle: () => void } {
  const [paused, setPaused] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = (): void => setPaused(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  return { paused, toggle: () => setPaused((value) => !value) };
}
