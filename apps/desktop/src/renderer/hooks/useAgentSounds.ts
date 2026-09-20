/**
 * Plays generated milestone sounds from live compose, run, and Smith
 * snapshots. Historical rows are a baseline, not a concert: the first read
 * of each run or pending proposal is silent. Snapshot maps survive project-list
 * refreshes so a known row cannot become a first-sighting replay.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { ComposeState } from '@shared/ipc-contract.js';
import type { ProjectDef } from '@shared/types.js';
import { api } from '../api.js';
import { playAgentSound, unlockAgentSounds } from '../utils/agent-sounds.js';
import {
  applyRunSnapshots,
  composeCues,
  rememberSmithProposals,
  smithCues,
  snapshotCompose,
  snapshotSmith,
  type AgentSoundCue,
  type ComposeCueSnapshot,
  type RunCueSnapshot,
  type SmithCueSnapshot,
} from '../view-models/agent-sound-cues.js';

export function useAgentSounds(enabled: boolean, projects: ProjectDef[]): void {
  const projectsRef = useRef(projects);
  const composeRef = useRef(new Map<string, ComposeCueSnapshot>());
  const runsRef = useRef(new Map<string, RunCueSnapshot>());
  const smithRef = useRef<SmithCueSnapshot | undefined>(undefined);
  const projectKey = useMemo(() => projects.map((project) => project.id).join(','), [projects]);

  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  useEffect(() => {
    if (!enabled) return;
    const unlock = (): void => unlockAgentSounds();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      composeRef.current.clear();
      runsRef.current.clear();
      smithRef.current = undefined;
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let inFlight = false;
    let queued = false;

    const play = (cues: readonly AgentSoundCue[]): void => {
      if (disposed) return;
      for (const cue of cues) playAgentSound(cue);
    };

    let timer: number | null = null;
    const schedule = (live: boolean): void => {
      if (disposed) return;
      if (timer !== null) window.clearTimeout(timer);
      // Idle pages do not poll: settled rows have nothing left to announce,
      // and a 4s refresh was enough to turn a static accepted run into a
      // repeating beep. Live runs still need the short cadence because phase
      // completions do not push `runs-changed`.
      if (!live) {
        timer = null;
        return;
      }
      timer = window.setTimeout(() => {
        if (disposed) return;
        void refreshRuns();
      }, 800);
    };

    const refreshRuns = async (): Promise<void> => {
      if (disposed) return;
      if (inFlight) {
        queued = true;
        return;
      }
      inFlight = true;
      try {
        const lists = await Promise.all(
          projectsRef.current.map((project) => api.runs.list(project.id, false)),
        );
        if (disposed) return;
        const rows = lists.flat();
        play(applyRunSnapshots(rows, runsRef.current));
        schedule(rows.some((run) => run.status === 'running'));
      } catch {
        /* A missed poll is silent; the next change event or live tick retries. */
      } finally {
        inFlight = false;
        if (!disposed && queued) {
          queued = false;
          void refreshRuns();
        }
      }
    };

    const refreshSmith = async (): Promise<void> => {
      try {
        const snap = snapshotSmith(await api.smith.proposalsList());
        if (disposed) return;
        play(smithCues(smithRef.current, snap));
        smithRef.current = rememberSmithProposals(smithRef.current, snap);
      } catch {
        /* A missed poll is silent; the next change event retries. */
      }
    };

    const offCompose = api.on('smith-compose-progress', (data) => {
      if (disposed) return;
      const state = data as ComposeState | undefined;
      if (!state) return;
      const next = snapshotCompose(state);
      const prev = composeRef.current.get(state.planId);
      composeRef.current.set(state.planId, next);
      play(composeCues(prev, next));
    });

    const offRuns = api.on('runs-changed', () => {
      void refreshRuns();
    });

    const offSmith = api.on('smith-proposals-changed', () => {
      void refreshSmith();
    });

    void Promise.all([refreshRuns(), refreshSmith()]);

    return () => {
      disposed = true;
      offCompose();
      offRuns();
      offSmith();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [enabled, projectKey]);
}
