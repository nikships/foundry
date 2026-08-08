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
import { CliIcon } from '../components/BrandIcon.js';
import DryRunSheet from '../components/DryRunSheet.js';

/* ── phase track ─────────────────────────────────────────────────────── */

const KIND_HUE: Record<string, string> = { code: 'var(--amber)', engineer: 'var(--blue)' };
const KIND_LABEL: Record<string, string> = {
  agent: 'agent',
  code: 'command',
  engineer: 'checkpoint',
};

function AgentGlyph(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden
    >
      <rect x="2.5" y="4" width="9" height="7" rx="1.5" />
      <path d="M7 4V1.8" />
      <circle cx="7" cy="1.4" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="5.2" cy="7.2" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="8.8" cy="7.2" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  );
}

function CommandGlyph(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 3.5 6 6.5 3 9.5" />
      <path d="M7 10.5h4.5" />
    </svg>
  );
}

function CheckpointGlyph(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 12.5v-11" />
      <path d="M3 2.2c1.6-1 3.2 1 4.8 0s3-0.6 3.4-0.2v5.6c-0.4-0.4-1.8-0.8-3.4 0.2s-3.2 1-4.8 0" />
    </svg>
  );
}

function PhaseGlyph({ kind }: { kind: PhaseDef['kind'] }): React.JSX.Element {
  if (kind === 'agent') return <AgentGlyph />;
  if (kind === 'code') return <CommandGlyph />;
  return <CheckpointGlyph />;
}

