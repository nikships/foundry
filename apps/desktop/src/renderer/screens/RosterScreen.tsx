import { useEffect, useMemo, useState } from 'react';
import type {
  AgentDef,
  CliDescriptor,
  CliVendor,
  ModelInfo,
  ValidationIssue,
} from '@shared/types.js';
import { api, plain } from '../api.js';
import { useApp } from '../stores/app.js';
import { modelLabel } from '../format.js';
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
  const [saving, setSaving] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  const selected = useMemo(
    () => agents.find((a) => a.name === selectedName) ?? null,
    [agents, selectedName],
  );
  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(selected),
    [draft, selected],
  );
  const errors = useMemo(() => issues.filter((i) => i.level === 'error'), [issues]);

  useEffect(() => {
    if (!agents.some((a) => a.name === selectedName)) setSelectedName(agents[0]?.name ?? '');
  }, [agents, selectedName]);

  useEffect(() => {
    setDraft(selected ? plain({ ...selected }) : null);
    setIssues([]);
    setActionError('');
  }, [selected]);

  useEffect(() => {
    void api.catalog.clis().then(setClis);
  }, []);

  // Live validation, same rail save uses, so a bad name or empty prompt is
  // obvious before the user hits Save and wonders why nothing happened.
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

  // Each CLI answers for its own models, so switching an agent's CLI reloads the
  // list. Without this the picker keeps offering ids the new CLI cannot resolve,
  // which fails on the first turn instead of here.
  const draftCli = draft?.cli ?? 'droid';
  useEffect(() => {
    void api.catalog.models(draftCli).then(setModels);
  }, [draftCli]);

  const selectAgent = (name: string): void => {
    if (name === selectedName) return;
    if (dirty) {
      const discard = window.confirm('Discard unsaved changes to this agent?');
      if (!discard) return;
    }
    setSelectedName(name);
  };

  const revert = (): void => {
    setDraft(selected ? plain({ ...selected }) : null);
    setActionError('');
  };

  const save = async (): Promise<void> => {
    if (!draft || saving || errors.length > 0) return;
    setSaving(true);
    setActionError('');
    try {
      const result = await api.roster.save(draft, projectId || undefined);
      setIssues(result.issues);
      if (result.ok) {
        setSelectedName(draft.name);
        await refreshScoped();
      }
    } catch (e) {
      setIssues([{ level: 'error', where: 'save', message: (e as Error).message }]);
    } finally {
      setSaving(false);
    }
  };

  const duplicate = async (): Promise<void> => {
    if (!selected) return;
    if (dirty) {
      const discard = window.confirm('Discard unsaved changes and duplicate the saved agent?');
      if (!discard) return;
    }
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
    if (dirty) {
      const discard = window.confirm('Discard unsaved changes and create a new agent?');
      if (!discard) return;
    }
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
      <div className="screen">
        <aside className="list">
          <header className="list-head">
            <h1>Roster</h1>
            <button className="btn sm" onClick={() => void createAgent()}>
              New
            </button>
          </header>
          <div className="scroll agents">
            {agents.map((agent) => (
              <button
                key={agent.name}
                className={`agent ${agent.name === selectedName ? 'active' : ''}`}
                onClick={() => selectAgent(agent.name)}
              >
                <AgentAvatar name={agent.name} size={34} />
                <span className="who">
                  <span className="name">{agent.name}</span>
                  <span className="faint purpose">{agent.purpose}</span>
                </span>
                <CliIcon vendor={agent.cli ?? 'droid'} size={14} />
                <span className="faint mono model">{modelLabel(agent.model)}</span>
              </button>
            ))}
          </div>
        </aside>
        {draft && (
          <div className="editor scroll">
            <header className="edit-head">
              <AgentAvatar name={draft.name} size={44} />
              <div className="grow">
                <h2>{draft.name}</h2>
                <p className="faint sub">
                  {draft.builtin ? 'Shipped with Foundry, editable' : 'Custom agent'}
                </p>
              </div>
              <CliIcon vendor={draftCli} size={20} />
              <button className="btn sm" onClick={() => setShowPreview(true)}>
                Preview prompt
              </button>
              <button className="btn sm" onClick={() => void duplicate()}>
                Duplicate
              </button>
              {!draft.builtin && (
                <button className="btn sm danger" onClick={() => void remove()}>
                  Delete
                </button>
              )}
            </header>
            <div className="field">
              <label>Name</label>
              <input
                className="input"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
              <span className="hint">
                Pipelines refer to an agent by this name. Renaming creates a new agent under the new
                name and leaves the old one in place, so pipelines keep pointing at the old name
                until you update them.
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
            <div className="field">
              <label>CLI</label>
              <div className="cli-picker">
                <select
                  className="select"
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
                Which binary runs this agent's phases. Changing it resets the model, because model
                ids do not carry across CLIs.
              </span>
              {(clis.find((c) => c.id === draftCli)?.caveats ?? []).map((caveat) => (
                <span key={caveat} className="hint caveat">
                  {caveat}
                </span>
              ))}
            </div>
            <div className="two">
              <div className="field">
                <label>Model</label>
                <ModelPicker
                  value={draft.model}
                  models={models}
                  allowInherit
                  onChange={(value) => setDraft({ ...draft, model: value })}
                />
                <span className="hint">“Inherit” uses this CLI's own default.</span>
              </div>
              <div className="field">
                <label>Reasoning effort</label>
                <select
                  className="select"
                  value={draft.reasoningEffort}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      reasoningEffort: e.target.value as AgentDef['reasoningEffort'],
                    })
                  }
                >
                  <option value="off">Off</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
                <span className="hint">
                  Higher effort costs more thinking tokens and takes longer.
                </span>
              </div>
            </div>
            <div className="field">
              <label>Colour</label>
              <div className="swatches">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    className={`swatch ${draft.color === c ? 'on' : ''}`}
                    style={{ background: c }}
                    onClick={() => setDraft({ ...draft, color: c })}
                  />
                ))}
              </div>
              <span className="hint">Used for this agent's lane in the waterfall.</span>
            </div>
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
            <div className="field">
              <label>Envelope</label>
              <select
                className="select"
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
            <div className="field">
              <label>Write boundary</label>
              <BoundaryEditor
                value={draft.writes}
                onChange={(value) => setDraft({ ...draft, writes: value })}
              />
            </div>
            {issues.length > 0 && (
              <ul className="issues">
                {issues.map((issue, i) => (
                  <li key={i} className={issue.level}>
                    <strong>{issue.where}</strong> {issue.message}
                  </li>
                ))}
              </ul>
            )}
            {actionError && <p className="action-err">{actionError}</p>}
            <footer className={`save-bar ${dirty ? 'show' : ''}`}>
              <span className="faint">
                {errors.length ? 'Fix errors to save' : dirty ? 'Unsaved changes' : 'No changes'}
              </span>
              <div className="grow" />
              <button className="btn" onClick={revert}>
                Revert
              </button>
              <button
                className="btn primary"
                disabled={saving || !dirty || errors.length > 0}
                title={
                  errors.length
                    ? 'Fix validation errors first'
                    : !dirty
                      ? 'No changes to save'
                      : undefined
                }
                onClick={() => void save()}
              >
                {saving ? 'Saving…' : errors.length ? 'Fix errors to save' : 'Save agent'}
              </button>
            </footer>
          </div>
        )}
        {showPreview && draft && (
          <PromptPreview agent={draft} onClose={() => setShowPreview(false)} />
        )}
      </div>
      <style>{`
        .screen { display: grid; grid-template-columns: 300px minmax(0, 1fr); height: 100%; min-height: 0; }
        .list { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--line); background: var(--bg-panel); }
        .list-head { display: flex; align-items: center; justify-content: space-between; padding: calc(var(--titlebar-h) + var(--s2)) var(--s4) var(--s3); }
        .list-head h1 { font-size: var(--text-xl); font-weight: 600; }
        .agents { flex: 1; min-height: 0; padding: 0 var(--s2) var(--s4); overflow-y: auto; }
        .agent { display: flex; align-items: center; gap: var(--s3); width: 100%; padding: var(--s2) var(--s3); border: none; border-radius: var(--r-sm); background: transparent; color: inherit; font: inherit; text-align: left; cursor: default; }
        .agent:hover { background: var(--bg-hover); }
        .agent.active { background: var(--bg-active); }
        .who { flex: 1; min-width: 0; display: flex; flex-direction: column; }
        .agent .name { font-size: var(--text-sm); font-weight: 500; }
        .purpose, .model { font-size: var(--text-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .model { flex: none; max-width: 76px; }
        .cli-picker { display: flex; align-items: center; gap: var(--s2); }
        .cli-picker .select { flex: 1; }
        .editor { min-height: 0; padding: calc(var(--titlebar-h) + var(--s2)) var(--s8) var(--s16); max-width: 900px; overflow-y: auto; }
        .edit-head { display: flex; align-items: center; gap: var(--s3); margin-bottom: var(--s6); }
        .edit-head h2 { font-size: var(--text-xl); font-weight: 600; }
        .sub { font-size: var(--text-xs); }
        .grow { flex: 1; }
        .two { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s5); }
        .field { display: flex; flex-direction: column; gap: var(--s1); margin-bottom: var(--s4); }
        .field label { font-size: var(--text-sm); font-weight: 500; }
        .hint { font-size: var(--text-xs); color: var(--text-faint); }
        .caveat { color: var(--amber, var(--text-faint)); }
        .swatches { display: flex; gap: var(--s2); }
        .swatch { width: 26px; height: 26px; border: 2px solid transparent; border-radius: var(--r-full); cursor: default; }
        .swatch.on { border-color: var(--text); }
        .field code { font-family: var(--font-mono); font-size: 11px; padding: 1px 4px; border-radius: 4px; background: var(--bg-raised); color: var(--cyan); }
        .issues { list-style: none; padding: var(--s3); border-radius: var(--r-sm); background: var(--red-dim); font-size: var(--text-sm); margin-top: var(--s3); display: flex; flex-direction: column; gap: var(--s2); }
        .issues .warning { color: var(--amber); }
        .issues .error { color: var(--red); }
        .action-err { margin-top: var(--s3); padding: var(--s3); border-radius: var(--r-sm); background: var(--red-dim); color: var(--red); font-size: var(--text-sm); }
        .save-bar { position: sticky; bottom: var(--s4); display: flex; align-items: center; gap: var(--s3); margin-top: var(--s6); padding: var(--s3) var(--s4); border: 1px solid var(--line-strong); border-radius: var(--r-lg); background: var(--bg-raised); box-shadow: var(--shadow); opacity: 0; transform: translateY(8px); pointer-events: none; transition: opacity var(--normal) var(--ease), transform var(--normal) var(--ease); }
        .save-bar.show { opacity: 1; transform: none; pointer-events: auto; }
        .scroll { overflow-y: auto; }
      `}</style>
    </>
  );
}
