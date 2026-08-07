import { useEffect, useRef, useState } from 'react';
import type { PendingInterrupt } from '@shared/types.js';
import { api } from '../api.js';
import { useApp } from '../stores/app.js';

export default function InterruptSheet({
  interrupt,
}: {
  interrupt: PendingInterrupt;
}): React.JSX.Element {
  const { refreshInterrupts } = useApp();
  const [notes, setNotes] = useState('');
  const [remember, setRemember] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const sheetRef = useRef<HTMLElement>(null);
  const approveRef = useRef<HTMLButtonElement>(null);

  const isEngineer = interrupt.kind === 'engineer';
  const rejectLabel = isEngineer ? 'Reject' : 'Deny';
  const approveLabel = isEngineer ? 'Approve' : 'Allow';

  // A new interrupt must not inherit notes or a stale error from the last one.
  useEffect(() => {
    setNotes('');
    setRemember(false);
    setError('');
    setSending(false);
    approveRef.current?.focus();
  }, [interrupt.interruptId]);

  const answer = async (decision: 'approve' | 'reject'): Promise<void> => {
    if (sending) return;
    setSending(true);
    setError('');
    try {
      await api.interrupts.answer({
        interruptId: interrupt.interruptId,
        decision,
        text: notes.trim() || undefined,
        remember,
      });
      setNotes('');
      setRemember(false);
      await refreshInterrupts();
    } catch (e) {
      setError((e as Error).message || 'Could not send that answer. Try again.');
    } finally {
      setSending(false);
    }
  };

  // Escape denies rather than silently closing: an unanswered interrupt would
  // leave the run parked with no UI if the sheet just vanished.
  const sendingRef = useRef(sending);
  sendingRef.current = sending;
  const answerRef = useRef(answer);
  answerRef.current = answer;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || sendingRef.current) return;
      event.preventDefault();
      void answerRef.current('reject');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const contextBits = [
    interrupt.runId ? `run ${interrupt.runId.slice(0, 8)}` : null,
    interrupt.phaseId ? `phase ${interrupt.phaseId}` : null,
  ].filter(Boolean);

  return (
    <>
      <div
        className="scrim"
        role="presentation"
        onMouseDown={(e) => {
          // Clicks on the dimmed backdrop must not dismiss: the run is waiting.
          if (e.target === e.currentTarget) sheetRef.current?.focus();
        }}
      >
        <section
          ref={sheetRef}
          className="sheet card"
          role="dialog"
          aria-modal="true"
          aria-labelledby="interrupt-title"
          tabIndex={-1}
        >
          <header>
            <span className="badge kind">{isEngineer ? 'checkpoint' : 'permission'}</span>
            <h2 id="interrupt-title">{interrupt.title}</h2>
          </header>
          {contextBits.length > 0 && (
            <p className="context mono faint">{contextBits.join(' · ')}</p>
          )}
          <p className="body selectable">{interrupt.body}</p>
          {interrupt.command && <pre className="command selectable mono">{interrupt.command}</pre>}
          <label className="field">
            <span>
              Notes for the agent <em className="faint">(optional)</em>
            </span>
            <textarea
              className="textarea"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              disabled={sending}
              placeholder="Anything you add here is sent to the agent as part of your answer."
            />
          </label>
          {interrupt.command && (
            <label className="remember">
              <input
                type="checkbox"
                checked={remember}
                disabled={sending}
                onChange={(e) => setRemember(e.target.checked)}
              />
              Always allow this command in this project
            </label>
          )}
          {error && (
            <p className="err" role="alert">
              {error}
            </p>
          )}
          <footer>
            <button
              className="btn"
              disabled={sending}
              onClick={() => void answer('reject')}
              title={`${rejectLabel} (Esc)`}
            >
              {sending ? 'Sending…' : rejectLabel}
            </button>
            <div className="grow" />
            <span className="esc faint">Esc {rejectLabel.toLowerCase()}</span>
            <button
              ref={approveRef}
              className="btn primary"
              disabled={sending}
              onClick={() => void answer('approve')}
            >
              {sending ? 'Sending…' : approveLabel}
            </button>
          </footer>
        </section>
      </div>
      <style>{`
        .scrim { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; background: rgba(4, 6, 12, 0.72); backdrop-filter: blur(8px); animation: fade-in var(--fast) var(--ease); }
        .sheet { width: min(620px, calc(100vw - 96px)); max-height: calc(100vh - 120px); overflow-y: auto; padding: var(--s6); box-shadow: var(--shadow-lg); background: var(--bg-panel); border: 1px solid var(--line); border-radius: var(--r-lg); outline: none; }
        .sheet header { display: flex; align-items: center; gap: var(--s3); margin-bottom: var(--s2); }
        .kind { background: var(--amber-dim); color: var(--amber); text-transform: uppercase; letter-spacing: 0.06em; padding: 2px 6px; border-radius: var(--r-sm); font-size: var(--text-xs); }
        .sheet h2 { font-size: var(--text-lg); font-weight: 600; }
        .context { font-size: var(--text-xs); margin-bottom: var(--s3); }
        .body { font-size: var(--text-sm); color: var(--text-dim); line-height: var(--leading-loose); margin-bottom: var(--s4); white-space: pre-wrap; }
        .command { padding: var(--s3); margin-bottom: var(--s4); border-radius: var(--r-sm); background: var(--bg-void); border: 1px solid var(--amber-dim); color: var(--amber); font-size: var(--text-xs); white-space: pre-wrap; word-break: break-all; }
        .field > span { font-size: var(--text-sm); }
        .field .textarea { width: 100%; margin-top: var(--s1); }
        .remember { display: flex; align-items: center; gap: var(--s2); font-size: var(--text-sm); color: var(--text-dim); margin-bottom: var(--s4); margin-top: var(--s3); }
        .err { margin: 0 0 var(--s3); padding: var(--s3); border-radius: var(--r-sm); background: var(--red-dim); color: var(--red); font-size: var(--text-sm); line-height: var(--leading); }
        .sheet footer { display: flex; align-items: center; gap: var(--s3); }
        .esc { font-size: var(--text-xs); }
        .grow { flex: 1; }
      `}</style>
    </>
  );
}
