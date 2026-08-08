import { useEffect, useRef } from 'react';
import type { DetectionState, DetectionProposal } from '@shared/ipc-contract.js';
import { duration } from '../format.js';
import { Button } from './ui/Button.js';
import { CodeBlock } from './ui/CodeBlock.js';
import styles from './DetectionPanel.module.css';

const TOOL_ICON: Record<string, string> = {
  command: '⚙',
  read: '◇',
  edit: '✎',
  search: '⌕',
  other: '·',
};

const STATUS_LABEL: Record<DetectionState['status'], string> = {
  running: 'Reading the repo',
  verifying: 'Running what it found',
  done: 'Finished',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

function VerifyMark({ proposal }: { proposal: DetectionProposal }): React.JSX.Element {
  if (proposal.verify === 'pending')
    return <span className={`${styles.mark} ${styles.wait}`}>·</span>;
  if (proposal.verify === 'running')
    return <span className={`${styles.mark} ${styles.wait}`}>◌</span>;
  if (proposal.verify === 'pass') return <span className={`${styles.mark} ${styles.ok}`}>✓</span>;
  return <span className={`${styles.mark} ${styles.bad}`}>✕</span>;
}

/**
 * The live view of an agent finding commands: what it is reading, what it
 * proposed, and what happened when each proposal was actually run.
 *
 * Every proposal is shown even when it fails to verify, because a command that
 * is right but unrunnable (a missing binary) and a command that is simply wrong
 * are different problems, and only one of them is the agent's fault.
 */
export default function DetectionPanel({
  state,
  onCancel,
  onAccept,
  onAcceptAll,
  showRaw,
  onToggleRaw,
}: {
  state: DetectionState;
  onCancel: () => void;
  onAccept: (proposal: DetectionProposal) => void;
  onAcceptAll: () => void;
  showRaw: boolean;
  onToggleRaw: () => void;
}): React.JSX.Element {
  const live = state.status === 'running' || state.status === 'verifying';
  const tailRef = useRef<HTMLDivElement | null>(null);

  // Follow the tail while the agent is working, but stop once it is done so a
  // reader who scrolled up to inspect a tool call is not yanked back down.
  useEffect(() => {
    if (!live) return;
    tailRef.current?.scrollTo({ top: tailRef.current.scrollHeight });
  }, [state.entries, live]);

  const usable = state.proposals.filter((p) => p.verify !== 'running');

  return (
    <div className={`field ${styles.detection}`}>
      <label>
        {STATUS_LABEL[state.status]}
        <span className={`faint ${styles.cli}`}>
          {' '}
          · {state.cli}
          {state.model === 'inherit' ? '' : ` · ${state.model}`}
        </span>
      </label>
      <span className="hint">{state.detail}</span>

      <div className={`${styles.transcript} scroll`} ref={tailRef}>
        {state.entries.map((entry) => (
          <div key={entry.id} className={`${styles.line} ${styles[entry.kind] ?? ''}`}>
            {entry.kind === 'tool' && (
              <span
                className={`${styles.ticon} ${entry.done ? (entry.failed ? styles.bad : styles.ok) : styles.wait}`}
              >
                {TOOL_ICON[entry.toolKind ?? 'other'] ?? '·'}
              </span>
            )}
            <span className={styles.ltext}>{entry.text}</span>
          </div>
        ))}
        {live && <div className={`${styles.line} ${styles.note} ${styles.pulse}`}>…</div>}
        {!state.entries.length && !live && (
          <div className={`${styles.line} ${styles.note}`}>Nothing was reported.</div>
        )}
      </div>

      {live && (
        <div className={`row ${styles.actions}`}>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      )}

      {state.proposals.length > 0 && (
        <div className={`commands ${styles.proposals}`}>
          {state.proposals.map((p) => (
            <div key={p.name} className={`row ${styles.found}`}>
              <VerifyMark proposal={p} />
              <span className={styles.name}>{p.name}</span>
              <code className={`mono ${styles.argv}`}>{p.argv.join(' ')}</code>
              <span className={`faint ${styles.why}`}>
                {p.source}
                {p.verify === 'pass' && `, exit 0 in ${duration(p.durationMs)}`}
                {p.verify === 'fail' &&
                  (p.notFound
                    ? ', could not run: binary not found on PATH'
                    : `, exit ${p.exitCode ?? '—'} in ${duration(p.durationMs)}`)}
                {p.verify === 'running' && ', running…'}
              </span>
              <Button size="sm" disabled={p.verify === 'running'} onClick={() => onAccept(p)}>
                Use
              </Button>
            </div>
          ))}
          {usable.length > 1 && (
            <div className="row">
              <Button size="sm" onClick={onAcceptAll}>
                Use all {usable.length}
              </Button>
            </div>
          )}
        </div>
      )}

      {state.rejected.length > 0 && (
        <div className={styles.rejected}>
          {state.rejected.map((r, i) => (
            <div key={i} className={`${styles.line} ${styles.note}`}>
              Ignored: {r.reason}
            </div>
          ))}
        </div>
      )}

      {state.rawReply && (
        <>
          <button className={`linkish ${styles.rawToggle}`} onClick={onToggleRaw}>
            {showRaw ? 'Hide raw reply' : 'Show raw reply'}
          </button>
          {showRaw && (
            <CodeBlock maxHeight={220} className={styles.output}>
              {state.rawReply}
            </CodeBlock>
          )}
        </>
      )}
    </div>
  );
}
