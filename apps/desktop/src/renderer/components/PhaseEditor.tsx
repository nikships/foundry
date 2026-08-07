import { useEffect, useMemo, useState } from 'react';
import type { AgentDef, PhaseDef } from '@shared/types.js';
import { api } from '../api.js';
import { useApp } from '../stores/app.js';
import AgentAvatar from './AgentAvatar.js';
import { CliIcon } from './BrandIcon.js';

const KIND_COLOR: Record<string, string> = { code: 'var(--blue)', engineer: 'var(--amber)' };

/** Phase objects are mutated in place; the parent re-renders on its own draft updates. */
function patchPhase(phase: PhaseDef, patch: Record<string, unknown>): void {
  Object.assign(phase, patch);
}

export default function PhaseEditor({
  phase,
  index,
  open,
  phases,
  agents,
  commands,
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
    () => (phase.kind === 'agent' ? agentColor(phase.agent ?? null) : KIND_COLOR[phase.kind]!),
    [phase.kind, phase.agent, agentColor],
  );
  const earlier = useMemo(() => phases.slice(0, index).map((p) => p.name), [phases, index]);
  const usesArgv = phase.kind === 'code' && !!phase.command && 'argv' in phase.command;

  const toggleGate = (id: string): void => {
    const current = phase.gates ?? [];
    patchPhase(phase, {
      gates: current.includes(id) ? current.filter((g) => g !== id) : [...current, id],
    });
  };

  const toggleInput = (name: string): void => {
    const prompt = phase.prompt ?? { template: 'user' as const, inputs: [] as string[] };
    if (!phase.prompt) patchPhase(phase, { prompt });
    const current = prompt.inputs ?? [];
    prompt.inputs = current.includes(name) ? current.filter((i) => i !== name) : [...current, name];
  };

  const setCommandMode = (mode: 'ref' | 'argv'): void => {
    if (phase.kind !== 'code') return;
    patchPhase(phase, {
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
      <div className={`phase card ${open ? 'open' : ''}`}>
        <button className="row head" onClick={onToggle}>
          <span className="dot" style={{ background: color }} />
          {phase.kind === 'agent' && <AgentAvatar name={phase.agent ?? null} size={26} />}
          <span className="pname">{phase.name}</span>
          {owner && <CliIcon vendor={owner.cli ?? 'droid'} size={14} />}
          <span
            className="badge kind"
            style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
          >
            {phase.kind === 'engineer' ? 'checkpoint' : phase.kind}
          </span>
          {phase.feedbackTo && <span className="badge loop">↩ {phase.feedbackTo}</span>}
          {phase.optional && <span className="badge optional">optional</span>}
          <span className="grow" />
          <span className="controls">
            <button
              className="btn sm ghost"
              disabled={index === 0}
              onClick={(e) => {
                e.stopPropagation();
                onMove(-1);
              }}
            >
              ↑
            </button>
            <button
              className="btn sm ghost"
              disabled={index === phases.length - 1}
              onClick={(e) => {
                e.stopPropagation();
                onMove(1);
              }}
            >
              ↓
            </button>
            <button
              className="btn sm ghost danger"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
            >
              ✕
            </button>
          </span>
        </button>
        {open && (
          <div className="body">
            <div className="two">
              <div className="field">
                <label>Name</label>
                <input
                  className="input"
                  value={phase.name}
                  onChange={(e) => {
                    phase.name = e.target.value;
                  }}
                />
                <span className="hint">Other phases refer to this one by name.</span>
              </div>
              {phase.kind === 'agent' && (
                <div className="field">
                  <label>Agent</label>
                  <select
                    className="select"
                    value={phase.agent ?? ''}
                    onChange={(e) => patchPhase(phase, { agent: e.target.value })}
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
            <div className="field">
              <label>Description</label>
              <input
                className="input"
                value={phase.description}
                placeholder="What this phase is for, in one line."
                onChange={(e) => {
                  phase.description = e.target.value;
                }}
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
                    {gates.map((gate) => (
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
                  <select
                    className="select"
                    value={commandRef}
                    onChange={(e) => patchPhase(phase, { command: { ref: e.target.value } })}
                  >
                    {commands.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="input mono"
                    value={argvText}
                    placeholder="npm test"
                    onChange={(e) =>
                      patchPhase(phase, {
                        command: { argv: e.target.value.split(/\s+/).filter(Boolean) },
                      })
                    }
                  />
                )}
                <span className="hint">
                  {!usesArgv
                    ? 'Runs the command configured for the project, so the same pipeline works across repos.'
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
                  onChange={(e) => patchPhase(phase, { question: e.target.value })}
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
                  onChange={(e) => patchPhase(phase, { feedbackTo: e.target.value || undefined })}
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
                    onChange={(e) => patchPhase(phase, { feedbackRetries: Number(e.target.value) })}
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
                onChange={(e) => patchPhase(phase, { optional: e.target.checked })}
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
        .phase { overflow: hidden; border: 1px solid var(--line); border-radius: var(--r); background: var(--bg-panel); }
        .phase.open { border-color: var(--line-strong); }
        .phase .head { width: 100%; padding: var(--s3) var(--s4); border: none; background: transparent; color: inherit; font: inherit; cursor: default; text-align: left; display: flex; align-items: center; gap: var(--s2); }
        .phase .head:hover { background: var(--bg-hover); }
        .dot { width: 8px; height: 8px; border-radius: var(--r-full); flex: none; }
        .pname { font-size: var(--text-sm); font-weight: 500; }
        .grow { flex: 1; }
        .kind { text-transform: lowercase; padding: 2px 6px; border-radius: var(--r-sm); font-size: var(--text-xs); }
        .loop { background: var(--amber-dim); color: var(--amber); padding: 2px 6px; border-radius: var(--r-sm); font-size: var(--text-xs); }
        .optional { background: var(--bg-raised); color: var(--text-faint); padding: 2px 6px; border-radius: var(--r-sm); font-size: var(--text-xs); }
        .controls { display: flex; gap: 2px; }
        .phase .body { padding: var(--s4); border-top: 1px solid var(--line-faint); animation: fade-in var(--fast) var(--ease); }
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
        .opt-line { display: flex; gap: var(--s2); font-size: var(--text-sm); margin-top: var(--s3); }
        .opt-line em { display: block; font-style: normal; font-size: var(--text-xs); margin-top: 1px; }
      `}</style>
    </>
  );
}
