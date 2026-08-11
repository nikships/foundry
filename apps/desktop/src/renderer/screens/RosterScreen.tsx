import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BUILTIN_ENVELOPE_BLURBS,
  BUILTIN_ENVELOPE_KINDS,
  type AgentDef,
  type ModelInfo,
  type ValidationIssue,
} from '@shared/types.js';
import { api, plain } from '../api.js';
import { useApp } from '../stores/app.js';
import AgentAvatar from '../components/AgentAvatar.js';
import { CliIcon } from '../components/BrandIcon.js';
import ModelPicker from '../components/ModelPicker.js';
import BoundaryEditor from '../components/BoundaryEditor.js';
import PromptPreview from '../components/PromptPreview.js';
import { Dropdown, type DropdownOption } from '../components/ui/Dropdown.js';
import { Field, TextInput, Textarea } from '../components/ui/Field.js';
import { useConfirmAction } from '../hooks/useConfirmAction.js';
import { useDebouncedSave } from '../hooks/useDebouncedSave.js';
import { useTablistNav } from '../hooks/useTablistNav.js';
import styles from './RosterScreen.module.css';

const COLORS = ['#4fa8b8', '#9b7ede', '#d19a3d', '#3cb87a', '#e0605f', '#5b8fd9'];

export default function RosterScreen({
  onOpenSettings,
}: {
  onOpenSettings?: (pane: string) => void;
} = {}): React.JSX.Element {
  const { agents, envelopes, projectId, settings, refreshScoped } = useApp();
  const [selectedName, setSelectedName] = useState('');
  const [draft, setDraft] = useState<AgentDef | null>(null);
  /** Kept out of `draft`: a name is committed on blur or Enter, not per keystroke. */
  const [nameDraft, setNameDraft] = useState('');
  const [renameError, setRenameError] = useState('');
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [actionError, setActionError] = useState('');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [showPreview, setShowPreview] = useState(false);
  const agentsRef = useRef<AgentDef[]>(agents);
  agentsRef.current = agents;
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const lastSyncedNameRef = useRef<string | null>(null);

  const selected = useMemo(
    () => agents.find((a) => a.name === selectedName) ?? null,
    [agents, selectedName],
  );
  const errors = useMemo(() => issues.filter((i) => i.level === 'error'), [issues]);
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

  useEffect(() => {
    if (!agents.some((a) => a.name === selectedName)) setSelectedName(agents[0]?.name ?? '');
  }, [agents, selectedName]);

  useEffect(() => {
    if (!selected) {
      if (draft !== null && lastSyncedNameRef.current !== null) {
        // No selection available; clear only if we had a synced one before
        // (keeps new-agent draft alive until it appears in agents)
      }
      if (!agents.length) {
        setDraft(null);
        lastSyncedNameRef.current = null;
      }
      return;
    }
    if (lastSyncedNameRef.current !== selected.name) {
      setDraft(plain({ ...selected }));
      setNameDraft(selected.name);
      setRenameError('');
      setIssues([]);
      setActionError('');
      lastSyncedNameRef.current = selected.name;
    }
  }, [selected, agents.length, draft]);

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

  const draftCli = draft?.cli ?? 'droid';
  useEffect(() => {
    void api.catalog.models(draftCli).then(setModels);
  }, [draftCli]);

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

  const createAgent = async (): Promise<void> => {
    setActionError('');
    // Counting agents collides after any delete, and save upserts by name, so a
    // collision would silently overwrite an existing agent instead of adding one.
    const taken = new Set(agents.map((a) => a.name));
    let n = agents.length + 1;
    while (taken.has(`agent-${n}`)) n += 1;
    const fresh: AgentDef = {
      name: `agent-${n}`,
      purpose: 'Describe what this agent is for in one line.',
      cli: settings?.defaultCli ?? 'droid',
      model: 'inherit',
      reasoningEffort: 'medium',
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
        setSelectedName(fresh.name);
        lastSyncedNameRef.current = fresh.name;
      } else {
        setIssues(result.issues);
        setActionError(result.issues.map((i) => i.message).join(' '));
      }
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

  const TEMPLATE_TOKENS = ['request', 'worktree', 'plan.envelope.summary'].map((t) => `{{${t}}}`);

  return (
    <>
      <div className={styles.rosterScreen}>
        <header className={styles.rosterHeader}>
          <p className="eyebrow">
            <span className="index">03</span>Roster
          </p>
        </header>
        {/* ── agent strip: the whole roster, one horizontal band ── */}
        <div
          className={styles.rosterTabs}
          role="tablist"
          aria-label="Agents"
          onKeyDown={onTablistKey}
        >
          <div className={styles.rosterTabsInner}>
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
                >
                  <AgentAvatar name={agent.name} size={30} />
                  <span className={styles.rosterCellWho}>
                    <span className={styles.rosterCellName}>{agent.name}</span>
                    <span className={styles.rosterCellRole}>{agent.purpose}</span>
                    <span className={styles.rosterCellCli}>
                      <CliIcon vendor={agent.cli ?? 'droid'} size={11} />
                      {agent.cli ?? 'droid'}
                    </span>
                  </span>
                  {isActive && <span className={styles.rosterCellUnderline} aria-hidden />}
                </button>
              );
            })}
            <button type="button" className={styles.rosterNew} onClick={() => void createAgent()}>
              + New agent
            </button>
          </div>
        </div>

        {draft && (
          <div className={styles.rosterScroll}>
            <div className={styles.rosterPage}>
              {/* ── title row ── */}
              <div className={styles.rosterHead}>
                <div className={styles.rosterHeadMain}>
                  <div className={styles.rosterHeadTitlerow}>
                    <h1
                      className={styles.rosterTitle}
                      style={{ color: draft.color ?? 'var(--accent)' }}
                    >
                      {draft.name}
                    </h1>
                    <span className={styles.rosterHeadMeta}>
                      <CliIcon vendor={draftCli} size={13} />
                      {draftCli} · {draft.envelope}
                    </span>
                  </div>
                  <p className={styles.rosterHeadSub}>
                    {draft.purpose || 'No purpose yet.'}{' '}
                    <span className={styles.rosterHeadTag}>
                      {draft.builtin ? 'Shipped with Foundry, editable' : 'Custom agent'}
                    </span>
                  </p>
                </div>
                <div className={styles.rosterHeadActions}>
                  <button
                    type="button"
                    className={styles.rosterAction}
                    onClick={() => setShowPreview(true)}
                  >
                    Preview prompt
                  </button>
                  <button
                    type="button"
                    className={styles.rosterAction}
                    onClick={() => void duplicate()}
                  >
                    Duplicate
                  </button>
                  {!draft.builtin && (
                    <button
                      type="button"
                      className={`${styles.rosterAction} ${styles.danger}`}
                      onClick={() => void remove()}
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
                  <Field label="Name">
                    <TextInput
                      mono
                      value={nameDraft}
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
                      onChange={(e) => setDraft({ ...draft, purpose: e.target.value })}
                    />
                    <span className={styles.hint}>
                      One line, shown wherever this agent appears.
                    </span>
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
                      {(() => {
                        const lower = draft.color.toLowerCase();
                        const isCustom = !COLORS.includes(lower);
                        const safeValue = /^#[0-9a-fA-F]{6}$/.test(draft.color)
                          ? draft.color
                          : '#4fa8b8';
                        return (
                          <label
                            className={`${styles.swatch} ${styles.colorPickerWrapper} ${isCustom ? styles.on : ''}`}
                            title="Custom accent color"
                          >
                            <span
                              className={styles.swatchDot}
                              style={{
                                background: isCustom
                                  ? draft.color
                                  : 'conic-gradient(red, yellow, lime, aqua, blue, magenta, red)',
                              }}
                            />
                            <input
                              type="color"
                              aria-label="Custom accent color"
                              value={safeValue}
                              onChange={(e) =>
                                setDraft({ ...draft, color: e.target.value.toLowerCase() })
                              }
                              className={styles.colorInput}
                            />
                          </label>
                        );
                      })()}
                      <span className={styles.swatchHex}>{draft.color}</span>
                    </div>
                    <span className={styles.hint}>
                      Used for this agent's lane in the waterfall.
                    </span>
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
                  <Field label="Model">
                    <ModelPicker
                      value={draft.model}
                      models={models}
                      allowInherit
                      emptyHint="No models available from Factory Droid. Check Settings, or use Inherit."
                      onChange={(value) => setDraft({ ...draft, model: value })}
                      onRefresh={() => void api.catalog.models(draftCli, true).then(setModels)}
                    />
                    <span className={styles.hint}>“Inherit” uses Factory Droid's default.</span>
                  </Field>
                  <Field label="Reasoning effort">
                    <div
                      className={styles.rosterSeg}
                      role="radiogroup"
                      aria-label="Reasoning effort"
                    >
                      {(['off', 'low', 'medium', 'high'] as const).map((level) => (
                        <button
                          key={level}
                          type="button"
                          role="radio"
                          aria-checked={draft.reasoningEffort === level}
                          className={`${styles.rosterSegBtn} ${draft.reasoningEffort === level ? styles.on : ''}`}
                          onClick={() =>
                            setDraft({
                              ...draft,
                              reasoningEffort: level as AgentDef['reasoningEffort'],
                            })
                          }
                        >
                          {level}
                        </button>
                      ))}
                    </div>
                    <span className={styles.hint}>
                      Higher effort costs more thinking tokens and takes longer.
                    </span>
                  </Field>
                  <Field label="Envelope kind">
                    <Dropdown
                      value={draft.envelope}
                      options={envelopeOptions}
                      triggerClassName="mono"
                      onChange={(next) => setDraft({ ...draft, envelope: next })}
                    />
                    <span className={styles.hint}>
                      The typed reply this agent must return. Parsed and validated on every turn.
                      {onOpenSettings && (
                        <>
                          {' '}
                          <button
                            type="button"
                            className={styles.linkBtn}
                            onClick={() => onOpenSettings('envelopes')}
                          >
                            Manage envelopes…
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

              {/* ── write boundary ── */}
              <section className={styles.rosterSection}>
                <div className={styles.rosterSectionLabel}>
                  <p className="eyebrow">
                    <span className="index">04</span>Write boundary
                  </p>
                  <p>Paths this agent may modify. Everything else is refused at the tool layer.</p>
                </div>
                <BoundaryEditor
                  value={draft.writes}
                  onChange={(value) => setDraft({ ...draft, writes: value })}
                />
              </section>

              {/* ── validation + autosave ── */}
              <div className={styles.rosterStatusbar}>
                {issues.length > 0 ? (
                  <ul className={styles.issues}>
                    {issues.map((issue, i) => (
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
        {showPreview && draft && (
          <PromptPreview agent={draft} onClose={() => setShowPreview(false)} />
        )}
      </div>
    </>
  );
}
