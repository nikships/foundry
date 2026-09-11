/**
 * Durable proposal reads for one project. The DB is the source of truth, so
 * mounting (or remounting after navigation, reload, or reconnect) re-reads
 * the full list — in-progress, ready, failed, and unaccepted rows — then
 * subscribes to live pushes. No hook owns a proposal: progress and
 * completion arrive independently of the composer that submitted them.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProposalSnapshot } from '@shared/types.js';
import type { OrchestratorState } from '@shared/ipc-contract.js';
import { api } from '../api.js';
import { applyProposalProgress, sortProposals } from '../view-models/proposals-view.js';

export interface ProposalsController {
  proposals: ProposalSnapshot[];
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
}

async function readProposals(projectId: string): Promise<ProposalSnapshot[]> {
  if (!projectId) return [];
  const list = (await api.orchestrator.list?.(projectId)) ?? [];
  return sortProposals(list.filter((proposal) => proposal.projectId === projectId));
}

export function useProposals(projectId: string): ProposalsController {
  const [proposals, setProposals] = useState<ProposalSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const projectRef = useRef(projectId);
  useEffect(() => {
    projectRef.current = projectId;
  }, [projectId]);

  const refresh = useCallback(async (): Promise<void> => {
    const scope = projectRef.current;
    if (!scope) {
      setProposals([]);
      setLoading(false);
      return;
    }
    try {
      setProposals(await readProposals(scope));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setProposals([]);
    setError('');
    setLoading(true);
    void refresh();
  }, [projectId, refresh]);

  useEffect(() => {
    if (!projectId) return;
    const offProposals = api.on('proposals-changed', () => {
      void refresh();
    });
    const offProgress = api.on('orchestrator-progress', (data) => {
      const state = data as OrchestratorState | undefined;
      if (!state) {
        void refresh();
        return;
      }
      if (state.projectId !== projectRef.current) return;
      // Patch the single row for live transcripts; the debounced
      // `proposals-changed` re-read reconciles with the DB afterwards.
      setProposals((prev) => applyProposalProgress(prev, state));
    });
    const offRuns = api.on('runs-changed', () => {
      void refresh();
    });
    return () => {
      offProposals();
      offProgress();
      offRuns();
    };
  }, [projectId, refresh]);

  return { proposals, loading, error, refresh };
}
