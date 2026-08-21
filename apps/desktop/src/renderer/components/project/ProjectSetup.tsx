import { useEffect, useRef, useState } from 'react';
import type { SetupState } from '@shared/ipc-contract.js';
import type { ProjectDef } from '@shared/types.js';
import { modelLabel } from '@shared/model-label.js';
import { api } from '../../api.js';
import { Button } from '../ui/Button.js';
import { Field, Textarea } from '../ui/Field.js';
import { CodeBlock } from '../ui/CodeBlock.js';
import { duration } from '../../utils/format.js';
import styles from './ProjectCommands.module.css';
import panelStyles from '../readiness/DetectionPanel.module.css';

const TOOL_ICON: Record<string, string> = {
  command: '⚙',
  read: '◇',
  edit: '✎',
  search: '⌕',
  other: '·',
};

function SetupPanel({
  state,
  onCancel,
  onUse,
}: {
  state: SetupState;
  onCancel: () => void;
  onUse: (script: string) => void;
}): React.JSX.Element {
  const tailRef = useRef<HTMLDivElement | null>(null);
  const live = state.status === 'running';
  useEffect(() => {
    if (!live) return;
    tailRef.current?.scrollTo({ top: tailRef.current.scrollHeight });
  }, [state.entries, live]);

  return (
    <div className={`field ${panelStyles.detection}`}>
      <label>
        {state.status === 'running'
          ? 'Reading the repo'
          : state.status === 'done'
            ? 'Finished'
            : state.status}
        <span className={`faint ${panelStyles.model}`}>
          {state.model === 'inherit' ? '' : ` · ${modelLabel(state.model)}`}
        </span>
      </label>
      <span className="hint">{state.detail}</span>
      <div className={`${panelStyles.transcript} scroll`} ref={tailRef}>
        {state.entries.map((e) => (
          <div key={e.id} className={`${panelStyles.line} ${panelStyles[e.kind] ?? ''}`}>
            {e.kind === 'tool' && (
              <span
                className={`${panelStyles.transcriptIcon} ${e.done ? (e.failed ? panelStyles.failed : panelStyles.ok) : panelStyles.wait}`}
              >
                {TOOL_ICON[e.toolKind ?? 'other'] ?? '·'}
              </span>
            )}
            <span className={panelStyles.transcriptText}>{e.text}</span>
          </div>
        ))}
        {live && (
          <div className={`${panelStyles.line} ${panelStyles.note} ${panelStyles.pulse}`}>…</div>
        )}
        {!state.entries.length && !live && (
          <div className={`${panelStyles.line} ${panelStyles.note}`}>Nothing was reported.</div>
        )}
      </div>
      {live && (
        <div className={`row ${panelStyles.actions}`}>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      )}
      {state.status === 'done' && state.script && (
        <div style={{ marginTop: 8 }}>
          <CodeBlock maxHeight={180}>{state.script}</CodeBlock>
          <div className="row" style={{ marginTop: 8 }}>
            <Button size="sm" onClick={() => onUse(state.script)}>
              Use this script
            </Button>
          </div>
        </div>
      )}
      {state.rawReply && state.status !== 'running' && (
        <details style={{ marginTop: 8 }} className="faint">
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
  const [tryState, setTryState] = useState<{
    running: boolean;
    passed?: boolean;
    exitCode?: number | null;
    output?: string;
    durationMs?: number;
  } | null>(null);
  const setupIdRef = useRef('');

  useEffect(() => {
    setDraft(project.setupScript ?? '');
  }, [project.id, project.setupScript]);

  useEffect(() => {
    return api.on('setup-progress', (data) => {
      const s = data as SetupState | undefined;
      if (!s || s.setupId !== setupIdRef.current) return;
      setSettingUp(s);
    });
  }, []);

  const commit = (): void => {
    if (draft !== (project.setupScript ?? '')) onChange(draft);
  };

  const sniff = async (): Promise<void> => {
    setSniffing(true);
    setSniffDetail('');
    try {
      const r = await api.projects.setupScriptSniff(project.id);
      setDraft(r.script);
      setSniffDetail(r.detail);
      // Don't auto-save; user reviews then saves via blur/Use.
    } catch (e) {
      setSniffDetail((e as Error).message);
    } finally {
      setSniffing(false);
    }
  };

  const tryIt = async (): Promise<void> => {
    setTryState({ running: true });
    const r = await api.projects.setupScriptTry(project.id, draft);
    setTryState({
      running: false,
      passed: r.passed,
      exitCode: r.exitCode,
      output: r.outputTail,
      durationMs: r.durationMs,
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
      const cur = await api.projects.setupProgress(started.setupId);
      if (cur && cur.setupId === setupIdRef.current) setSettingUp(cur);
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

      <div className={styles.commandActionsRow} style={{ marginTop: 8 }}>
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

      {sniffDetail && (
        <span className="hint" style={{ marginTop: 6 }}>
          {sniffDetail}
        </span>
      )}
      {setupError && <span className={styles.detectError}>{setupError}</span>}

      {tryState && !tryState.running && (
        <div
          className={`${styles.result} ${tryState.passed ? styles.ok : ''}`}
          style={{ marginTop: 8 }}
        >
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