function PhaseTrack({
  pipeline,
  selected,
  onSelect,
  onAdd,
}: {
  pipeline: PipelineDef;
  selected: number;
  onSelect: (index: number) => void;
  onAdd: (kind: PhaseDef['kind']) => void;
}): React.JSX.Element {
  const { agents, agentColor } = useApp();
  const hue = (phase: PhaseDef): string =>
    phase.kind === 'agent' ? agentColor(phase.agent ?? null) : KIND_HUE[phase.kind]!;
  const meta = (phase: PhaseDef): React.ReactNode => {
    if (phase.kind === 'agent') {
      const owner = agents.find((a) => a.name === phase.agent) ?? null;
      return (
        <>
          {owner && <CliIcon vendor={owner.cli ?? 'droid'} size={11} />}
          <span>{phase.agent}</span>
          <span className="pl-tr-meta-dim">·</span>
          <span>{phase.envelope ?? owner?.envelope ?? 'build'}</span>
        </>
      );
    }
    if (phase.kind === 'code') {
      const cmd =
        phase.command && 'ref' in phase.command
          ? phase.command.ref
          : phase.command && 'argv' in phase.command
            ? phase.command.argv.join(' ')
            : '';
      return <span>$ {cmd}</span>;
    }
    return <span>yes / no</span>;
  };
  return (
    <div className="pl-track-wrap">
      <div className="pl-track">
        {pipeline.phases.map((phase, i) => (
          <div key={i} className="pl-tr-cell" role="presentation">
            {i > 0 && <span className="pl-tr-link" aria-hidden />}
            <button
              type="button"
              className={`pl-tr-node ${selected === i ? 'on' : ''}`}
              style={{ ['--hue' as string]: hue(phase) }}
              onClick={() => onSelect(i)}
              aria-pressed={selected === i}
            >
              <span className="pl-tr-num">{String(i + 1).padStart(2, '0')}</span>
              <span className="pl-tr-box">
                <span className="pl-tr-icon">
                  <PhaseGlyph kind={phase.kind} />
                </span>
                <span className="pl-tr-name">{phase.name}</span>
              </span>
              <span className="pl-tr-kind">{KIND_LABEL[phase.kind]}</span>
              <span className="pl-tr-meta">{meta(phase)}</span>
            </button>
          </div>
        ))}
        <span className="pl-tr-link pl-tr-link-tail" aria-hidden />
        <div className="pl-tr-add">
          <span className="pl-tr-add-label">add</span>
          <button
            type="button"
            className="pl-tr-addbtn"
            style={{ ['--hue' as string]: 'var(--purple)' }}
            onClick={() => onAdd('agent')}
          >
            <AgentGlyph /> Agent
          </button>
          <button
            type="button"
            className="pl-tr-addbtn"
            style={{ ['--hue' as string]: 'var(--amber)' }}
            onClick={() => onAdd('code')}
          >
            <CommandGlyph /> Command
          </button>
          <button
            type="button"
            className="pl-tr-addbtn"
            style={{ ['--hue' as string]: 'var(--blue)' }}
            onClick={() => onAdd('engineer')}
          >
            <CheckpointGlyph /> Checkpoint
          </button>
        </div>
      </div>
      <style>{`
        .pl-track-wrap { border-top: 1px solid var(--line); }
        .pl-track {
          display: flex; align-items: flex-start;
          padding: var(--s6) var(--s6) var(--s7, 28px);
          overflow-x: auto;
        }
        .pl-tr-cell { display: contents; }
        .pl-tr-link { flex: 1 1 18px; min-width: 18px; height: 1px; background: var(--line-strong); margin-top: 25px; }
        .pl-tr-link-tail { background: var(--line); }
        .pl-tr-node {
          flex: none; width: 150px; display: flex; flex-direction: column; align-items: flex-start;
          border: none; background: transparent; color: inherit; font: inherit;
          text-align: left; cursor: default;
        }
        .pl-tr-num { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.14em; color: var(--text-faint); margin-bottom: 8px; }
        .pl-tr-box {
          display: flex; align-items: center; gap: var(--s2);
          width: 100%; height: 36px; padding: 0 10px;
          border: 1px solid var(--line-strong); border-radius: 3px;
          background: transparent;
          transition: border-color var(--fast) var(--ease), background var(--fast) var(--ease);
        }
        .pl-tr-node:hover .pl-tr-box { border-color: color-mix(in srgb, var(--hue) 55%, transparent); }
        .pl-tr-node.on .pl-tr-box { border-color: var(--hue); background: color-mix(in srgb, var(--hue) 6%, transparent); }
        .pl-tr-icon { color: var(--hue); display: flex; align-items: center; flex: none; }
        .pl-tr-name { font-size: var(--text-sm); color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; transition: color var(--fast) var(--ease); }
        .pl-tr-node:hover .pl-tr-name, .pl-tr-node.on .pl-tr-name { color: var(--text); }
        .pl-tr-kind { font-family: var(--font-mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.16em; color: var(--hue); margin-top: 8px; }
        .pl-tr-meta {
          display: flex; align-items: center; gap: 5px; max-width: 100%;
          margin-top: 4px; font-family: var(--font-mono); font-size: 11px; color: var(--text-faint);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .pl-tr-meta-dim { opacity: 0.6; }
        .pl-tr-add { flex: none; display: flex; align-items: center; gap: 6px; margin-top: 21px; }
        .pl-tr-add-label { font-family: var(--font-mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.16em; color: var(--text-faint); margin-right: 2px; }
        .pl-tr-addbtn {
          display: inline-flex; align-items: center; gap: 6px;
          height: 32px; padding: 0 10px;
          border: 1px dashed var(--line-strong); border-radius: 3px;
          background: transparent; color: var(--text-dim);
          font: inherit; font-size: var(--text-xs); cursor: default; white-space: nowrap;
          transition: color var(--fast) var(--ease), border-color var(--fast) var(--ease);
        }
        .pl-tr-addbtn svg { color: var(--hue); }
        .pl-tr-addbtn:hover { color: var(--text); border-color: color-mix(in srgb, var(--hue) 55%, transparent); }
      `}</style>
    </div>
  );
}

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
      <div className="pl-screen">
        {/* ── switcher strip: pipelines as tabs, actions at the right ── */}
        <div className="pl-switcher">
          <span className="pl-mono pl-switcher-label">Pipelines</span>
          <div className="pl-tabs" role="tablist" aria-label="Pipelines">
            {pipelines.map((p) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={p.id === selectedId}
                className={`pl-tab ${p.id === selectedId ? 'on' : ''}`}
                onClick={() => selectPipeline(p.id)}
              >
                <span className="pl-tab-name">{p.name}</span>
                <span className="pl-tab-count">{p.phases.length}</span>
                {p.id === selectedId && <span className="pl-tab-rule" aria-hidden />}
              </button>
            ))}
            <button type="button" className="pl-newtab" onClick={() => void createPipeline()}>
              + New pipeline
            </button>
          </div>
          {draft && (
            <div className="pl-actions">
              <button
                type="button"
                className="pl-action"
                disabled={!projectId}
                title={!projectId ? 'Select a project first' : undefined}
                onClick={() => void preview()}
              >
                Dry run
              </button>
              <span className="pl-action-sep" aria-hidden />
              {selected && (
                <button type="button" className="pl-action" onClick={() => void duplicate()}>
                  Duplicate
                </button>
              )}
              {selected && !selected.builtin && (
                <button type="button" className="pl-action danger" onClick={() => void remove()}>
                  Delete
                </button>
              )}
            </div>
          )}
        </div>

        {draft && (
          <div className="pl-scroll">
            <div className="pl-page">
              {/* ── identity ── */}
              <div className="pl-identity">
                <div className="pl-identity-main">
                  <input
                    className="pl-title"
                    aria-label="Pipeline name"
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                  <input
                    className="pl-desc"
                    aria-label="Pipeline description"
                    value={draft.description}
                    placeholder="What is this pipeline for?"
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  />
                </div>
                <div className="pl-identity-meta">
                  <span className="pl-mono">Phases</span>
                  <span className="pl-identity-count">{draft.phases.length}</span>
                </div>
              </div>

              {/* ── phase track ── */}
              <PhaseTrack
                pipeline={draft}
                selected={openPhase}
                onSelect={(i) => setOpenPhase(i === openPhase ? -1 : i)}
                onAdd={addPhase}
              />

              {/* ── phase rows ── */}
              <section className="pl-phases" aria-label="Phases">
                <div className="pl-section-head">
                  <h2 className="pl-mono">Phases</h2>
                  <span className="pl-section-count">{draft.phases.length} steps</span>
                </div>
                <div className="pl-phase-list">
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
                </div>
              </section>

              {/* ── acceptance ── */}
              <section className="pl-acceptance" aria-label="Acceptance">
                <div className="pl-section-head">
                  <h2 className="pl-mono">Acceptance</h2>
                  <span className="pl-section-count">evaluated when the run settles</span>
                </div>
                <div className="pl-acceptance-row">
                  <div className="pl-field">
                    <span className="pl-field-label">A run counts as accepted when</span>
                    <span className="pl-field-control">
                      <select
                        className="pl-select"
                        value={draft.acceptance.kind}
                        onChange={(e) => setAcceptanceKind(e.target.value as Acceptance['kind'])}
                      >
                        <option value="all_phases_pass">Every phase passed</option>
                        <option value="last_phase_pass">The last phase passed</option>
                        <option value="envelope_status">A phase's envelope reports success</option>
                        <option value="phase_flag">A phase's envelope sets a flag</option>
                      </select>
                    </span>
                    <span className="pl-field-hint">
                      A run where every phase passed is not automatically a run that did what was
                      asked.
                    </span>
                  </div>
                  {acceptancePhase !== null && (
                    <div className="pl-field">
                      <span className="pl-field-label">Phase</span>
                      <span className="pl-field-control">
                        <select
                          className="pl-select"
                          value={acceptancePhase}
                          onChange={(e) => setAcceptancePhase(e.target.value)}
                        >
                          {draft.phases.map((p) => (
                            <option key={p.name} value={p.name}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      </span>
                    </div>
                  )}
                  {draft.acceptance.kind === 'phase_flag' && (
                    <div className="pl-field pl-field-narrow">
                      <span className="pl-field-label">Flag</span>
                      <span className="pl-field-control">
                        <select
                          className="pl-select"
                          value={(draft.acceptance as { flag: string }).flag}
                          onChange={(e) =>
                            setAcceptanceFlag(e.target.value as 'passed' | 'approved')
                          }
                        >
                          <option value="passed">passed</option>
                          <option value="approved">approved</option>
                        </select>
                      </span>
                    </div>
                  )}
                  <label className="pl-worktree">
                    <input
                      type="checkbox"
                      checked={draft.isolation !== false}
                      onChange={(e) => setDraft({ ...draft, isolation: e.target.checked })}
                    />
                    <span>
                      <span className="pl-worktree-title">Isolated git worktree</span>
                      <span className="pl-field-hint">
                        Each run gets its own checkout, so phases never touch your working tree.
                      </span>
                    </span>
                  </label>
                </div>
              </section>
            </div>
          </div>
        )}

        {draft && (
          <div className="pl-validation">
            <span className="pl-mono">Validation</span>
            <div className="pl-validation-items">
              {readyCopy && (
                <span
                  className={`pl-val-item ${errors.length === 0 && warnings.length === 0 ? 'ok' : ''}`}
                >
                  {readyCopy}
                </span>
              )}
              {[...errors, ...warnings].map((issue, i) => (
                <span key={i} className={`pl-val-item ${issue.level}`}>
                  <span className="pl-val-mark">{issue.level === 'error' ? '✕' : '!'}</span>
                  <strong>{issue.where}</strong> {issue.message}
                </span>
              ))}
              {dryRunError && <span className="pl-val-item error">{dryRunError}</span>}
            </div>
            <span className="pl-autosave">Changes save automatically</span>
          </div>
        )}

        {!draft && (
          <div className="pl-empty">
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
        /* One continuous surface — structure from hairlines + type, never tinted columns. */
        .pl-screen {
          display: flex; flex-direction: column; height: 100%; min-height: 0;
          background: var(--bg-base);
        }
        .pl-mono {
          font-family: var(--font-mono); font-size: 10px; font-weight: 500;
          text-transform: uppercase; letter-spacing: 0.16em; color: var(--text-dim);
        }

        /* switcher */
        .pl-switcher {
          flex: none; display: flex; align-items: center; gap: var(--s6);
          padding: calc(var(--titlebar-h)) var(--s6) 0;
          border-bottom: 1px solid var(--line);
        }
        .pl-switcher-label { color: var(--text-faint); padding-bottom: var(--s3); }
        .pl-tabs { display: flex; align-items: stretch; gap: 2px; overflow-x: auto; min-width: 0; }
        .pl-tab {
          position: relative; display: flex; align-items: baseline; gap: 6px;
          padding: var(--s2) var(--s3) var(--s3);
          border: none; background: transparent; color: var(--text-faint);
          font: inherit; font-size: var(--text-sm); cursor: default; white-space: nowrap;
          transition: color var(--fast) var(--ease);
        }
        .pl-tab:hover { color: var(--text-dim); }
        .pl-tab.on { color: var(--text); }
        .pl-tab-count { font-family: var(--font-mono); font-size: 10px; color: var(--text-faint); }
        .pl-tab-rule { position: absolute; left: var(--s2); right: var(--s2); bottom: -1px; height: 1px; background: var(--cyan); }
        .pl-newtab {
          border: none; background: transparent; color: var(--text-faint);
          font: inherit; font-size: var(--text-xs); cursor: default; white-space: nowrap;
          padding: var(--s2) var(--s3) var(--s3);
          transition: color var(--fast) var(--ease);
        }
        .pl-newtab:hover { color: var(--text); }
        .pl-actions { margin-left: auto; display: flex; align-items: center; gap: 2px; padding-bottom: var(--s2); flex: none; }
        .pl-action {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 4px 8px; border: none; border-radius: var(--r-sm);
          background: transparent; color: var(--text-dim);
          font: inherit; font-size: var(--text-xs); cursor: default; white-space: nowrap;
          transition: color var(--fast) var(--ease);
        }
        .pl-action:hover:not(:disabled) { color: var(--text); }
        .pl-action:disabled { opacity: 0.4; }
        .pl-action.danger:hover { color: var(--red); }
        .pl-action-sep { width: 1px; height: 14px; background: var(--line); margin: 0 4px; }

        /* page */
        .pl-scroll { flex: 1; min-height: 0; overflow-y: auto; }
        .pl-page { display: flex; flex-direction: column; }

        .pl-identity {
          display: flex; align-items: flex-start; gap: var(--s10);
          padding: var(--s7, 28px) var(--s6) var(--s6);
        }
        .pl-identity-main { flex: 1; min-width: 0; }
        .pl-title, .pl-desc {
          display: block; width: 100%; border: none; background: transparent;
          color: inherit; font: inherit; padding: 2px 0;
        }
        .pl-title { font-size: 22px; font-weight: 600; letter-spacing: -0.015em; max-width: 36ch; }
        .pl-desc { margin-top: var(--s2); font-size: var(--text-sm); color: var(--text-dim); max-width: 64ch; }
        .pl-title:focus, .pl-desc:focus { outline: none; box-shadow: 0 1px 0 var(--line-strong); }
        .pl-identity-meta { flex: none; padding-top: 10px; text-align: right; display: flex; flex-direction: column; gap: 6px; }
        .pl-identity-meta .pl-mono { color: var(--text-faint); }
        .pl-identity-count { font-family: var(--font-mono); font-size: var(--text-sm); color: var(--text-dim); }

        .pl-section-head {
          display: flex; align-items: baseline; gap: var(--s3);
          padding: 0 var(--s6) var(--s3);
        }
        .pl-section-count { font-family: var(--font-mono); font-size: 11px; color: var(--text-faint); }

        .pl-phases { padding-top: var(--s5); }
        .pl-phase-list { border-top: 1px solid var(--line); }

        /* acceptance */
        .pl-acceptance { border-top: 1px solid var(--line); padding: var(--s6) 0 var(--s8); }
        .pl-acceptance-row {
          display: flex; align-items: flex-start; gap: var(--s10); flex-wrap: wrap;
          padding: 0 var(--s6);
        }
        .pl-field { display: flex; flex-direction: column; gap: 6px; min-width: 240px; max-width: 360px; }
        .pl-field-narrow { min-width: 140px; }
        .pl-field-label {
          font-family: var(--font-mono); font-size: 10px; text-transform: uppercase;
          letter-spacing: 0.14em; color: var(--text-faint);
        }
        .pl-field-control { border-bottom: 1px solid var(--line); padding-bottom: 6px; }
        .pl-field-control:focus-within { border-bottom-color: var(--line-strong); }
        .pl-select {
          width: 100%; appearance: none; border: none; background: transparent;
          color: var(--text); font: inherit; font-size: var(--text-sm); outline: none;
        }
        .pl-select option { background: var(--bg-base); color: var(--text); }
        .pl-field-hint { font-size: 11px; line-height: 1.5; color: var(--text-faint); }
        .pl-worktree { display: flex; gap: var(--s3); align-items: flex-start; padding-top: 18px; max-width: 300px; }
        .pl-worktree input { margin-top: 2px; accent-color: var(--cyan); }
        .pl-worktree-title { display: block; font-size: var(--text-sm); color: var(--text); margin-bottom: 4px; }

        /* validation strip */
        .pl-validation {
          flex: none; display: flex; align-items: center; gap: var(--s6);
          min-height: 40px; padding: var(--s2) var(--s6);
          border-top: 1px solid var(--line);
        }
        .pl-validation .pl-mono { color: var(--text-faint); flex: none; }
        .pl-validation-items {
          flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--s6);
          overflow-x: auto; white-space: nowrap;
        }
        .pl-val-item { font-size: var(--text-xs); color: var(--text-dim); display: inline-flex; align-items: center; gap: 6px; }
        .pl-val-item.ok { color: var(--green); }
        .pl-val-item.error { color: var(--red); }
        .pl-val-item.warning { color: var(--amber); }
        .pl-val-mark { flex: none; }
        .pl-autosave { flex: none; font-family: var(--font-mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.18em; color: var(--text-faint); }

        .pl-empty { flex: 1; display: grid; place-items: center; padding: var(--s8); min-height: 0; }
      `}</style>
    </>
  );
}
