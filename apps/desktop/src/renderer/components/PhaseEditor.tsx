import { useEffect, useMemo, useState } from 'react';
import type { AgentDef, EnvelopeKind, PhaseDef } from '@shared/types.js';
import { api } from '../api.js';
import { useApp } from '../stores/app.js';
import { phaseKindColor } from '../derive.js';
import AgentAvatar from './AgentAvatar.js';
import { CliIcon } from './BrandIcon.js';

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
      <div className={`phase ${open ? 'open' : ''}`} style={{ ['--hue' as string]: color }}>
        {open && <span className="phase-edge" aria-hidden />}
        <div className="row-wrap">
          <button className="row head" onClick={onToggle} aria-expanded={open}>
            <span className="num">{String(index + 1).padStart(2, '0')}</span>
            <span className="glyph" style={{ color }}>
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
            <span className="pname">{phase.name}</span>
            <span className="kind">{phase.kind === 'engineer' ? 'checkpoint' : phase.kind}</span>
            <span className="summary">
              {phase.kind === 'agent' && (
                <>
                  {owner && <CliIcon vendor={owner.cli ?? 'droid'} size={12} />}
                  <span className="sum-strong">{phase.agent}</span>
                  <span className="sum-dim"> · envelope </span>
                  <span className="sum-strong">{phase.envelope ?? owner?.envelope ?? 'build'}</span>
                </>
              )}
              {phase.kind === 'code' && (
                <>
                  <span className="sum-dim">$ </span>
                  <span className="sum-strong">
                    {phase.command && 'ref' in phase.command
                      ? phase.command.ref
                      : phase.command && 'argv' in phase.command
                        ? phase.command.argv.join(' ')
                        : ''}
                  </span>
                </>
              )}
              {phase.kind === 'engineer' && <span className="sum-strong">{phase.question}</span>}
              {phase.optional && <span className="sum-dim"> · optional</span>}
            </span>
            {phase.feedbackTo && <span className="badge loop">↩ {phase.feedbackTo}</span>}
            <svg
              className={`chev ${open ? 'up' : ''}`}
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
          <span className="controls">
            <button
              className="ctl"
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
              className="ctl"
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
              className="ctl danger"
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
          <div className="body">
            <div className="two">
              <div className="field">
                <label>Name</label>
                <input
                  className="input"
                  value={phase.name}
                  onChange={(e) => patch({ name: e.target.value })}
                />
                <span className="hint">Other phases refer to this one by name.</span>
              </div>
              {phase.kind === 'agent' && (
                <div className="field">
                  <label>Agent</label>
                  <select
                    className="select"
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
                  </select>
                </div>
              )}
            </div>
            {phase.kind === 'agent' && (
              <div className="field">
                <label>Envelope</label>
                <select
                  className="select"
                  value={phase.envelope ?? owner?.envelope ?? 'build'}
                  onChange={(e) => patch({ envelope: e.target.value as EnvelopeKind })}
                >
                  {ENVELOPE_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {kind}
                    </option>
                  ))}
                </select>
                <span className="hint">
                  Typed reply this phase must return. Defaults from the agent; override when the
                  same agent wears different hats.
                </span>
              </div>
            )}
            <div className="field">
              <label>Description</label>
              <input
                className="input"
                value={phase.description}
                placeholder="What this phase is for, in one line."
                onChange={(e) => patch({ description: e.target.value })}
              />
              <span className="hint">
                Shown in the run view. A phase nobody can explain is a phase nobody should run.
              </span>
            </div>
            {phase.kind === 'agent' && (
              <>
                <div className="field">
                  <label>Inputs from earlier phases</label>
                  <div className="chips">
                    {earlier.map((name) => (
                      <button
                        key={name}
                        className={`chip ${phase.prompt?.inputs?.includes(name) ? 'on' : ''}`}
                        onClick={() => toggleInput(name)}
                      >
                        {name}
                      </button>
                    ))}
                    <button
                      className={`chip ${phase.prompt?.inputs?.includes('request') ? 'on' : ''}`}
                      onClick={() => toggleInput('request')}
                    >
                      request
                    </button>
                  </div>
                  <span className="hint">
                    Selected envelopes are appended to the prompt unless the agent's template
                    already references them.
                  </span>
                </div>
                <div className="field">
                  <label>Gates</label>
                  <div className="gates">
                    {gates
                      // command_passes needs a configured argv the editor cannot
                      // yet set, so offering it only produces a save-blocking error.
                      .filter((gate) => gate.id !== 'command_passes')
                      .map((gate) => (
                        <label key={gate.id} className="gate">
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
                  <span className="hint">
                    Gates produce evidence. A failed gate is sent back to the agent as a correction.
                  </span>
                </div>
              </>
            )}
            {phase.kind === 'code' && (
              <div className="field">
                <label>Command</label>
                <div className="modes">
                  <button
                    className={`mode ${!usesArgv ? 'on' : ''}`}
                    onClick={() => setCommandMode('ref')}
                  >
                    Project command
                  </button>
                  <button
                    className={`mode ${usesArgv ? 'on' : ''}`}
                    onClick={() => setCommandMode('argv')}
                  >
                    Literal
                  </button>
                </div>
                {!usesArgv ? (
                  commands.length ? (
                    <select
                      className="select"
                      value={commandRef}
                      onChange={(e) => patch({ command: { ref: e.target.value } })}
                    >
                      {commands.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <p className="hint empty-cmds">
                      No project commands yet. Switch to Literal, or detect them in Settings →
                      Project.
                    </p>
                  )
                ) : (
                  <input
                    className="input mono"
                    value={argvText}
                    placeholder="npm test"
                    onChange={(e) =>
                      patch({
                        command: { argv: e.target.value.split(/\s+/).filter(Boolean) },
                      })
                    }
                  />
                )}
                <span className="hint">
                  {!usesArgv
                    ? 'Runs the command configured for the project, so the same pipeline works across repos. Detect or ask an agent from Settings → Project.'
                    : 'Runs exactly these arguments, with no shell.'}
                </span>
              </div>
            )}
            {phase.kind === 'engineer' && (
              <div className="field">
                <label>Question</label>
                <textarea
                  className="textarea"
                  value={phase.question ?? ''}
                  rows={2}
                  onChange={(e) => patch({ question: e.target.value })}
                />
                <span className="hint">The run pauses here until someone answers.</span>
              </div>
            )}
            <div className="two">
              <div className="field">
                <label>Send failures back to</label>
                <select
                  className="select"
                  value={phase.feedbackTo ?? ''}
                  onChange={(e) => patch({ feedbackTo: e.target.value || undefined })}
                >
                  <option value="">Nowhere: a failure ends the run</option>
                  {earlier.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <span className="hint">
                  The failure output is handed to that phase as a repair request.
                </span>
              </div>
              {phase.feedbackTo && (
                <div className="field">
                  <label>Repair attempts</label>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={5}
                    value={phase.feedbackRetries ?? 1}
                    onChange={(e) => patch({ feedbackRetries: Number(e.target.value) })}
                  />
                  <span className="hint">
                    After this many attempts the run stops rather than looping.
                  </span>
                </div>
              )}
            </div>
            <label className="opt-line">
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
      <style>{`
        /* Flat row in one continuous list — hairlines only, no card. */
        .phase { position: relative; border-bottom: 1px solid var(--line); }
        .phase-edge { position: absolute; left: 0; top: 0; bottom: 0; width: 1px; background: var(--hue); }
        .row-wrap { display: flex; align-items: center; padding-right: var(--s6); }
        .row-wrap:hover { background: color-mix(in srgb, #ffffff 1.8%, transparent); }
        .phase .head {
          flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--s3);
          padding: 13px 0 13px var(--s6);
          border: none; background: transparent; color: inherit; font: inherit;
          cursor: default; text-align: left;
        }
        .num { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.14em; color: var(--text-faint); width: 22px; flex: none; }
        .glyph { display: flex; align-items: center; flex: none; }
        .pname { font-size: var(--text-sm); font-weight: 500; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; flex: none; }
        .kind {
          font-family: var(--font-mono); font-size: 10px; text-transform: uppercase;
          letter-spacing: 0.16em; color: var(--hue); flex: none;
        }
        .summary {
          flex: 1; min-width: 0; display: flex; align-items: center; gap: 2px;
          font-family: var(--font-mono); font-size: 11.5px;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .summary .sum-strong { color: var(--text-dim); }
        .summary .sum-dim { color: var(--text-faint); }
        .badge.loop { background: var(--amber-dim); color: var(--amber); padding: 2px 6px; border-radius: var(--r-sm); font-size: var(--text-xs); flex: none; }
        .chev { color: var(--text-faint); flex: none; transition: transform var(--fast) var(--ease); transform: rotate(-90deg); }
        .chev.up { transform: rotate(0deg); }
        .controls { display: flex; gap: 2px; flex: none; opacity: 0; transition: opacity var(--fast) var(--ease); }
        .row-wrap:hover .controls, .phase.open .controls { opacity: 1; }
        .ctl {
          display: inline-flex; align-items: center; justify-content: center;
          width: 26px; height: 26px; border: none; border-radius: var(--r-sm);
          background: transparent; color: var(--text-faint); font: inherit; font-size: 11px;
          cursor: default; transition: color var(--fast) var(--ease), background var(--fast) var(--ease);
        }
        .ctl:hover:not(:disabled) { color: var(--text); background: var(--bg-hover); }
        .ctl:disabled { opacity: 0.3; }
        .ctl.danger:hover { color: var(--red); }
        .phase .body { padding: var(--s4) var(--s6) var(--s5) calc(var(--s6) + 22px + var(--s3)); border-top: 1px solid var(--line); animation: fade-in var(--fast) var(--ease); }
        .two { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s4); }
        .field { display: flex; flex-direction: column; gap: var(--s1); margin-bottom: var(--s3); }
        .field label { font-size: var(--text-sm); font-weight: 500; }
        .hint { font-size: var(--text-xs); color: var(--text-faint); }
        .chips { display: flex; flex-wrap: wrap; gap: var(--s2); }
        .chip { padding: var(--s1) var(--s3); border: 1px solid var(--line); border-radius: var(--r-full); background: transparent; color: var(--text-faint); font: inherit; font-size: var(--text-xs); cursor: default; }
        .chip.on { border-color: var(--cyan); background: var(--cyan-dim); color: var(--cyan); }
        .gates { display: flex; flex-direction: column; gap: var(--s2); }
        .gate { display: flex; gap: var(--s2); font-size: var(--text-sm); }
        .gate em { display: block; font-style: normal; font-size: var(--text-xs); margin-top: 1px; }
        .gate code { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--purple); }
        .modes { display: flex; gap: var(--s1); padding: 3px; border-radius: var(--r-sm); background: var(--bg-input); border: 1px solid var(--line); width: fit-content; margin-bottom: var(--s2); }
        .mode { padding: var(--s1) var(--s3); border: none; border-radius: 5px; background: transparent; color: var(--text-faint); font: inherit; font-size: var(--text-xs); cursor: default; }
        .mode.on { background: var(--bg-active); color: var(--text); }
        .empty-cmds { margin: var(--s2) 0; padding: var(--s2) var(--s3); border: 1px dashed var(--line); border-radius: var(--r-sm); }
        .opt-line { display: flex; gap: var(--s2); font-size: var(--text-sm); margin-top: var(--s3); }
        .opt-line em { display: block; font-style: normal; font-size: var(--text-xs); margin-top: 1px; }
      `}</style>
    </>
  );
}
