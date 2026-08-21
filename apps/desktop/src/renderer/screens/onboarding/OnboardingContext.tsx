import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { DoctorCheck, ModelInfo, ProjectDef } from '@shared/types.js';
import type { BridgeState } from '@shared/ipc-contract.js';
import type { StepId } from './shared.js';
import { STEPS } from './shared.js';
import { api } from '../../api.js';
import { useConfirmAction } from '../../hooks/useConfirmAction.js';
import { useApp } from '../../stores/app.js';
import { useAgentModels } from '../../hooks/useAgentModels.js';

export type OnboardingContextValue = {
  stepIndex: number;
  step: StepId;
  go: (i: number) => void;
  next: () => void;
  back: () => void;
  entered: boolean;
  // shared domain state
  checks: DoctorCheck[];
  checking: boolean;
  recheck: () => Promise<void>;
  blockingCount: number;
  canLeaveDoctor: boolean;
  doctorHint: string;
  // providers step
  bridge: BridgeState | null;
  models: ModelInfo[];
  /** True once at least one model has a working credential. */
  hasUsableModel: boolean;
  providersHint: string;
  providerBusy: string | null;
  connectProvider: (providerId: string) => Promise<void>;
  cancelProviderLogin: (providerId: string) => Promise<void>;
  saveProviderKey: (providerId: string, apiKey: string) => Promise<void>;
  refreshProviders: () => Promise<void>;
  // project step
  name: string;
  setName: (s: string) => void;
  selectedId: string;
  setSelectedId: (s: string) => void;
  nameDrafts: Record<string, string>;
  setNameDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  renamingId: string | null;
  setRenamingId: (s: string | null) => void;
  busy: boolean;
  error: string;
  setError: (s: string) => void;
  addProject: () => Promise<void>;
  /** True while the create-a-repository wizard is open over this step. */
  creatingProject: boolean;
  startCreateProject: () => void;
  cancelCreateProject: () => void;
  projectCreated: (project: ProjectDef) => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  commitProjectRename: (id: string) => Promise<void>;
  canEnterProject: boolean;
  projectBlockingHint: string;
  finish: () => Promise<void>;
  onDone: () => void;
};

const Ctx = createContext<OnboardingContextValue | null>(null);

export function useOnboarding(): OnboardingContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useOnboarding must be inside OnboardingProvider');
  return v;
}

