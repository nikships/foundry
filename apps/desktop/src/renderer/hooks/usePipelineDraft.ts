/**
 * Everything the Pipelines screen does that is not drawing.
 *
 * Two redesign options render the same pipeline in very different shapes (a
 * vertical ladder, a gated stage board). Selection, the draft, live
 * validation, debounced auto-save, phase mutation and dry run are identical in
 * both and must stay identical — so they live here, and a screen is only a
 * presentation of this hook. A behaviour fixed here is fixed in both options;
 * a behaviour that drifts is a bug in one of them, not a design difference.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Acceptance,
  AgentDef,
  DryRunPrompt,
  PhaseDef,
  PipelineDef,
  ValidationIssue,
} from '@shared/types.js';
import { api, plain } from '../api.js';
import { useApp } from '../stores/app.js';
import { useConfirmAction } from './useConfirmAction.js';
import { useDebouncedSave } from './useDebouncedSave.js';

export interface PipelineDraftApi {
  /** Every pipeline in scope, for the switcher. */
  pipelines: PipelineDef[];
  /** The persisted record behind the draft, or null for an unsaved new one. */
  selected: PipelineDef | null;
  selectedId: string;
  /** The live, editable copy. Null when there is nothing to edit. */
  draft: PipelineDef | null;
  agents: AgentDef[];
  commandNames: string[];
  projectId: string;
  issues: ValidationIssue[];
  errors: ValidationIssue[];
  /** Index of the phase the inspector is showing; -1 when there are none. */
  activePhase: number;
  setActivePhase: (index: number) => void;
  dryRun: DryRunPrompt[] | null;
  dryRunError: string;
  closeDryRun: () => void;
  setDraft: (next: PipelineDef) => void;
  selectPipeline: (id: string) => void;
  createPipeline: () => Promise<void>;
  duplicate: () => Promise<void>;
  /** Confirms, then deletes. Resolves false when the operator backs out. */
  remove: () => Promise<boolean>;
  preview: () => Promise<void>;
  addPhase: (kind: PhaseDef['kind']) => void;
  /** Inserts at a position rather than appending; used by the stage board. */
  insertPhase: (kind: PhaseDef['kind'], at: number) => void;
  movePhase: (index: number, delta: number) => void;
  /** Moves a phase to an absolute index, keeping the rest in order. */
  reorderPhase: (from: number, to: number) => void;
  removePhase: (index: number) => void;
  updatePhase: (index: number, phase: PhaseDef) => void;
  setAcceptanceKind: (kind: Acceptance['kind']) => void;
  setAcceptancePhase: (phase: string) => void;
  setAcceptanceFlag: (flag: 'passed' | 'approved') => void;
  setIsolation: (isolation: boolean) => void;
  acceptancePhase: string | null;
}

/** A fresh phase of the requested kind, defaulted from the roster and project. */
export function newPhase(
  kind: PhaseDef['kind'],
  ordinal: number,
  agents: AgentDef[],
  commandNames: string[],
): PhaseDef {
  const base = { name: `phase_${ordinal}`, description: '' };
  if (kind === 'agent') {
    return {
      ...base,
      kind,
      agent: agents[0]?.name ?? '',
      envelope: agents[0]?.envelope ?? 'build',
      prompt: { template: 'user', inputs: ['request'] },
    } as PhaseDef;
  }
  if (kind === 'code') {
    return {
      ...base,
      kind,
      description: 'Run a project command and fail the phase if it exits non-zero.',
      command: commandNames[0] ? { ref: commandNames[0] } : { argv: ['echo', 'configure-me'] },
    } as PhaseDef;
  }
  return { ...base, kind, question: 'Approve this?' } as PhaseDef;
}

