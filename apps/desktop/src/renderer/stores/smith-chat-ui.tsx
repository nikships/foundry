import { createContext, useContext, useEffect, useState } from 'react';
import type { SmithScreenContext } from '@shared/ipc-contract.js';
import { useSmithVoice } from '../hooks/useSmithVoice.js';
import { useApp } from './app.js';

type SmithChatUIContextValue = ReturnType<typeof useSmithVoice> & {
  mode: 'text' | 'voice';
  setMode: (mode: 'text' | 'voice') => void;
  openSettings: () => void;
  draft: string;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
};

const SmithChatUIContext = createContext<SmithChatUIContextValue | null>(null);

export function useSmithChatUI(): SmithChatUIContextValue {
  const context = useContext(SmithChatUIContext);
  if (!context) throw new Error('Smith chat requires its provider.');
  return context;
}

export function SmithChatUIProvider({
  children,
  screenContext,
  openSettings,
}: {
  children: React.ReactNode;
  screenContext: SmithScreenContext;
  openSettings: () => void;
}): React.JSX.Element {
  const voice = useSmithVoice();
  const { smithProjectId } = useApp();
  const scope = smithProjectId ?? '';
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const setDraft: React.Dispatch<React.SetStateAction<string>> = (next) => {
    setDrafts((current) => ({
      ...current,
      [scope]: typeof next === 'function' ? next(current[scope] ?? '') : next,
    }));
  };
  const [mode, setMode] = useState<'text' | 'voice'>('text');
  const { setScreenContext } = voice;
  useEffect(() => setScreenContext(screenContext), [screenContext, setScreenContext]);

  return (
    <SmithChatUIContext.Provider
      value={{ ...voice, mode, setMode, openSettings, draft: drafts[scope] ?? '', setDraft }}
    >
      {children}
    </SmithChatUIContext.Provider>
  );
}
