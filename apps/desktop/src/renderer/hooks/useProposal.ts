import { useEffect, useState } from 'react';
import type { ProposalSnapshot } from '@shared/types.js';
import { api } from '../api.js';

/** A durable row, never a previous id's response or an out-of-order refresh. */
export function useProposal(planId: string | undefined): ProposalSnapshot | null {
  const [live, setLive] = useState<ProposalSnapshot | null>(null);
  useEffect(() => {
    let active = true;
    let request = 0;
    const refresh = async (): Promise<void> => {
      const current = ++request;
      const row = planId ? await api.compose.get?.(planId).catch(() => null) : null;
      if (active && current === request) setLive(row ?? null);
    };
    void refresh();
    const off = api.on('proposals-changed', () => void refresh());
    return () => {
      active = false;
      off();
    };
  }, [planId]);
  return live?.planId === planId ? live : null;
}
