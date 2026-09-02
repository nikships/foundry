import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import {
  BUILTIN_ENVELOPE_BLURBS,
  BUILTIN_ENVELOPE_KINDS,
  resolveAgentExecution,
  type AgentDef,
  type ModelInfo,
  type ValidationIssue,
} from '@shared/types.js';
import { modelLabel } from '@shared/model-label.js';
import { modelForEffortPicker } from '@shared/reasoning-effort.js';
import { api, plain } from '../api.js';
import type { DesignTab } from '../utils/navigation.js';
import { useApp } from '../stores/app.js';
import {
  addField,
  validateCustomFields,
  shadowedLibraryFields,
} from '../view-models/custom-fields.js';
import AgentAvatar from '../components/media/AgentAvatar.js';
import AgentIconPicker from '../components/media/AgentIconPicker.js';
import { ProviderIcon } from '../components/media/BrandIcon.js';
import ModelPicker from '../components/common/ModelPicker.js';
import ReasoningEffortPicker from '../components/common/ReasoningEffortPicker.js';
import BoundaryEditor from '../components/pipeline/BoundaryEditor.js';
import CustomFieldsEditor from '../components/project/CustomFieldsEditor.js';
import { Button } from '../components/ui/Button.js';
import PromptPreview from '../components/common/PromptPreview.js';
import { Dropdown, type DropdownOption } from '../components/ui/Dropdown.js';
import { Field, TextInput, Textarea } from '../components/ui/Field.js';
import { defaultEmblemFor, isDefaultMark, markLabel } from '../data/emblems.js';
import { useConfirmAction } from '../hooks/useConfirmAction.js';
import { useDebouncedSave } from '../hooks/useDebouncedSave.js';
import { useTablistNav } from '../hooks/useTablistNav.js';
import { useAgentModels } from '../hooks/useAgentModels.js';
import { draftSyncAction } from '../view-models/roster-draft.js';
import { rosterScrollEdges } from '../view-models/roster-scroll.js';
import styles from './RosterScreen.module.css';

const COLORS = ['#4fa8b8', '#9b7ede', '#d19a3d', '#3cb87a', '#e0605f', '#5b8fd9'];

const TOOL_PROFILE_OPTIONS: DropdownOption[] = [
  { value: 'full', label: 'Full', description: 'Read, search, edit, write, and run commands.' },
  {
    value: 'read-only',
    label: 'Read-only',
    description: 'Read and search only — no editing tool and no shell exist for this agent.',
  },
];

const CREW = [
  ['Refiner', 'grounds a rough request in the repository'],
  ['Planner', 'turns the request into reviewable tasks'],
  ['Builder', 'implements the work in isolation'],
  ['Scout', 'maps the files and patterns that matter'],
  ['Reviewer', 'judges the diff before it ships'],
  ['Finisher', 'closes gaps against the ship bar'],
  ['Documenter', 'records the decisions and follow-ups'],
  ['PR writer', 'drafts the pull request'],
  ['Issue writer', 'turns follow-up work into an issue'],
] as const;

/**
 * The brand behind a stored model id, for the roster's badge.
 *
 * Read off the catalog rather than parsed out of the id: `bridge-claude/…` and
 * `anthropic/…` are the same brand, and only the catalog knows that. An id no
 * connected provider offers has no mark, which is the same honest gap a missing
 * logo leaves everywhere else.
 */
function providerFor(model: string, models: ModelInfo[]): string {
  return models.find((m) => m.id === model)?.provider ?? '';
}

/** Provider mark plus the model's label, with the inheritance sentinel named as a model default. */
function ModelBadge({
  model,
  models,
  size,
}: {
  model: string;
  models: ModelInfo[];
  size: number;
}): React.JSX.Element {
  return (
    <>
      <ProviderIcon provider={providerFor(model, models)} size={size} />
      {model === 'inherit'
        ? 'default model'
        : !models.some((m) => m.id === model)
          ? 'inherit'
          : modelLabel(model)}
    </>
  );
}

