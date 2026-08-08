import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Acceptance,
  DryRunPrompt,
  PhaseDef,
  PipelineDef,
  ValidationIssue,
} from '@shared/types.js';
import { api, plain } from '../api.js';
import { useApp } from '../stores/app.js';
import EmptyState from '../components/EmptyState.js';
import PhaseEditor from '../components/PhaseEditor.js';
import PipelineGraph from '../components/PipelineGraph.js';
import DryRunSheet from '../components/DryRunSheet.js';

export default function PipelinesScreen(): React.JSX.Element {
  const { pipelines, project, projectId, agents, refreshScoped } = useApp();
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState<PipelineDef | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [openPhase, setOpenPhase] = useState(0);
  const [dryRun, setDryRun] = useState<DryRunPrompt[] | null>(null);
  const [dryRunError, setDryRunError] = useState('');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef<PipelineDef | null>(null);
  draftRef.current = draft;

  const selected = useMemo(
    () => pipelines.find((p) => p.id === selectedId) ?? null,
    [pipelines, selectedId],
  );
  const commandNames = useMemo(() => project?.commands.map((c) => c.name) ?? [], [project]);
  const errors = useMemo(() => issues.filter((i) => i.level === 'error'), [issues]);
  const warnings = useMemo(() => issues.filter((i) => i.level === 'warning'), [issues]);

  // Keep a valid selection when the list changes (initial load, add, remove, project switch).
  // Don't clobber a transient new pipeline that hasn't appeared in the list yet.
  useEffect(() => {
    if (pipelines.some((p) => p.id === selectedId)) return;
    if (draft && draft.id === selectedId) return;
    setSelectedId(pipelines[0]?.id ?? '');
  }, [pipelines, selectedId, draft]);

  // Sync draft when the selected pipeline changes. Don't clobber an in-flight
  // edit that hasn't been persisted yet; only sync when the id changes.
  useEffect(() => {
    if (!selected) {
      // No pipeline to edit. If we already have a draft for a different id
      // (transient new pipeline before it appears in the list), keep it.
      // Otherwise clear.
      if (draft && pipelines.some((p) => p.id === draft.id)) setDraft(null);
      else if (!draft) setDraft(null);
      return;
    }
    if (!draft || draft.id !== selected.id) {
      setDraft(plain({ ...selected }));
      setOpenPhase(0);
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
  const pendingRef = useRef<PipelineDef | null>(null);

  // Live auto-save: every valid edit is persisted shortly after typing stops.
  // Visual state is the single source of truth, no Save button. A pending save
  // is flushed when the user switches pipelines so no edit is lost.
  useEffect(() => {
    if (!draft) return;
    const sel = pipelinesRef.current.find((p) => p.id === draft.id) ?? null;
    if (JSON.stringify(draft) === JSON.stringify(sel)) return;
    if (errors.length > 0) return;
    const snapshot = plain(draft);
    pendingRef.current = snapshot;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const toSave = pendingRef.current;
      pendingRef.current = null;
      saveTimer.current = null;
      if (!toSave) return;
      const latestSel = pipelinesRef.current.find((p) => p.id === toSave.id) ?? null;
      if (JSON.stringify(toSave) === JSON.stringify(latestSel)) return;
      const pid = projectIdRef.current;
      void (async () => {
        try {
          const result = await api.pipelines.save(toSave, pid || undefined);
          if (result.ok) await refreshScoped();
          else setIssues(result.issues);
        } catch (e) {
          setIssues([{ level: 'error', where: 'save', message: (e as Error).message }]);
        }
      })();
    }, 350);
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        const toSave = pendingRef.current;
        pendingRef.current = null;
        if (toSave) {
          const latestSel = pipelinesRef.current.find((p) => p.id === toSave.id) ?? null;
          if (JSON.stringify(toSave) !== JSON.stringify(latestSel)) {
            const pid = projectIdRef.current;
            void (async () => {
              try {
                const result = await api.pipelines.save(toSave, pid || undefined);
                if (result.ok) await refreshScoped();
                else setIssues(result.issues);
              } catch {
                // Flush on unmount/switch is best-effort; validation is already visible
              }
            })();
          }
        }
      }
    };
  }, [draft, errors, refreshScoped]);

  const acceptancePhase = useMemo(() => {
    const a = draft?.acceptance;
    if (!a) return null;
    return 'phase' in a ? (a as { phase: string }).phase : null;
  }, [draft]);

  const setAcceptanceKind = (kind: Acceptance['kind']): void => {
    if (!draft) return;
    const phase = acceptancePhase ?? draft.phases[draft.phases.length - 1]?.name ?? '';
    let next: Acceptance;
    if (kind === 'phase_flag') next = { kind, phase, flag: 'approved' };
    else if (kind === 'envelope_status') next = { kind, phase };
    else next = { kind } as Acceptance;
    setDraft({ ...draft, acceptance: next });
  };
  const setAcceptancePhase = (phase: string): void => {
    if (!draft?.acceptance || !('phase' in draft.acceptance)) return;
    setDraft({ ...draft, acceptance: { ...draft.acceptance, phase } });
  };
  const setAcceptanceFlag = (flag: 'passed' | 'approved'): void => {
    if (draft?.acceptance?.kind !== 'phase_flag') return;
    setDraft({ ...draft, acceptance: { ...draft.acceptance, flag } });
  };
  const addPhase = (kind: PhaseDef['kind']): void => {
    if (!draft) return;
    const n = draft.phases.length + 1;
    const base = { name: `phase-${n}`, description: '' };
    let phase: PhaseDef;
    if (kind === 'agent') {
      phase = {
        ...base,
        kind,
        agent: agents[0]?.name ?? '',
        envelope: agents[0]?.envelope ?? 'build',
        prompt: { template: 'user', inputs: ['request'] },
      } as PhaseDef;
    } else if (kind === 'code') {
      phase = {
        ...base,
        kind,
        description: 'Run a project command and fail the phase if it exits non-zero.',
        command: commandNames[0] ? { ref: commandNames[0] } : { argv: ['echo', 'configure-me'] },
      } as PhaseDef;
    } else {
      phase = { ...base, kind, question: 'Approve this?' } as PhaseDef;
    }
    const next = { ...draft, phases: [...draft.phases, phase] };
    setDraft(next);
    setOpenPhase(next.phases.length - 1);
  };
  const movePhase = (index: number, delta: number): void => {
    if (!draft) return;
    const target = index + delta;
    if (target < 0 || target >= draft.phases.length) return;
    const phases = [...draft.phases];
    [phases[index], phases[target]] = [phases[target]!, phases[index]!];
    setDraft({ ...draft, phases });
    setOpenPhase(target);
  };
  const removePhase = (index: number): void => {
    if (!draft) return;
    const phases = [...draft.phases];
    phases.splice(index, 1);
    setDraft({ ...draft, phases });
    setOpenPhase(Math.max(0, index - 1));
  };
  const updatePhase = (index: number, phase: PhaseDef): void => {
    if (!draft) return;
    setDraft({
      ...draft,
      phases: draft.phases.map((p, i) => (i === index ? phase : p)),
    });
  };
  const createPipeline = async (): Promise<void> => {
    const id = `pipeline-${Date.now().toString(36)}`;
    const starter: PhaseDef | null = agents[0]
      ? ({
          name: 'phase-1',
          description: 'Describe what this phase does and why.',
          kind: 'agent',
          agent: agents[0].name,
          envelope: agents[0].envelope ?? 'build',
          prompt: { template: 'user', inputs: ['request'] },
        } as PhaseDef)
      : null;
    const fresh: PipelineDef = {
      id,
      name: 'New pipeline',
      description: 'Say what this pipeline is for and when to reach for it.',
      acceptance: { kind: 'all_phases_pass' },
      phases: starter ? [starter] : [],
    };
    setSelectedId(id);
    setDraft(fresh);
    setOpenPhase(0);
    setIssues([]);
    try {
      const result = await api.pipelines.save(fresh, projectId || undefined);
      if (result.ok) {
        await refreshScoped();
      } else {
        setIssues(result.issues);
      }
    } catch (e) {
      setIssues([{ level: 'error', where: 'save', message: (e as Error).message }]);
    }
  };
  const selectPipeline = (id: string): void => {
    if (id === selectedId) return;
    setSelectedId(id);
  };
  const duplicate = async (): Promise<void> => {
    if (!selected) return;
    const copy = await api.pipelines.duplicate(selected.id, projectId || undefined);
    await refreshScoped();
    if (copy) setSelectedId(copy.id);
  };
  const remove = async (): Promise<void> => {
    if (!selected) return;
    if (!window.confirm(`Delete pipeline "${selected.name}"? This cannot be undone.`)) return;
    await api.pipelines.remove(selected.id, projectId || undefined);
    await refreshScoped();
  };
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

  const readyCopy =
    errors.length === 0
      ? warnings.length
        ? `Valid with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}.`
        : projectId
          ? 'This pipeline is ready to run.'
          : 'Select a project to run this pipeline.'
      : null;

  return (
    <>
      <div className="screen">
        <aside className="list">
          <header className="list-head">
            <h1>Pipelines</h1>
            <button className="btn sm" onClick={() => void createPipeline()}>
              New
            </button>
          </header>
          <div className="scroll items">
            {pipelines.map((p) => (
              <button
                key={p.id}
                className={`item ${p.id === selectedId ? 'active' : ''}`}
                onClick={() => selectPipeline(p.id)}
              >
                <span className="name">{p.name}</span>
                <span className="faint count">{p.phases.length} phases</span>
              </button>
            ))}
          </div>
        </aside>
        {draft && (
          <div className="editor scroll">
            <header className="edit-head">
              <div className="grow">
                <input
                  className="title-input"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
                <input
                  className="desc-input"
                  value={draft.description}
                  placeholder="What is this pipeline for?"
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </div>
              <button
                className="btn sm"
                disabled={!projectId}
                title={!projectId ? 'Select a project first' : undefined}
                onClick={() => void preview()}
              >
                Dry run
              </button>
              {selected && (
                <button className="btn sm" onClick={() => void duplicate()}>
                  Duplicate
                </button>
              )}
              {selected && !selected.builtin && (
                <button className="btn sm danger" onClick={() => void remove()}>
                  Delete
                </button>
              )}
            </header>
            <PipelineGraph pipeline={draft} selected={openPhase} onSelect={setOpenPhase} />
            <section className="phases">
              {draft.phases.map((phase, i) => (
                <PhaseEditor
                  key={i}
                  phase={phase}
                  index={i}
                  open={openPhase === i}
                  phases={draft.phases}
                  agents={agents}
                  commands={commandNames}
                  onChange={(next) => updatePhase(i, next)}
                  onToggle={() => setOpenPhase(openPhase === i ? -1 : i)}
                  onMove={(d) => movePhase(i, d)}
                  onRemove={() => removePhase(i)}
                />
              ))}
              <div className="add">
                <span className="faint">Add a phase:</span>
                <button className="btn sm" onClick={() => addPhase('agent')}>
                  Agent
                </button>
                <button className="btn sm" onClick={() => addPhase('code')}>
                  Command
                </button>
                <button className="btn sm" onClick={() => addPhase('engineer')}>
                  Checkpoint
                </button>
              </div>
            </section>
            <section className="acceptance card">
              <h3>Acceptance</h3>
              <p className="faint hint">
                What has to be true for this run to count as accepted. A run where every phase
                passed is not automatically a run that did what was asked.
              </p>
              <div className="row">
                <select
                  className="select"
                  value={draft.acceptance.kind}
                  onChange={(e) => setAcceptanceKind(e.target.value as Acceptance['kind'])}
                >
                  <option value="all_phases_pass">Every phase passed</option>
                  <option value="last_phase_pass">The last phase passed</option>
                  <option value="envelope_status">A phase's envelope reports success</option>
                  <option value="phase_flag">A phase's envelope sets a flag</option>
                </select>
                {acceptancePhase !== null && (
                  <select
                    className="select"
                    value={acceptancePhase}
                    onChange={(e) => setAcceptancePhase(e.target.value)}
                  >
                    {draft.phases.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                )}
                {draft.acceptance.kind === 'phase_flag' && (
                  <select
                    className="select flag"
                    value={(draft.acceptance as { flag: string }).flag}
                    onChange={(e) => setAcceptanceFlag(e.target.value as 'passed' | 'approved')}
                  >
                    <option value="passed">passed</option>
                    <option value="approved">approved</option>
                  </select>
                )}
              </div>
            </section>
            <section className="options card">
              <label className="opt">
                <input
                  type="checkbox"
                  checked={draft.isolation !== false}
                  onChange={(e) => setDraft({ ...draft, isolation: e.target.checked })}
                />
                <span>
                  Run in an isolated git worktree
                  <em className="faint">
                    Recommended. Without it, phases write directly into your checkout.
                  </em>
                </span>
              </label>
            </section>
          </div>
        )}
        {draft && (
          <aside className="rail">
            <h3>Validation</h3>
            {readyCopy && <p className="ok">{readyCopy}</p>}
            {issues.length > 0 && (
              <ul className="issues">
                {[...errors, ...warnings].map((issue, i) => (
                  <li key={i} className={issue.level}>
                    <span className="mark">{issue.level === 'error' ? '✕' : '!'}</span>
                    <span>
                      <strong>{issue.where}</strong> {issue.message}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {dryRunError && <p className="dry-err">{dryRunError}</p>}
            <p className="faint live-hint">Changes save automatically.</p>
          </aside>
        )}
        {!draft && (
          <div className="empty-wrap">
            <EmptyState
              art="scenes/empty-state.png"
              title={pipelines.length ? 'No pipeline selected' : 'No pipelines yet'}
              body={
                pipelines.length
                  ? 'Pick a pipeline from the list or create a new one. Pipelines are data — reorder phases, swap agents, and save.'
                  : 'This workspace has no pipelines. Create one to define how agents should work together.'
              }
            >
              <button className="btn primary" onClick={() => void createPipeline()}>
                New pipeline
              </button>
            </EmptyState>
          </div>
        )}
        {dryRun && <DryRunSheet prompts={dryRun} onClose={() => setDryRun(null)} />}
      </div>
      <style>{`
        .screen { display: grid; grid-template-columns: 240px minmax(0, 1fr) 280px; height: 100%; min-height: 0; }
        .list { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--line); background: var(--bg-panel); }
        .list-head { display: flex; align-items: center; justify-content: space-between; padding: calc(var(--titlebar-h) + var(--s2)) var(--s4) var(--s3); }
        .list-head h1 { font-size: var(--text-xl); font-weight: 600; }
        .items { flex: 1; min-height: 0; padding: 0 var(--s2) var(--s4); overflow-y: auto; }
        .item { display: flex; flex-direction: column; align-items: flex-start; width: 100%; padding: var(--s2) var(--s3); border: none; border-radius: var(--r-sm); background: transparent; color: inherit; font: inherit; text-align: left; cursor: default; }
        .item:hover { background: var(--bg-hover); }
        .item.active { background: var(--bg-active); }
        .item .name { font-size: var(--text-sm); font-weight: 500; }
        .count { font-size: var(--text-xs); }
        .editor { min-height: 0; padding: calc(var(--titlebar-h) + var(--s2)) var(--s6) var(--s16); overflow-y: auto; }
        .edit-head { display: flex; align-items: flex-start; gap: var(--s2); margin-bottom: var(--s4); }
        .grow { flex: 1; min-width: 0; }
        .title-input, .desc-input { display: block; width: 100%; border: none; background: transparent; color: inherit; font: inherit; padding: 2px 0; }
        .title-input { font-size: var(--text-xl); font-weight: 600; letter-spacing: -0.01em; }
        .desc-input { font-size: var(--text-sm); color: var(--text-dim); }
        .title-input:focus, .desc-input:focus { outline: none; border-bottom: 1px solid var(--cyan); }
        .phases { display: flex; flex-direction: column; gap: var(--s2); margin-top: var(--s5); }
        .add { display: flex; align-items: center; gap: var(--s2); padding: var(--s3); border: 1px dashed var(--line); border-radius: var(--r); font-size: var(--text-sm); }
        .acceptance, .options { margin-top: var(--s5); padding: var(--s4); background: var(--bg-panel); border: 1px solid var(--line); border-radius: var(--r-lg); }
        .acceptance h3, .options h3 { font-size: var(--text-sm); font-weight: 600; margin-bottom: var(--s2); }
        .hint { font-size: var(--text-xs); line-height: var(--leading); margin-bottom: var(--s3); }
        .row { display: flex; gap: var(--s2); }
        .flag { width: 180px; }
        .opt { display: flex; gap: var(--s3); font-size: var(--text-sm); }
        .opt em { display: block; font-style: normal; font-size: var(--text-xs); margin-top: 2px; }
        .rail { display: flex; flex-direction: column; min-height: 0; padding: calc(var(--titlebar-h) + var(--s2)) var(--s4) var(--s4); border-left: 1px solid var(--line); background: var(--bg-panel); }
        .ok { font-size: var(--text-sm); color: var(--green); }
        .dry-err { margin-top: var(--s3); font-size: var(--text-xs); color: var(--red); }
        .issues { flex: 1; overflow-y: auto; list-style: none; display: flex; flex-direction: column; gap: var(--s2); }
        .issues li { display: flex; gap: var(--s2); font-size: var(--text-xs); line-height: var(--leading); }
        .issues .error { color: var(--red); }
        .issues .warning { color: var(--amber); }
        .mark { flex: none; }
        .live-hint { margin-top: auto; padding-top: var(--s4); font-size: var(--text-xs); }
        .empty-wrap { grid-column: 2 / -1; display: grid; place-items: center; padding: var(--s8); min-height: 0; }
        .scroll { overflow-y: auto; }
        .card { border: 1px solid var(--line); border-radius: var(--r-lg); }
      `}</style>
    </>
  );
}
