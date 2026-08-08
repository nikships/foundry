import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentDef,
  CliDescriptor,
  CliVendor,
  ModelInfo,
  ValidationIssue,
} from '@shared/types.js';
import { api, plain } from '../api.js';
import { useApp } from '../stores/app.js';
import AgentAvatar from '../components/AgentAvatar.js';
import { CliIcon } from '../components/BrandIcon.js';
import ModelPicker from '../components/ModelPicker.js';
import BoundaryEditor from '../components/BoundaryEditor.js';
import PromptPreview from '../components/PromptPreview.js';

const ENVELOPE_KINDS = ['plan', 'build', 'review', 'scout', 'document', 'generic'] as const;
const COLORS = ['#5ad2dd', '#c89bff', '#e8b64a', '#4ade80', '#ff6f67', '#6aa8ff'];

export default function RosterScreen(): React.JSX.Element {
  const { agents, projectId, settings, refreshScoped } = useApp();
  const [selectedName, setSelectedName] = useState('');
  const [draft, setDraft] = useState<AgentDef | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [actionError, setActionError] = useState('');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [clis, setClis] = useState<CliDescriptor[]>([]);
  const [showPreview, setShowPreview] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const agentsRef = useRef<AgentDef[]>(agents);
  agentsRef.current = agents;
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const pendingRef = useRef<AgentDef | null>(null);
  const lastSyncedNameRef = useRef<string | null>(null);

  const selected = useMemo(
    () => agents.find((a) => a.name === selectedName) ?? null,
    [agents, selectedName],
  );
  const errors = useMemo(() => issues.filter((i) => i.level === 'error'), [issues]);

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
      setIssues([]);
      setActionError('');
      lastSyncedNameRef.current = selected.name;
    }
  }, [selected, agents.length, draft]);

  useEffect(() => {
    void api.catalog.clis().then(setClis);
  }, []);

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
  // Visual truth is the source of truth. Pending edits flush when switching agents.
  useEffect(() => {
    if (!draft) return;
    if (errors.length > 0) return;
    const persisted = agentsRef.current.find((a) => a.name === draft.name) ?? null;
    if (JSON.stringify(draft) === JSON.stringify(persisted)) return;
    const snapshot = plain({ ...draft });
    pendingRef.current = snapshot;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const toSave = pendingRef.current;
      pendingRef.current = null;
      saveTimer.current = null;
      if (!toSave) return;
      const curPersisted = agentsRef.current.find((a) => a.name === toSave.name) ?? null;
      if (JSON.stringify(toSave) === JSON.stringify(curPersisted)) return;
      const pid = projectIdRef.current;
      void api.roster.validate(toSave).then((v) => {
        if (v.some((i) => i.level === 'error')) {
          setIssues(v);
          return;
        }
        void (async () => {
          try {
            const result = await api.roster.save(toSave, pid || undefined);
            if (result.ok) {
              if (toSave.name !== lastSyncedNameRef.current) {
                setSelectedName(toSave.name);
                lastSyncedNameRef.current = toSave.name;
              }
              setIssues([]);
              await refreshScoped();
            } else setIssues(result.issues);
          } catch (e) {
            setIssues([{ level: 'error', where: 'save', message: (e as Error).message }]);
          }
        })();
      });
    }, 350);
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        const toSave = pendingRef.current;
        pendingRef.current = null;
        if (toSave) {
          const curPersisted = agentsRef.current.find((a) => a.name === toSave.name) ?? null;
          if (JSON.stringify(toSave) !== JSON.stringify(curPersisted)) {
            const pid = projectIdRef.current;
            void api.roster.validate(toSave).then((v) => {
              if (v.some((i) => i.level === 'error')) return;
              void api.roster.save(toSave, pid || undefined).then((r) => {
                if (r.ok) void refreshScoped();
              });
            });
          }
        }
      }
    };
  }, [draft, errors, refreshScoped]);

  const selectAgent = (name: string): void => {
    if (name === selectedName) return;
    setSelectedName(name);
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

  const remove = async (): Promise<void> => {
    if (!selected || selected.builtin) return;
    if (!window.confirm(`Delete agent “${selected.name}”? Pipelines that name it will break.`)) {
      return;
    }
    setActionError('');
    try {
      await api.roster.remove(selected.name, projectId || undefined);
      await refreshScoped();
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

  const createAgent = async (): Promise<void> => {
    setActionError('');
    const fresh: AgentDef = {
      name: `agent-${agents.length + 1}`,
      purpose: 'Describe what this agent is for in one line.',
      cli: settings?.defaultCli ?? 'droid',
      model: 'inherit',
      reasoningEffort: 'medium',
      systemPrompt: 'You are a careful engineer. State what you did and what you did not do.',
      userPrompt: 'Work on: {{request}}',
      writes: null,
      envelope: 'build',
      color: '#5ad2dd',
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
      <div className="ro-screen">
        {/* ── agent strip: the whole roster, one horizontal band ── */}
        <div className="ro-strip" role="tablist" aria-label="Agents">
          {agents.map((agent) => {
            const isActive = agent.name === selectedName;
            return (
              <button
                key={agent.name}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`ro-cell ${isActive ? 'on' : ''}`}
                style={{ ['--hue' as string]: agent.color ?? 'var(--cyan)' }}
                onClick={() => selectAgent(agent.name)}
              >
                <AgentAvatar name={agent.name} size={30} />
                <span className="ro-cell-who">
                  <span className="ro-cell-name">{agent.name}</span>
                  <span className="ro-cell-role">{agent.purpose}</span>
                  <span className="ro-cell-cli">
                    <CliIcon vendor={agent.cli ?? 'droid'} size={11} />
                    {agent.cli ?? 'droid'}
                  </span>
                </span>
                {isActive && <span className="ro-cell-rule" aria-hidden />}
              </button>
            );
          })}
          <button type="button" className="ro-new" onClick={() => void createAgent()}>
            + New agent
          </button>
        </div>

        {draft && (
          <div className="ro-scroll">
            <div className="ro-page">
              {/* ── title row ── */}
              <div className="ro-head">
                <div className="ro-head-main">
                  <div className="ro-head-titlerow">
                    <h1 className="ro-title" style={{ color: draft.color ?? 'var(--cyan)' }}>
                      {draft.name}
                    </h1>
                    <span className="ro-head-meta">
                      <CliIcon vendor={draftCli} size={13} />
                      {draftCli} · {draft.envelope}
                    </span>
                  </div>
                  <p className="ro-head-sub">
                    {draft.purpose || 'No purpose yet.'}{' '}
                    <span className="ro-head-tag">
                      {draft.builtin ? 'Shipped with Foundry, editable' : 'Custom agent'}
                    </span>
                  </p>
                </div>
                <div className="ro-head-actions">
                  <button type="button" className="ro-action" onClick={() => setShowPreview(true)}>
                    Preview prompt
                  </button>
                  <button type="button" className="ro-action" onClick={() => void duplicate()}>
                    Duplicate
                  </button>
                  {!draft.builtin && (
                    <button
                      type="button"
                      className="ro-action danger"
                      onClick={() => void remove()}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>

              {/* ── identity ── */}
              <section className="ro-section">
                <div className="ro-section-label">
                  <h2>Identity</h2>
                  <p>How this agent is referenced in pipelines and run logs.</p>
                </div>
                <div className="ro-fields">
                  <div className="field">
                    <label>Name</label>
                    <input
                      className="input mono"
                      value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    />
                    <span className="hint">
                      Renaming creates a new agent under the new name and leaves the old one in
                      place, so pipelines keep pointing at the old name until you update them.
                    </span>
                  </div>
                  <div className="field">
                    <label>Purpose</label>
                    <input
                      className="input"
                      value={draft.purpose}
                      onChange={(e) => setDraft({ ...draft, purpose: e.target.value })}
                    />
                    <span className="hint">One line, shown wherever this agent appears.</span>
                  </div>
                  <div className="field span2">
                    <label>Accent</label>
                    <div className="swatches">
                      {COLORS.map((c) => (
                        <button
                          key={c}
                          type="button"
                          className={`swatch ${draft.color === c ? 'on' : ''}`}
                          aria-label={`Accent ${c}`}
                          aria-pressed={draft.color === c}
                          onClick={() => setDraft({ ...draft, color: c })}
                        >
                          <span className="swatch-dot" style={{ background: c }} />
                        </button>
                      ))}
                      <span className="swatch-hex">{draft.color}</span>
                    </div>
                    <span className="hint">Used for this agent's lane in the waterfall.</span>
                  </div>
                </div>
              </section>

              {/* ── execution ── */}
              <section className="ro-section">
                <div className="ro-section-label">
                  <h2>Execution</h2>
                  <p>Which CLI runs this agent, and how hard it thinks.</p>
                </div>
                <div className="ro-fields">
                  <div className="field">
                    <label>CLI vendor</label>
                    <div className="cli-picker">
                      <select
                        className="select mono"
                        value={draftCli}
                        onChange={(e) =>
                          setDraft({ ...draft, cli: e.target.value as CliVendor, model: 'inherit' })
                        }
                      >
                        {clis.map((cli) => (
                          <option key={cli.id} value={cli.id}>
                            {cli.label}
                          </option>
                        ))}
                      </select>
                      <CliIcon vendor={draftCli} size={18} />
                    </div>
                    <span className="hint">
                      Which binary runs this agent's phases. Changing it resets the model, because
                      model ids do not carry across CLIs.
                    </span>
                    {(clis.find((c) => c.id === draftCli)?.caveats ?? []).map((caveat) => (
                      <span key={caveat} className="hint caveat">
                        {caveat}
                      </span>
                    ))}
                  </div>
                  <div className="field">
                    <label>Model</label>
                    <ModelPicker
                      value={draft.model}
                      models={models}
                      allowInherit
                      emptyHint={`No models from ${draftCli}. Check Agent CLIs in Settings, or use Inherit.`}
                      onChange={(value) => setDraft({ ...draft, model: value })}
                      onRefresh={() => void api.catalog.models(draftCli, true).then(setModels)}
                    />
                    <span className="hint">“Inherit” uses this CLI's own default.</span>
                  </div>
                  <div className="field">
                    <label>Reasoning effort</label>
                    <div className="ro-seg" role="radiogroup" aria-label="Reasoning effort">
                      {(['off', 'low', 'medium', 'high'] as const).map((level) => (
                        <button
                          key={level}
                          type="button"
                          role="radio"
                          aria-checked={draft.reasoningEffort === level}
                          className={`ro-seg-btn ${draft.reasoningEffort === level ? 'on' : ''}`}
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
                    <span className="hint">
                      Higher effort costs more thinking tokens and takes longer.
                    </span>
                  </div>
                  <div className="field">
                    <label>Envelope kind</label>
                    <select
                      className="select mono"
                      value={draft.envelope}
                      onChange={(e) =>
                        setDraft({ ...draft, envelope: e.target.value as AgentDef['envelope'] })
                      }
                    >
                      {ENVELOPE_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {kind}
                        </option>
                      ))}
                    </select>
                    <span className="hint">
                      The typed reply this agent must return. Parsed and validated on every turn.
                    </span>
                  </div>
                </div>
              </section>

              {/* ── prompts ── */}
              <section className="ro-section">
                <div className="ro-section-label">
                  <h2>Prompts</h2>
                  <p>The system prompt is fixed per agent; the template is filled per phase.</p>
                </div>
                <div className="ro-stack">
                  <div className="field">
                    <label>System prompt</label>
                    <textarea
                      className="textarea"
                      value={draft.systemPrompt}
                      rows={7}
                      onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
                    />
                    <span className="hint">
                      The agent's standing instructions. Sent once, at the start of its session.
                    </span>
                  </div>
                  <div className="field">
                    <label>User prompt template</label>
                    <textarea
                      className="textarea"
                      value={draft.userPrompt}
                      rows={6}
                      onChange={(e) => setDraft({ ...draft, userPrompt: e.target.value })}
                    />
                    <span className="hint">
                      Supports{' '}
                      {TEMPLATE_TOKENS.map((token) => (
                        <code key={token}>{token}</code>
                      ))}{' '}
                      Declared inputs not referenced here are appended to the prompt automatically.
                    </span>
                  </div>
                </div>
              </section>

              {/* ── write boundary ── */}
              <section className="ro-section">
                <div className="ro-section-label">
                  <h2>Write boundary</h2>
                  <p>Paths this agent may modify. Everything else is refused at the tool layer.</p>
                </div>
                <BoundaryEditor
                  value={draft.writes}
                  onChange={(value) => setDraft({ ...draft, writes: value })}
                />
              </section>

              {/* ── validation + autosave ── */}
              <div className="ro-statusbar">
                {issues.length > 0 ? (
                  <ul className="issues">
                    {issues.map((issue, i) => (
                      <li key={i} className={issue.level}>
                        <strong>{issue.where}</strong> {issue.message}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="ro-status-ok">
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
                {actionError && <p className="action-err">{actionError}</p>}
                <span className="ro-autosave">Changes save automatically</span>
              </div>
            </div>
          </div>
        )}
        {showPreview && draft && (
          <PromptPreview agent={draft} onClose={() => setShowPreview(false)} />
        )}
      </div>
      <style>{`
        /* One continuous surface — structure from hairlines + type, never tinted columns. */
        .ro-screen { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg-base); }

        /* strip */
        .ro-strip {
          flex: none; display: flex; align-items: stretch;
          padding: calc(var(--titlebar-h)) var(--s6) 0;
          border-bottom: 1px solid var(--line);
          overflow-x: auto;
        }
        .ro-cell {
          position: relative; flex: 1 1 0; min-width: 170px;
          display: flex; align-items: center; gap: var(--s3);
          padding: var(--s4) var(--s5) var(--s4) var(--s4);
          border: none; border-right: 1px solid var(--line);
          background: transparent; color: inherit; font: inherit; text-align: left; cursor: default;
          transition: background var(--fast) var(--ease);
        }
        .ro-cell:first-child { padding-left: 0; }
        .ro-cell:hover { background: color-mix(in srgb, #ffffff 2%, transparent); }
        .ro-cell-who { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
        .ro-cell-name {
          font-size: var(--text-sm); font-weight: 500; color: var(--text);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .ro-cell.on .ro-cell-name { color: var(--hue); }
        .ro-cell-role {
          font-size: 11px; color: var(--text-dim);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .ro-cell-cli {
          display: flex; align-items: center; gap: 5px; margin-top: 3px;
          font-family: var(--font-mono); font-size: 10px; text-transform: uppercase;
          letter-spacing: 0.14em; color: var(--text-faint);
        }
        .ro-cell-rule { position: absolute; left: 0; right: 0; bottom: -1px; height: 1px; background: var(--hue); }
        .ro-new {
          flex: none; align-self: center; margin-left: var(--s4);
          padding: 6px 10px; border: none; border-radius: var(--r-sm);
          background: transparent; color: var(--text-faint);
          font: inherit; font-size: var(--text-xs); cursor: default; white-space: nowrap;
          transition: color var(--fast) var(--ease);
        }
        .ro-new:hover { color: var(--text); }

        /* page */
        .ro-scroll { flex: 1; min-height: 0; overflow-y: auto; }
        .ro-page { max-width: 1160px; padding: 0 var(--s6) var(--s16); }

        .ro-head { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--s6); padding: var(--s8) 0; }
        .ro-head-main { min-width: 0; }
        .ro-head-titlerow { display: flex; align-items: baseline; gap: var(--s3); }
        .ro-title { font-size: 26px; font-weight: 600; letter-spacing: -0.01em; line-height: 1; }
        .ro-head-meta {
          display: inline-flex; align-items: center; gap: 6px;
          font-family: var(--font-mono); font-size: 11px; text-transform: uppercase;
          letter-spacing: 0.16em; color: var(--text-faint); white-space: nowrap;
        }
        .ro-head-sub { margin-top: 10px; font-size: var(--text-sm); color: var(--text-dim); }
        .ro-head-tag { color: var(--text-faint); font-size: var(--text-xs); }
        .ro-head-actions { flex: none; display: flex; gap: var(--s2); }
        .ro-action {
          display: inline-flex; align-items: center; height: 32px; padding: 0 var(--s3);
          border: 1px solid var(--line-strong); border-radius: var(--r-sm);
          background: transparent; color: var(--text-dim);
          font: inherit; font-size: var(--text-xs); cursor: default; white-space: nowrap;
          transition: color var(--fast) var(--ease), border-color var(--fast) var(--ease);
        }
        .ro-action:hover { color: var(--text); border-color: var(--text-faint); }
        .ro-action.danger:hover { color: var(--red); border-color: color-mix(in srgb, var(--red) 50%, transparent); }

        .ro-section {
          display: grid; grid-template-columns: 220px minmax(0, 1fr);
          gap: var(--s4) var(--s12, 48px);
          border-top: 1px solid var(--line);
          padding: var(--s8) 0;
        }
        .ro-section-label h2 {
          font-family: var(--font-mono); font-size: 10px; font-weight: 500;
          text-transform: uppercase; letter-spacing: 0.22em; color: var(--text-dim);
        }
        .ro-section-label p { margin-top: var(--s2); font-size: var(--text-xs); line-height: var(--leading); color: var(--text-faint); max-width: 24ch; }
        .ro-fields { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s5) var(--s8); }
        .ro-fields .span2 { grid-column: span 2; }
        .ro-stack { display: flex; flex-direction: column; gap: var(--s6); }

        .swatches { display: flex; align-items: center; gap: var(--s2); }
        .swatch {
          display: flex; align-items: center; justify-content: center;
          width: 32px; height: 32px; border: 1px solid var(--line); border-radius: var(--r-sm);
          background: transparent; cursor: default;
          transition: border-color var(--fast) var(--ease);
        }
        .swatch:hover { border-color: var(--line-strong); }
        .swatch.on { border-color: var(--text-dim); }
        .swatch-dot { width: 12px; height: 12px; border-radius: var(--r-full); }
        .swatch-hex { margin-left: var(--s2); font-family: var(--font-mono); font-size: 11px; color: var(--text-faint); }

        .ro-seg { display: flex; height: 34px; border: 1px solid var(--line); border-radius: var(--r-sm); overflow: hidden; }
        .ro-seg-btn {
          flex: 1; border: none; border-right: 1px solid var(--line);
          background: transparent; color: var(--text-faint);
          font-family: var(--font-mono); font-size: 11px; text-transform: uppercase;
          letter-spacing: 0.12em; cursor: default;
          transition: color var(--fast) var(--ease), background var(--fast) var(--ease);
        }
        .ro-seg-btn:last-child { border-right: none; }
        .ro-seg-btn:hover { color: var(--text-dim); }
        .ro-seg-btn.on { color: var(--text); background: color-mix(in srgb, #ffffff 4.5%, transparent); }

        .ro-statusbar {
          display: flex; align-items: center; gap: var(--s4);
          border-top: 1px solid var(--line); padding-top: var(--s5);
        }
        .ro-status-ok { display: inline-flex; align-items: center; gap: 6px; font-size: var(--text-xs); color: var(--green); }
        .ro-statusbar .issues { margin: 0; }
        .ro-autosave {
          margin-left: auto; flex: none;
          font-family: var(--font-mono); font-size: 10px; text-transform: uppercase;
          letter-spacing: 0.18em; color: var(--text-faint);
        }

        .field { display: flex; flex-direction: column; gap: var(--s1); }
        .field label { font-size: var(--text-sm); font-weight: 500; }
        .hint { font-size: var(--text-xs); color: var(--text-faint); }
        .caveat { color: var(--amber, var(--text-faint)); }
        .cli-picker { display: flex; align-items: center; gap: var(--s2); }
        .cli-picker .select { flex: 1; }
        .field code { font-family: var(--font-mono); font-size: 11px; padding: 1px 4px; border-radius: 4px; background: var(--bg-raised); color: var(--cyan); }
        .issues { list-style: none; padding: var(--s3); border-radius: var(--r-sm); background: var(--red-dim); font-size: var(--text-sm); display: flex; flex-direction: column; gap: var(--s2); }
        .issues .warning { color: var(--amber); }
        .issues .error { color: var(--red); }
        .action-err { margin: 0; padding: var(--s2) var(--s3); border-radius: var(--r-sm); background: var(--red-dim); color: var(--red); font-size: var(--text-xs); }
      `}</style>
    </>
  );
}
