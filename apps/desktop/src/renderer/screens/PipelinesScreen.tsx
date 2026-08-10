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
import { phaseKindColor, KIND_LABEL } from '../derive.js';
import EmptyState from '../components/EmptyState.js';
import PhaseEditor from '../components/PhaseEditor.js';
import { CliIcon } from '../components/BrandIcon.js';
import DryRunSheet from '../components/DryRunSheet.js';
import { useConfirmAction } from '../hooks/useConfirmAction.js';
import { useDebouncedSave } from '../hooks/useDebouncedSave.js';
import { useTablistNav } from '../hooks/useTablistNav.js';
import { Button } from '../components/ui/Button.js';
import { Dropdown, type DropdownOption } from '../components/ui/Dropdown.js';
import styles from './PipelinesScreen.module.css';

function EnvelopeGlyph(): React.JSX.Element {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="1.5" y="3" width="11" height="8" rx="1.2" />
      <path d="M1.8 3.6 7 8l5.2-4.4" />
    </svg>
  );
}

const ACCEPTANCE_OPTIONS: DropdownOption[] = [
  {
    value: 'all_phases_pass',
    label: 'Every phase passed',
    description: 'The run is accepted only when every phase ends in success.',
  },
  {
    value: 'last_phase_pass',
    label: 'The last phase passed',
    description: "Only the final phase's status decides acceptance.",
  },
  {
    value: 'envelope_status',
    label: "A phase's envelope reports success",
    description: "Accepted when a chosen phase's envelope status is success.",
  },
  {
    value: 'phase_flag',
    label: "A phase's envelope sets a flag",
    description: 'Accepted when a chosen phase sets passed or approved.',
  },
];

function phaseComposition(phases: PhaseDef[]): string {
  const agents = phases.filter((p) => p.kind === 'agent').length;
  const commands = phases.filter((p) => p.kind === 'code').length;
  const checkpoints = phases.filter((p) => p.kind === 'engineer').length;
  const parts: string[] = [];
  if (agents) parts.push(`${agents} agent${agents === 1 ? '' : 's'}`);
  if (commands) parts.push(`${commands} command${commands === 1 ? '' : 's'}`);
  if (checkpoints) parts.push(`${checkpoints} checkpoint${checkpoints === 1 ? '' : 's'}`);
  if (!parts.length) return 'Empty';
  return parts.join(' · ');
}

function pipelineHue(pipeline: PipelineDef, agentColor: (name: string | null) => string): string {
  const firstAgent = pipeline.phases.find((p) => p.kind === 'agent' && p.agent);
  if (firstAgent?.agent) return agentColor(firstAgent.agent);
  return 'var(--accent)';
}

/* ── phase track ─────────────────────────────────────────────────────── */

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

function PlusGlyph(): React.JSX.Element {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M7 2v10M2 7h10" />
    </svg>
  );
}

function ChevronDownGlyph(): React.JSX.Element {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3.5 5.25 7 8.75l3.5-3.5" />
    </svg>
  );
}

const ADD_PHASE_OPTIONS: DropdownOption[] = [
  {
    value: 'agent',
    label: 'Agent',
    description: 'Prompt an agent with an envelope',
    icon: <AgentGlyph />,
  },
  {
    value: 'code',
    label: 'Command',
    description: 'Run a project command or shell script',
    icon: <CommandGlyph />,
  },
  {
    value: 'engineer',
    label: 'Checkpoint',
    description: 'Pause execution for human approval',
    icon: <CheckpointGlyph />,
  },
];

function PhaseGlyph({ kind }: { kind: PhaseDef['kind'] }): React.JSX.Element {
  if (kind === 'agent') return <AgentGlyph />;
  if (kind === 'code') return <CommandGlyph />;
  return <CheckpointGlyph />;
}

