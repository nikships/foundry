import { useEffect, useRef, useState } from 'react';
import type {
  DetectCommandsResult,
  DetectionProposal,
  DetectionState,
} from '@shared/ipc-contract.js';
import type { ProjectCommand, ProjectDef } from '@shared/types.js';
import { api } from '../../api.js';
import { duration } from '../../utils/format.js';
import DetectionPanel from '../readiness/DetectionPanel.js';
import { CodeBlock } from '../ui/CodeBlock.js';
import { Field, TextInput } from '../ui/Field.js';
import { Button } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import styles from './ProjectCommands.module.css';

interface TryState {
  running: boolean;
  passed?: boolean;
  exitCode?: number | null;
  output?: string;
  durationMs?: number;
}

function upsert(list: ProjectCommand[], entry: ProjectCommand): ProjectCommand[] {
  const existing = list.findIndex((c) => c.name === entry.name);
  return existing < 0 ? [...list, entry] : list.map((c, i) => (i === existing ? entry : c));
}

export default function ProjectCommands({
  project,
  onChange,
}: {
  project: ProjectDef;
  onChange: (commands: ProjectCommand[]) => void;
}): React.JSX.Element {
  const [results, setResults] = useState<Record<string, TryState>>({});
  const [expanded, setExpanded] = useState('');
  const [sniffing, setSniffing] = useState(false);
  const [found, setFound] = useState<DetectCommandsResult | null>(null);
  const [detection, setDetection] = useState<DetectionState | null>(null);
  const [starting, setStarting] = useState(false);
  const [detectError, setDetectError] = useState('');
  const [showRaw, setShowRaw] = useState(false);

  // Which detection this component is showing. A stale session's progress must
  // not paint over a newer one the user just started.
  const detectionIdRef = useRef<string>('');

  useEffect(
    () =>
      api.on('detection-progress', (data) => {
        const state = data as DetectionState | undefined;
        if (state && state.detectionId === detectionIdRef.current) setDetection(state);
      }),
    [],
  );

  // Manifest sniffing: free, no model, no agent. Proposes; never writes.
  const sniff = async (): Promise<void> => {
    setSniffing(true);
    setFound(null);
    try {
      setFound(await api.projects.sniffCommands(project.id));
    } catch (e) {
      setFound({ commands: [], via: 'none', detail: (e as Error).message });
    } finally {
      setSniffing(false);
    }
  };

  /**
   * Always spawns an agent. The panel appears immediately: this awaits the
   * session id, not the turn, so the button can never look like it did nothing.
   */
  const askAgent = async (): Promise<void> => {
    setStarting(true);
    setDetectError('');
    setFound(null);
    setDetection(null);
    setShowRaw(false);
    try {
      const started = await api.projects.askAgentCommands(project.id);
      if ('error' in started) {
        setDetectError(started.error);
        return;
      }
      detectionIdRef.current = started.detectionId;
      // The first progress event may already have fired before this returned.
      const current = await api.projects.detection(started.detectionId);
      if (current && current.detectionId === detectionIdRef.current) setDetection(current);
    } catch (e) {
      setDetectError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const cancelDetection = (): void => {
    if (!detectionIdRef.current) return;
    void api.projects.cancelDetection(detectionIdRef.current);
  };

  const accept = (command: DetectCommandsResult['commands'][number]): void => {
    onChange(upsert(project.commands, { name: command.name, argv: command.argv }));
    setFound((prev) =>
      prev ? { ...prev, commands: prev.commands.filter((c) => c.name !== command.name) } : prev,
    );
  };

  const acceptProposal = (proposal: DetectionProposal): void => {
    onChange(upsert(project.commands, { name: proposal.name, argv: proposal.argv }));
    setDetection((prev) =>
      prev ? { ...prev, proposals: prev.proposals.filter((p) => p.name !== proposal.name) } : prev,
    );
  };

  const detectionLive = detection?.status === 'running' || detection?.status === 'verifying';

  const acceptAllProposals = (): void => {
    if (!detection) return;
    const next = detection.proposals
      .filter((p) => p.verify !== 'running')
      .reduce((list, p) => upsert(list, { name: p.name, argv: p.argv }), project.commands);
    onChange(next);
    setDetection((prev) =>
      prev ? { ...prev, proposals: prev.proposals.filter((p) => p.verify === 'running') } : prev,
    );
  };

  const add = (): void => {
    const hasTest = project.commands.some((c) => c.name === 'test');
    onChange([
      ...project.commands,
      {
        name: hasTest ? `command-${project.commands.length + 1}` : 'test',
        argv: [],
      },
    ]);
  };
  const remove = (index: number): void => {
    onChange(project.commands.filter((_, i) => i !== index));
  };
  const argvText = (index: number): string => project.commands[index]!.argv.join(' ');
  const setName = (index: number, name: string): void => {
    onChange(project.commands.map((c, i) => (i === index ? { ...c, name } : c)));
  };
  const setArgv = (index: number, value: string): void => {
    const argv = value.split(/\s+/).filter(Boolean);
    onChange(project.commands.map((c, i) => (i === index ? { ...c, argv } : c)));
  };
  const tryIt = async (name: string, argv: string[]): Promise<void> => {
    setResults((prev) => ({ ...prev, [name]: { running: true } }));
    setExpanded(name);
    const result = await api.projects.tryCommand(project.id, argv);
    setResults((prev) => ({
      ...prev,
      [name]: {
        running: false,
        passed: result.passed,
        exitCode: result.exitCode,
        output: result.outputTail,
        durationMs: result.durationMs,
      },
    }));
  };

  return (
    <>
      <Field label="Commands">
        <span className="hint">
          Named commands a pipeline can reference, so the same pipeline works in every repo. Run
          each one once here so you know it works before a phase depends on it.
        </span>
        <div className={styles.commands}>
          {project.commands.map((command, i) => {
            const result = results[command.name];
            const isOpen = expanded === command.name;
            return (
              <div key={i} className={styles.command}>
                <div className="row">
                  <TextInput
                    className={styles.name}
                    value={command.name}
                    onChange={(e) => setName(i, e.target.value)}
                    placeholder="test"
                  />
                  <TextInput
                    mono
                    className={styles.args}
                    value={argvText(i)}
                    placeholder="npm test"
                    onChange={(e) => setArgv(i, e.target.value)}
                  />
                  <div className={styles.commandActions}>
                    <Button
                      size="sm"
                      disabled={!command.argv.length || result?.running}
                      title={
                        !command.argv.length
                          ? 'Enter an argv first (e.g. npm test)'
                          : result?.running
                            ? 'Running…'
                            : undefined
                      }
                      onClick={() => void tryIt(command.name, command.argv)}
                    >
                      {result?.running ? 'Running…' : 'Try it'}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => remove(i)}>
                      ✕
                    </Button>
                  </div>
                </div>
                {result && !result.running && (
                  <div className={cx(styles.result, result.passed && styles.ok)}>
                    <button
                      className={styles.resultHead}
                      onClick={() => setExpanded(isOpen ? '' : command.name)}
                    >
                      <span className={styles.mark}>{result.passed ? '✓' : '✕'}</span>
                      exit {result.exitCode ?? '—'} in {duration(result.durationMs)}
                      <span className="faint">{isOpen ? 'hide output' : 'show output'}</span>
                    </button>
                    {isOpen && (
                      <CodeBlock maxHeight={260} className={styles.output}>
                        {result.output}
                      </CodeBlock>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <div className={styles.commandActionsRow}>
            <Button size="sm" onClick={add}>
              Add command
            </Button>
            <Button
              size="sm"
              disabled={sniffing}
              title="Reads the repo's manifests. Free, no model."
              onClick={() => void sniff()}
            >
              {sniffing ? 'Reading manifests…' : 'Detect from manifests'}
            </Button>
            <Button
              size="sm"
              disabled={starting || detectionLive}
              title="Asks an agent to read the repo and propose commands."
              onClick={() => void askAgent()}
            >
              {starting || detectionLive ? 'Asking AI…' : 'Ask AI to find commands'}
            </Button>
          </div>
        </div>
      </Field>

      {detectError && (
        <Field>
          <span className={styles.detectError}>{detectError}</span>
        </Field>
      )}

      {detection && (
        <DetectionPanel
          state={detection}
          onCancel={cancelDetection}
          onAccept={acceptProposal}
          onAcceptAll={acceptAllProposals}
          showRaw={showRaw}
          onToggleRaw={() => setShowRaw((v) => !v)}
        />
      )}
      {found && (
        <Field label="Detected">
          <span className="hint">{found.detail}</span>
          {found.commands.length > 0 ? (
            <div className={styles.commands}>
              {found.commands.map((c) => (
                <div key={c.name} className={`row ${styles.found}`}>
                  <span className={cx(styles.mark, c.verified && styles.ok)}>
                    {c.verified ? '✓' : '✕'}
                  </span>
                  <span className={styles.name}>{c.name}</span>
                  <code className={`mono ${styles.args}`}>{c.argv.join(' ')}</code>
                  <span className="faint">
                    {c.source}, exit {c.exitCode ?? '—'} in {duration(c.durationMs)}
                  </span>
                  <Button size="sm" onClick={() => accept(c)}>
                    Use
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className={`faint ${styles.empty}`}>
              Nothing in the manifests. Ask AI to read the repo, or type the argv by hand.
            </p>
          )}
        </Field>
      )}
    </>
  );
}
