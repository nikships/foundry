/**
 * Plays generated milestone sounds from live orchestrator, run, and Smith
 * snapshots. Historical rows are a baseline, not a concert: the first read
 * of each run or pending proposal is silent. Priming waits until the first
 * successful run-list fetch so a failed startup poll cannot replay history.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { OrchestratorState } from '@shared/ipc-contract.js';
import type { ProjectDef, RunRow } from '@shared/types.js';
import { api } from '../api.js';
import { playAgentSound, unlockAgentSounds } from '../utils/agent-sounds.js';
import {
  orchestratorCues,
  runCues,
  smithCues,
  snapshotOrchestrator,
  snapshotRun,
  snapshotSmith,
  type AgentSoundCue,
  type OrchestratorCueSnapshot,
  type RunCueSnapshot,
  type SmithCueSnapshot,
} from '../view-models/agent-sound-cues.js';

export function useAgentSounds(enabled: boolean, projects: ProjectDef[]): void {
  const enabledRef = useRef(enabled);
  const projectsRef = useRef(projects);
  const orchestratorRef = useRef(new Map<string, OrchestratorCueSnapshot>());
  const runsRef = useRef(new Map<string, RunCueSnapshot>());
  const smithRef = useRef<SmithCueSnapshot | undefined>(undefined);
  const primedRef = useRef(false);
  const inFlightRef = useRef(false);
  const queuedRef = useRef(false);
  const projectKey = useMemo(() => projects.map((project) => project.id).join(','), [projects]);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  useEffect(() => {
    const unlock = (): void => unlockAgentSounds();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    primedRef.current = false;
    inFlightRef.current = false;
    queuedRef.current = false;
    runsRef.current = new Map();
    smithRef.current = undefined;
    orchestratorRef.current = new Map();

    const play = (cues: readonly AgentSoundCue[]): void => {
      if (disposed || !enabledRef.current) return;
      for (const cue of cues) playAgentSound(cue);
    };

    const refreshRuns = async (): Promise<{ live: boolean; loaded: boolean }> => {
      if (disposed) return { live: false, loaded: false };
      if (inFlightRef.current) {
        queuedRef.current = true;
        return {
          live: [...runsRef.current.values()].some((run) => run.status === 'running'),
          loaded: primedRef.current,
        };
      }
      inFlightRef.current = true;
      try {
        const lists = await Promise.all(
          projectsRef.current.map((project) => api.runs.list(project.id, false)),
        );
        if (disposed) return { live: false, loaded: false };
        applyRunSnapshots(lists.flat(), runsRef.current, primedRef.current, play);
        return {
          live: [...runsRef.current.values()].some((run) => run.status === 'running'),
          loaded: true,
        };
      } catch {
        return {
          live: [...runsRef.current.values()].some((run) => run.status === 'running'),
          loaded: false,
        };
      } finally {
        inFlightRef.current = false;
        if (!disposed && queuedRef.current) {
          queuedRef.current = false;
          void refreshRuns();
        }
      }
    };

    const refreshSmith = async (): Promise<void> => {
      try {
        const snap = snapshotSmith(await api.smith.proposalsList());
        if (disposed) return;
        if (primedRef.current) play(smithCues(smithRef.current, snap));
        smithRef.current = snap;
      } catch {
        /* A missed poll is silent; the next change event retries. */
      }
    };

    const offOrchestrator = api.on('orchestrator-progress', (data) => {
      if (disposed) return;
      const state = data as OrchestratorState | undefined;
      if (!state) return;
      const next = snapshotOrchestrator(state);
      const prev = orchestratorRef.current.get(state.planId);
      orchestratorRef.current.set(state.planId, next);
      play(orchestratorCues(prev, next));
    });

    const offRuns = api.on('runs-changed', () => {
      void refreshRuns();
    });

    const offSmith = api.on('smith-proposals-changed', () => {
      void refreshSmith();
    });

    let timer: number | null = null;
    const schedule = (live: boolean): void => {
      if (disposed) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(
        () => {
          if (disposed) return;
          void refreshRuns().then((result) => {
            if (!primedRef.current && result.loaded) primedRef.current = true;
            schedule(result.live);
          });
        },
        live ? 800 : 4_000,
      );
    };

    void Promise.all([refreshRuns(), refreshSmith()]).then(([result]) => {
      if (disposed) return;
      if (result.loaded) primedRef.current = true;
      schedule(result.live);
    });

    return () => {
      disposed = true;
      offOrchestrator();
      offRuns();
      offSmith();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [projectKey]);
}

function applyRunSnapshots(
  runs: RunRow[],
  store: Map<string, RunCueSnapshot>,
  primed: boolean,
  play: (cues: readonly AgentSoundCue[]) => void,
): void {
  const next = new Map<string, RunCueSnapshot>();
  const cues: AgentSoundCue[] = [];
  for (const run of runs) {
    const snap = snapshotRun(run);
    next.set(run.runId, snap);
    if (primed) cues.push(...runCues(store.get(run.runId), snap));
  }
  store.clear();
  for (const [id, snap] of next) store.set(id, snap);
  play(cues);
}