export function usePipelineDraft(): PipelineDraftApi {
  const { pipelines, project, projectId, agents, refreshScoped } = useApp();
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraftState] = useState<PipelineDef | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [activePhase, setActivePhase] = useState(0);
  const [dryRun, setDryRun] = useState<DryRunPrompt[] | null>(null);
  const [dryRunError, setDryRunError] = useState('');

  const selected = useMemo(
    () => pipelines.find((p) => p.id === selectedId) ?? null,
    [pipelines, selectedId],
  );
  const commandNames = useMemo(() => project?.commands.map((c) => c.name) ?? [], [project]);
  const errors = useMemo(() => issues.filter((i) => i.level === 'error'), [issues]);

  // Keep a valid selection when the list changes (initial load, add, remove,
  // project switch). Don't clobber a transient new pipeline that hasn't
  // appeared in the list yet.
  useEffect(() => {
    if (pipelines.some((p) => p.id === selectedId)) return;
    if (draft && draft.id === selectedId) return;
    setSelectedId(pipelines[0]?.id ?? '');
  }, [pipelines, selectedId, draft]);

  // Sync draft when the selected pipeline changes. Don't clobber an in-flight
  // edit that hasn't been persisted yet; only sync when the id changes.
  useEffect(() => {
    if (!selected) {
      if (draft && pipelines.some((p) => p.id === draft.id)) setDraftState(null);
      else if (!draft) setDraftState(null);
      return;
    }
    if (!draft || draft.id !== selected.id) {
      setDraftState(plain({ ...selected }));
      setActivePhase(0);
    }
  }, [selected, pipelines, draft]);

  // Live validation so errors are visible immediately.
  useEffect(() => {
    if (!draft) {
      setIssues([]);
      return;
    }
    let cancelled = false;
    void api.pipelines.validate(draft, projectId || undefined).then((next) => {
      if (!cancelled) setIssues(next);
    });
    return () => {
      cancelled = true;
    };
  }, [draft, projectId]);

  const pipelinesRef = useRef<PipelineDef[]>(pipelines);
  pipelinesRef.current = pipelines;
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  // Live auto-save: every valid edit is persisted shortly after typing stops.
  // Visual state is the single source of truth, no Save button. `flush` is
  // called on switch, `cancel` before a delete so a queued save cannot
  // re-create the pipeline.
  const { flush, cancel } = useDebouncedSave<PipelineDef>({
    value: draft,
    delay: 350,
    disabled: errors.length > 0,
    compare: (d) => pipelinesRef.current.find((p) => p.id === d.id) ?? null,
    save: (d) => api.pipelines.save(d, projectIdRef.current || undefined),
    onSuccess: async () => {
      await refreshScoped();
    },
    onIssues: setIssues,
    onError: (e) => setIssues([{ level: 'error', where: 'save', message: (e as Error).message }]),
  });

  const acceptancePhase = useMemo(() => {
    const a = draft?.acceptance;
    if (!a) return null;
    return 'phase' in a ? (a as { phase: string }).phase : null;
  }, [draft]);

  const setDraft = useCallback((next: PipelineDef): void => setDraftState(next), []);

  const patchPhases = useCallback((phases: PhaseDef[]): void => {
    setDraftState((current) => (current ? { ...current, phases } : current));
  }, []);

  const setAcceptanceKind = (kind: Acceptance['kind']): void => {
    if (!draft) return;
    const phase = acceptancePhase ?? draft.phases[draft.phases.length - 1]?.name ?? '';
    let next: Acceptance;
    if (kind === 'phase_flag') next = { kind, phase, flag: 'approved' };
    else if (kind === 'envelope_status') next = { kind, phase };
    else next = { kind } as Acceptance;
    setDraftState({ ...draft, acceptance: next });
  };
  const setAcceptancePhase = (phase: string): void => {
    if (!draft?.acceptance || !('phase' in draft.acceptance)) return;
    setDraftState({ ...draft, acceptance: { ...draft.acceptance, phase } });
  };
  const setAcceptanceFlag = (flag: 'passed' | 'approved'): void => {
    if (draft?.acceptance?.kind !== 'phase_flag') return;
    setDraftState({ ...draft, acceptance: { ...draft.acceptance, flag } });
  };
  const setIsolation = (isolation: boolean): void => {
    if (!draft) return;
    setDraftState({ ...draft, isolation });
  };

  const insertPhase = (kind: PhaseDef['kind'], at: number): void => {
    if (!draft) return;
    const phase = newPhase(kind, draft.phases.length + 1, agents, commandNames);
    const phases = [...draft.phases];
    const index = Math.max(0, Math.min(at, phases.length));
    phases.splice(index, 0, phase);
    patchPhases(phases);
    setActivePhase(index);
  };
  const addPhase = (kind: PhaseDef['kind']): void => {
    if (!draft) return;
    insertPhase(kind, draft.phases.length);
  };
  const movePhase = (index: number, delta: number): void => {
    if (!draft) return;
    const target = index + delta;
    if (target < 0 || target >= draft.phases.length) return;
    const phases = [...draft.phases];
    [phases[index], phases[target]] = [phases[target]!, phases[index]!];
    patchPhases(phases);
    setActivePhase(target);
  };
  const reorderPhase = (from: number, to: number): void => {
    if (!draft) return;
    const phases = [...draft.phases];
    if (from < 0 || from >= phases.length) return;
    const target = Math.max(0, Math.min(to, phases.length - 1));
    if (target === from) return;
    const [moved] = phases.splice(from, 1);
    phases.splice(target, 0, moved!);
    patchPhases(phases);
    setActivePhase(target);
  };
  const removePhase = (index: number): void => {
    if (!draft) return;
    const phases = [...draft.phases];
    phases.splice(index, 1);
    patchPhases(phases);
    setActivePhase(Math.max(0, index - 1));
  };
  const updatePhase = (index: number, phase: PhaseDef): void => {
    if (!draft) return;
    patchPhases(draft.phases.map((p, i) => (i === index ? phase : p)));
  };

  const createPipeline = async (): Promise<void> => {
    const id = `pipeline-${Date.now().toString(36)}`;
    const starter = agents[0] ? newPhase('agent', 1, agents, commandNames) : null;
    const fresh: PipelineDef = {
      id,
      name: 'New pipeline',
      description: 'Say what this pipeline is for and when to reach for it.',
      acceptance: { kind: 'all_phases_pass' },
      phases: starter
        ? [{ ...starter, description: 'Describe what this phase does and why.' }]
        : [],
    };
    setSelectedId(id);
    setDraftState(fresh);
    setActivePhase(0);
    setIssues([]);
    try {
      const result = await api.pipelines.save(fresh, projectId || undefined);
      if (result.ok) await refreshScoped();
      else setIssues(result.issues);
    } catch (e) {
      setIssues([{ level: 'error', where: 'save', message: (e as Error).message }]);
    }
  };

  const selectPipeline = (id: string): void => {
    if (id === selectedId) return;
    void flush();
    setSelectedId(id);
  };

  const duplicate = async (): Promise<void> => {
    if (!selected) return;
    const copy = await api.pipelines.duplicate(selected.id, projectId || undefined);
    await refreshScoped();
    if (copy) setSelectedId(copy.id);
  };

  const remove = useConfirmAction(
    () => `Delete pipeline "${selected?.name}"? This cannot be undone.`,
    async (): Promise<void> => {
      if (!selected) return;
      // A queued save for this pipeline would re-create it moments after the delete.
      cancel();
      await api.pipelines.remove(selected.id, projectId || undefined);
      await refreshScoped();
    },
    { title: 'Delete Pipeline', confirmLabel: 'Delete', variant: 'danger' },
  );

  const preview = async (): Promise<void> => {
    if (!draft || !projectId) return;
    setDryRunError('');
    if (errors.length > 0) {
      setDryRunError('Fix validation errors before dry-running.');
      return;
    }
    const prompts = await api.pipelines.dryRun(
      draft.id,
      projectId,
      'Add rate limiting to the public API',
    );
    if (!prompts.length) {
      setDryRunError('Dry run returned no agent prompts. Add an agent phase first.');
      return;
    }
    setDryRun(prompts);
  };

  const phaseCount = draft?.phases.length ?? 0;
  const clampedActive = phaseCount ? Math.min(Math.max(activePhase, 0), phaseCount - 1) : -1;

  return {
    pipelines,
    selected,
    selectedId,
    draft,
    agents,
    commandNames,
    projectId,
    issues,
    errors,
    activePhase: clampedActive,
    setActivePhase,
    dryRun,
    dryRunError,
    closeDryRun: () => setDryRun(null),
    setDraft,
    selectPipeline,
    createPipeline,
    duplicate,
    remove,
    preview,
    addPhase,
    insertPhase,
    movePhase,
    reorderPhase,
    removePhase,
    updatePhase,
    setAcceptanceKind,
    setAcceptancePhase,
    setAcceptanceFlag,
    setIsolation,
    acceptancePhase,
  };
}
