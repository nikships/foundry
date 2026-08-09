import { useEffect, useMemo, useState } from 'react';
import type { AgentDef, EnvelopeKind, PhaseDef } from '@shared/types.js';
import { api } from '../api.js';
import { useApp } from '../stores/app.js';
import { phaseKindColor, KIND_LABEL } from '../derive.js';
import AgentAvatar from './AgentAvatar.js';
import { CliIcon } from './BrandIcon.js';
import { Field, Select, TextInput, Textarea } from './ui/Field.js';
import { SegmentedControl } from './ui/SegmentedControl.js';
import styles from './PhaseEditor.module.css';

const ENVELOPE_KINDS: EnvelopeKind[] = ['plan', 'build', 'review', 'scout', 'document', 'generic'];

export default function PhaseEditor({
  phase,
  index,
  open,
  phases,
  agents,
  commands,
  onChange,
  onToggle,
  onMove,
  onRemove,
}: {
  phase: PhaseDef;
  index: number;
  open: boolean;
  phases: PhaseDef[];
  agents: AgentDef[];
  commands: string[];
  onChange: (phase: PhaseDef) => void;
  onToggle: () => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const { agentColor } = useApp();
  const [gates, setGates] = useState<{ id: string; description: string }[]>([]);

  useEffect(() => {
    void api.catalog.gates().then(setGates);
  }, []);

  const color = useMemo(
    () => phaseKindColor(phase.kind, agentColor(phase.agent ?? null)),
    [phase.kind, phase.agent, agentColor],
  );
  const earlier = useMemo(() => phases.slice(0, index).map((p) => p.name), [phases, index]);
  const usesArgv = phase.kind === 'code' && !!phase.command && 'argv' in phase.command;

  const patch = (next: Partial<PhaseDef>): void => onChange({ ...phase, ...next });

  const toggleGate = (id: string): void => {
    const current = phase.gates ?? [];
    patch({
      gates: current.includes(id) ? current.filter((g) => g !== id) : [...current, id],
    });
  };

  const toggleInput = (name: string): void => {
    const prompt = phase.prompt ?? { template: 'user' as const, inputs: [] as string[] };
    const current = prompt.inputs ?? [];
    patch({
      prompt: {
        ...prompt,
        inputs: current.includes(name) ? current.filter((i) => i !== name) : [...current, name],
      },
    });
  };

  const setCommandMode = (mode: 'ref' | 'argv'): void => {
    if (phase.kind !== 'code') return;
    patch({
      command: mode === 'ref' ? { ref: commands[0] ?? '' } : { argv: ['echo', 'hello'] },
    });
  };

  // The CLI is the agent's, not the phase's, so a phase head can say which
  // harness will actually run it without opening the Roster.
  const owner =
    phase.kind === 'agent' ? (agents.find((a) => a.name === phase.agent) ?? null) : null;

  const commandRef = phase.command && 'ref' in phase.command ? phase.command.ref : '';
  const argvText = phase.command && 'argv' in phase.command ? phase.command.argv.join(' ') : '';

  return (
    <>
      <div
        className={`${styles.phase} ${open ? styles.open : ''}`}
        style={{ ['--hue' as string]: color }}
      >
        {open && <span className={styles.phaseEdge} aria-hidden />}
        <div className={styles.rowWrap}>
          <button className={`row ${styles.head}`} onClick={onToggle} aria-expanded={open}>
            <span className={styles.num}>{String(index + 1).padStart(2, '0')}</span>
            <span className={styles.glyph} style={{ color }}>
              {phase.kind === 'agent' ? (
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
              ) : phase.kind === 'code' ? (
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
              ) : (
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
              )}
            </span>
            {phase.kind === 'agent' && <AgentAvatar name={phase.agent ?? null} size={20} />}
            <span className={styles.pname}>{phase.name}</span>
            <span className={styles.kind}>{KIND_LABEL[phase.kind] ?? phase.kind}</span>
            <span className={styles.summary}>
              {phase.kind === 'agent' && (
                <>
                  {owner && <CliIcon vendor={owner.cli ?? 'droid'} size={12} />}
                  <span className={styles.sumStrong}>{phase.agent}</span>
                  <span className={styles.sumDim}> · envelope </span>
                  <span className={styles.sumStrong}>
                    {phase.envelope ?? owner?.envelope ?? 'build'}
                  </span>
                </>
              )}
              {phase.kind === 'code' && (
                <>
                  <span className={styles.sumDim}>$ </span>
                  <span className={styles.sumStrong}>
                    {phase.command && 'ref' in phase.command
                      ? phase.command.ref
                      : phase.command && 'argv' in phase.command
                        ? phase.command.argv.join(' ')
                        : ''}
                  </span>
                </>
              )}
              {phase.kind === 'engineer' && (
                <span className={styles.sumStrong}>{phase.question}</span>
              )}
              {phase.optional && <span className={styles.sumDim}> · optional</span>}
            </span>
            {phase.feedbackTo && (
              <span className={`badge ${styles.loop}`}>↩ {phase.feedbackTo}</span>
            )}
            <svg
              className={`${styles.chev} ${open ? styles.up : ''}`}
              width="12"
              height="12"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M3.5 5.5 7 9l3.5-3.5" />
            </svg>
          </button>
          <span className={styles.controls}>
            <button
              className={styles.ctl}
              disabled={index === 0}
              title="Move earlier"
              onClick={(e) => {
                e.stopPropagation();
                onMove(-1);
              }}
            >
              ↑
            </button>
            <button
              className={styles.ctl}
              disabled={index === phases.length - 1}
              title="Move later"
              onClick={(e) => {
                e.stopPropagation();
                onMove(1);
              }}
            >
              ↓
            </button>
            <button
              className={`${styles.ctl} ${styles.danger}`}
              title="Remove phase"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
            >
              ✕
            </button>
          </span>
        </div>
        {open && (
          <div className={styles.body}>
            <div className={styles.two}>
              <Field label="Name" hint="Other phases refer to this one by name.">
                <TextInput value={phase.name} onChange={(e) => patch({ name: e.target.value })} />
              </Field>
              {phase.kind === 'agent' && (
                <Field label="Agent">
                  <Select
                    value={phase.agent ?? ''}
                    onChange={(e) => {
                      const agent = agents.find((a) => a.name === e.target.value);
                      // Default the phase envelope to the agent's so a reviewer
                      // phase is not left on build after the agent is swapped.
                      patch({
                        agent: e.target.value,
                        envelope: agent?.envelope ?? phase.envelope ?? 'build',
                      });
                    }}
                  >
                    {agents.map((a) => (
                      <option key={a.name} value={a.name}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>
            {phase.kind === 'agent' && (
              <Field
                label="Envelope"
                hint="Typed reply this phase must return. Defaults from the agent; override when the same agent wears different hats."
              >
                <Select
                  value={phase.envelope ?? owner?.envelope ?? 'build'}
                  onChange={(e) => patch({ envelope: e.target.value as EnvelopeKind })}
                >
                  {ENVELOPE_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {kind}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field
              label="Description"
              hint="Shown in the run view. A phase nobody can explain is a phase nobody should run."
            >
              <TextInput
                value={phase.description}
                placeholder="What this phase is for, in one line."
                onChange={(e) => patch({ description: e.target.value })}
              />
            </Field>
            {phase.kind === 'agent' && (
              <>
                <Field
                  label="Inputs from earlier phases"
                  hint="Selected envelopes are appended to the prompt unless the agent's template already references them."
                >
                  <div className={styles.chips}>
                    {earlier.map((name) => (
                      <button
                        key={name}
                        className={`${styles.chip} ${phase.prompt?.inputs?.includes(name) ? styles.on : ''}`}
                        onClick={() => toggleInput(name)}
                      >
                        {name}
                      </button>
                    ))}
                    <button
                      className={`${styles.chip} ${phase.prompt?.inputs?.includes('request') ? styles.on : ''}`}
                      onClick={() => toggleInput('request')}
                    >
                      request
                    </button>
                  </div>
                </Field>
                <Field
                  label="Gates"
                  hint="Gates produce evidence. A failed gate is sent back to the agent as a correction."
                >
                  <div className={styles.gates}>
                    {gates
                      // command_passes needs a configured argv the editor cannot
                      // yet set, so offering it only produces a save-blocking error.
                      .filter((gate) => gate.id !== 'command_passes')
                      .map((gate) => (
                        <label key={gate.id} className={styles.gate}>
                          <input
                            type="checkbox"
                            checked={phase.gates?.includes(gate.id) ?? false}
                            onChange={() => toggleGate(gate.id)}
                          />
                          <span>
                            <code>{gate.id}</code>
                            <em className="faint">{gate.description}</em>
                          </span>
                        </label>
                      ))}
                  </div>
                </Field>
              </>
            )}
            {phase.kind === 'code' && (
              <Field
                label="Command"
                hint={
                  !usesArgv
                    ? 'Runs the command configured for the project, so the same pipeline works across repos. Detect or ask an agent from Settings → Project.'
                    : 'Runs exactly these arguments, with no shell.'
                }
              >
                <SegmentedControl
                  className={styles.commandModes}
                  options={[
                    {
                      label: 'Project command',
                      on: !usesArgv,
                      onClick: () => setCommandMode('ref'),
                    },
                    { label: 'Literal', on: usesArgv, onClick: () => setCommandMode('argv') },
                  ]}
                />
                {!usesArgv ? (
                  commands.length ? (
                    <Select
                      value={commandRef}
                      onChange={(e) => patch({ command: { ref: e.target.value } })}
                    >
                      {commands.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <p className={`hint ${styles.emptyCmds}`}>
                      No project commands yet. Switch to Literal, or detect them in Settings →
                      Project.
                    </p>
                  )
                ) : (
                  <TextInput
                    mono
                    value={argvText}
                    placeholder="npm test"
                    onChange={(e) =>
                      patch({
                        command: { argv: e.target.value.split(/\s+/).filter(Boolean) },
                      })
                    }
                  />
                )}
              </Field>
            )}
            {phase.kind === 'engineer' && (
              <Field label="Question" hint="The run pauses here until someone answers.">
                <Textarea
                  value={phase.question ?? ''}
                  rows={2}
                  onChange={(e) => patch({ question: e.target.value })}
                />
              </Field>
            )}
            <div className={styles.two}>
              <Field
                label="Send failures back to"
                hint="The failure output is handed to that phase as a repair request."
              >
                <Select
                  value={phase.feedbackTo ?? ''}
                  onChange={(e) => patch({ feedbackTo: e.target.value || undefined })}
                >
                  <option value="">Nowhere: a failure ends the run</option>
                  {earlier.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </Select>
              </Field>
              {phase.feedbackTo && (
                <Field
                  label="Repair attempts"
                  hint="After this many attempts the run stops rather than looping."
                >
                  <TextInput
                    type="number"
                    min={1}
                    max={5}
                    value={phase.feedbackRetries ?? 1}
                    onChange={(e) => patch({ feedbackRetries: Number(e.target.value) })}
                  />
                </Field>
              )}
            </div>
            <label className={styles.optLine}>
              <input
                type="checkbox"
                checked={!!phase.optional}
                onChange={(e) => patch({ optional: e.target.checked })}
              />
              <span>
                Optional
                <em className="faint">
                  A failure here is recorded and skipped instead of ending the run.
                </em>
              </span>
            </label>
          </div>
        )}
      </div>
    </>
  );
}
