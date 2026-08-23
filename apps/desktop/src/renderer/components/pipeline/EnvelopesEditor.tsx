/**
 * Design → Envelopes: shared library of named custom envelopes.
 *
 * An envelope is the typed return shape of an agent phase, so this is a
 * designer rather than a preference — it sits beside the pipeline and agent
 * editors that reference it, not in Settings.
 *
 * Built-ins are inspectable (same JSON the agent sees). Customs get a field
 * editor, live preview, duplicate, and usage-aware delete. Empty library opens
 * on starters so the first visit is not a blank admin form.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BUILTIN_ENVELOPE_KINDS,
  type CustomEnvelopeField,
  type EnvelopeDef,
  type EnvelopeKind,
  type ValidationIssue,
} from '@shared/types.js';
import { api, plain } from '../../api.js';
import { useApp } from '../../stores/app.js';
import { addField as appendField } from '../../view-models/custom-fields.js';
import CustomFieldsEditor from '../project/CustomFieldsEditor.js';
import { Field, TextInput } from '../ui/Field.js';
import { Button } from '../ui/Button.js';
import { confirmManager } from '../../hooks/useConfirmAction.js';
import { useDebouncedSave } from '../../hooks/useDebouncedSave.js';
import styles from './EnvelopesEditor.module.css';

const BUILTIN_BLURBS: Record<EnvelopeKind, string> = {
  generic: 'Bare outcome — status, summary, artifacts, handoff note.',
  brief: 'Adds a rewritten request, its constraints, and acceptance criteria.',
  plan: 'Adds a commit_message for the plan phase.',
  build: 'Adds a commit_message for implementation work.',
  scout: 'Adds findings — a list of what was discovered.',
  review: 'Adds approved, structured findings, and blocking issues.',
  document: 'Base reply; the written doc is declared in artifacts.',
  pr: 'Adds a bounded title and a non-empty markdown pull-request body.',
  issue: 'Adds a bounded title, a markdown GitHub-issue body, and optional labels.',
};

/** Starter shapes so an empty library is not a blank form. */
const STARTERS: { id: string; title: string; blurb: string; def: EnvelopeDef }[] = [
  {
    id: 'severity',
    title: 'Severity report',
    blurb: 'Outcome plus severity and an optional score — good for scouts and judges.',
    def: {
      name: 'severity_report',
      description: 'Outcome plus severity and optional score',
      fields: [
        {
          name: 'severity',
          type: 'string',
          required: true,
          description: 'low | medium | high',
        },
        {
          name: 'score',
          type: 'number',
          required: false,
          description: '0-100 if you scored it',
        },
      ],
    },
  },
  {
    id: 'checklist',
    title: 'Checklist',
    blurb: 'Pass/fail with the items you verified and anything still blocking.',
    def: {
      name: 'checklist',
      description: 'Pass/fail checklist with blocking items',
      fields: [
        {
          name: 'passed',
          type: 'boolean',
          required: true,
          description: 'true only if every required item passed',
        },
        {
          name: 'checked',
          type: 'string[]',
          required: true,
          description: 'items you verified',
        },
        {
          name: 'blocking',
          type: 'string[]',
          required: false,
          description: 'must-fix items before this can ship',
        },
      ],
    },
  },
  {
    id: 'handoff',
    title: 'Handoff note',
    blurb: 'Ordered next steps and risks for the agent that follows.',
    def: {
      name: 'handoff_note',
      description: 'Structured note for the next agent',
      fields: [
        {
          name: 'next_steps',
          type: 'string[]',
          required: true,
          description: 'ordered next actions',
        },
        {
          name: 'risks',
          type: 'string[]',
          required: false,
          description: 'things that could go wrong',
        },
      ],
    },
  },
];

