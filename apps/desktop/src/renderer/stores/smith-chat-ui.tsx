import { createContext, useContext, useState } from 'react';
import type { SmithScreenContext } from '@shared/ipc-contract.js';
import type { ProposalSnapshot, SmithReceiptLink, SmithRunPlanArtifact } from '@shared/types.js';
import { smithRunPlanArtifact } from '@shared/smith-run-plan.js';
import { useProposal } from '../hooks/useProposal.js';
import { pinnedSmithContext } from '../view-models/smith-scope.js';
import { useApp } from './app.js';

type SmithChatUIContextValue = {
  openReceiptLink: (link: SmithReceiptLink) => void;
  draft: string;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  discussPlan: (planId: string) => Promise<void>;
  pinnedPlan: SmithRunPlanArtifact | null;
  pinnedPlanAvailable: boolean;
  unpinPlan: () => void;
  withPinnedPlan: (screen: SmithScreenContext) => SmithScreenContext;
};

const SmithChatUIContext = createContext<SmithChatUIContextValue | null>(null);

export function useSmithChatUI(): SmithChatUIContextValue {
  const context = useContext(SmithChatUIContext);
  if (!context) throw new Error('Smith chat requires its provider.');
  return context;
}

export function SmithChatUIProvider({
  children,
  openReceiptLink,
  onDiscussPlan,
}: {
  children: React.ReactNode;
  openReceiptLink: (link: SmithReceiptLink) => void;
  onDiscussPlan: (planId: string) => Promise<ProposalSnapshot>;
}): React.JSX.Element {
  const { smithProjectId } = useApp();
  const scope = smithProjectId ?? '';
  const [pins, setPins] = useState<Record<string, SmithRunPlanArtifact | null>>({});
  const pin = pins[scope] ?? null;
  const livePin = useProposal(pin?.planId);
  const discussPlan = async (planId: string): Promise<void> => {
    const row = await onDiscussPlan(planId);
    setPins((current) => ({ ...current, [row.projectId]: smithRunPlanArtifact(row) }));
  };
  const unpinPlan = (): void => setPins((current) => ({ ...current, [scope]: null }));
  const withPinnedPlan = (screen: SmithScreenContext): SmithScreenContext =>
    pinnedSmithContext(screen, livePin, smithProjectId);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const setDraft: React.Dispatch<React.SetStateAction<string>> = (next) => {
    setDrafts((current) => ({
      ...current,
      [scope]: typeof next === 'function' ? next(current[scope] ?? '') : next,
    }));
  };

  return (
    <SmithChatUIContext.Provider
      value={{
        openReceiptLink,
        draft: drafts[scope] ?? '',
        setDraft,
        discussPlan,
        pinnedPlan: livePin ? smithRunPlanArtifact(livePin) : pin,
        pinnedPlanAvailable: livePin !== null,
        unpinPlan,
        withPinnedPlan,
      }}
    >
      {children}
    </SmithChatUIContext.Provider>
  );
}
