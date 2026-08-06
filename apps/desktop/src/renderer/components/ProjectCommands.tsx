import { useState } from 'react';
import type { DetectCommandsResult } from '@shared/ipc-contract.js';
import type { ProjectDef } from '@shared/types.js';
import { api } from '../api.js';
import { duration } from '../format.js';

interface TryState { running: boolean; passed?: boolean; exitCode?: number | null; output?: string; durationMs?: number; }

export default function ProjectCommands({ project }: { project: ProjectDef }): React.JSX.Element {
  const [results, setResults] = useState<Record<string, TryState>>({});
  const [expanded, setExpanded] = useState('');
  const [detecting, setDetecting] = useState(false);
  const [found, setFound] = useState<DetectCommandsResult | null>(null);
  const [, force] = useState(0);

  // Detection proposes; nothing is written until the human accepts, so a wrong
  // guess costs a glance rather than a silently broken test phase.
  const detect = async (useAgent: boolean): Promise<void> => {
    setDetecting(true);
    setFound(null);
    try {
      setFound(await api.projects.detectCommands(project.id, useAgent));
    } catch (e) {
      setFound({ commands: [], via: 'none', detail: (e as Error).message });
    } finally {
      setDetecting(false);
    }
  };

  const accept = (command: DetectCommandsResult['commands'][number]): void => {
    const existing = project.commands.findIndex((c) => c.name === command.name);
    const entry = { name: command.name, argv: command.argv };
    if (existing < 0) project.commands.push(entry);
    else project.commands[existing] = entry;
    setFound((prev) =>
      prev ? { ...prev, commands: prev.commands.filter((c) => c.name !== command.name) } : prev,
    );
    force((n) => n + 1);
  };

  const add = (): void => { project.commands.push({ name: `command-${project.commands.length + 1}`, argv: [] }); };
  const remove = (index: number): void => { project.commands.splice(index, 1); };
  const argvText = (index: number): string => project.commands[index]!.argv.join(' ');
  const setArgv = (index: number, value: string): void => { project.commands[index]!.argv = value.split(/\s+/).filter(Boolean); };
  const tryIt = async (name: string, argv: string[]): Promise<void> => {
    setResults((prev) => ({ ...prev, [name]: { running: true } }));
    setExpanded(name);
    const result = await api.projects.tryCommand(project.id, argv);
    setResults((prev) => ({ ...prev, [name]: { running: false, passed: result.passed, exitCode: result.exitCode, output: result.outputTail, durationMs: result.durationMs } }));
  };

  return (
    <>
      <div className="field">
        <label>Commands</label>
        <span className="hint">Named commands a pipeline can reference, so the same pipeline works in every repo. Run each one once here so you know it works before a phase depends on it.</span>
        <div className="commands">
          {project.commands.map((command, i) => {
            const result = results[command.name];
            const isOpen = expanded === command.name;
            return (
              <div key={i} className="command">
                <div className="row">
                  <input className="input name" value={command.name} onChange={(e) => { command.name = e.target.value; }} placeholder="test" />
                  <input className="input mono argv" value={argvText(i)} placeholder="npm test" onChange={(e) => setArgv(i, e.target.value)} />
                  <button className="btn sm" disabled={!command.argv.length || result?.running} onClick={() => void tryIt(command.name, command.argv)}>
                    {result?.running ? 'Running…' : 'Try it'}
                  </button>
                  <button className="btn sm ghost" onClick={() => remove(i)}>✕</button>
                </div>
                {result && !result.running && (
                  <div className={`result ${result.passed ? 'ok' : ''}`}>
                    <button className="result-head" onClick={() => setExpanded(isOpen ? '' : command.name)}>
                      <span className="mark">{result.passed ? '✓' : '✕'}</span>
                      exit {result.exitCode ?? '—'} in {duration(result.durationMs)}
                      <span className="faint">{isOpen ? 'hide output' : 'show output'}</span>
                    </button>
                    {isOpen && <pre className="output selectable mono">{result.output}</pre>}
                  </div>
                )}
              </div>
            );
          })}
          <div className="row">
            <button className="btn sm" onClick={add}>Add command</button>
            <button className="btn sm" disabled={detecting} onClick={() => void detect(false)}>
              {detecting ? 'Detecting…' : 'Detect from repo'}
            </button>
          </div>
        </div>
      </div>
      {found && (
        <div className="field">
          <label>Detected</label>
          <span className="hint">{found.detail}</span>
          {found.commands.length > 0 ? (
            <div className="commands">
              {found.commands.map((c) => (
                <div key={c.name} className="row found">
                  <span className={`mark ${c.verified ? 'ok' : ''}`}>{c.verified ? '✓' : '✕'}</span>
                  <span className="name">{c.name}</span>
                  <code className="mono argv">{c.argv.join(' ')}</code>
                  <span className="faint">
                    {c.source}, exit {c.exitCode ?? '—'} in {duration(c.durationMs)}
                  </span>
                  <button className="btn sm" onClick={() => accept(c)}>Use</button>
                </div>
              ))}
            </div>
          ) : (
            <button className="btn sm" disabled={detecting} onClick={() => void detect(true)}>
              {detecting ? 'Reading the repo…' : 'Ask an agent to read the repo'}
            </button>
          )}
        </div>
      )}
      <style>{`
        .commands { display: flex; flex-direction: column; gap: var(--s3); margin-top: var(--s2); }
        .command { display: flex; flex-direction: column; gap: var(--s2); }
        .row { display: flex; gap: var(--s2); align-items: center; }
        .name { width: 140px; flex: none; }
        .argv { flex: 1; }
        .result { border: 1px solid var(--red-dim); border-radius: var(--r-sm); overflow: hidden; }
        .result.ok { border-color: var(--green-dim); }
        .result-head { display: flex; align-items: center; gap: var(--s2); width: 100%; padding: var(--s2) var(--s3); border: none; background: var(--bg-raised); color: var(--text-dim); font: inherit; font-size: var(--text-xs); text-align: left; cursor: default; }
        .mark { color: var(--red); }
        .mark.ok, .result.ok .mark { color: var(--green); }
        .found { font-size: var(--text-xs); color: var(--text-dim); }
        .found .name { width: 80px; flex: none; }
        .found .argv { flex: 1; color: var(--text); }
        .output { padding: var(--s3); background: var(--bg-void); font-size: var(--text-xs); line-height: var(--leading); white-space: pre-wrap; word-break: break-word; max-height: 260px; overflow-y: auto; color: var(--text-dim); }
      `}</style>
    </>
  );
}