/** Extra fields a built-in adds beyond the generic base — used as a starting point. */
const BUILTIN_EXTRA_FIELDS: Record<EnvelopeKind, CustomEnvelopeField[]> = {
  generic: [],
  brief: [
    {
      name: 'improved_request',
      type: 'string',
      required: true,
      description: 'the rewritten request, standalone and ready to hand to the next phase',
    },
    {
      name: 'constraints',
      type: 'string[]',
      required: false,
      description: 'a rule the work must respect',
    },
    {
      name: 'acceptance_criteria',
      type: 'string[]',
      required: false,
      description: 'how anyone can tell this is done',
    },
  ],
  plan: [
    {
      name: 'commit_message',
      type: 'string',
      required: false,
      description: 'imperative subject line under 72 chars',
    },
  ],
  build: [
    {
      name: 'commit_message',
      type: 'string',
      required: false,
      description: 'imperative subject line under 72 chars',
    },
  ],
  scout: [
    {
      name: 'findings',
      type: 'string[]',
      required: false,
      description: 'what you found, one per entry',
    },
  ],
  review: [
    {
      name: 'approved',
      type: 'boolean',
      required: true,
      description: 'true only if this is ready to ship',
    },
    {
      name: 'findings',
      type: 'string[]',
      required: false,
      description: 'requirement — met/unmet — evidence',
    },
    {
      name: 'blocking',
      type: 'string[]',
      required: false,
      description: 'problems that must be fixed before this can ship',
    },
  ],
  document: [],
  pr: [
    {
      name: 'title',
      type: 'string',
      required: true,
      description: 'imperative PR title, ≤72 chars, no trailing period',
    },
    {
      name: 'body',
      type: 'string',
      required: true,
      description: 'markdown PR body — follow the repo template, or the fallback headings',
    },
  ],
  issue: [
    {
      name: 'title',
      type: 'string',
      required: true,
      description: 'imperative issue title, ≤72 chars, no trailing period',
    },
    {
      name: 'body',
      type: 'string',
      required: true,
      description: 'markdown issue body — context, evidence, and what done looks like',
    },
    {
      name: 'labels',
      type: 'string[]',
      required: false,
      description: 'labels that already exist in the repo',
    },
  ],
};

type Selection =
  | { kind: 'none' }
  | { kind: 'custom'; name: string; isNew: boolean }
  | { kind: 'builtin'; name: EnvelopeKind };

