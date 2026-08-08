import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { CliDescriptor, DoctorCheck, ProjectState } from '@shared/types.js';
import type { StepId } from './shared.js';
import { STEPS } from './shared.js';
import { api } from '../../api.js';
import { useConfirmAction } from '../../hooks/useConfirmAction.js';
import { useApp } from '../../stores/app.js';
import type { CliVendor } from '@shared/types.js';

export type OnboardingContextValue = {
  stepIndex: number;
  step: StepId;
  go: (i: number) => void;
  next: () => void;
  back: () => void;
  entered: boolean;
  // shared domain state
  checks: DoctorCheck[];
  clis: CliDescriptor[];
  checking: boolean;
  recheck: () => Promise<void>;
  blockingCount: number;
  canLeaveDoctor: boolean;
  doctorHint: string;
  defaultCli: CliVendor;
  defaultCliLabel: string;
  pickCli: (v: CliVendor) => Promise<void>;
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
  const { projects, settings, refreshAll, patchSettings, selectProject, selectedProjectId } =
    useApp();
  const [checks, setChecks] = useState<DoctorCheck[]>([]);
  const [clis, setClis] = useState<CliDescriptor[]>([]);
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

  const step: StepId = STEPS[stepIndex]!.id;

  const blocking = useMemo(() => checks.filter((c) => !c.ok && c.blocking), [checks]);
  const defaultCli = (settings?.defaultCli ?? 'droid') as CliVendor;
  const defaultCliLabel = clis.find((c) => c.id === defaultCli)?.label ?? defaultCli;
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
    void Promise.all([api.doctor.run(), api.catalog.clis()]).then(([nextChecks, nextClis]) => {
      setChecks(nextChecks);
      setClis(nextClis);
      setChecking(false);
    });
  }, [settings?.engineerName]);

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
  }, [step]);

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
  const pickCli = async (vendor: CliVendor): Promise<void> => {
    setError('');
    try {
      const issues = await patchSettings({ defaultCli: vendor });
      if (issues.length) setError(issues.join(' '));
    } catch (e) {
      setError((e as Error).message);
    }
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

  const removeProject = useConfirmAction(
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
    clis,
    checking,
    recheck,
    blockingCount: blocking.length,
    canLeaveDoctor,
    doctorHint,
    defaultCli,
    defaultCliLabel,
    pickCli,
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
    removeProject,
    commitProjectRename,
    canEnterProject,
    projectBlockingHint,
    finish,
    onDone,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
