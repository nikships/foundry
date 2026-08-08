import { useEffect, useRef } from 'react';
import type { DetectionState, DetectionProposal } from '@shared/ipc-contract.js';
import { duration } from '../format.js';

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
  if (proposal.verify === 'pending') return <span className="mark wait">·</span>;
  if (proposal.verify === 'running') return <span className="mark wait">◌</span>;
  if (proposal.verify === 'pass') return <span className="mark ok">✓</span>;
  return <span className="mark bad">✕</span>;
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
    <div className="field detection">
      <label>
        {STATUS_LABEL[state.status]}
        <span className="faint cli">
          {' '}
          · {state.cli}
          {state.model === 'inherit' ? '' : ` · ${state.model}`}
        </span>
      </label>
      <span className="hint">{state.detail}</span>

      <div className="transcript scroll" ref={tailRef}>
        {state.entries.map((entry) => (
          <div key={entry.id} className={`line ${entry.kind}`}>
            {entry.kind === 'tool' && (
              <span className={`ticon ${entry.done ? (entry.failed ? 'bad' : 'ok') : 'wait'}`}>
                {TOOL_ICON[entry.toolKind ?? 'other'] ?? '·'}
              </span>
            )}
            <span className="ltext">{entry.text}</span>
          </div>
        ))}
        {live && <div className="line note pulse">…</div>}
        {!state.entries.length && !live && <div className="line note">Nothing was reported.</div>}
      </div>

      {live && (
        <div className="row actions">
          <button className="btn sm ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}

      {state.proposals.length > 0 && (
        <div className="commands proposals">
          {state.proposals.map((p) => (
            <div key={p.name} className="row found">
              <VerifyMark proposal={p} />
              <span className="name">{p.name}</span>
              <code className="mono argv">{p.argv.join(' ')}</code>
              <span className="faint why">
                {p.source}
                {p.verify === 'pass' && `, exit 0 in ${duration(p.durationMs)}`}
                {p.verify === 'fail' &&
                  (p.notFound
                    ? ', could not run: binary not found on PATH'
                    : `, exit ${p.exitCode ?? '—'} in ${duration(p.durationMs)}`)}
                {p.verify === 'running' && ', running…'}
              </span>
              <button
                className="btn sm"
                disabled={p.verify === 'running'}
                onClick={() => onAccept(p)}
              >
                Use
              </button>
            </div>
          ))}
          {usable.length > 1 && (
            <div className="row">
              <button className="btn sm" onClick={onAcceptAll}>
                Use all {usable.length}
              </button>
            </div>
          )}
        </div>
      )}

      {state.rejected.length > 0 && (
        <div className="rejected">
          {state.rejected.map((r, i) => (
            <div key={i} className="line note">
              Ignored: {r.reason}
            </div>
          ))}
        </div>
      )}

      {state.rawReply && (
        <>
          <button className="linkish raw-toggle" onClick={onToggleRaw}>
            {showRaw ? 'Hide raw reply' : 'Show raw reply'}
          </button>
          {showRaw && <pre className="output selectable mono">{state.rawReply}</pre>}
        </>
      )}

      <style>{`
        .detection { margin-top: var(--s3); }
        .cli { font-size: var(--text-xs); }
        .transcript { margin-top: var(--s2); padding: var(--s2) var(--s3); background: var(--bg-void); border: 1px solid var(--line); border-radius: var(--r-sm); max-height: 220px; overflow-y: auto; font-size: var(--text-xs); line-height: var(--leading); }
        .line { display: flex; gap: var(--s2); align-items: baseline; padding: 1px 0; color: var(--text-dim); }
        .line.text { color: var(--text); white-space: pre-wrap; word-break: break-word; }
        .line.error { color: var(--red); }
        .line.note { color: var(--text-faint); }
        .ticon { flex: none; width: 1em; color: var(--text-faint); }
        .ticon.ok { color: var(--green); }
        .ticon.bad { color: var(--red); }
        .ticon.wait { color: var(--amber); }
        .ltext { flex: 1; min-width: 0; overflow-wrap: anywhere; }
        .pulse { opacity: 0.6; }
        .actions { margin-top: var(--s2); }
        .proposals { margin-top: var(--s3); }
        .found { font-size: var(--text-xs); color: var(--text-dim); }
        .found .name { width: 80px; flex: none; }
        .found .argv { flex: 1; color: var(--text); }
        .found .why { flex: none; }
        .mark { flex: none; width: 1em; }
        .mark.ok { color: var(--green); }
        .mark.bad { color: var(--red); }
        .mark.wait { color: var(--amber); }
        .rejected { margin-top: var(--s2); font-size: var(--text-xs); }
        .raw-toggle { display: inline-block; margin-top: var(--s2); border: none; background: none; padding: 0; font: inherit; font-size: var(--text-xs); color: var(--cyan); text-decoration: underline; cursor: default; }
        .output { margin-top: var(--s2); padding: var(--s3); background: var(--bg-void); font-size: var(--text-xs); line-height: var(--leading); white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow-y: auto; color: var(--text-dim); }
      `}</style>
    </div>
  );
}
