import { useEffect, useMemo, useState } from 'react';
import {
  BUILTIN_ENVELOPE_BLURBS,
  BUILTIN_ENVELOPE_KINDS,
  commandSourceOf,
  effectivePhaseEnvelope,
  healingEligible,
  type AgentDef,
  type CommandSource,
  type EnvelopeKind,
  type PhaseDef,
  type PhaseKind,
  type ValidationIssue,
} from '@shared/types.js';
import { modelLabel } from '@shared/model-label.js';
import { api } from '../../api.js';
import type { DesignTab } from '../../utils/navigation.js';
import { useApp } from '../../stores/app.js';
import { useAgentModels } from '../../hooks/useAgentModels.js';
import {
  applyPhaseEnvelopeOverride,
  applyPhaseModelOverride,
  bindPhaseAgent,
  gateNames,
  inheritEnvelopeOptionLabel,
} from '../../view-models/pipeline-view.js';
import ModelPicker from '../common/ModelPicker.js';
import { SegmentedControl } from '../ui/SegmentedControl.js';
import { Button } from '../ui/Button.js';
import { IssueLine } from '../ui/Issues.js';
import { Toggle } from '../ui/Toggle.js';
import styles from './PhaseEditor.module.css';

function isBuiltinEnvelope(env: string | undefined): env is EnvelopeKind {
  return env ? (BUILTIN_ENVELOPE_KINDS as readonly string[]).includes(env) : false;
}

function FieldGroup({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={styles.fieldGroup}>
      <div className={styles.fieldHeader}>
        {htmlFor ? (
          <label htmlFor={htmlFor} className={styles.fieldLabel}>
            {label}
          </label>
        ) : (
          <span className={styles.fieldLabel}>{label}</span>
        )}
        {typeof hint === 'string' ? <span className={styles.fieldHint}>{hint}</span> : hint}
      </div>
      {children}
    </div>
  );
}

function RemovableChips({
  items,
  empty,
  removeTitle,
  onRemove,
}: {
  items: string[];
  empty?: React.ReactNode;
  removeTitle: string;
  onRemove: (item: string) => void;
}): React.JSX.Element {
  return (
    <div className={styles.chipRow}>
      {items.map((item) => (
        <button
          key={item}
          type="button"
          onClick={() => onRemove(item)}
          className={styles.removableChip}
          title={removeTitle}
        >
          {item}
          <span className={styles.chipClose}>×</span>
        </button>
      ))}
      {items.length === 0 && empty}
    </div>
  );
}

function envelopeFieldHint(
  phase: PhaseDef,
  selectedAgent: AgentDef | undefined,
  effectiveEnvelope: ReturnType<typeof effectivePhaseEnvelope>,
): React.ReactNode {
  if (phase.envelope) {
    return (
      <span className={styles.fieldHint}>
        {isBuiltinEnvelope(phase.envelope)
          ? `override · ${BUILTIN_ENVELOPE_BLURBS[phase.envelope]}`
          : 'override'}
      </span>
    );
  }
  if (isBuiltinEnvelope(effectiveEnvelope)) {
    return (
      <span className={styles.fieldHint}>
        {selectedAgent
          ? `via ${selectedAgent.name} · ${BUILTIN_ENVELOPE_BLURBS[effectiveEnvelope]}`
          : BUILTIN_ENVELOPE_BLURBS[effectiveEnvelope]}
      </span>
    );
  }
  if (selectedAgent?.envelope) {
    return <span className={styles.fieldHint}>via {selectedAgent.name}</span>;
  }
  return null;
}