function uniqueName(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

export default function EnvelopesEditor({
  openEnvelope,
  openNonce = 0,
}: {
  /** Deep link (e.g. a Smith approve): select this custom envelope once it resolves. */
  openEnvelope?: string;
  /** Bumped per deep-link so re-selecting the same envelope re-fires the effect. */
  openNonce?: number;
} = {}): React.JSX.Element {
  const { envelopes, refreshAll } = useApp();
  const [selection, setSelection] = useState<Selection>({ kind: 'none' });
  const [draft, setDraft] = useState<EnvelopeDef | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [example, setExample] = useState('');
  const [builtinExample, setBuiltinExample] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const envelopesRef = useRef(envelopes);
  envelopesRef.current = envelopes;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const lastSyncedRef = useRef<string | null>(null);

  const selectedCustom = useMemo(() => {
    if (selection.kind !== 'custom') return null;
    return envelopes.find((e) => e.name === selection.name) ?? null;
  }, [envelopes, selection]);

  const errors = useMemo(() => issues.filter((i) => i.level === 'error'), [issues]);
  const isEditing = selection.kind === 'custom' && draft != null;
  const isNew = selection.kind === 'custom' && selection.isNew;
  const showEmptyHero = envelopes.length === 0 && selection.kind === 'none';

  // Deep link from a Smith approve: select the saved custom envelope once it
  // appears. `openNonce` re-fires the effect for a repeat approval.
  useEffect(() => {
    if (openEnvelope && envelopes.some((e) => e.name === openEnvelope)) {
      setSelection({ kind: 'custom', name: openEnvelope, isNew: false });
    }
  }, [openEnvelope, openNonce, envelopes]);

  // Keep a custom selection valid when the library shrinks under us.
  useEffect(() => {
    if (selection.kind !== 'custom' || selection.isNew) return;
    if (!envelopes.some((e) => e.name === selection.name)) {
      setSelection(
        envelopes[0] ? { kind: 'custom', name: envelopes[0].name, isNew: false } : { kind: 'none' },
      );
      lastSyncedRef.current = null;
    }
  }, [envelopes, selection]);

  // Load draft when selecting an existing custom envelope.
  useEffect(() => {
    if (selection.kind !== 'custom' || selection.isNew) return;
    if (!selectedCustom) return;
    if (lastSyncedRef.current === selectedCustom.name) return;
    setDraft(plain({ ...selectedCustom, fields: selectedCustom.fields.map((f) => ({ ...f })) }));
    setNameDraft(selectedCustom.name);
    setIssues([]);
    setActionError('');
    lastSyncedRef.current = selectedCustom.name;
  }, [selection, selectedCustom]);

  // Live validate + example for the draft under edit.
  useEffect(() => {
    if (selection.kind !== 'custom') {
      setIssues([]);
      setExample('');
      return;
    }
    if (!draft) return;
    let cancelled = false;
    void api.envelopes.validate(draft).then((result) => {
      if (cancelled) return;
      setIssues(result.issues);
      setExample(result.example);
    });
    return () => {
      cancelled = true;
    };
  }, [draft, selection.kind]);

  // Built-in inspect loads the real agent example from main.
  useEffect(() => {
    if (selection.kind !== 'builtin') {
      setBuiltinExample('');
      return;
    }
    let cancelled = false;
    void api.envelopes.preview(selection.name).then((json) => {
      if (!cancelled) setBuiltinExample(json);
    });
    return () => {
      cancelled = true;
    };
  }, [selection]);

  const { flush, cancel } = useDebouncedSave<EnvelopeDef>({
    value: selection.kind === 'custom' ? draft : null,
    delay: 350,
    disabled: errors.length > 0 || !draft?.name,
    compare: (d) => envelopesRef.current.find((e) => e.name === d.name) ?? null,
    validate: async (d) => {
      const result = await api.envelopes.validate(d);
      return result.issues;
    },
    save: (d) => api.envelopes.save(d),
    onSuccess: async (saved) => {
      setIssues([]);
      // refreshAll adds the new envelope to the library, which must settle
      // first: a late-arriving stale save for the previously selected envelope
      // could otherwise slip through as a later flush (FOU-40).
      await refreshAll();
      if (
        selectionRef.current.kind === 'custom' &&
        selectionRef.current.isNew &&
        selectionRef.current.name === saved.name
      ) {
        setSelection({ kind: 'custom', name: saved.name, isNew: false });
      }
      lastSyncedRef.current = saved.name;
    },
    onIssues: setIssues,
    onError: (e) => setIssues([{ level: 'error', where: 'save', message: (e as Error).message }]),
  });

  const beginDraft = async (
    def: EnvelopeDef,
    opts: { focusName?: boolean } = {},
  ): Promise<void> => {
    await flush();
    cancel();
    setSelection({ kind: 'custom', name: def.name, isNew: true });
    setDraft(plain({ ...def, fields: def.fields.map((f) => ({ ...f })) }));
    setNameDraft(def.name);
    setIssues([]);
    setActionError('');
    lastSyncedRef.current = def.name;
    if (opts.focusName) {
      requestAnimationFrame(() => {
        const el = document.getElementById('envelope-name-input') as HTMLInputElement | null;
        el?.focus();
        el?.select();
      });
    }
  };

  const startBlank = async (): Promise<void> => {
    const existing = new Set(envelopes.map((e) => e.name));
    const name = uniqueName('my_envelope', existing);
    await beginDraft(
      {
        name,
        description: '',
        fields: [
          {
            name: 'detail',
            type: 'string',
            required: true,
            description: 'what this phase wants to report',
          },
        ],
      },
      { focusName: true },
    );
  };

  const startFromStarter = async (starter: (typeof STARTERS)[number]): Promise<void> => {
    const existing = new Set(envelopes.map((e) => e.name));
    const name = uniqueName(starter.def.name, existing);
    await beginDraft(
      {
        ...starter.def,
        name,
        fields: starter.def.fields.map((f) => ({ ...f })),
      },
      { focusName: true },
    );
  };

  const selectCustom = async (name: string): Promise<void> => {
    if (selection.kind === 'custom' && selection.name === name && !selection.isNew) return;
    await flush();
    setSelection({ kind: 'custom', name, isNew: false });
    lastSyncedRef.current = null;
    setActionError('');
  };

  const selectBuiltin = async (name: EnvelopeKind): Promise<void> => {
    await flush();
    setSelection({ kind: 'builtin', name });
    setDraft(null);
    setActionError('');
  };

  const commitName = (): void => {
    if (!draft || !isNew) return;
    const next = nameDraft
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^[^a-z]+/, '')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
    if (!next) {
      setNameDraft(draft.name);
      return;
    }
    if (next === draft.name) {
      setNameDraft(next);
      return;
    }
    setDraft({ ...draft, name: next });
    setNameDraft(next);
    setSelection({ kind: 'custom', name: next, isNew: true });
    lastSyncedRef.current = next;
  };

  const addField = (): void => {
    if (!draft) return;
    setDraft({ ...draft, fields: appendField(draft.fields) });
  };

  const duplicateCurrent = async (): Promise<void> => {
    if (selection.kind !== 'custom' || selection.isNew) return;
    const name = selection.name;
    setBusy(true);
    setActionError('');
    try {
      await flush();
      const copy = await api.envelopes.duplicate(name);
      await refreshAll();
      if (copy) {
        setSelection({ kind: 'custom', name: copy.name, isNew: false });
        lastSyncedRef.current = null;
      } else {
        setActionError('Could not duplicate that envelope.');
      }
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const extendBuiltin = async (kind: EnvelopeKind): Promise<void> => {
    const existing = new Set(envelopes.map((e) => e.name));
    const name = uniqueName(`${kind}_custom`, existing);
    await beginDraft(
      {
        name,
        description: `Custom shape starting from ${kind}`,
        fields: BUILTIN_EXTRA_FIELDS[kind].map((f) => ({ ...f })),
      },
      { focusName: true },
    );
  };

  const removeEnvelope = async (): Promise<void> => {
    if (selection.kind !== 'custom') return;
    const name = draft?.name ?? selection.name;
    if (!name) return;

    // Unsaved new draft — discard without touching disk.
    if (selection.isNew && !envelopes.some((e) => e.name === name)) {
      cancel();
      setDraft(null);
      setSelection(
        envelopes[0] ? { kind: 'custom', name: envelopes[0].name, isNew: false } : { kind: 'none' },
      );
      lastSyncedRef.current = null;
      return;
    }

    try {
      const usage = await api.envelopes.usage(name);
      const parts: string[] = [];
      if (usage.agents.length) {
        parts.push(`agents ${usage.agents.map((a) => `"${a}"`).join(', ')}`);
      }
      if (usage.phases.length) {
        parts.push(
          usage.phases.map((p) => `phase "${p.phase}" of pipeline "${p.pipeline}"`).join(', '),
        );
      }
      const message = parts.length
        ? `Delete report “${name}”? Used by ${parts.join(' and ')} — those will fall back to the generic report.`
        : `Delete report “${name}”? Nothing currently uses it.`;
      const accepted = await confirmManager.ask(message, {
        confirmLabel: 'Delete',
        variant: 'danger',
      });
      if (!accepted) return;
      cancel();
      await api.envelopes.remove(name);
      setActionError('');
      setDraft(null);
      lastSyncedRef.current = null;
      const remaining = envelopes.filter((e) => e.name !== name);
      setSelection(
        remaining[0] ? { kind: 'custom', name: remaining[0].name, isNew: false } : { kind: 'none' },
      );
      await refreshAll();
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

  return (
    <div className={styles.envelopesPage}>
      <div className={styles.envelopeShell}>
        <header className={styles.envelopeHeader}>
          <div>
            <h2 className={styles.envelopeTitle}>Reports</h2>
            <p className={styles.envelopeLead}>
              Named JSON shapes agents must return. Pick one on an agent or a pipeline phase — the
              live preview below is exactly what the agent is shown.
            </p>
          </div>
          <Button
            size="sm"
            variant="primary"
            onClick={() => void startBlank()}
            disabled={busy}
            data-testid="envelope-new"
          >
            New report
          </Button>
        </header>

        <div className={styles.envelopeLayout}>
          {/* ── library rail ───────────────────────────────────────────── */}
          <aside className={styles.envelopeList} aria-label="Report library">
            <div className={styles.envelopeListHead}>
              <span>Your library</span>
              <span className={styles.envelopeCount}>{envelopes.length}</span>
            </div>
            {envelopes.length === 0 ? (
              <p className={styles.envelopeListEmpty}>None yet — start from a template or blank.</p>
            ) : (
              <ul className={styles.envelopeItems}>
                {envelopes.map((env) => {
                  const on =
                    selection.kind === 'custom' && selection.name === env.name && !selection.isNew;
                  return (
                    <li key={env.name}>
                      <button
                        type="button"
                        className={`${styles.envelopeItem} ${on ? styles.on : ''}`}
                        onClick={() => void selectCustom(env.name)}
                        data-testid={`envelope-item-${env.name}`}
                      >
                        <strong className="mono">{env.name}</strong>
                        <em>
                          {env.description?.trim() ||
                            (env.fields.length
                              ? `${env.fields.length} field${env.fields.length === 1 ? '' : 's'}`
                              : 'No extra fields')}
                        </em>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {isNew && draft && !envelopes.some((e) => e.name === draft.name) && (
              <ul className={styles.envelopeItems}>
                <li>
                  <div className={`${styles.envelopeItem} ${styles.on} ${styles.envelopeDraft}`}>
                    <strong className="mono">{draft.name}</strong>
                    <em>Unsaved draft</em>
                  </div>
                </li>
              </ul>
            )}

            <div className={styles.envelopeListHead}>
              <span>Built-in</span>
              <span className={styles.envelopeCountMuted}>inspect</span>
            </div>
            <ul className={styles.envelopeItems}>
              {BUILTIN_ENVELOPE_KINDS.map((kind) => {
                const on = selection.kind === 'builtin' && selection.name === kind;
                return (
                  <li key={kind}>
                    <button
                      type="button"
                      className={`${styles.envelopeItem} ${styles.envelopeBuiltinBtn} ${on ? styles.on : ''}`}
                      onClick={() => void selectBuiltin(kind)}
                      data-testid={`envelope-builtin-${kind}`}
                    >
                      <strong className="mono">{kind}</strong>
                      <em>{BUILTIN_BLURBS[kind]}</em>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>

          {/* ── main pane ──────────────────────────────────────────────── */}
          <div className={styles.envelopeEditor}>
            {showEmptyHero && (
              <div className={styles.envelopeHero}>
                <div className={styles.envelopeHeroCopy}>
                  <h3>Shape what agents return</h3>
                  <p>
                    Built-ins cover plan, build, review, and friends. When a phase needs a field
                    they do not have — severity, a checklist, next steps — define it once here and
                    pick it from any agent or phase.
                  </p>
                </div>
                <div className={styles.envelopeStarters}>
                  {STARTERS.map((starter) => (
                    <button
                      key={starter.id}
                      type="button"
                      className={styles.envelopeStarter}
                      onClick={() => void startFromStarter(starter)}
                    >
                      <strong>{starter.title}</strong>
                      <span>{starter.blurb}</span>
                      <em className="mono">+ {starter.def.name}</em>
                    </button>
                  ))}
                  <button
                    type="button"
                    className={styles.envelopeStarterBlank}
                    onClick={() => void startBlank()}
                  >
                    <strong>Start blank</strong>
                    <span>Generic base plus the fields you add.</span>
                  </button>
                </div>
              </div>
            )}

            {selection.kind === 'none' && !showEmptyHero && (
              <div className={styles.envelopeIdle}>
                <p>Select a report to edit, or inspect a built-in to see the JSON agents return.</p>
                <Button size="sm" onClick={() => void startBlank()}>
                  New report
                </Button>
              </div>
            )}

            {selection.kind === 'builtin' && (
              <div className={styles.envelopeInspect}>
                <div className={styles.envelopeInspectHead}>
                  <div>
                    <p className={styles.envelopeBadge}>Built-in</p>
                    <h3 className="mono">{selection.name}</h3>
                    <p className={styles.envelopeInspectBlurb}>{BUILTIN_BLURBS[selection.name]}</p>
                  </div>
                  <div className={styles.envelopeActions}>
                    <Button size="sm" onClick={() => void extendBuiltin(selection.name)}>
                      Start from this
                    </Button>
                  </div>
                </div>
                <p className={styles.envelopePreviewLabel}>
                  JSON the agent is shown — read-only. Built-ins cannot be edited; start from this
                  to add your own fields on a custom report.
                </p>
                <pre className={`mono ${styles.envelopePreviewCode}`}>{builtinExample || '…'}</pre>
                {selection.name === 'review' && (
                  <p className={styles.hint}>
                    Review findings are structured objects in the built-in. A custom starting point
                    flattens them to a list of text so you stay inside the four field types.
                  </p>
                )}
              </div>
            )}

            {isEditing && draft && (
              <>
                <div className={styles.envelopeEditHead}>
                  <div className={styles.envelopeEditIdentity}>
                    <Field
                      label="Name"
                      htmlFor="envelope-name-input"
                      hint={
                        isNew
                          ? 'Lowercase, digits, dash, underscore. Locked after the first save — duplicate to rename.'
                          : 'Immutable after creation. Duplicate if you need a new name.'
                      }
                    >
                      <TextInput
                        id="envelope-name-input"
                        className="mono"
                        value={nameDraft}
                        disabled={!isNew || busy}
                        onChange={(e) => setNameDraft(e.target.value)}
                        onBlur={commitName}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            commitName();
                          }
                        }}
                      />
                    </Field>
                    <Field label="Description" hint="One line in the library list.">
                      <TextInput
                        value={draft.description ?? ''}
                        disabled={busy}
                        placeholder="What this shape is for"
                        onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                      />
                    </Field>
                  </div>
                  <div className={styles.envelopeActions}>
                    {!isNew && (
                      <Button size="sm" onClick={() => void duplicateCurrent()} disabled={busy}>
                        Duplicate
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => void removeEnvelope()}
                      disabled={busy}
                    >
                      {isNew ? 'Discard' : 'Delete'}
                    </Button>
                  </div>
                </div>

                <div className={styles.envelopeFields}>
                  <div className={styles.envelopeFieldsHead}>
                    <div>
                      <span>Fields</span>
                      <p className={styles.envelopeFieldsNote}>
                        Every report already carries the four base fields. Add only what is unique
                        to this shape.
                      </p>
                    </div>
                    <Button size="sm" onClick={addField} disabled={busy}>
                      Add field
                    </Button>
                  </div>

                  <div className={styles.envelopeFieldStack}>
                    {draft.fields.length === 0 && (
                      <div className={styles.envelopeFieldEmpty}>
                        <p>
                          No custom fields yet. Add one, or the agent only returns the base four.
                        </p>
                        <Button size="sm" onClick={addField}>
                          Add field
                        </Button>
                      </div>
                    )}

                    <CustomFieldsEditor
                      idPrefix={`envelope-${draft.name}`}
                      fields={draft.fields}
                      disabled={busy}
                      onChange={(fields) => setDraft({ ...draft, fields })}
                    />
                  </div>
                </div>

                <div className={styles.envelopePreviewBlock}>
                  <div className={styles.envelopePreviewHead}>
                    <span>Live preview</span>
                    <em>Same schema path used at parse time — what the agent must return.</em>
                  </div>
                  <pre className={`mono ${styles.envelopePreviewCode}`}>{example || '…'}</pre>
                </div>

                <div className={styles.envelopeStatusbar}>
                  {issues.length > 0 ? (
                    <ul className={styles.envelopeIssues}>
                      {issues.map((issue, i) => (
                        <li key={i} className={issue.level}>
                          <strong>{issue.where}</strong> {issue.message}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className={styles.envelopeStatusOk}>
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
                  {actionError && <p className={styles.envelopeActionErr}>{actionError}</p>}
                  <span className={styles.envelopeAutosave}>
                    {isNew ? 'Saves when valid' : 'Changes save automatically'}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
