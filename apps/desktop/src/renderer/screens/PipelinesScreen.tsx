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
import { phaseKindColor } from '../derive.js';
import EmptyState from '../components/EmptyState.js';
import PhaseEditor from '../components/PhaseEditor.js';
import { CliIcon } from '../components/BrandIcon.js';
import DryRunSheet from '../components/DryRunSheet.js';
import styles from './PipelinesScreen.module.css';

/* ── phase track ─────────────────────────────────────────────────────── */

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
    phaseKindColor(phase.kind, agentColor(phase.agent ?? null));
  const meta = (phase: PhaseDef): React.ReactNode => {
    if (phase.kind === 'agent') {
      const owner = agents.find((a) => a.name === phase.agent) ?? null;
      return (
        <>
          {owner && <CliIcon vendor={owner.cli ?? 'droid'} size={11} />}
          <span>{phase.agent}</span>
          <span className={styles.plTrMetaDim}>·</span>
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
    <div className={styles.plTrackWrap}>
      <div className={styles.plTrack}>
        {pipeline.phases.map((phase, i) => (
          <div key={i} className={styles.plTrCell} role="presentation">
            {i > 0 && <span className={styles.plTrLink} aria-hidden />}
            <button
              type="button"
              className={`${styles.plTrNode} ${selected === i ? styles.on : ''}`}
              style={{ ['--hue' as string]: hue(phase) }}
              onClick={() => onSelect(i)}
              aria-pressed={selected === i}
            >
              <span className={styles.plTrNum}>{String(i + 1).padStart(2, '0')}</span>
              <span className={styles.plTrBox}>
                <span className={styles.plTrIcon}>
                  <PhaseGlyph kind={phase.kind} />
                </span>
                <span className={styles.plTrName}>{phase.name}</span>
              </span>
              <span className={styles.plTrKind}>{KIND_LABEL[phase.kind]}</span>
              <span className={styles.plTrMeta}>{meta(phase)}</span>
            </button>
          </div>
        ))}
        <span className={`styles.plTrLink styles.plTrLinkTail`} aria-hidden />
        <div className={styles.plTrAdd}>
          <span className={styles.plTrAddLabel}>add</span>
          <button
            type="button"
            className={styles.plTrAddbtn}
            style={{ ['--hue' as string]: 'var(--purple)' }}
            onClick={() => onAdd('agent')}
          >
            <AgentGlyph /> Agent
          </button>
          <button
            type="button"
            className={styles.plTrAddbtn}
            style={{ ['--hue' as string]: 'var(--amber)' }}
            onClick={() => onAdd('code')}
          >
            <CommandGlyph /> Command
          </button>
          <button
            type="button"
            className={styles.plTrAddbtn}
            style={{ ['--hue' as string]: 'var(--blue)' }}
            onClick={() => onAdd('engineer')}
          >
            <CheckpointGlyph /> Checkpoint
          </button>
        </div>
      </div>
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
      <div className={styles.plScreen}>
        {/* ── switcher strip: pipelines as tabs, actions at the right ── */}
        <div className={styles.plSwitcher}>
          <span className={`styles.plMono styles.plSwitcherLabel`}>Pipelines</span>
          <div className={styles.plTabs} role="tablist" aria-label="Pipelines">
            {pipelines.map((p) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={p.id === selectedId}
                className={`${styles.plTab} ${p.id === selectedId ? styles.on : ''}`}
                onClick={() => selectPipeline(p.id)}
              >
                <span className={styles.plTabName}>{p.name}</span>
                <span className={styles.plTabCount}>{p.phases.length}</span>
                {p.id === selectedId && <span className={styles.plTabRule} aria-hidden />}
              </button>
            ))}
            <button type="button" className={styles.plNewtab} onClick={() => void createPipeline()}>
              + New pipeline
            </button>
          </div>
          {draft && (
            <div className={styles.plActions}>
              <button
                type="button"
                className={styles.plAction}
                disabled={!projectId}
                title={!projectId ? 'Select a project first' : undefined}
                onClick={() => void preview()}
              >
                Dry run
              </button>
              <span className={styles.plActionSep} aria-hidden />
              {selected && (
                <button type="button" className={styles.plAction} onClick={() => void duplicate()}>
                  Duplicate
                </button>
              )}
              {selected && !selected.builtin && (
                <button
                  type="button"
                  className={`styles.plAction styles.danger`}
                  onClick={() => void remove()}
                >
                  Delete
                </button>
              )}
            </div>
          )}
        </div>

        {draft && (
          <div className={styles.plScroll}>
            <div className={styles.plPage}>
              {/* ── identity ── */}
              <div className={styles.plIdentity}>
                <div className={styles.plIdentityMain}>
                  <input
                    className={styles.plTitle}
                    aria-label="Pipeline name"
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                  <input
                    className={styles.plDesc}
                    aria-label="Pipeline description"
                    value={draft.description}
                    placeholder="What is this pipeline for?"
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  />
                </div>
                <div className={styles.plIdentityMeta}>
                  <span className={styles.plMono}>Phases</span>
                  <span className={styles.plIdentityCount}>{draft.phases.length}</span>
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
              <section className={styles.plPhases} aria-label="Phases">
                <div className={styles.plSectionHead}>
                  <h2 className={styles.plMono}>Phases</h2>
                  <span className={styles.plSectionCount}>{draft.phases.length} steps</span>
                </div>
                <div className={styles.plPhaseList}>
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
              <section className={styles.plAcceptance} aria-label="Acceptance">
                <div className={styles.plSectionHead}>
                  <h2 className={styles.plMono}>Acceptance</h2>
                  <span className={styles.plSectionCount}>evaluated when the run settles</span>
                </div>
                <div className={styles.plAcceptanceRow}>
                  <div className={styles.plField}>
                    <span className={styles.plFieldLabel}>A run counts as accepted when</span>
                    <span className={styles.plFieldControl}>
                      <select
                        className={styles.plSelect}
                        value={draft.acceptance.kind}
                        onChange={(e) => setAcceptanceKind(e.target.value as Acceptance['kind'])}
                      >
                        <option value="all_phases_pass">Every phase passed</option>
                        <option value="last_phase_pass">The last phase passed</option>
                        <option value="envelope_status">A phase's envelope reports success</option>
                        <option value="phase_flag">A phase's envelope sets a flag</option>
                      </select>
                    </span>
                    <span className={styles.plFieldHint}>
                      A run where every phase passed is not automatically a run that did what was
                      asked.
                    </span>
                  </div>
                  {acceptancePhase !== null && (
                    <div className={styles.plField}>
                      <span className={styles.plFieldLabel}>Phase</span>
                      <span className={styles.plFieldControl}>
                        <select
                          className={styles.plSelect}
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
                    <div className={`styles.plField styles.plFieldNarrow`}>
                      <span className={styles.plFieldLabel}>Flag</span>
                      <span className={styles.plFieldControl}>
                        <select
                          className={styles.plSelect}
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
                  <label className={styles.plWorktree}>
                    <input
                      type="checkbox"
                      checked={draft.isolation !== false}
                      onChange={(e) => setDraft({ ...draft, isolation: e.target.checked })}
                    />
                    <span>
                      <span className={styles.plWorktreeTitle}>Isolated git worktree</span>
                      <span className={styles.plFieldHint}>
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
          <div className={styles.plValidation}>
            <span className={styles.plMono}>Validation</span>
            <div className={styles.plValidationItems}>
              {readyCopy && (
                <span
                  className={`${styles.plValItem} ${errors.length === 0 && warnings.length === 0 ? 'ok' : ''}`}
                >
                  {readyCopy}
                </span>
              )}
              {[...errors, ...warnings].map((issue, i) => (
                <span key={i} className={`${styles.plValItem} ${issue.level}`}>
                  <span className={styles.plValMark}>{issue.level === 'error' ? '✕' : '!'}</span>
                  <strong>{issue.where}</strong> {issue.message}
                </span>
              ))}
              {dryRunError && <span className={`styles.plValItem error`}>{dryRunError}</span>}
            </div>
            <span className={styles.plAutosave}>Changes save automatically</span>
          </div>
        )}

        {!draft && (
          <div className={styles.plEmpty}>
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
    </>
  );
}
