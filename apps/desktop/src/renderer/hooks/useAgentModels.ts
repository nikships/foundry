import { useCallback, useEffect, useState } from 'react';
import type { ModelInfo } from '@shared/types.js';
import { api } from '../api.js';

export function useAgentModels(): {
  models: ModelInfo[];
  refresh: () => Promise<void>;
} {
  const [models, setModels] = useState<ModelInfo[]>([]);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await api.catalog.agentModels();
      setModels(next);
    } catch {
      setModels([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const offBridge = api.on('bridge-changed', () => void refresh());
    const offSettings = api.on('settings-changed', () => void refresh());
    return () => {
      offBridge();
      offSettings();
    };
  }, [refresh]);

  return { models, refresh };
}
