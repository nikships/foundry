import { useEffect, useMemo, useState } from 'react';
import {
  BUILTIN_ENVELOPE_BLURBS,
  BUILTIN_ENVELOPE_KINDS,
  type AgentDef,
  type EnvelopeKind,
  type PhaseDef,
  type PhaseKind,
} from '@shared/types.js';
import { api } from '../api.js';
import { useApp } from '../stores/app.js';
import { gateNames } from '../pipeline-view.js';
import { SegmentedControl } from './ui/SegmentedControl.js';
import { Button } from './ui/Button.js';
import styles from './PhaseEditor.module.css';

type CommandSource = 'ref' | 'builtin' | 'argv';

function isBuiltinEnvelope(env: string | undefined): env is EnvelopeKind {
  return env ? (BUILTIN_ENVELOPE_KINDS as readonly string[]).includes(env) : false;
}

export default function PhaseEditor({
  phase,
  index,
  phases,
  agents,
  commands,
  onChange,
  onRemove,
}: {
  phase: PhaseDef;
  index: number;
  phases: PhaseDef[];
  agents: AgentDef[];
  commands: string[];
  onChange: (phase: PhaseDef) => void;
  onRemove: () => void;
  onOpenSettings?: (pane: string) => void;
}): React.JSX.Element {
  const { envelopes } = useApp();
  const [catalogGates, setCatalogGates] = useState<{ id: string; description: string }[]>([]);

  useEffect(() => {
    void api.catalog.gates().then(setCatalogGates);
  }, []);

  const earlier = useMemo(() => phases.slice(0, index), [phases, index]);
  const earlierAgents = useMemo(() => earlier.filter((p) => p.kind === 'agent'), [earlier]);
  const activeGates = useMemo(() => gateNames(phase), [phase]);
  const inputs = useMemo(() => phase.prompt?.inputs ?? [], [phase.prompt?.inputs]);

  const availableInputs = useMemo(() => {
    const standard = ['request', 'handoff_files', 'feedback'];
    const envelopeInputs = earlier.map((p) => `envelope:${p.name}`);
    return [...standard, ...envelopeInputs].filter((i) => !inputs.includes(i));
  }, [earlier, inputs]);

  const commandSource: CommandSource = useMemo(() => {
    if (phase.kind !== 'code' || !phase.command) return 'ref';
    if ('ref' in phase.command) return 'ref';
    if ('builtin' in phase.command) return 'builtin';
    return 'argv';
  }, [phase]);

  const handleKindChange = (kind: PhaseKind): void => {
    if (kind === phase.kind) return;
    if (kind === 'agent') {
      onChange({
        name: phase.name,
        kind: 'agent',
        description: phase.description,
        agent: agents[0]?.name ?? 'builder',
        envelope: 'build',
        prompt: { template: 'user', inputs: ['request'] },
        gates: [],
      });
      return;
    }
    if (kind === 'code') {
      onChange({
        name: phase.name,
        kind: 'code',
        description: phase.description,
        command: commands[0] ? { ref: commands[0] } : { builtin: 'git_commit' },
      });
      return;
    }
    onChange({
      name: phase.name,
      kind: 'engineer',
      description: phase.description,
      question: '',
    });
  };

  const handleSourceChange = (next: CommandSource): void => {
    if (next === 'ref') {
      onChange({
        ...phase,
        command: commands[0] ? { ref: commands[0] } : { ref: 'test' },
      });
    } else if (next === 'builtin') {
      onChange({ ...phase, command: { builtin: 'git_commit' } });
    } else {
      onChange({ ...phase, command: { argv: ['sh', '-c', 'echo run'] } });
    }
  };

  const kindOptions = [
    { label: 'Agent', on: phase.kind === 'agent', onClick: () => handleKindChange('agent') },
    { label: 'Command', on: phase.kind === 'code', onClick: () => handleKindChange('code') },
    {
      label: 'Checkpoint',
      on: phase.kind === 'engineer',
      onClick: () => handleKindChange('engineer'),
    },
  ];

  const sourceOptions = [
    { label: 'Project', on: commandSource === 'ref', onClick: () => handleSourceChange('ref') },
    {
      label: 'Builtin',
      on: commandSource === 'builtin',
      onClick: () => handleSourceChange('builtin'),
    },
    { label: 'Argv', on: commandSource === 'argv', onClick: () => handleSourceChange('argv') },
  ];

  return (
    <div className={styles.container}>
      {/* ── Name & Kind ──────────────────────────────────────────────── */}
      <div className={styles.fieldGroup}>
        <div className={styles.fieldHeader}>
          <label htmlFor={`phase-name-${index}`} className={styles.fieldLabel}>
            Name
          </label>
          <span className={styles.fieldHint}>snake_case identifier</span>
        </div>
        <input
          id={`phase-name-${index}`}
          className={styles.monoInput}
          value={phase.name}
          onChange={(e) => onChange({ ...phase, name: e.target.value })}
          placeholder="e.g. build_app"
        />
      </div>

      <div className={styles.fieldGroup}>
        <div className={styles.fieldHeader}>
          <span className={styles.fieldLabel}>Kind</span>
        </div>
        <SegmentedControl options={kindOptions} />
      </div>

      <div className={styles.fieldGroup}>
        <div className={styles.fieldHeader}>
          <label htmlFor={`phase-desc-${index}`} className={styles.fieldLabel}>
            Description
          </label>
          <span className={styles.fieldHint}>required</span>
        </div>
        <textarea
          id={`phase-desc-${index}`}
          rows={3}
          className={styles.textarea}
          placeholder="What this phase does, and why the run needs it."
          value={phase.description}
          onChange={(e) => onChange({ ...phase, description: e.target.value })}
        />
      </div>

      {/* ── Agent Specific ───────────────────────────────────────────── */}
      {phase.kind === 'agent' && (
        <>
          <div className={styles.fieldGroup}>
            <div className={styles.fieldHeader}>
              <label htmlFor={`phase-agent-${index}`} className={styles.fieldLabel}>
                Agent
              </label>
              <span className={styles.fieldHint}>{agents.length} in roster</span>
            </div>
            <select
              id={`phase-agent-${index}`}
              className={styles.select}
              value={phase.agent ?? ''}
              onChange={(e) => onChange({ ...phase, agent: e.target.value })}
            >
              <option value="">— select agent —</option>
              {agents.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name} ({a.model})
                </option>
              ))}
            </select>
          </div>

          <div className={styles.fieldGroup}>
            <div className={styles.fieldHeader}>
              <label htmlFor={`phase-envelope-${index}`} className={styles.fieldLabel}>
                Envelope
              </label>
              {isBuiltinEnvelope(phase.envelope) && (
                <span className={styles.fieldHint}>{BUILTIN_ENVELOPE_BLURBS[phase.envelope]}</span>
              )}
            </div>
            <select
              id={`phase-envelope-${index}`}
              className={styles.select}
              value={phase.envelope ?? ''}
              onChange={(e) => onChange({ ...phase, envelope: e.target.value || undefined })}
            >
              <option value="">— inherit from agent —</option>
              <optgroup label="Built-in">
                {BUILTIN_ENVELOPE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </optgroup>
              {envelopes.length > 0 && (
                <optgroup label="Custom">
                  {envelopes.map((env) => (
                    <option key={env.name} value={env.name}>
                      {env.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>

          <div className={styles.fieldGroup}>
            <div className={styles.fieldHeader}>
              <span className={styles.fieldLabel}>Gates</span>
              <span className={styles.fieldHint}>{activeGates.length} active</span>
            </div>
            <div className={styles.chipRow}>
              {activeGates.map((gate) => (
                <button
                  key={gate}
                  type="button"
                  onClick={() =>
                    onChange({
                      ...phase,
                      gates: (phase.gates ?? []).filter((g) =>
                        typeof g === 'string' ? g !== gate : g.gate !== gate,
                      ),
                    })
                  }
                  className={styles.removableChip}
                  title="Remove gate"
                >
                  {gate}
                  <span className={styles.chipClose}>×</span>
                </button>
              ))}
              {activeGates.length === 0 && <span className={styles.mutedText}>none</span>}
            </div>
            <select
              className={`${styles.select} ${styles.selectSm}`}
              value=""
              onChange={(e) => {
                if (e.target.value) {
                  const next = [...(phase.gates ?? []), e.target.value];
                  onChange({ ...phase, gates: next });
                }
              }}
            >
              <option value="">+ add gate</option>
              {catalogGates
                .filter((g) => !activeGates.includes(g.id))
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.id} — {g.description}
                  </option>
                ))}
            </select>
          </div>

          <div className={styles.fieldGroup}>
            <div className={styles.fieldHeader}>
              <span className={styles.fieldLabel}>Prompt inputs</span>
              <span className={styles.fieldHint}>template: user</span>
            </div>
            <div className={styles.chipRow}>
              {inputs.map((inp) => (
                <button
                  key={inp}
                  type="button"
                  onClick={() =>
                    onChange({
                      ...phase,
                      prompt: {
                        template: phase.prompt?.template ?? 'user',
                        inputs: inputs.filter((i) => i !== inp),
                      },
                    })
                  }
                  className={styles.removableChip}
                  title="Remove input"
                >
                  {inp}
                  <span className={styles.chipClose}>×</span>
                </button>
              ))}
            </div>
            {availableInputs.length > 0 && (
              <select
                className={`${styles.select} ${styles.selectSm}`}
                value=""
                onChange={(e) => {
                  if (e.target.value) {
                    onChange({
                      ...phase,
                      prompt: {
                        template: phase.prompt?.template ?? 'user',
                        inputs: [...inputs, e.target.value],
                      },
                    });
                  }
                }}
              >
                <option value="">+ add input</option>
                {availableInputs.map((i) => (
                  <option key={i} value={i}>
                    {i}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className={styles.fieldGroup}>
            <div className={styles.fieldHeader}>
              <label htmlFor={`phase-retries-${index}`} className={styles.fieldLabel}>
                Retries
              </label>
              <span className={styles.fieldHint}>0–5 on gate failure</span>
            </div>
            <input
              id={`phase-retries-${index}`}
              type="number"
              min={0}
              max={5}
              className={styles.monoInput}
              value={phase.retries ?? 0}
              onChange={(e) => onChange({ ...phase, retries: Number(e.target.value) })}
            />
          </div>
        </>
      )}

      {/* ── Command Specific ─────────────────────────────────────────── */}
      {phase.kind === 'code' && (
        <>
          <div className={styles.fieldGroup}>
            <div className={styles.fieldHeader}>
              <span className={styles.fieldLabel}>Command source</span>
              {commands.length > 0 && (
                <span className={styles.fieldHint}>project: {commands.join(', ')}</span>
              )}
            </div>
            <SegmentedControl options={sourceOptions} />

            <div className={styles.subField}>
              {commandSource === 'ref' && (
                <select
                  className={styles.select}
                  value={phase.command && 'ref' in phase.command ? phase.command.ref : ''}
                  onChange={(e) => onChange({ ...phase, command: { ref: e.target.value } })}
                >
                  <option value="">— pick a command —</option>
                  {commands.map((cmd) => (
                    <option key={cmd} value={cmd}>
                      {cmd}
                    </option>
                  ))}
                  {phase.command &&
                    'ref' in phase.command &&
                    !commands.includes(phase.command.ref) && (
                      <option value={phase.command.ref}>
                        {phase.command.ref} (not configured)
                      </option>
                    )}
                </select>
              )}

              {commandSource === 'builtin' && (
                <select
                  className={styles.select}
                  value={
                    phase.command && 'builtin' in phase.command
                      ? phase.command.builtin
                      : 'git_commit'
                  }
                  onChange={(e) =>
                    onChange({
                      ...phase,
                      command: {
                        builtin: e.target.value as 'git_commit' | 'git_status' | 'noop',
                        messageFrom:
                          phase.command && 'builtin' in phase.command
                            ? phase.command.messageFrom
                            : undefined,
                      },
                    })
                  }
                >
                  <option value="git_commit">git_commit</option>
                  <option value="git_status">git_status</option>
                  <option value="noop">noop</option>
                </select>
              )}

              {commandSource === 'argv' && (
                <input
                  className={styles.monoInput}
                  value={
                    phase.command && 'argv' in phase.command ? phase.command.argv.join(' ') : ''
                  }
                  onChange={(e) =>
                    onChange({ ...phase, command: { argv: e.target.value.split(' ') } })
                  }
                  placeholder="e.g. npm test"
                />
              )}
            </div>
          </div>

          <div className={styles.fieldGroup}>
            <div className={styles.fieldHeader}>
              <label htmlFor={`phase-feedback-${index}`} className={styles.fieldLabel}>
                Feedback to
              </label>
              <span className={styles.fieldHint}>earlier agent phases only</span>
            </div>
            <select
              id={`phase-feedback-${index}`}
              className={styles.select}
              value={phase.feedbackTo ?? ''}
              onChange={(e) =>
                onChange({
                  ...phase,
                  feedbackTo: e.target.value || undefined,
                  feedbackRetries: e.target.value ? (phase.feedbackRetries ?? 1) : undefined,
                })
              }
            >
              <option value="">— fail the run on error —</option>
              {earlierAgents.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>

            {phase.feedbackTo && (
              <div className={styles.subField}>
                <div className={styles.fieldHeader}>
                  <label htmlFor={`phase-fb-retries-${index}`} className={styles.fieldLabel}>
                    Feedback retries
                  </label>
                  <span className={styles.fieldHint}>1–5 attempts</span>
                </div>
                <input
                  id={`phase-fb-retries-${index}`}
                  type="number"
                  min={1}
                  max={5}
                  className={styles.monoInput}
                  value={phase.feedbackRetries ?? 1}
                  onChange={(e) => onChange({ ...phase, feedbackRetries: Number(e.target.value) })}
                />
              </div>
            )}
          </div>

          <div className={styles.fieldGroup}>
            <label className={styles.toggleRow}>
              <input
                type="checkbox"
                checked={!!phase.optional}
                onChange={(e) => onChange({ ...phase, optional: e.target.checked })}
                className={styles.checkbox}
              />
              <div>
                <span className={styles.toggleLabel}>Optional</span>
                <span className={styles.toggleHint}>
                  Non-zero exit is recorded in the trace but does not fail the run.
                </span>
              </div>
            </label>
          </div>
        </>
      )}

      {/* ── Checkpoint Specific ──────────────────────────────────────── */}
      {phase.kind === 'engineer' && (
        <>
          <div className={styles.fieldGroup}>
            <div className={styles.fieldHeader}>
              <label htmlFor={`phase-question-${index}`} className={styles.fieldLabel}>
                Question
              </label>
              <span className={styles.fieldHint}>shown on interrupt sheet</span>
            </div>
            <textarea
              id={`phase-question-${index}`}
              rows={3}
              className={styles.textarea}
              placeholder="What this checkpoint asks the human operator."
              value={phase.question ?? ''}
              onChange={(e) => onChange({ ...phase, question: e.target.value })}
            />
            {!phase.question?.trim() && (
              <p className={styles.warningText}>
                No question set — the interrupt sheet opens with no question text.
              </p>
            )}
          </div>

          <div className={styles.fieldGroup}>
            <div className={styles.fieldHeader}>
              <label htmlFor={`phase-timeout-${index}`} className={styles.fieldLabel}>
                Timeout (minutes)
              </label>
              <span className={styles.fieldHint}>optional</span>
            </div>
            <input
              id={`phase-timeout-${index}`}
              type="number"
              min={1}
              className={styles.monoInput}
              value={phase.timeoutMs ? Math.round(phase.timeoutMs / 60000) : ''}
              onChange={(e) =>
                onChange({
                  ...phase,
                  timeoutMs: e.target.value ? Number(e.target.value) * 60000 : undefined,
                })
              }
              placeholder="e.g. 30"
            />
          </div>
        </>
      )}

      {/* ── Danger Zone ──────────────────────────────────────────────── */}
      <div className={styles.footerAction}>
        <Button variant="danger" size="sm" onClick={onRemove}>
          Remove phase
        </Button>
      </div>
    </div>
  );
}