function MarkTrigger({
  draft,
  size,
  onClick,
}: {
  draft: AgentDef;
  size: number;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-mark-trigger
      aria-label={`Change mark for ${draft.name}`}
      onClick={onClick}
      className={styles.avatarTrigger}
    >
      <AgentAvatar name={draft.name} emblem={draft.emblem} color={draft.color} size={size} />
      <span className={styles.avatarTriggerOverlay} aria-hidden />
    </button>
  );
}

function CustomAccentSwatch({
  color,
  onChange,
}: {
  color: string;
  onChange: (color: string) => void;
}): React.JSX.Element {
  const isCustom = !COLORS.includes(color.toLowerCase());
  const safeValue = /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#4fa8b8';
  return (
    <label
      className={`${styles.swatch} ${styles.colorPickerWrapper} ${isCustom ? styles.on : ''}`}
      title="Custom accent color"
    >
      <span
        className={styles.swatchDot}
        style={{
          background: isCustom
            ? color
            : 'conic-gradient(red, yellow, lime, aqua, blue, magenta, red)',
        }}
      />
      <input
        type="color"
        aria-label="Custom accent color"
        value={safeValue}
        onChange={(e) => onChange(e.target.value.toLowerCase())}
        className={styles.colorInput}
      />
    </label>
  );
}

