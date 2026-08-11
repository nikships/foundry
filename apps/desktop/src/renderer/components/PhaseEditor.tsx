/**
 * PhaseEditor — the fields for one phase.
 *
 * Presentation only: this is the body of the phase inspector docked beside the
 * ladder, so it owns no row head, no disclosure, and no reorder controls —
 * identity and ordering live on the rung that selected it. The editing
 * semantics (envelope following the agent, gate filtering, command modes,
 * repair loops, optional) are unchanged.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  BUILTIN_ENVELOPE_BLURBS,
  BUILTIN_ENVELOPE_KINDS,
  type AgentDef,
  type PhaseDef,
} from '@shared/types.js';
import { api } from '../api.js';
import { useApp } from '../stores/app.js';
import AgentAvatar from './AgentAvatar.js';
import { EnvelopeGlyph } from './PhaseGlyphs.js';
import { Dropdown, type DropdownOption } from './ui/Dropdown.js';
import { Field, TextInput, Textarea } from './ui/Field.js';
import { SegmentedControl } from './ui/SegmentedControl.js';
import styles from './PhaseEditor.module.css';

export default function PhaseEditor({
  phase,
  index,
  phases,
  agents,
  commands,
  onChange,
  onOpenSettings,
}: {
  phase: PhaseDef;
  index: number;
  phases: PhaseDef[];
  agents: AgentDef[];
  commands: string[];
  onChange: (phase: PhaseDef) => void;
  onOpenSettings?: (pane: string) => void;
}): React.JSX.Element {
  const { envelopes } = useApp();
  const [gates, setGates] = useState<{ id: string; description: string }[]>([]);

  useEffect(() => {
    void api.catalog.gates().then(setGates);
  }, []);

  const earlier = useMemo(() => phases.slice(0, index).map((p) => p.name), [phases, index]);
  const usesArgv = phase.kind === 'code' && !!phase.command && 'argv' in phase.command;

  const agentOptions = useMemo<DropdownOption[]>(
    () =>
      agents.map((a) => ({
        value: a.name,
        label: a.name,
        description: a.purpose,
        icon: <AgentAvatar name={a.name} size={22} />,
      })),
    [agents],
  );

  const envelopeOptions = useMemo<DropdownOption[]>(() => {
    const builtin: DropdownOption[] = BUILTIN_ENVELOPE_KINDS.map((kind) => ({
      value: kind,
      label: kind,
      description: BUILTIN_ENVELOPE_BLURBS[kind],
      group: 'Built-in',
      icon: (
        <span className={styles.envelopeOptionIcon}>
          <EnvelopeGlyph size={12} />
        </span>
      ),
    }));
    const custom: DropdownOption[] = envelopes.map((env) => ({
      value: env.name,
      label: env.name,
      description: env.description || undefined,
      group: 'Custom',
      icon: (
        <span className={styles.envelopeOptionIcon}>
          <EnvelopeGlyph size={12} />
        </span>
      ),
    }));
    return [...builtin, ...custom];
  }, [envelopes]);

  const commandOptions = useMemo<DropdownOption[]>(
    () => commands.map((name) => ({ value: name, label: name })),
    [commands],
  );

  const feedbackOptions = useMemo<DropdownOption[]>(
    () => [
      { value: '', label: 'Nowhere: a failure ends the run' },
      ...earlier.map((name) => ({ value: name, label: name })),
    ],
    [earlier],
  );

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

  // The CLI is the agent's, not the phase's, so the envelope default can follow
  // the agent without the Roster being open.
  const owner =
    phase.kind === 'agent' ? (agents.find((a) => a.name === phase.agent) ?? null) : null;

  const commandRef = phase.command && 'ref' in phase.command ? phase.command.ref : '';
  const argvText = phase.command && 'argv' in phase.command ? phase.command.argv.join(' ') : '';

  return (
    <div className={styles.body}>
      <div className={styles.two}>
        <Field label="Name" hint="Other phases refer to this one by name.">
          <TextInput value={phase.name} onChange={(e) => patch({ name: e.target.value })} />
        </Field>
        {phase.kind === 'agent' && (
          <Field label="Agent">
            <Dropdown
              value={phase.agent ?? ''}
              options={agentOptions}
              onChange={(next) => {
                const agent = agents.find((a) => a.name === next);
                // Default the phase envelope to the agent's so a reviewer
                // phase is not left on build after the agent is swapped.
                patch({
                  agent: next,
                  envelope: agent?.envelope ?? phase.envelope ?? 'build',
                });
              }}
            />
          </Field>
        )}
      </div>
      {phase.kind === 'agent' && (
        <Field
          label="Envelope"
          hint={
            <>
              Typed reply this phase must return. Defaults from the agent; override when the same
              agent wears different hats.
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
            </>
          }
        >
          <Dropdown
            value={phase.envelope ?? owner?.envelope ?? 'build'}
            options={envelopeOptions}
            onChange={(next) => patch({ envelope: next })}
          />
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
              <Dropdown
                value={commandRef}
                options={commandOptions}
                onChange={(next) => patch({ command: { ref: next } })}
              />
            ) : (
              <p className={`hint ${styles.emptyCmds}`}>
                No project commands yet. Switch to Literal, or detect them in Settings → Project.
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
          <Dropdown
            value={phase.feedbackTo ?? ''}
            options={feedbackOptions}
            onChange={(next) => patch({ feedbackTo: next || undefined })}
          />
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
      <label className={styles.optionalToggle}>
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
  );
}