export default function PhaseEditor({
  phase,
  index,
  phases,
  agents,
  commands,
  issues = [],
  onChange,
  onRemove,
  onOpenDesignTab,
}: {
  phase: PhaseDef;
  index: number;
  phases: PhaseDef[];
  agents: AgentDef[];
  commands: string[];
  /** Validation issues already narrowed to this phase. */
  issues?: ValidationIssue[];
  onChange: (phase: PhaseDef) => void;
  onRemove: () => void;
  /** Cross-link to a sibling Design tab, e.g. the envelope library. */
  onOpenDesignTab?: (tab: DesignTab) => void;
}): React.JSX.Element {
  const { envelopes } = useApp();
  const { models, refresh: refreshModels } = useAgentModels();
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

  const commandSource: CommandSource = useMemo(
    () => (phase.kind === 'code' ? commandSourceOf(phase.command) : 'ref'),
    [phase.kind, phase.command],
  );

  // The engine's own rule, so the toggle cannot draw a phase as healing that
  // would not heal — including the default an unset `heal` resolves to.
  const healEnabled = healingEligible(phase);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.name === phase.agent),
    [agents, phase.agent],
  );
  const effectiveEnvelope = effectivePhaseEnvelope(phase, agents);

  const handleKindChange = (kind: PhaseKind): void => {
    if (kind === phase.kind) return;
    if (kind === 'agent') {
      onChange({
        name: phase.name,
        kind: 'agent',
        description: phase.description,
        agent: agents[0]?.name ?? 'builder',
        prompt: { inputs: ['request'] },
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
    }
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
      {issues.length > 0 && (
        <div className={styles.issueList} role="alert">
          {issues.map((issue, i) => (
            <IssueLine key={`${issue.level}-${issue.message}-${i}`} issue={issue} />
          ))}
        </div>
      )}

      {/* ── Name & Kind ──────────────────────────────────────────────── */}
      <FieldGroup label="Name" htmlFor={`phase-name-${index}`} hint="snake_case identifier">
        <input
          id={`phase-name-${index}`}
          className={styles.monoInput}
          value={phase.name}
          onChange={(e) => onChange({ ...phase, name: e.target.value })}
          placeholder="e.g. build_app"
        />
      </FieldGroup>

      <FieldGroup label="Kind">
        <SegmentedControl options={kindOptions} />
      </FieldGroup>

      <FieldGroup label="Description" htmlFor={`phase-desc-${index}`} hint="required">
        <textarea
          id={`phase-desc-${index}`}
          rows={3}
          className={styles.textarea}
          placeholder="What this phase does, and why the run needs it."
          value={phase.description}
          onChange={(e) => onChange({ ...phase, description: e.target.value })}
        />
      </FieldGroup>

      {/* ── Agent Specific ───────────────────────────────────────────── */}
      {phase.kind === 'agent' && (
        <>
          <FieldGroup
            label="Agent"
            htmlFor={`phase-agent-${index}`}
            hint={`${agents.length} in roster`}
          >
            <select
              id={`phase-agent-${index}`}
              className={styles.select}
              value={phase.agent ?? ''}
              onChange={(e) => onChange(bindPhaseAgent(phase, e.target.value))}
            >
              <option value="">— select agent —</option>
              {agents.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name} ({modelLabel(a.model)})
                </option>
              ))}
            </select>
          </FieldGroup>

          <FieldGroup label="Model" hint={phase.model ? 'override' : 'via agent'}>
            <ModelPicker
              value={phase.model ?? 'inherit'}
              models={models}
              allowInherit
              inheritLabel={
                selectedAgent
                  ? `Inherit from ${selectedAgent.name} (${modelLabel(selectedAgent.model)})`
                  : 'Inherit from agent'
              }
              emptyHint="No models are reachable. Connect a provider under Settings → Providers, or inherit from the agent."
              onChange={(value) => onChange(applyPhaseModelOverride(phase, value))}
              onRefresh={() => void refreshModels()}
            />
          </FieldGroup>

          <FieldGroup
            label="Report"
            htmlFor={`phase-envelope-${index}`}
            hint={envelopeFieldHint(phase, selectedAgent, effectiveEnvelope)}
          >
            <select
              id={`phase-envelope-${index}`}
              className={styles.select}
              value={phase.envelope ?? ''}
              onChange={(e) => onChange(applyPhaseEnvelopeOverride(phase, e.target.value))}
            >
              <option value="">{inheritEnvelopeOptionLabel(selectedAgent)}</option>
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
            {onOpenDesignTab && (
              <button
                type="button"
                className={styles.linkBtn}
                onClick={() => onOpenDesignTab('envelopes')}
              >
                Manage reports…
              </button>
            )}
          </FieldGroup>

          <FieldGroup label="Checks" hint={`${activeGates.length} active`}>
            <RemovableChips
              items={activeGates}
              removeTitle="Remove check"
              empty={<span className={styles.mutedText}>none</span>}
              onRemove={(gate) =>
                onChange({
                  ...phase,
                  gates: (phase.gates ?? []).filter((g) =>
                    typeof g === 'string' ? g !== gate : g.gate !== gate,
                  ),
                })
              }
            />
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
              <option value="">+ add check</option>
              {catalogGates
                .filter((g) => g.id !== 'command_passes' && !activeGates.includes(g.id))
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.id} — {g.description}
                  </option>
                ))}
            </select>
          </FieldGroup>

          <FieldGroup label="Prompt inputs">
            <RemovableChips
              items={inputs}
              removeTitle="Remove input"
              onRemove={(inp) =>
                onChange({
                  ...phase,
                  prompt: {
                    inputs: inputs.filter((i) => i !== inp),
                  },
                })
              }
            />
            {availableInputs.length > 0 && (
              <select
                className={`${styles.select} ${styles.selectSm}`}
                value=""
                onChange={(e) => {
                  if (e.target.value) {
                    onChange({
                      ...phase,
                      prompt: {
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
          </FieldGroup>

          <FieldGroup
            label="Retries"
            htmlFor={`phase-retries-${index}`}
            hint="0–5 on check failure"
          >
            <input
              id={`phase-retries-${index}`}
              type="number"
              min={0}
              max={5}
              className={styles.monoInput}
              value={phase.retries ?? 0}
              onChange={(e) => onChange({ ...phase, retries: Number(e.target.value) })}
            />
          </FieldGroup>
        </>
      )}

      {/* ── Command Specific ─────────────────────────────────────────── */}
      {phase.kind === 'code' && (
        <>
          <FieldGroup
            label="Command source"
            hint={commands.length > 0 ? `project: ${commands.join(', ')}` : undefined}
          >
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
          </FieldGroup>

          <FieldGroup
            label="Feedback to"
            htmlFor={`phase-feedback-${index}`}
            hint="earlier agent phases only"
          >
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
          </FieldGroup>

          <div className={styles.fieldGroup}>
            <Toggle
              checked={!!phase.optional}
              onChange={(optional) => onChange({ ...phase, optional })}
              label="Optional"
              hint="Non-zero exit is recorded in the trace but does not fail the run."
            />
          </div>

          <div className={styles.fieldGroup}>
            <Toggle
              checked={healEnabled}
              onChange={(heal) => onChange({ ...phase, heal })}
              label="Heal on failure"
              // `optional` already decided this, so the switch reports rather
              // than offers: accepting a click it cannot honour would read as
              // a broken control.
              disabled={!!phase.optional}
              hint={
                phase.optional
                  ? 'An optional phase never heals: its failure does not fail the run.'
                  : 'A failed command gets a bounded agent turn to make the smallest fix, then the exact command runs again. On by default.'
              }
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