function PhaseTrack({
  pipeline,
  selected,
  onSelect,
}: {
  pipeline: PipelineDef;
  selected: number;
  onSelect: (index: number) => void;
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
          <span className={styles.pipelineEnvelopeChip} title="Envelope">
            <EnvelopeGlyph />
            <span>{phase.envelope ?? owner?.envelope ?? 'build'}</span>
          </span>
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
    <div className={styles.pipelineTrackWrap}>
      <div className={styles.pipelineTrack}>
        {pipeline.phases.map((phase, i) => (
          <div key={i} className={styles.pipelinePhaseCell} role="presentation">
            {i > 0 && <span className={styles.pipelinePhaseConnector} aria-hidden />}
            <button
              type="button"
              className={`${styles.pipelinePhaseNode} ${selected === i ? styles.on : ''}`}
              style={{ ['--hue' as string]: hue(phase) }}
              onClick={() => onSelect(i)}
              aria-pressed={selected === i}
            >
              <span className={styles.pipelinePhaseNumber}>{String(i + 1).padStart(2, '0')}</span>
              <span className={styles.pipelinePhaseBox}>
                <span className={styles.pipelinePhaseIcon}>
                  <PhaseGlyph kind={phase.kind} />
                </span>
                <span className={styles.pipelinePhaseName}>{phase.name}</span>
              </span>
              <span className={styles.pipelinePhaseKind}>{KIND_LABEL[phase.kind]}</span>
              <span className={styles.pipelinePhaseMeta}>{meta(phase)}</span>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function PipelinesScreen({
  onOpenSettings,
}: {
  onOpenSettings?: (pane: string) => void;
} = {}): React.JSX.Element {
  const { pipelines, project, projectId, agents, agentColor, refreshScoped } = useApp();
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState<PipelineDef | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [openPhase, setOpenPhase] = useState(0);
  const [dryRun, setDryRun] = useState<DryRunPrompt[] | null>(null);
  const [dryRunError, setDryRunError] = useState('');

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
    const base = { name: `phase_${n}`, description: '' };
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
          name: 'phase_1',
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
    void flush();
    setSelectedId(id);
  };
  const onTablistKey = useTablistNav();
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
      <div className={styles.pipelineScreen}>
        <header className={styles.pipelineHeader}>
          <p className="eyebrow">
            <span className="index">02</span>Pipelines
          </p>
        </header>
        {/* ── pipeline strip: each pipeline as a full cell, roster-style ── */}
        <div
          className={styles.pipelineTabs}
          role="tablist"
          aria-label="Pipelines"
          onKeyDown={onTablistKey}
        >
          <div className={styles.pipelineTabsInner}>
            {pipelines.map((p) => {
              const isActive = p.id === selectedId;
              const hue = pipelineHue(p, agentColor);
              return (
                <button
                  key={p.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  tabIndex={isActive ? 0 : -1}
                  className={`${styles.pipelineCell} ${isActive ? styles.on : ''}`}
                  style={{ ['--hue' as string]: hue }}
                  onClick={() => selectPipeline(p.id)}
                >
                  <span className={styles.pipelineCellMark} aria-hidden>
                    <span className={styles.pipelineCellCount}>{p.phases.length}</span>
                    <span className={styles.pipelineCellDots}>
                      {p.phases.slice(0, 5).map((phase, i) => (
                        <span
                          key={`${phase.name}-${i}`}
                          className={styles.pipelineCellDot}
                          style={{
                            background: phaseKindColor(phase.kind, agentColor(phase.agent ?? null)),
                          }}
                        />
                      ))}
                      {p.phases.length > 5 && (
                        <span className={styles.pipelineCellDotMore}>+{p.phases.length - 5}</span>
                      )}
                    </span>
                  </span>
                  <span className={styles.pipelineCellWho}>
                    <span className={styles.pipelineCellName}>{p.name}</span>
                    <span className={styles.pipelineCellDesc}>
                      {p.description || 'No description yet.'}
                    </span>
                    <span className={styles.pipelineCellMeta}>{phaseComposition(p.phases)}</span>
                  </span>
                  {isActive && <span className={styles.pipelineCellUnderline} aria-hidden />}
                </button>
              );
            })}
            <button
              type="button"
              className={styles.pipelineNew}
              onClick={() => void createPipeline()}
            >
              + New pipeline
            </button>
          </div>
        </div>

        {draft && (
          <div className={styles.pipelineScroll}>
            <div className={styles.pipelinePage}>
              {/* ── identity ── */}
              <div className={styles.pipelineIdentity}>
                <div className={styles.pipelineIdentityMain}>
                  <div className={styles.pipelineIdentityTitlerow}>
                    <input
                      className={styles.pipelineTitle}
                      aria-label="Pipeline name"
                      value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    />
                    <span className={styles.pipelineIdentityBadge}>
                      {draft.phases.length} phase{draft.phases.length === 1 ? '' : 's'}
                      {draft.builtin ? ' · shipped' : ''}
                    </span>
                  </div>
                  <input
                    className={styles.pipelineDesc}
                    aria-label="Pipeline description"
                    value={draft.description}
                    placeholder="What is this pipeline for?"
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  />
                </div>
                <div className={styles.pipelineHeadActions}>
                  <button
                    type="button"
                    className={styles.pipelineAction}
                    disabled={!projectId}
                    title={!projectId ? 'Select a project first' : undefined}
                    onClick={() => void preview()}
                  >
                    Dry run
                  </button>
                  {selected && (
                    <button
                      type="button"
                      className={styles.pipelineAction}
                      onClick={() => void duplicate()}
                    >
                      Duplicate
                    </button>
                  )}
                  {selected && !selected.builtin && (
                    <button
                      type="button"
                      className={`${styles.pipelineAction} ${styles.danger}`}
                      onClick={() => void remove()}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>

              {/* ── phase track ── */}
              <PhaseTrack
                pipeline={draft}
                selected={openPhase}
                onSelect={(i) => setOpenPhase(i === openPhase ? -1 : i)}
              />

              {/* ── phase rows ── */}
              <section className={styles.pipelinePhases} aria-label="Phases">
                <div className={styles.pipelineSectionHead}>
                  <div className={styles.pipelineSectionTitleRow}>
                    <p className="eyebrow">
                      <span className="index">01</span>Phases
                    </p>
                    <span className={styles.pipelineSectionCount}>
                      {draft.phases.length} step{draft.phases.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <Dropdown
                    value=""
                    options={ADD_PHASE_OPTIONS}
                    onChange={(kind) => addPhase(kind as PhaseDef['kind'])}
                    className={styles.pipelineAddDropdownWrap}
                    triggerClassName={styles.pipelineHeaderAddBtn}
                    renderValue={() => (
                      <span className={styles.pipelineHeaderAddFace}>
                        <PlusGlyph />
                        <span>Add phase</span>
                        <ChevronDownGlyph />
                      </span>
                    )}
                  />
                </div>
                <div className={styles.pipelinePhaseList}>
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
                      onOpenSettings={onOpenSettings}
                    />
                  ))}
                </div>
              </section>

              {/* ── acceptance ── */}
              <section className={styles.pipelineAcceptance} aria-label="Acceptance">
                <div className={styles.pipelineSectionHead}>
                  <p className="eyebrow">
                    <span className="index">02</span>Acceptance
                  </p>
                  <span className={styles.pipelineSectionCount}>
                    evaluated when the run settles
                  </span>
                </div>
                <div className={styles.pipelineAcceptanceRow}>
                  <div className={styles.pipelineField}>
                    <span className={styles.pipelineFieldLabel}>A run counts as accepted when</span>
                    <span className={styles.pipelineFieldControl}>
                      <Dropdown
                        value={draft.acceptance.kind}
                        options={ACCEPTANCE_OPTIONS}
                        triggerClassName={styles.pipelineSelect}
                        onChange={(next) => setAcceptanceKind(next as Acceptance['kind'])}
                      />
                    </span>
                    <span className={styles.pipelineFieldHint}>
                      A run where every phase passed is not automatically a run that did what was
                      asked.
                    </span>
                  </div>
                  {acceptancePhase !== null && (
                    <div className={styles.pipelineField}>
                      <span className={styles.pipelineFieldLabel}>Phase</span>
                      <span className={styles.pipelineFieldControl}>
                        <Dropdown
                          value={acceptancePhase}
                          options={draft.phases.map((p) => ({ value: p.name, label: p.name }))}
                          triggerClassName={styles.pipelineSelect}
                          onChange={setAcceptancePhase}
                        />
                      </span>
                    </div>
                  )}
                  {draft.acceptance.kind === 'phase_flag' && (
                    <div className={`${styles.pipelineField} ${styles.pipelineFieldNarrow}`}>
                      <span className={styles.pipelineFieldLabel}>Flag</span>
                      <span className={styles.pipelineFieldControl}>
                        <Dropdown
                          value={(draft.acceptance as { flag: string }).flag}
                          options={[
                            { value: 'passed', label: 'passed' },
                            { value: 'approved', label: 'approved' },
                          ]}
                          triggerClassName={styles.pipelineSelect}
                          onChange={(next) => setAcceptanceFlag(next as 'passed' | 'approved')}
                        />
                      </span>
                    </div>
                  )}
                  <label className={styles.pipelineWorktree}>
                    <input
                      type="checkbox"
                      checked={draft.isolation !== false}
                      onChange={(e) => setDraft({ ...draft, isolation: e.target.checked })}
                    />
                    <span>
                      <span className={styles.pipelineWorktreeTitle}>Isolated git worktree</span>
                      <span className={styles.pipelineFieldHint}>
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
          <div className={styles.pipelineValidation}>
            <span className="eyebrow">
              <span className="index">03</span>Validation
            </span>
            <div className={styles.pipelineValidationItems}>
              {readyCopy && (
                <span
                  className={`${styles.pipelineValItem} ${errors.length === 0 && warnings.length === 0 ? 'ok' : ''}`}
                >
                  {readyCopy}
                </span>
              )}
              {[...errors, ...warnings].map((issue, i) => (
                <span key={i} className={`${styles.pipelineValItem} ${issue.level}`}>
                  <span className={styles.pipelineValMark}>
                    {issue.level === 'error' ? '✕' : '!'}
                  </span>
                  <strong>{issue.where}</strong> {issue.message}
                </span>
              ))}
              {dryRunError && (
                <span className={`${styles.pipelineValItem} error`}>{dryRunError}</span>
              )}
            </div>
            <span className={styles.pipelineAutosave}>Changes save automatically</span>
          </div>
        )}

        {!draft && (
          <div className={styles.pipelineEmpty}>
            <EmptyState
              art="scenes/empty-state.png"
              title={pipelines.length ? 'No pipeline selected' : 'No pipelines yet'}
              body={
                pipelines.length
                  ? 'Pick a pipeline from the list or create a new one. Pipelines are data — reorder phases, swap agents, and save.'
                  : 'This workspace has no pipelines. Create one to define how agents should work together.'
              }
            >
              <Button variant="primary" onClick={() => void createPipeline()}>
                New pipeline
              </Button>
            </EmptyState>
          </div>
        )}
        {dryRun && <DryRunSheet prompts={dryRun} onClose={() => setDryRun(null)} />}
      </div>
    </>
  );
}
