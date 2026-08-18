/**
 * Draft state, debounced auto-save, live validation, and mutations for the
 * Pipelines workbench.
 *
 * Pipelines in Foundry are held in the app store, but active editing happens on
 * a local draft. Edits are debounced and saved via IPC (`api.pipelines.save`),
 * validated live against project commands and roster, and flushed before
 * pipeline switches. Canvas pan, zoom, and card placement are presentation:
 * they update the draft and a local cache, but they do not write the pipeline.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Acceptance,
  DryRunPrompt,
  PhaseDef,
  PhaseKind,
  PipelineCanvas,
  PipelineDef,
  ValidationIssue,
} from '@shared/types.js';
import { api, plain } from '../api.js';
import { useApp } from '../stores/app.js';
import {
  applyPipelineDraftPatch,
  blankPhase,
  defaultCanvasPosition,
  formatClock,
  pipelineFlowEquals,
} from '../pipeline-view.js';
import { safeGetItem, safeSetItem } from '../local-store.js';

const STORAGE_KEY = 'foundry.pipeline';
const canvasStorageKey = (id: string): string => `foundry.pipeline.canvas.${id}`;

function readStoredCanvas(id: string): PipelineCanvas | undefined {
  const raw = safeGetItem(canvasStorageKey(id));
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as PipelineCanvas;
  } catch {
    return undefined;
  }
}

function persistCanvas(id: string, canvas: PipelineCanvas | undefined): void {
  if (!canvas) return;
  safeSetItem(canvasStorageKey(id), JSON.stringify(canvas));
}

function withLocalCanvas(pipeline: PipelineDef): PipelineDef {
  const stored = readStoredCanvas(pipeline.id);
  return stored ? { ...pipeline, canvas: stored } : pipeline;
}

function clonePipeline(p: PipelineDef): PipelineDef {
  return {
    ...p,
    acceptance: { ...p.acceptance },
    phases: p.phases.map((phase) => ({
      ...phase,
      prompt: phase.prompt
        ? { ...phase.prompt, inputs: phase.prompt.inputs ? [...phase.prompt.inputs] : [] }
        : undefined,
      command: phase.command
        ? 'argv' in phase.command
          ? { ...phase.command, argv: [...phase.command.argv] }
          : { ...phase.command }
        : undefined,
      gates: phase.gates ? [...phase.gates] : undefined,
    })),
    canvas: p.canvas
      ? {
          nodes: p.canvas.nodes
            ? Object.fromEntries(
                Object.entries(p.canvas.nodes).map(([name, point]) => [name, { ...point }]),
              )
            : undefined,
          viewport: p.canvas.viewport ? { ...p.canvas.viewport } : undefined,
        }
      : undefined,
  };
}

function canvasForPhases(phases: PhaseDef[], canvas: PipelineCanvas | undefined): PipelineCanvas {
  const nodes = { ...canvas?.nodes };
  phases.forEach((phase, index) => {
    nodes[phase.name] ??= defaultCanvasPosition(index);
  });
  return { ...canvas, nodes };
}

function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

export function usePipelineDraft(deepLink?: {
  /** Deep link (e.g. a Smith approve): select this pipeline id once it resolves. */
  openPipeline?: string;
  /** Bumped per deep-link so re-selecting the same pipeline re-fires the effect. */
  openNonce?: number;
}): {
  pipelines: PipelineDef[];
  selected: PipelineDef | null;
  selectedId: string;
  draft: PipelineDef | null;
  agents: string[];
  commandNames: string[];
  projectId: string;
  issues: ValidationIssue[];
  activePhase: number | null;
  saving: boolean;
  savedAt: string;
  dryRun: DryRunPrompt[] | null;
  dryRunError: string | null;
  isDirty: boolean;
  setActivePhase: (phaseIndex: number | null) => void;
  setDraft: (next: PipelineDef | null) => void;
  selectPipeline: (id: string) => void;
  createPipeline: () => Promise<void>;
  duplicate: () => Promise<void>;
  remove: () => Promise<void>;
  preview: () => Promise<void>;
  closeDryRun: () => void;
  insertPhase: (kind: PhaseKind, at?: number) => number;
  movePhase: (index: number, delta: number) => void;
  removePhase: (index: number) => void;
  updatePhase: (index: number, patch: Partial<PhaseDef>) => void;
  updateDraft: (patch: Partial<PipelineDef>) => void;
  updateCanvas: (canvas: PipelineCanvas) => void;
  setAcceptanceKind: (kind: Acceptance['kind']) => void;
  setAcceptancePhase: (phaseName: string) => void;
  setAcceptanceFlag: (flag: string) => void;
  setIsolation: (isolation: boolean) => void;
} {
  const { pipelines, agents: appAgents, project, projectId, refreshAll } = useApp();
  const [selectedId, setSelectedId] = useState(() => safeGetItem(STORAGE_KEY) ?? '');
  const [draft, setDraft] = useState<PipelineDef | null>(null);
  const [activePhase, setActivePhase] = useState<number | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(() => formatClock(new Date()));
  const [dryRun, setDryRun] = useState<DryRunPrompt[] | null>(null);
  const [dryRunError, setDryRunError] = useState<string | null>(null);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<PipelineDef | null>(null);

  const selected = useMemo(
    () => pipelines.find((p) => p.id === selectedId) ?? pipelines[0] ?? null,
    [pipelines, selectedId],
  );

  // Synchronize selectedId if pipelines change or if initially unset
  useEffect(() => {
    if (!selected) {
      if (pipelines.length > 0) {
        setSelectedId(pipelines[0].id);
      }
    } else if (selected.id !== selectedId) {
      setSelectedId(selected.id);
    }
  }, [pipelines, selected, selectedId]);

  // Persist selectedId to localStorage
  useEffect(() => {
    if (selectedId) safeSetItem(STORAGE_KEY, selectedId);
  }, [selectedId]);

  // Deep link from a Smith approve: select the saved pipeline once it appears.
  // `openNonce` re-fires the effect for a repeat approval of the same pipeline.
  const openPipeline = deepLink?.openPipeline;
  const openNonce = deepLink?.openNonce ?? 0;
  useEffect(() => {
    if (openPipeline && pipelines.some((p) => p.id === openPipeline)) {
      setSelectedId(openPipeline);
    }
  }, [openPipeline, openNonce, pipelines]);

  // Initialize or reset draft when selected pipeline changes
  const prevSelectedIdRef = useRef<string | null>(null);
  useEffect(() => {
    const currentId = selected?.id ?? null;
    if (currentId !== prevSelectedIdRef.current) {
      prevSelectedIdRef.current = currentId;
      setDraft(selected ? withLocalCanvas(clonePipeline(selected)) : null);
      setActivePhase(null);
    }
  }, [selected]);

  const commandNames = useMemo(
    () => project?.commands.map((c) => c.name) ?? [],
    [project?.commands],
  );
  const agents = useMemo(() => appAgents.map((r) => r.name), [appAgents]);

  // Live validation on draft changes
  useEffect(() => {
    if (!draft) {
      setIssues([]);
      return;
    }
    let cancelled = false;
    void api.pipelines.validate(draft, projectId || undefined).then((result) => {
      if (!cancelled) setIssues(result);
    });
    return () => {
      cancelled = true;
    };
  }, [draft, projectId, commandNames, agents]);

  // Execute an immediate save
  const commitSave = useCallback(
    async (toSave: PipelineDef): Promise<void> => {
      setSaving(true);
      try {
        await api.pipelines.save(plain(toSave), projectId || undefined);
        setSavedAt(formatClock(new Date()));
        await refreshAll();
      } catch (err) {
        console.error('Failed to save pipeline draft:', err);
      } finally {
        setSaving(false);
      }
    },
    [projectId, refreshAll],
  );

  // Debounced auto-save
  const scheduleSave = useCallback(
    (next: PipelineDef): void => {
      pendingSaveRef.current = next;
      setSaving(true);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        if (pendingSaveRef.current) {
          void commitSave(pendingSaveRef.current);
          pendingSaveRef.current = null;
        }
      }, 600);
    },
    [commitSave],
  );

  // Flush any pending save before unmounting or switching
  const flushSave = useCallback(async (): Promise<void> => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (pendingSaveRef.current) {
      const p = pendingSaveRef.current;
      pendingSaveRef.current = null;
      await commitSave(p);
    }
  }, [commitSave]);

  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    },
    [],
  );

  const updateDraft = useCallback(
    (patch: Partial<PipelineDef>): void => {
      if (!draft) return;
      const { next, needsSave } = applyPipelineDraftPatch(draft, patch);
      setDraft(next);
      if (next.canvas && next.canvas !== draft.canvas) persistCanvas(next.id, next.canvas);
      // A pending flow save should pick up the latest presentation, but
      // viewport / card placement alone must not start one.
      if (pendingSaveRef.current) pendingSaveRef.current = next;
      if (needsSave) scheduleSave(next);
    },
    [draft, scheduleSave],
  );

  const selectPipeline = useCallback(
    async (id: string): Promise<void> => {
      if (id === selectedId) return;
      await flushSave();
      setSelectedId(id);
      safeSetItem(STORAGE_KEY, id);
    },
    [flushSave, selectedId],
  );

  const createPipeline = useCallback(async (): Promise<void> => {
    await flushSave();
    const id = `pipeline_${Date.now()}`;
    const taken = new Set(pipelines.map((p) => p.name));
    const fresh: PipelineDef = {
      id,
      name: uniqueName('New Pipeline', taken),
      description: '',
      acceptance: { kind: 'last_phase_pass' },
      phases: [],
      isolation: true,
    };
    await api.pipelines.save(plain(fresh), projectId || undefined);
    await refreshAll();
    setSelectedId(id);
    setDraft(fresh);
    setActivePhase(null);
  }, [flushSave, pipelines, projectId, refreshAll]);

  const duplicate = useCallback(async (): Promise<void> => {
    if (!draft) return;
    await flushSave();
    const id = `pipeline_${Date.now()}`;
    const copy: PipelineDef = {
      ...clonePipeline(draft),
      id,
      name: `${draft.name} (copy)`,
      builtin: false,
    };
    await api.pipelines.save(plain(copy), projectId || undefined);
    await refreshAll();
    setSelectedId(id);
    setDraft(copy);
    setActivePhase(null);
  }, [draft, flushSave, projectId, refreshAll]);

  const remove = useCallback(async (): Promise<void> => {
    if (!draft || pipelines.length <= 1) return;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      pendingSaveRef.current = null;
    }
    await api.pipelines.remove(draft.id, projectId || undefined);
    const nextList = pipelines.filter((p) => p.id !== draft.id);
    await refreshAll();
    if (nextList.length > 0) {
      setSelectedId(nextList[0].id);
    }
  }, [draft, pipelines, projectId, refreshAll]);

  const updatePhase = useCallback(
    (index: number, patch: Partial<PhaseDef>): void => {
      if (!draft) return;
      const phases = draft.phases.map((phase, i) => (i === index ? { ...phase, ...patch } : phase));
      const previousName = draft.phases[index]?.name;
      const nextName = phases[index]?.name;
      const nodes = draft.canvas?.nodes;
      const canvas =
        previousName && nextName && previousName !== nextName && nodes?.[previousName]
          ? {
              ...draft.canvas,
              nodes: Object.fromEntries(
                Object.entries(nodes).map(([name, point]) => [
                  name === previousName ? nextName : name,
                  point,
                ]),
              ),
            }
          : draft.canvas;
      updateDraft({ phases, canvas });
    },
    [draft, updateDraft],
  );

  const insertPhase = useCallback(
    (kind: PhaseKind, at?: number): number => {
      if (!draft) return 0;
      const taken = new Set(draft.phases.map((p) => p.name));
      const phase = blankPhase(kind, taken);
      const index =
        at != null ? Math.min(Math.max(0, at), draft.phases.length) : draft.phases.length;
      const phases = [...draft.phases];
      phases.splice(index, 0, phase);
      updateDraft({ phases, canvas: canvasForPhases(phases, draft.canvas) });
      setActivePhase(index);
      return index;
    },
    [draft, updateDraft],
  );

  const movePhase = useCallback(
    (index: number, delta: number): void => {
      if (!draft) return;
      const target = index + delta;
      if (target < 0 || target >= draft.phases.length) return;
      const phases = [...draft.phases];
      const [item] = phases.splice(index, 1);
      phases.splice(target, 0, item);
      updateDraft({ phases, canvas: canvasForPhases(draft.phases, draft.canvas) });
      setActivePhase((cur) => (cur === index ? target : cur));
    },
    [draft, updateDraft],
  );

  const removePhase = useCallback(
    (index: number): void => {
      if (!draft) return;
      const removedName = draft.phases[index]?.name;
      const phases = draft.phases.filter((_, i) => i !== index);
      const nodes = draft.canvas?.nodes;
      const canvas =
        removedName && nodes?.[removedName]
          ? {
              ...draft.canvas,
              nodes: Object.fromEntries(
                Object.entries(nodes).filter(([name]) => name !== removedName),
              ),
            }
          : draft.canvas;
      updateDraft({ phases, canvas });
      setActivePhase((cur) => {
        if (cur === null) return null;
        if (cur === index) return null;
        return cur > index ? cur - 1 : cur;
      });
    },
    [draft, updateDraft],
  );

  const updateCanvas = useCallback(
    (canvas: PipelineCanvas): void => updateDraft({ canvas }),
    [updateDraft],
  );

  const setAcceptanceKind = useCallback(
    (kind: Acceptance['kind']): void => {
      if (!draft) return;
      const fallback = draft.phases[draft.phases.length - 1]?.name ?? '';
      const cur = draft.acceptance;
      const phase = 'phase' in cur ? cur.phase : fallback;
      const acceptance: Acceptance =
        kind === 'phase_flag'
          ? { kind, phase, flag: cur.kind === 'phase_flag' ? cur.flag : 'approved' }
          : kind === 'envelope_status'
            ? { kind, phase }
            : { kind };
      updateDraft({ acceptance });
    },
    [draft, updateDraft],
  );

  const setAcceptancePhase = useCallback(
    (phase: string): void => {
      if (!draft) return;
      const cur = draft.acceptance;
      if (cur.kind === 'envelope_status' || cur.kind === 'phase_flag') {
        updateDraft({ acceptance: { ...cur, phase } as Acceptance });
      }
    },
    [draft, updateDraft],
  );

  const setAcceptanceFlag = useCallback(
    (flag: string): void => {
      if (!draft) return;
      const cur = draft.acceptance;
      if (cur.kind === 'phase_flag') {
        updateDraft({ acceptance: { ...cur, flag } as Acceptance });
      }
    },
    [draft, updateDraft],
  );

  const setIsolation = useCallback(
    (isolation: boolean): void => {
      updateDraft({ isolation });
    },
    [updateDraft],
  );

  const preview = useCallback(async (): Promise<void> => {
    if (!draft) return;
    setDryRunError(null);
    try {
      const res = await api.pipelines.dryRun(draft.id, projectId, 'Implement the requested task');
      setDryRun(res);
    } catch (err) {
      setDryRunError(err instanceof Error ? err.message : String(err));
    }
  }, [draft, projectId]);

  const closeDryRun = useCallback((): void => {
    setDryRun(null);
    setDryRunError(null);
  }, []);

  const isDirty = useMemo(() => {
    if (!draft || !selected) return false;
    return !pipelineFlowEquals(draft, selected);
  }, [draft, selected]);

  return {
    pipelines,
    selected,
    selectedId,
    draft,
    agents,
    commandNames,
    projectId,
    issues,
    activePhase,
    saving,
    savedAt,
    dryRun,
    dryRunError,
    isDirty,
    setActivePhase,
    setDraft,
    selectPipeline,
    createPipeline,
    duplicate,
    remove,
    preview,
    closeDryRun,
    insertPhase,
    movePhase,
    removePhase,
    updatePhase,
    updateDraft,
    updateCanvas,
    setAcceptanceKind,
    setAcceptancePhase,
    setAcceptanceFlag,
    setIsolation,
  };
}
