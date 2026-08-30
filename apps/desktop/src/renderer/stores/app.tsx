/**
 * App-wide state: settings, projects, roster, pipelines, and the selected
 * project. React Context + hooks.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { AgentDef, AppSettings, EnvelopeDef, PipelineDef, ProjectDef } from '@shared/types.js';
import { api } from '../api.js';
import { safeGetItem, safeSetItem } from '../utils/local-store.js';
import { resolveSmithProjectId } from '../view-models/smith-scope.js';

export interface AppState {
  settings: AppSettings | null;
  projects: ProjectDef[];
  agents: AgentDef[];
  pipelines: PipelineDef[];
  envelopes: EnvelopeDef[];
  selectedProjectId: string;
  /** Null selects Smith's global “All projects” conversation. */
  smithProjectId: string | null;
  ready: boolean;
}

export interface AppContextValue extends AppState {
  project: ProjectDef | null;
  projectId: string;
  selectProject: (id: string) => void;
  selectSmithProject: (id: string | null) => void;
  refreshScoped: () => Promise<void>;
  refreshAll: () => Promise<void>;
  patchSettings: (patch: Partial<AppSettings>) => Promise<string[]>;
  agentByName: (name: string) => AgentDef | null;
  pipelineById: (id: string) => PipelineDef | null;
  agentColor: (name: string | null) => string;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}

export function agentColorFor(agents: AgentDef[], name: string | null): string {
  if (!name) return 'var(--text-faint)';
  return agents.find((a) => a.name === name)?.color ?? 'var(--accent)';
}

async function loadScoped(projectId: string | undefined): Promise<[AgentDef[], PipelineDef[]]> {
  return Promise.all([api.roster.list(projectId), api.pipelines.list(projectId)]);
}

const PROJECT_KEY = 'foundry.project';
const SMITH_PROJECT_KEY = 'foundry.smithProject';
/** Stored stand-in for Smith's “All projects” scope, which is a null id. */
const SMITH_ALL_PROJECTS = '__all__';

export function AppProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [projects, setProjects] = useState<ProjectDef[]>([]);
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [pipelines, setPipelines] = useState<PipelineDef[]>([]);
  const [envelopes, setEnvelopes] = useState<EnvelopeDef[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>(
    () => safeGetItem(PROJECT_KEY) ?? '',
  );
  const smithPreferenceRef = useRef(safeGetItem(SMITH_PROJECT_KEY));
  const [smithProjectId, setSmithProjectId] = useState<string | null>(() => {
    const stored = smithPreferenceRef.current;
    if (stored === SMITH_ALL_PROJECTS) return null;
    return stored ?? safeGetItem(PROJECT_KEY);
  });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!settings) return;
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    root.style.colorScheme = settings.theme;
    root.dataset.themeReady = 'true';
  }, [settings]);

  const selectedProjectIdRef = useRef(selectedProjectId);
  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
  }, [selectedProjectId]);

  const project = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) ?? projects[0] ?? null,
    [projects, selectedProjectId],
  );
  const projectId = project?.id ?? '';

  const rememberSmithScope = useCallback((id: string | null): void => {
    smithPreferenceRef.current = id ?? SMITH_ALL_PROJECTS;
    safeSetItem(SMITH_PROJECT_KEY, smithPreferenceRef.current);
  }, []);

  const refreshScoped = useCallback(async (): Promise<void> => {
    const id = (project?.id ?? selectedProjectIdRef.current) || undefined;
    const [nextAgents, nextPipelines] = await loadScoped(id);
    setAgents(nextAgents);
    setPipelines(nextPipelines);
  }, [project?.id]);

  const refreshAll = useCallback(async (): Promise<void> => {
    const storedScope = selectedProjectIdRef.current || undefined;
    const [nextSettings, nextProjects, nextEnvelopes, scoped] = await Promise.all([
      api.settings.get(),
      api.projects.list(),
      api.envelopes.list(),
      loadScoped(storedScope),
    ]);
    const [nextAgents, nextPipelines] = scoped;
    setSettings(nextSettings);
    setProjects(nextProjects);
    setEnvelopes(nextEnvelopes);

    let scopeId = selectedProjectIdRef.current;
    if (!nextProjects.some((p) => p.id === scopeId)) {
      scopeId = nextProjects[0]?.id ?? '';
      setSelectedProjectId(scopeId);
      safeSetItem(PROJECT_KEY, scopeId);
      const [scopedAgents, scopedPipelines] = await loadScoped(scopeId || undefined);
      setAgents(scopedAgents);
      setPipelines(scopedPipelines);
    } else {
      setAgents(nextAgents);
      setPipelines(nextPipelines);
    }

    const smithScope = resolveSmithProjectId(
      nextProjects,
      scopeId,
      smithProjectId,
      smithPreferenceRef.current !== null,
    );
    if (smithScope !== smithProjectId) setSmithProjectId(smithScope);
    rememberSmithScope(smithScope);

    setReady(true);
  }, [smithProjectId, rememberSmithScope]);

  const selectProject = useCallback(
    (id: string): void => {
      setSelectedProjectId(id);
      safeSetItem(PROJECT_KEY, id);
      setSmithProjectId(id);
      rememberSmithScope(id);
    },
    [rememberSmithScope],
  );

  const selectSmithProject = useCallback(
    (id: string | null): void => {
      setSmithProjectId(id);
      rememberSmithScope(id);
    },
    [rememberSmithScope],
  );

  useEffect(() => {
    if (!ready) return;
    void refreshScoped();
  }, [selectedProjectId, ready, refreshScoped]);

  const patchSettings = useCallback(async (patch: Partial<AppSettings>): Promise<string[]> => {
    const result = await api.settings.patch(patch);
    if (result.ok && result.value) setSettings(result.value);
    return result.issues.map((i) => i.message);
  }, []);

  const agentByName = useCallback(
    (name: string): AgentDef | null => agents.find((a) => a.name === name) ?? null,
    [agents],
  );

  const pipelineById = useCallback(
    (id: string): PipelineDef | null => pipelines.find((p) => p.id === id) ?? null,
    [pipelines],
  );

  const agentColor = useCallback(
    (name: string | null): string => agentColorFor(agents, name),
    [agents],
  );

  useEffect(() => {
    void refreshAll();
    const offSettings = api.on('settings-changed', () => void refreshAll());
    return () => {
      offSettings();
    };
  }, [refreshAll]);

  const value = useMemo<AppContextValue>(
    () => ({
      settings,
      projects,
      agents,
      pipelines,
      envelopes,
      selectedProjectId,
      smithProjectId,
      ready,
      project,
      projectId,
      selectProject,
      selectSmithProject,
      refreshScoped,
      refreshAll,
      patchSettings,
      agentByName,
      pipelineById,
      agentColor,
    }),
    [
      settings,
      projects,
      agents,
      pipelines,
      envelopes,
      selectedProjectId,
      smithProjectId,
      ready,
      project,
      projectId,
      selectProject,
      selectSmithProject,
      refreshScoped,
      refreshAll,
      patchSettings,
      agentByName,
      pipelineById,
      agentColor,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
