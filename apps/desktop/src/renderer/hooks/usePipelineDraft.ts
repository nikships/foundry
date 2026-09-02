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
  newPipelineDraft,
  pipelineFlowEquals,
} from '../view-models/pipeline-view.js';
import { safeGetItem, safeSetItem } from '../utils/local-store.js';

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

/** Load a pipeline into a fresh draft, preferring the operator's local canvas. */
function draftFrom(pipeline: PipelineDef | null): PipelineDef | null {
  return pipeline ? withLocalCanvas(structuredClone(pipeline)) : null;
}

function canvasForPhases(phases: PhaseDef[], canvas: PipelineCanvas | undefined): PipelineCanvas {
  const nodes = { ...canvas?.nodes };
  phases.forEach((phase, index) => {
    nodes[phase.name] ??= defaultCanvasPosition(index);
  });
  return { ...canvas, nodes };
}

function formatIssues(issues: ValidationIssue[]): string {
  return issues.map((issue) => issue.message).join(' ');
}

function errorMessage(err: unknown, fallback = ''): string {
  const message = err instanceof Error ? err.message : String(err);
  return message || fallback;
}

/** Rename or drop a node in the canvas map, leaving the canvas alone otherwise. */
function renameCanvasNode(
  canvas: PipelineCanvas | undefined,
  from: string | undefined,
  to: string | null,
): PipelineCanvas | undefined {
  const nodes = canvas?.nodes;
  if (!from || !nodes?.[from]) return canvas;
  const entries = Object.entries(nodes)
    .filter(([name]) => to !== null || name !== from)
    .map(([name, at]) => [name === from && to !== null ? to : name, at] as const);
  return { ...canvas, nodes: Object.fromEntries(entries) };
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
  actionError: string;
  staleBuiltins: Set<string>;
  setActivePhase: (phaseIndex: number | null) => void;
  setDraft: (next: PipelineDef | null) => void;
  selectPipeline: (id: string) => void;
  createPipeline: () => Promise<boolean>;
  duplicate: () => Promise<boolean>;
  remove: () => Promise<void>;
  resetToShipped: () => Promise<void>;
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
  const [actionError, setActionError] = useState('');
  const [staleBuiltins, setStaleBuiltins] = useState<Set<string>>(new Set());

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<PipelineDef | null>(null);
  const preserveSelectionRef = useRef<{ id: string; phase: number | null } | null>(null);

  const selected = useMemo(
    () =>
      selectedId ? (pipelines.find((p) => p.id === selectedId) ?? null) : (pipelines[0] ?? null),
    [pipelines, selectedId],
  );

  // Synchronize selectedId if pipelines change or if initially unset.
  // A just-created / duplicated id must not snap back to pipelines[0] while
  // refreshAll's list is still catching up.
  useEffect(() => {
    const pendingId = preserveSelectionRef.current?.id;
    if (pendingId) {
      if (selectedId !== pendingId && pipelines.some((p) => p.id === pendingId)) {
        setSelectedId(pendingId);
      }
      return;
    }
    if (selectedId && pipelines.some((p) => p.id === selectedId)) return;
    if (pipelines.length > 0) setSelectedId(pipelines[0].id);
  }, [pipelines, selectedId]);

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

  // Initialize or reset draft when selected pipeline changes.
  // Create/duplicate install a local draft first; keep it (and the starter
  // phase) until the refreshed list actually contains that id.
  const prevSelectedIdRef = useRef<string | null>(null);
  useEffect(() => {
    const currentId = selected?.id ?? null;
    const preserved = preserveSelectionRef.current;
    if (preserved && selectedId === preserved.id && currentId !== preserved.id) {
      return;
    }
    if (currentId === prevSelectedIdRef.current) return;
    prevSelectedIdRef.current = currentId;
    const restoredPhase = preserved?.id === currentId ? preserved.phase : null;
    if (preserved?.id === currentId) preserveSelectionRef.current = null;
    setDraft(draftFrom(selected));
    setActivePhase(restoredPhase);
  }, [selected, selectedId]);

  const commandNames = useMemo(
    () => project?.commands.map((c) => c.name) ?? [],
    [project?.commands],
  );
  const agents = useMemo(() => appAgents.map((r) => r.name), [appAgents]);
  const preferredAgent = useMemo(
    () => (agents.includes('builder') ? 'builder' : (agents[0] ?? 'builder')),
    [agents],
  );

  useEffect(() => {
    let cancelled = false;
    void api.pipelines.staleBuiltins(projectId || undefined).then((ids) => {
      if (!cancelled) setStaleBuiltins(new Set(ids));
    });
    return () => {
      cancelled = true;
    };
  }, [pipelines, projectId]);

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
    async (toSave: PipelineDef): Promise<boolean> => {
      setSaving(true);
      try {
        const result = await api.pipelines.save(plain(toSave), projectId || undefined);
        if (!result.ok) {
          setIssues(result.issues);
          setActionError(formatIssues(result.issues) || 'Could not save this pipeline.');
          return false;
        }
        setActionError('');
        setSavedAt(formatClock(new Date()));
        await refreshAll();
        return true;
      } catch (err) {
        setActionError(errorMessage(err, 'Could not save this pipeline.'));
        console.error('Failed to save pipeline draft:', err);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [projectId, refreshAll],
  );

  const clearSaveTimer = useCallback((): void => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
  }, []);

  /** Drop a queued save outright — used before a delete or a reset. */
  const cancelPendingSave = useCallback((): void => {
    clearSaveTimer();
    pendingSaveRef.current = null;
  }, [clearSaveTimer]);

  // Debounced auto-save
  const scheduleSave = useCallback(
    (next: PipelineDef): void => {
      pendingSaveRef.current = next;
      setSaving(true);
      clearSaveTimer();
      saveTimerRef.current = setTimeout(() => {
        const pending = pendingSaveRef.current;
        if (!pending) return;
        pendingSaveRef.current = null;
        void commitSave(pending);
      }, 600);
    },
    [clearSaveTimer, commitSave],
  );

  // Flush any pending save before unmounting or switching
  const flushSave = useCallback(async (): Promise<void> => {
    clearSaveTimer();
    const pending = pendingSaveRef.current;
    if (!pending) return;
    pendingSaveRef.current = null;
    await commitSave(pending);
  }, [clearSaveTimer, commitSave]);

  useEffect(() => clearSaveTimer, [clearSaveTimer]);

  const updateDraft = useCallback(
    (patch: Partial<PipelineDef>): void => {
      if (!draft) return;
      const { next, needsSave } = applyPipelineDraftPatch(draft, patch);
      setDraft(next);
      if (next.canvas && next.canvas !== draft.canvas) persistCanvas(next.id, next.canvas);
      // A pending flow save should pick up the latest presentation, but
      // viewport / card placement alone must not start one.
      if (pendingSaveRef.current) pendingSaveRef.current = next;
      if (needsSave) {
        setActionError('');
        scheduleSave(next);
      }
    },
    [draft, scheduleSave],
  );

  const selectPipeline = useCallback(
    async (id: string): Promise<void> => {
      if (id === selectedId) return;
      setActionError('');
      await flushSave();
      setSelectedId(id);
      safeSetItem(STORAGE_KEY, id);
    },
    [flushSave, selectedId],
  );

  /** Install a freshly created / duplicated pipeline as the live draft. */
  const adoptPipeline = useCallback((pipeline: PipelineDef, phase: number | null): void => {
    preserveSelectionRef.current = { id: pipeline.id, phase };
    setSelectedId(pipeline.id);
    setDraft(draftFrom(pipeline));
    setIssues([]);
    setActivePhase(phase);
  }, []);

  const createPipeline = useCallback(async (): Promise<boolean> => {
    setActionError('');
    await flushSave();
    const fresh = newPipelineDraft({ existing: pipelines, preferredAgent });
    try {
      const result = await api.pipelines.save(plain(fresh), projectId || undefined);
      if (!result.ok) {
        setActionError(formatIssues(result.issues) || 'Could not create that pipeline.');
        return false;
      }
      await refreshAll();
      persistCanvas(fresh.id, fresh.canvas);
      adoptPipeline(fresh, 0);
      return true;
    } catch (err) {
      setActionError(errorMessage(err, 'Could not create that pipeline.'));
      return false;
    }
  }, [adoptPipeline, flushSave, pipelines, preferredAgent, projectId, refreshAll]);

  const duplicate = useCallback(async (): Promise<boolean> => {
    if (!draft) return false;
    setActionError('');
    await flushSave();
    try {
      const copy = await api.pipelines.duplicate(draft.id, projectId || undefined);
      if (!copy) {
        setActionError('Could not duplicate that pipeline.');
        return false;
      }
      await refreshAll();
      adoptPipeline(copy, null);
      return true;
    } catch (err) {
      setActionError(errorMessage(err, 'Could not duplicate that pipeline.'));
      return false;
    }
  }, [adoptPipeline, draft, flushSave, projectId, refreshAll]);

  const remove = useCallback(async (): Promise<void> => {
    if (!draft || pipelines.length <= 1) return;
    cancelPendingSave();
    await api.pipelines.remove(draft.id, projectId || undefined);
    const nextList = pipelines.filter((p) => p.id !== draft.id);
    await refreshAll();
    if (nextList.length > 0) setSelectedId(nextList[0].id);
  }, [cancelPendingSave, draft, pipelines, projectId, refreshAll]);

  const resetToShipped = useCallback(async (): Promise<void> => {
    if (!draft?.builtin) return;
    cancelPendingSave();
    setSaving(false);
    setActionError('');
    try {
      const next = await api.pipelines.reset(draft.id, projectId || undefined);
      const reset = next.find((pipeline) => pipeline.id === draft.id);
      if (reset) setDraft(draftFrom(reset));
      setStaleBuiltins((current) => {
        const updated = new Set(current);
        updated.delete(draft.id);
        return updated;
      });
      await refreshAll();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }, [cancelPendingSave, draft, projectId, refreshAll]);

  const updatePhase = useCallback(
    (index: number, patch: Partial<PhaseDef>): void => {
      if (!draft) return;
      const phases = draft.phases.map((phase, i) => (i === index ? { ...phase, ...patch } : phase));
      const previousName = draft.phases[index]?.name;
      const nextName = phases[index]?.name ?? null;
      const canvas =
        nextName && nextName !== previousName
          ? renameCanvasNode(draft.canvas, previousName, nextName)
          : draft.canvas;
      updateDraft({ phases, canvas });
    },
    [draft, updateDraft],
  );

  const insertPhase = useCallback(
    (kind: PhaseKind, at?: number): number => {
      if (!draft) return 0;
      const taken = new Set(draft.phases.map((p) => p.name));
      const phase = blankPhase(kind, taken, { preferredAgent, commandNames });
      const index =
        at != null ? Math.min(Math.max(0, at), draft.phases.length) : draft.phases.length;
      const phases = [...draft.phases];
      phases.splice(index, 0, phase);
      updateDraft({ phases, canvas: canvasForPhases(phases, draft.canvas) });
      setActivePhase(index);
      return index;
    },
    [commandNames, draft, preferredAgent, updateDraft],
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
      updateDraft({ phases, canvas: renameCanvasNode(draft.canvas, removedName, null) });
      setActivePhase((cur) => {
        if (cur === null || cur === index) return null;
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
      const cur = draft.acceptance;
      const phase =
        'phase' in cur ? cur.phase : (draft.phases[draft.phases.length - 1]?.name ?? '');
      let acceptance: Acceptance;
      if (kind === 'phase_flag') {
        acceptance = { kind, phase, flag: cur.kind === 'phase_flag' ? cur.flag : 'approved' };
      } else if (kind === 'envelope_status') {
        acceptance = { kind, phase };
      } else {
        acceptance = { kind };
      }
      updateDraft({ acceptance });
    },
    [draft, updateDraft],
  );

  const setAcceptancePhase = useCallback(
    (phase: string): void => {
      const cur = draft?.acceptance;
      if (cur?.kind === 'envelope_status' || cur?.kind === 'phase_flag') {
        updateDraft({ acceptance: { ...cur, phase } });
      }
    },
    [draft, updateDraft],
  );

  const setAcceptanceFlag = useCallback(
    (flag: string): void => {
      const cur = draft?.acceptance;
      // The setter takes a plain string so the screen's picker does not have to
      // carry the union; only the two legal flags are ever offered.
      if (cur?.kind === 'phase_flag') {
        updateDraft({ acceptance: { ...cur, flag: flag as typeof cur.flag } });
      }
    },
    [draft, updateDraft],
  );

  const setIsolation = useCallback(
    (isolation: boolean): void => updateDraft({ isolation }),
    [updateDraft],
  );

  const preview = useCallback(async (): Promise<void> => {
    if (!draft) return;
    setDryRunError(null);
    try {
      setDryRun(await api.pipelines.dryRun(draft.id, projectId, 'Implement the requested task'));
    } catch (err) {
      setDryRunError(errorMessage(err));
    }
  }, [draft, projectId]);

  const closeDryRun = useCallback((): void => {
    setDryRun(null);
    setDryRunError(null);
  }, []);

  const isDirty = useMemo(
    () => (draft && selected ? !pipelineFlowEquals(draft, selected) : false),
    [draft, selected],
  );

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
    actionError,
    staleBuiltins,
    setActivePhase,
    setDraft,
    selectPipeline,
    createPipeline,
    duplicate,
    remove,
    resetToShipped,
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