export default function RosterScreen({
  onOpenDesignTab,
  openAgent,
  openNonce = 0,
}: {
  /** Cross-link to a sibling Design tab, e.g. the envelope library. */
  onOpenDesignTab?: (tab: DesignTab) => void;
  /** Deep link (e.g. a Smith approve): select this agent when it resolves. */
  openAgent?: string;
  /** Bumped per deep-link so re-selecting the same agent re-fires the effect. */
  openNonce?: number;
} = {}): React.JSX.Element {
  const { agents, envelopes, projectId, settings, refreshScoped } = useApp();
  const [selectedName, setSelectedName] = useState('');
  const [draft, setDraft] = useState<AgentDef | null>(null);
  /** Kept out of `draft`: a name is committed on blur or Enter, not per keystroke. */
  const [nameDraft, setNameDraft] = useState('');
  const [renameError, setRenameError] = useState('');
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [actionError, setActionError] = useState('');
  const [staleBuiltins, setStaleBuiltins] = useState<Set<string>>(new Set());
  const { models, refresh: refreshModels } = useAgentModels();
  const [showPreview, setShowPreview] = useState(false);
  const [showIconPicker, setShowIconPicker] = useState(false);
  const rosterTabsRef = useRef<HTMLDivElement>(null);
  const [scrollEdges, setScrollEdges] = useState({ before: false, after: false });
  const agentsRef = useRef<AgentDef[]>(agents);
  agentsRef.current = agents;
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const lastSyncedNameRef = useRef<string | null>(null);

  const selected = useMemo(
    () => agents.find((a) => a.name === selectedName) ?? null,
    [agents, selectedName],
  );
  const rosterModelInfo = useMemo(() => {
    if (!draft) return null;
    const chosen = draft.inheritDefaults ? settings?.defaultModel : draft.model;
    return modelForEffortPicker(chosen, models, settings?.defaultModel);
  }, [draft, models, settings?.defaultModel]);
  /**
   * `agentSchema` rejects a malformed field name but accepts a duplicate or a
   * name that shadows a base field, both of which the engine would silently
   * collapse into one key. Those are caught here so autosave is blocked on
   * them rather than persisting a shape the agent cannot satisfy.
   */
  const fieldIssues = useMemo(
    () => validateCustomFields(draft?.customFields),
    [draft?.customFields],
  );

  /**
   * Store issues plus the field checks below. Deduped on `where` because
   * `agentSchema` already reports a malformed field name at the same path;
   * showing both would put two lines on one problem.
   */
  const allIssues = useMemo(() => {
    const claimed = new Set(issues.map((i) => i.where));
    return [...issues, ...fieldIssues.filter((i) => !claimed.has(i.where))];
  }, [issues, fieldIssues]);
  const errors = useMemo(() => allIssues.filter((i) => i.level === 'error'), [allIssues]);

  /**
   * A custom envelope's own fields are shadowed by an agent field of the same
   * name (the engine's precedence), which is a legitimate override but an
   * invisible one — so the editor names it rather than leaving it to a run.
   */
  const shadowed = useMemo(
    () =>
      shadowedLibraryFields(
        draft?.customFields,
        envelopes.find((e) => e.name === draft?.envelope)?.fields,
      ),
    [draft?.customFields, draft?.envelope, envelopes],
  );
  const envelopeOptions = useMemo<DropdownOption[]>(() => {
    const builtin: DropdownOption[] = BUILTIN_ENVELOPE_KINDS.map((kind) => ({
      value: kind,
      label: kind,
      description: BUILTIN_ENVELOPE_BLURBS[kind],
      group: 'Built-in',
    }));
    const custom: DropdownOption[] = envelopes.map((env) => ({
      value: env.name,
      label: env.name,
      description: env.description || undefined,
      group: 'Custom',
    }));
    return [...builtin, ...custom];
  }, [envelopes]);

  const displayedModel = (agent: AgentDef): string =>
    resolveAgentExecution(agent, {
      model: settings?.defaultModel,
      reasoningEffort: settings?.defaultReasoningEffort ?? 'medium',
    }).model;

  useEffect(() => {
    if (!agents.some((a) => a.name === selectedName)) setSelectedName(agents[0]?.name ?? '');
  }, [agents, selectedName]);

  useEffect(() => {
    const tabs = rosterTabsRef.current;
    if (!tabs) return;
    const updateEdges = (): void => setScrollEdges(rosterScrollEdges(tabs));
    updateEdges();
    const observer = new ResizeObserver(updateEdges);
    observer.observe(tabs);
    if (tabs.firstElementChild) observer.observe(tabs.firstElementChild);
    return () => observer.disconnect();
  }, [agents.length]);

  useEffect(() => {
    let cancelled = false;
    void api.roster.staleBuiltins(projectId || undefined).then((names) => {
      if (!cancelled) setStaleBuiltins(new Set(names));
    });
    return () => {
      cancelled = true;
    };
  }, [agents, projectId]);

  // Deep link from a Smith approve: once the saved agent shows up in the list,
  // select it so the editor opens on it. `openNonce` re-fires the effect when
  // the same agent is approved twice in a row.
  useEffect(() => {
    if (openAgent && agents.some((a) => a.name === openAgent)) setSelectedName(openAgent);
  }, [openAgent, openNonce, agents]);

  useEffect(() => {
    const action = draftSyncAction({
      selectedName: selected?.name ?? null,
      hasAgents: agents.length > 0,
      lastSyncedName: lastSyncedNameRef.current,
    });
    if (action === 'clear') {
      setDraft(null);
      lastSyncedNameRef.current = null;
      return;
    }
    if (action === 'keep' || !selected) return;
    setDraft(plain({ ...selected }));
    setNameDraft(selected.name);
    setRenameError('');
    setIssues([]);
    setActionError('');
    lastSyncedNameRef.current = selected.name;
  }, [selected, agents.length]);

  useEffect(() => {
    if (!draft) {
      setIssues([]);
      return;
    }
    let cancelled = false;
    void api.roster.validate(draft).then((next) => {
      if (!cancelled) setIssues(next);
    });
    return () => {
      cancelled = true;
    };
  }, [draft]);

  // Live auto-save: every valid edit persists shortly after typing stops.
  // Visual truth is the source of truth. `flush` is called on switch/rename,
  // `cancel` before a delete so a queued save cannot re-create the agent.
  const { flush, cancel } = useDebouncedSave<AgentDef>({
    value: draft,
    delay: 350,
    disabled: errors.length > 0,
    compare: (d) => agentsRef.current.find((a) => a.name === d.name) ?? null,
    validate: (d) => api.roster.validate(d),
    save: (d) => api.roster.save(d, projectIdRef.current || undefined),
    onSuccess: async () => {
      setIssues([]);
      await refreshScoped();
    },
    onIssues: setIssues,
    onError: (e) => setIssues([{ level: 'error', where: 'save', message: (e as Error).message }]),
  });

  const selectAgent = (name: string): void => {
    if (name === selectedName) return;
    void flush();
    setSelectedName(name);
  };
  const onTablistKey = useTablistNav();
  const scrollRoster = (direction: -1 | 1): void => {
    const tabs = rosterTabsRef.current;
    if (!tabs) return;
    tabs.scrollBy({ left: direction * Math.max(340, tabs.clientWidth * 0.75), behavior: 'smooth' });
  };

  /**
   * A rename is a separate operation from a save: `save` upserts by name, so
   * persisting a half-typed name would append an agent per keystroke.
   */
  const commitName = async (): Promise<void> => {
    if (!draft || !selected) return;
    const next = nameDraft.trim();
    if (!next || next === selected.name) {
      setNameDraft(selected.name);
      setRenameError('');
      return;
    }
    await flush();
    try {
      const result = await api.roster.rename(selected.name, next, projectId || undefined);
      if (!result.ok) {
        setRenameError(result.issues.map((i) => i.message).join(' '));
        return;
      }
      setRenameError('');
      lastSyncedNameRef.current = null;
      setSelectedName(next);
      await refreshScoped();
    } catch (e) {
      setRenameError((e as Error).message);
    }
  };

  const duplicate = async (): Promise<void> => {
    if (!selected) return;
    setActionError('');
    try {
      const copy = await api.roster.duplicate(selected.name, projectId || undefined);
      await refreshScoped();
      if (copy) setSelectedName(copy.name);
      else setActionError('Could not duplicate that agent.');
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

  const remove = useConfirmAction(
    () => `Delete agent “${selected?.name}”? Pipelines that name it will break.`,
    async (): Promise<void> => {
      if (!selected || selected.builtin) return;
      setActionError('');
      // A queued save for this agent would re-create it moments after the delete.
      cancel();
      try {
        await api.roster.remove(selected.name, projectId || undefined);
        await refreshScoped();
      } catch (e) {
        setActionError((e as Error).message);
      }
    },
    { title: 'Delete Agent', confirmLabel: 'Delete', variant: 'danger' },
  );

  const resetToShipped = useConfirmAction(
    () => `Reset agent “${selected?.name}” to the version shipped with Foundry?`,
    async (): Promise<void> => {
      if (!selected?.builtin) return;
      setActionError('');
      cancel();
      try {
        await api.roster.reset(selected.name, projectId || undefined);
        lastSyncedNameRef.current = null;
        setStaleBuiltins((current) => {
          const next = new Set(current);
          next.delete(selected.name);
          return next;
        });
        await refreshScoped();
      } catch (e) {
        setActionError((e as Error).message);
      }
    },
    { title: 'Reset Agent', confirmLabel: 'Reset to shipped version' },
  );

  const createAgent = async (): Promise<void> => {
    setActionError('');
    // The pane is about to move off the current agent, so persist its pending
    // edits first — exactly as an explicit tab switch does.
    await flush();
    // Counting agents collides after any delete, and save upserts by name, so a
    // collision would silently overwrite an existing agent instead of adding one.
    const taken = new Set(agents.map((a) => a.name));
    let n = agents.length + 1;
    while (taken.has(`agent-${n}`)) n += 1;
    const fresh: AgentDef = {
      name: `agent-${n}`,
      purpose: 'Describe what this agent is for in one line.',
      model: 'inherit',
      reasoningEffort: settings?.defaultReasoningEffort ?? 'medium',
      inheritDefaults: true,
      systemPrompt: 'You are a careful engineer. State what you did and what you did not do.',
      userPrompt: 'Work on: {{request}}',
      writes: null,
      envelope: 'build',
      color: '#4fa8b8',
    };
    try {
      const result = await api.roster.save(fresh, projectId || undefined);
      if (result.ok) {
        await refreshScoped();
        // Only move the selection: stamping `lastSyncedNameRef` here would tell
        // the sync effect the draft was already loaded from the new agent, and
        // the pane would keep showing the previous one (FOU-41).
        setSelectedName(fresh.name);
      } else {
        setIssues(result.issues);
        setActionError(result.issues.map((i) => i.message).join(' '));
      }
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

  // tests/renderer/roster-draft.test.ts uses this declaration as a source
  // marker delimiting createAgent, so it stays in place below it.
  const TEMPLATE_TOKENS = ['request', 'worktree', 'plan.envelope.summary'].map((t) => `{{${t}}}`);

  return (
    <div className={styles.rosterScreen}>
      {/* ── agent strip: every agent, one horizontal band ── */}
      <div className={styles.rosterTabs}>
        <div
          ref={rosterTabsRef}
          className={styles.rosterTabsInner}
          role="tablist"
          aria-label="Agents"
          onKeyDown={onTablistKey}
          onScroll={(event) => setScrollEdges(rosterScrollEdges(event.currentTarget))}
        >
          {agents.map((agent) => {
            const isActive = agent.name === selectedName;
            return (
              <button
                key={agent.name}
                type="button"
                role="tab"
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                className={`${styles.rosterCell} ${isActive ? styles.on : ''}`}
                style={{ ['--hue' as string]: agent.color ?? 'var(--accent)' }}
                onClick={() => selectAgent(agent.name)}
                data-testid={`agent-tab-${agent.name}`}
              >
                <AgentAvatar name={agent.name} size={30} />
                <span className={styles.rosterCellWho}>
                  <span className={styles.rosterCellName}>{agent.name}</span>
                  {staleBuiltins.has(agent.name) && (
                    <span className={styles.staleBadge}>Shipped update</span>
                  )}
                  <span className={styles.rosterCellRole}>{agent.purpose}</span>
                  <span className={styles.rosterCellModel}>
                    {isActive && <span className={styles.rosterCellDot} aria-hidden />}
                    <ModelBadge model={displayedModel(agent)} models={models} size={11} />
                  </span>
                </span>
                {isActive && <span className={styles.rosterCellUnderline} aria-hidden />}
              </button>
            );
          })}
          <button
            type="button"
            className={styles.rosterNew}
            onClick={() => void createAgent()}
            data-testid="agent-new"
          >
            + New agent
          </button>
        </div>
        {scrollEdges.before && (
          <button
            type="button"
            className={`${styles.rosterScrollControl} ${styles.before}`}
            aria-label="Scroll to earlier agents"
            onClick={() => scrollRoster(-1)}
          >
            <ChevronLeft size={18} aria-hidden />
          </button>
        )}
        {scrollEdges.after && (
          <button
            type="button"
            className={`${styles.rosterScrollControl} ${styles.after}`}
            aria-label="Scroll to later agents"
            onClick={() => scrollRoster(1)}
          >
            <ChevronRight size={18} aria-hidden />
          </button>
        )}
      </div>

      {draft && (
        <div className={styles.rosterScroll}>
          <div className={styles.rosterPage}>
            {/* ── title row ── */}
            <div className={styles.rosterHead}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 'var(--s4)',
                  minWidth: 0,
                }}
              >
                <MarkTrigger draft={draft} size={52} onClick={() => setShowIconPicker(true)} />
                <div className={styles.rosterHeadMain}>
                  <div className={styles.rosterHeadTitlerow}>
                    <h1
                      className={styles.rosterTitle}
                      style={{ color: draft.color ?? 'var(--accent)' }}
                    >
                      {draft.name}
                    </h1>
                    <span className={styles.rosterHeadMeta}>
                      <ModelBadge model={displayedModel(draft)} models={models} size={13} /> ·{' '}
                      {draft.envelope}
                    </span>
                  </div>
                  <p className={styles.rosterHeadSub}>
                    {draft.purpose || 'No purpose yet.'}{' '}
                    <span className={styles.rosterHeadTag}>
                      {draft.builtin ? 'Shipped with Foundry, editable' : 'Custom agent'}
                    </span>
                    {staleBuiltins.has(draft.name) && (
                      <span className={styles.staleBadge}>Shipped version differs</span>
                    )}
                  </p>
                </div>
              </div>
              <div className={styles.rosterHeadActions}>
                <button
                  type="button"
                  className={styles.rosterAction}
                  onClick={() => setShowPreview(true)}
                  data-testid="agent-preview"
                >
                  Preview prompt
                </button>
                <button
                  type="button"
                  className={styles.rosterAction}
                  onClick={() => void duplicate()}
                  data-testid="agent-duplicate"
                >
                  Duplicate
                </button>
                {draft.builtin && staleBuiltins.has(draft.name) && (
                  <button
                    type="button"
                    className={styles.rosterAction}
                    onClick={() => void resetToShipped()}
                    data-testid="agent-reset"
                  >
                    Reset to shipped version
                  </button>
                )}
                {!draft.builtin && (
                  <button
                    type="button"
                    className={`${styles.rosterAction} ${styles.danger}`}
                    onClick={() => void remove()}
                    data-testid="agent-delete"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>

            {/* ── identity ── */}
            <section className={styles.rosterSection}>
              <div className={styles.rosterSectionLabel}>
                <p className="eyebrow">
                  <span className="index">01</span>Identity
                </p>
                <p>How this agent is referenced in pipelines and run logs.</p>
              </div>
              <div className={styles.rosterFields}>
                <Field label="Mark" className={styles.span2}>
                  <div className={styles.identityMarkRow}>
                    <MarkTrigger draft={draft} size={44} onClick={() => setShowIconPicker(true)} />
                    <div className={styles.identityMarkInfo}>
                      <div className={styles.identityMarkMeta}>
                        <span className={styles.identityMarkLabel}>{markLabel(draft.emblem)}</span>
                        <span className={styles.identityMarkDot} aria-hidden>
                          ·
                        </span>
                        <button
                          type="button"
                          data-mark-trigger
                          onClick={() => setShowIconPicker(true)}
                          className={styles.changeMarkBtn}
                        >
                          Change mark
                        </button>
                        {!isDefaultMark({
                          name: draft.name,
                          emblem: draft.emblem,
                          builtin: draft.builtin,
                        }) && (
                          <button
                            type="button"
                            onClick={() =>
                              setDraft({
                                ...draft,
                                emblem: defaultEmblemFor({
                                  name: draft.name,
                                  builtin: draft.builtin,
                                }),
                              })
                            }
                            className={styles.resetMarkBtn}
                          >
                            <RotateCcw size={11} />
                            Reset
                          </button>
                        )}
                      </div>
                      <span className={styles.hint}>
                        An emblem, a custom upload, or the initial letter. Shown wherever this agent
                        appears.
                      </span>
                    </div>
                  </div>
                </Field>
                <Field label="Name">
                  <TextInput
                    mono
                    value={nameDraft}
                    aria-label="Agent name"
                    onChange={(e) => {
                      setNameDraft(e.target.value);
                      setRenameError('');
                    }}
                    onBlur={() => void commitName()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      if (e.key === 'Escape') {
                        setNameDraft(draft.name);
                        setRenameError('');
                        e.currentTarget.blur();
                      }
                    }}
                  />
                  <span className={styles.hint}>
                    {draft.builtin
                      ? 'Renaming a shipped agent copies it under the new name and leaves the original in place, so pipelines keep working.'
                      : 'Applied when you leave the field. Pipeline phases naming this agent are repointed for you.'}
                  </span>
                  {renameError && <span className={styles.hint}>{renameError}</span>}
                </Field>
                <Field label="Purpose">
                  <TextInput
                    value={draft.purpose}
                    aria-label="Agent purpose"
                    onChange={(e) => setDraft({ ...draft, purpose: e.target.value })}
                  />
                  <span className={styles.hint}>One line, shown wherever this agent appears.</span>
                </Field>
                <Field label="Accent" className={styles.span2}>
                  <div className={styles.swatches}>
                    {COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={`${styles.swatch} ${draft.color === c ? styles.on : ''}`}
                        aria-label={`Accent ${c}`}
                        aria-pressed={draft.color === c}
                        onClick={() => setDraft({ ...draft, color: c })}
                      >
                        <span className={styles.swatchDot} style={{ background: c }} />
                      </button>
                    ))}
                    <CustomAccentSwatch
                      color={draft.color}
                      onChange={(color) => setDraft({ ...draft, color })}
                    />
                    <span className={styles.swatchHex}>{draft.color}</span>
                  </div>
                  <span className={styles.hint}>Used for this agent's lane in the waterfall.</span>
                </Field>
              </div>
            </section>

            {/* ── execution ── */}
            <section className={styles.rosterSection}>
              <div className={styles.rosterSectionLabel}>
                <p className="eyebrow">
                  <span className="index">02</span>Execution
                </p>
                <p>Model selection and reasoning effort for this agent.</p>
              </div>
              <div className={styles.rosterFields}>
                <Field label="Defaults" className={styles.span2}>
                  <label className={styles.rosterCheck}>
                    <input
                      type="checkbox"
                      checked={!!draft.inheritDefaults}
                      onChange={(e) => setDraft({ ...draft, inheritDefaults: e.target.checked })}
                      data-testid="roster-inherit-defaults"
                    />
                    Follow all Agent defaults
                  </label>
                  <span className={styles.hint}>
                    Overrides both fields below. The model can follow its default independently.
                  </span>
                </Field>
                <Field label="Model">
                  <ModelPicker
                    value={
                      draft.inheritDefaults ? (settings?.defaultModel ?? 'inherit') : draft.model
                    }
                    models={models}
                    allowInherit
                    disabled={!!draft.inheritDefaults}
                    emptyHint="No models are reachable. Connect a provider under Settings → Providers, or use Inherit."
                    onChange={(value) => setDraft({ ...draft, model: value })}
                    onRefresh={() => void refreshModels()}
                  />
                  <span className={styles.hint}>
                    {draft.inheritDefaults
                      ? 'Following Settings → Agent defaults.'
                      : '“Inherit” uses the default model from Settings.'}
                  </span>
                </Field>
                <Field label="Reasoning effort">
                  <ReasoningEffortPicker
                    value={
                      draft.inheritDefaults
                        ? (settings?.defaultReasoningEffort ?? 'medium')
                        : draft.reasoningEffort
                    }
                    model={rosterModelInfo}
                    disabled={!!draft.inheritDefaults}
                    onChange={(effort) => setDraft({ ...draft, reasoningEffort: effort })}
                    data-testid="roster-effort"
                  />
                  <span className={styles.hint}>
                    {draft.inheritDefaults
                      ? 'Following Settings → Agent defaults.'
                      : 'Only the levels the chosen model offers.'}
                  </span>
                </Field>
                <Field label="Report kind">
                  <Dropdown
                    value={draft.envelope}
                    options={envelopeOptions}
                    triggerClassName="mono"
                    onChange={(next) => setDraft({ ...draft, envelope: next })}
                  />
                  <span className={styles.hint}>
                    The typed report this agent must return. Parsed and validated on every turn.
                    {onOpenDesignTab && (
                      <>
                        {' '}
                        <button
                          type="button"
                          className={styles.linkBtn}
                          onClick={() => onOpenDesignTab('envelopes')}
                        >
                          Manage reports…
                        </button>
                      </>
                    )}
                  </span>
                </Field>
              </div>
            </section>

            {/* ── prompts ── */}
            <section className={styles.rosterSection}>
              <div className={styles.rosterSectionLabel}>
                <p className="eyebrow">
                  <span className="index">03</span>Prompts
                </p>
                <p>The system prompt is fixed per agent; the template is filled per phase.</p>
              </div>
              <div className={styles.rosterStack}>
                <Field label="System prompt">
                  <Textarea
                    value={draft.systemPrompt}
                    rows={7}
                    aria-label="System prompt"
                    onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
                  />
                  <span className={styles.hint}>
                    The agent's standing instructions. Sent once, at the start of its session.
                  </span>
                </Field>
                <Field label="User prompt template">
                  <Textarea
                    value={draft.userPrompt}
                    rows={6}
                    aria-label="User prompt template"
                    onChange={(e) => setDraft({ ...draft, userPrompt: e.target.value })}
                  />
                  <span className={styles.hint}>
                    Supports{' '}
                    {TEMPLATE_TOKENS.map((token) => (
                      <code key={token}>{token}</code>
                    ))}{' '}
                    Declared inputs not referenced here are appended to the prompt automatically.
                  </span>
                </Field>
              </div>
            </section>

            {/* ── extra envelope fields ── */}
            <section className={styles.rosterSection}>
              <div className={styles.rosterSectionLabel}>
                <p className="eyebrow">
                  <span className="index">04</span>Extra fields
                </p>
                <p>
                  Added to the <code>{draft.envelope}</code> report for this agent only. Use these
                  when one agent must report something the shared report does not carry; change the
                  report itself when every agent using it should.
                </p>
              </div>
              <div className={styles.rosterStack}>
                <CustomFieldsEditor
                  idPrefix={`agent-${draft.name}`}
                  fields={draft.customFields ?? []}
                  onChange={(customFields) => setDraft({ ...draft, customFields })}
                />
                {(draft.customFields?.length ?? 0) === 0 && (
                  <p className={styles.rosterFieldsEmpty}>
                    No extra fields. This agent returns the {draft.envelope} report as defined.
                  </p>
                )}
                <div className={styles.rosterFieldsFoot}>
                  <Button
                    size="sm"
                    onClick={() =>
                      setDraft({ ...draft, customFields: addField(draft.customFields ?? []) })
                    }
                  >
                    Add field
                  </Button>
                  <span className={styles.hint}>
                    {shadowed.length > 0 ? (
                      <>
                        {shadowed.map((n) => (
                          <code key={n}>{n}</code>
                        ))}{' '}
                        {shadowed.length === 1 ? 'overrides a field' : 'override fields'} of the
                        same name on the <code>{draft.envelope}</code> report.
                      </>
                    ) : (
                      <>
                        Names are snake_case and must not reuse a base field (<code>status</code>,{' '}
                        <code>summary</code>, <code>artifacts</code>,{' '}
                        <code>notes_for_next_agent</code>).
                      </>
                    )}
                  </span>
                </div>
              </div>
            </section>

            {/* ── tools and write boundary ── */}
            <section className={styles.rosterSection}>
              <div className={styles.rosterSectionLabel}>
                <p className="eyebrow">
                  <span className="index">05</span>Tools and write boundary
                </p>
                <p>
                  What this agent can call, and the paths it may modify. Everything else is refused
                  at the tool layer.
                </p>
              </div>
              <div className={styles.rosterStack}>
                <Field label="Tool surface">
                  <Dropdown
                    value={draft.toolProfile ?? 'full'}
                    options={TOOL_PROFILE_OPTIONS}
                    onChange={(next) =>
                      setDraft({ ...draft, toolProfile: next as AgentDef['toolProfile'] })
                    }
                  />
                  <span className={styles.hint}>
                    Read-only opens the session without <code>edit</code>, <code>write</code>, or{' '}
                    <code>bash</code>: those tools are absent from the registry, not merely denied.
                  </span>
                </Field>
                <BoundaryEditor
                  value={draft.writes}
                  onChange={(value) => setDraft({ ...draft, writes: value })}
                />
              </div>
            </section>

            {/* ── validation + autosave ── */}
            <div className={styles.rosterStatusbar}>
              {allIssues.length > 0 ? (
                <ul className={styles.issues}>
                  {allIssues.map((issue, i) => (
                    <li key={i} className={issue.level}>
                      <strong>{issue.where}</strong> {issue.message}
                    </li>
                  ))}
                </ul>
              ) : (
                <span className={styles.rosterStatusOk}>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 14 14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M2.5 7.5 5.5 10.5 11.5 3.5" />
                  </svg>
                  No validation issues
                </span>
              )}
              {actionError && <p className={styles.actionErr}>{actionError}</p>}
              <span className={styles.rosterAutosave}>Changes save automatically</span>
            </div>
          </div>
        </div>
      )}
      {!draft && (
        <div className={styles.rosterEmpty}>
          <p className="eyebrow">Agents</p>
          <h1>Meet the crew</h1>
          <p className={styles.rosterEmptyLead}>
            Agents are editable specialists. Pipelines wire them into phases, and each phase can use
            its own model, prompt, reply report, and write boundary.
          </p>
          <ul className={styles.rosterEmptyCrew}>
            {CREW.map(([name, purpose]) => (
              <li key={name}>
                <strong>{name}</strong>
                <span>{purpose}</span>
              </li>
            ))}
          </ul>
          <Button variant="primary" onClick={() => void createAgent()}>
            Create your first agent
          </Button>
        </div>
      )}
      {showPreview && draft && (
        <PromptPreview agent={draft} onClose={() => setShowPreview(false)} />
      )}
      {showIconPicker && draft && (
        <AgentIconPicker
          name={draft.name}
          emblem={draft.emblem}
          color={draft.color}
          builtin={draft.builtin}
          onChange={(emblem) => setDraft({ ...draft, emblem })}
          onColorChange={(color) => setDraft({ ...draft, color })}
          onClose={() => setShowIconPicker(false)}
        />
      )}
    </div>
  );
}