export function OnboardingProvider({
  children,
  stepIndex,
  setStepIndex,
  onDone,
}: {
  children: React.ReactNode;
  stepIndex: number;
  setStepIndex: (n: number) => void;
  onDone: () => void;
}): React.JSX.Element {
  const { projects, settings, refreshAll, selectProject, selectedProjectId } = useApp();
  const [checks, setChecks] = useState<DoctorCheck[]>([]);
  const [bridge, setBridge] = useState<BridgeState | null>(null);
  const { models, refresh: refreshModels } = useAgentModels();
  const [providerBusy, setProviderBusy] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [entered, setEntered] = useState(false);
  const [selectedId, setSelectedId] = useState<string>(
    () => selectedProjectId || projects[0]?.id || '',
  );
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(projects.map((p) => [p.id, p.name])),
  );
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);

  const step: StepId = STEPS[stepIndex]!.id;

  const blocking = useMemo(() => checks.filter((c) => !c.ok && c.blocking), [checks]);
  const hasUsableModel = models.length > 0;
  const providersHint = hasUsableModel
    ? ''
    : (settings?.hiddenModelIds?.length ?? 0) > 0
      ? 'All models are hidden. Reset them in Settings → Providers.'
      : 'Connect a provider or store an API key — a run needs at least one usable model.';
  const canLeaveDoctor = !checking && blocking.length === 0;
  const doctorHint = checking
    ? 'Still checking the environment…'
    : blocking.length
      ? `Fix ${blocking.length === 1 ? 'the blocking check' : `${blocking.length} blocking checks`}, then Re-check.`
      : '';

  useEffect(() => {
    const t = window.setTimeout(() => setEntered(true), 40);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    setName(settings?.engineerName ?? '');
    void api.doctor.run().then((nextChecks) => {
      setChecks(nextChecks);
      setChecking(false);
    });
  }, [settings?.engineerName]);

  /**
   * A login lands minutes after `connect` returned, in a browser this window
   * does not own, so the providers step re-reads its whole world on
   * `bridge-changed` rather than trusting the action's own result.
   */
  useEffect(() => {
    const reload = (): void => {
      void api.bridge.state().then(setBridge);
    };
    reload();
    return api.on('bridge-changed', reload);
  }, []);

  useEffect(() => {
    setNameDrafts((prev) => {
      const next: Record<string, string> = { ...prev };
      for (const p of projects) {
        if (renamingId === p.id) {
          if (!(p.id in next)) next[p.id] = p.name;
          continue;
        }
        next[p.id] = p.name;
      }
      for (const id of Object.keys(next)) if (!projects.some((p) => p.id === id)) delete next[id];
      const pk = Object.keys(prev),
        nk = Object.keys(next);
      if (pk.length === nk.length && nk.every((k) => prev[k] === next[k])) return prev;
      return next;
    });
  }, [projects, renamingId]);

  useEffect(() => {
    if (!projects.length) {
      if (selectedId) setSelectedId('');
      return;
    }
    const stillThere = projects.some((p) => p.id === selectedId);
    if (!selectedId || !stillThere) {
      const preferred = selectedProjectId || projects[0]!.id;
      const exists = projects.some((p) => p.id === preferred);
      setSelectedId(exists ? preferred : projects[0]!.id);
    }
  }, [projects, selectedProjectId, selectedId]);

  useEffect(() => {
    if (step !== 'doctor') return;
    if (checks.length > 0) return;
    let cancelled = false;
    setChecking(true);
    void api.doctor.run().then((next) => {
      if (!cancelled) {
        setChecks(next);
        setChecking(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [step, checks.length]);

  const go = (next: number): void => {
    setError('');
    setStepIndex(Math.max(0, Math.min(STEPS.length - 1, next)));
  };
  const next = (): void => go(stepIndex + 1);
  const back = (): void => go(stepIndex - 1);

  const recheck = async (): Promise<void> => {
    setChecking(true);
    setError('');
    try {
      setChecks(await api.doctor.run());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };
  const refreshProviders = async (): Promise<void> => {
    setBridge(await api.bridge.state());
    await refreshModels();
  };

  /** One busy key and one error line for every provider action on this step. */
  const runProviderAction = async (
    key: string,
    action: () => Promise<{ ok: boolean; detail: string }>,
  ): Promise<void> => {
    if (providerBusy) return;
    setProviderBusy(key);
    setError('');
    try {
      const result = await action();
      if (!result.ok) setError(result.detail);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProviderBusy(null);
      await refreshProviders();
      void api.doctor.run().then(setChecks);
    }
  };

  const connectProvider = async (providerId: string): Promise<void> => {
    await runProviderAction(providerId, () => api.bridge.connect(providerId));
  };
  const saveProviderKey = async (providerId: string, apiKey: string): Promise<void> => {
    const key = apiKey.trim();
    if (!key) return;
    await runProviderAction(`key:${providerId}`, () => api.bridge.setApiKey(providerId, key));
  };
  const cancelProviderLogin = async (providerId: string): Promise<void> => {
    await runProviderAction(providerId, async () => {
      const cancelled = await api.bridge.cancelLogin(providerId);
      return { ok: true, detail: cancelled ? 'sign-in cancelled' : 'no sign-in was in flight' };
    });
  };
  const addProject = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const added = await api.projects.add();
      await refreshAll();
      if (added) {
        setSelectedId(added.id);
        selectProject(added.id);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const startCreateProject = (): void => {
    setError('');
    setCreatingProject(true);
  };
  const cancelCreateProject = (): void => setCreatingProject(false);

  /**
   * The wizard registered the project already; this selects it so the step's
   * "Enter Foundry" button is satisfied without a second click.
   */
  const projectCreated = async (project: ProjectDef): Promise<void> => {
    await refreshAll();
    setSelectedId(project.id);
    selectProject(project.id);
  };

  const removeProjectConfirm = useConfirmAction(
    (id: string) => {
      const target = projects.find((p) => p.id === id);
      return `Remove project "${target?.name}" from Foundry? The git repo on disk is not deleted.`;
    },
    async (id: string): Promise<void> => {
      if (busy) return;
      const target = projects.find((p) => p.id === id);
      if (!target) return;
      setBusy(true);
      setError('');
      try {
        await api.projects.remove(id);
        await refreshAll();
        if (selectedId === id) {
          const remaining = projects.filter((p) => p.id !== id);
          const nxt = remaining[0]?.id ?? '';
          setSelectedId(nxt);
          if (nxt) selectProject(nxt);
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
  );

  const removeProject = async (id: string): Promise<void> => {
    await removeProjectConfirm(id);
  };
  const commitProjectRename = async (id: string): Promise<void> => {
    const draft = (nameDrafts[id] ?? '').trim();
    const project = projects.find((p) => p.id === id);
    if (!project) return;
    if (!draft) {
      setError('Project name cannot be empty.');
      setNameDrafts((prev) => ({ ...prev, [id]: project.name }));
      setRenamingId(null);
      return;
    }
    if (draft.length > 80) {
      setError('Keep the project name under 80 characters.');
      return;
    }
    if (draft === project.name) {
      setRenamingId(null);
      return;
    }
    setRenamingId(null);
    setError('');
    try {
      const result = await api.projects.save({ ...project, name: draft });
      if (!result.ok) {
        setError(result.issues.map((i) => `${i.where}: ${i.message}`).join(' '));
        setNameDrafts((prev) => ({ ...prev, [id]: project.name }));
        return;
      }
      await refreshAll();
    } catch (e) {
      setError((e as Error).message);
      setNameDrafts((prev) => ({ ...prev, [id]: project.name }));
    }
  };
  const canEnterProject = useMemo(() => {
    if (busy) return false;
    if (!projects.length) return false;
    if (!selectedId) return false;
    return projects.some((p) => p.id === selectedId);
  }, [busy, projects, selectedId]);
  const projectBlockingHint = !projects.length
    ? 'Pick a project or add a repository to continue.'
    : !selectedId
      ? 'Select a project to continue.'
      : '';
  const finish = async (): Promise<void> => {
    if (busy) return;
    if (!canEnterProject) {
      setError(projectBlockingHint || 'Pick a project or add a repository to continue.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (name.trim()) await api.settings.patch({ engineerName: name.trim() });
      if (selectedId) selectProject(selectedId);
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const value: OnboardingContextValue = {
    stepIndex,
    step,
    go,
    next,
    back,
    entered,
    checks,
    checking,
    recheck,
    blockingCount: blocking.length,
    canLeaveDoctor,
    doctorHint,
    bridge,
    models,
    hasUsableModel,
    providersHint,
    providerBusy,
    connectProvider,
    cancelProviderLogin,
    saveProviderKey,
    refreshProviders,
    name,
    setName,
    selectedId,
    setSelectedId,
    nameDrafts,
    setNameDrafts,
    renamingId,
    setRenamingId,
    busy,
    error,
    setError,
    addProject,
    creatingProject,
    startCreateProject,
    cancelCreateProject,
    projectCreated,
    removeProject,
    commitProjectRename,
    canEnterProject,
    projectBlockingHint,
    finish,
    onDone,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
