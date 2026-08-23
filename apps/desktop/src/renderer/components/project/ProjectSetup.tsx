import { useEffect, useRef, useState } from 'react';
import type { SetupState } from '@shared/ipc-contract.js';
import type { ProjectDef } from '@shared/types.js';
import { modelLabel } from '@shared/model-label.js';
import { api } from '../../api.js';
import { Button } from '../ui/Button.js';
import { Field, Textarea } from '../ui/Field.js';
import { CodeBlock } from '../ui/CodeBlock.js';
import { cx } from '../ui/cx.js';
import { duration } from '../../utils/format.js';
import PanelTranscript from '../readiness/PanelTranscript.js';
import styles from './ProjectCommands.module.css';
import panelStyles from '../readiness/DetectionPanel.module.css';

const STATUS_LABEL: Partial<Record<SetupState['status'], string>> = {
  running: 'Reading the repo',
  done: 'Finished',
};

interface TryState {
  running: boolean;
  passed?: boolean;
  exitCode?: number | null;
  output?: string;
  durationMs?: number;
}

function SetupPanel({
  state,
  onCancel,
  onUse,
}: {
  state: SetupState;
  onCancel: () => void;
  onUse: (script: string) => void;
}): React.JSX.Element {
  const live = state.status === 'running';

  return (
    <div className={`field ${panelStyles.detection}`}>
      <label>
        {STATUS_LABEL[state.status] ?? state.status}
        <span className={`faint ${panelStyles.model}`}>
          {state.model === 'inherit' ? '' : ` · ${modelLabel(state.model)}`}
        </span>
      </label>
      <span className="hint">{state.detail}</span>
      <PanelTranscript entries={state.entries} live={live} />
      {live && (
        <div className={`row ${panelStyles.actions}`}>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      )}
      {state.status === 'done' && state.script && (
        <div className={styles.setupResult}>
          <CodeBlock maxHeight={180}>{state.script}</CodeBlock>
          <div className={`row ${styles.setupResultActions}`}>
            <Button size="sm" onClick={() => onUse(state.script)}>
              Use this script
            </Button>
          </div>
        </div>
      )}
      {state.rawReply && !live && (
        <details className={`faint ${styles.setupResult}`}>
          <summary className="linkish">Raw reply</summary>
          <CodeBlock maxHeight={160}>{state.rawReply}</CodeBlock>
        </details>
      )}
    </div>
  );
}

export default function ProjectSetup({
  project,
  onChange,
}: {
  project: ProjectDef;
  onChange: (script: string) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(project.setupScript ?? '');
  const [sniffing, setSniffing] = useState(false);
  const [sniffDetail, setSniffDetail] = useState('');
  const [settingUp, setSettingUp] = useState<SetupState | null>(null);
  const [starting, setStarting] = useState(false);
  const [setupError, setSetupError] = useState('');
  const [tryState, setTryState] = useState<TryState | null>(null);
  const setupIdRef = useRef('');

  useEffect(() => {
    setDraft(project.setupScript ?? '');
  }, [project.id, project.setupScript]);

  useEffect(
    () =>
      api.on('setup-progress', (data) => {
        const state = data as SetupState | undefined;
        if (state && state.setupId === setupIdRef.current) setSettingUp(state);
      }),
    [],
  );

  const commit = (): void => {
    if (draft !== (project.setupScript ?? '')) onChange(draft);
  };

  const sniff = async (): Promise<void> => {
    setSniffing(true);
    setSniffDetail('');
    try {
      // Fills the draft only; the operator reviews, then blur or Use saves it.
      const result = await api.projects.setupScriptSniff(project.id);
      setDraft(result.script);
      setSniffDetail(result.detail);
    } catch (e) {
      setSniffDetail((e as Error).message);
    } finally {
      setSniffing(false);
    }
  };

  const tryIt = async (): Promise<void> => {
    setTryState({ running: true });
    const result = await api.projects.setupScriptTry(project.id, draft);
    setTryState({
      running: false,
      passed: result.passed,
      exitCode: result.exitCode,
      output: result.outputTail,
      durationMs: result.durationMs,
    });
  };

  const askAgent = async (): Promise<void> => {
    setStarting(true);
    setSetupError('');
    setSettingUp(null);
    try {
      const started = await api.projects.setupScriptAskAgent(project.id);
      if ('error' in started) {
        setSetupError(started.error);
        return;
      }
      setupIdRef.current = started.setupId;
      // The first progress event may already have fired before this returned.
      const current = await api.projects.setupProgress(started.setupId);
      if (current && current.setupId === setupIdRef.current) setSettingUp(current);
    } catch (e) {
      setSetupError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const cancelSetup = (): void => {
    if (!setupIdRef.current) return;
    void api.projects.setupCancel(setupIdRef.current);
  };

  const useScript = (script: string): void => {
    setDraft(script);
    onChange(script);
  };

  const live = settingUp?.status === 'running';

  return (
    <>
      <Field
        label="Setup script"
        htmlFor="setup-script"
        hint="Shell script run at the worktree root after git worktree add, before any phase. One command per line. Keep it to idempotent installs (npm ci, pnpm install --frozen-lockfile, uv sync, cargo fetch). Empty means nothing to run."
      >
        <Textarea
          id="setup-script"
          className="mono"
          rows={5}
          placeholder={'npm ci\n# or: pnpm install --frozen-lockfile\n# or: uv sync'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
        />
        <span className="hint">
          Saved when you leave the field. Runs via <code>sh -c</code> in the fresh worktree; PATH
          comes from your login shell as usual. During a run it has no deadline; failures are
          captured in setup.log, and the run&apos;s Kill action still stops it.
        </span>
      </Field>

      <div className={cx(styles.commandActionsRow, styles.actionsRowSpaced)}>
        <Button size="sm" disabled={sniffing} onClick={() => void sniff()}>
          {sniffing ? 'Reading…' : 'Detect from manifests'}
        </Button>
        <Button size="sm" disabled={starting || !!live} onClick={() => void askAgent()}>
          {starting || live ? 'Asking AI…' : 'Generate with AI'}
        </Button>
        <Button
          size="sm"
          disabled={!draft.trim() || !!tryState?.running}
          onClick={() => void tryIt()}
        >
          {tryState?.running ? 'Running…' : 'Try it'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setDraft('');
            onChange('');
          }}
        >
          Clear
        </Button>
      </div>

      {sniffDetail && <span className={`hint ${styles.sniffDetail}`}>{sniffDetail}</span>}
      {setupError && <span className={styles.detectError}>{setupError}</span>}

      {tryState && !tryState.running && (
        <div className={cx(styles.result, tryState.passed && styles.ok, styles.tryResult)}>
          <span className={styles.mark}>{tryState.passed ? '✓' : '✕'}</span> exit{' '}
          {tryState.exitCode ?? '—'} in {duration(tryState.durationMs)}
          {tryState.output && (
            <CodeBlock maxHeight={260} className={styles.output}>
              {tryState.output}
            </CodeBlock>
          )}
        </div>
      )}

      {settingUp && <SetupPanel state={settingUp} onCancel={cancelSetup} onUse={useScript} />}
    </>
  );
}
