import { useState } from 'react';
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

  const answer = async (decision: 'approve' | 'reject'): Promise<void> => {
    if (sending) return;
    setSending(true);
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
    } finally {
      setSending(false);
    }
  };

  const isEngineer = interrupt.kind === 'engineer';

  return (
    <>
      <div className="scrim">
        <section className="sheet card">
          <header>
            <span className="badge kind">{isEngineer ? 'checkpoint' : 'permission'}</span>
            <h2>{interrupt.title}</h2>
          </header>
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
              placeholder="Anything you add here is sent to the agent as part of your answer."
            />
          </label>
          {interrupt.command && (
            <label className="remember">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              Always allow this command in this project
            </label>
          )}
          <footer>
            <button className="btn" disabled={sending} onClick={() => void answer('reject')}>
              {isEngineer ? 'Reject' : 'Deny'}
            </button>
            <div className="grow" />
            <button
              className="btn primary"
              disabled={sending}
              onClick={() => void answer('approve')}
            >
              {isEngineer ? 'Approve' : 'Allow'}
            </button>
          </footer>
        </section>
      </div>
      <style>{`
        .scrim { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; background: rgba(4, 6, 12, 0.72); backdrop-filter: blur(8px); animation: fade-in var(--fast) var(--ease); }
        .sheet { width: min(620px, calc(100vw - 96px)); max-height: calc(100vh - 120px); overflow-y: auto; padding: var(--s6); box-shadow: var(--shadow-lg); background: var(--bg-panel); border: 1px solid var(--line); border-radius: var(--r-lg); }
        .sheet header { display: flex; align-items: center; gap: var(--s3); margin-bottom: var(--s3); }
        .kind { background: var(--amber-dim); color: var(--amber); text-transform: uppercase; letter-spacing: 0.06em; padding: 2px 6px; border-radius: var(--r-sm); font-size: var(--text-xs); }
        .sheet h2 { font-size: var(--text-lg); font-weight: 600; }
        .body { font-size: var(--text-sm); color: var(--text-dim); line-height: var(--leading-loose); margin-bottom: var(--s4); white-space: pre-wrap; }
        .command { padding: var(--s3); margin-bottom: var(--s4); border-radius: var(--r-sm); background: var(--bg-void); border: 1px solid var(--amber-dim); color: var(--amber); font-size: var(--text-xs); white-space: pre-wrap; word-break: break-all; }
        .field > span { font-size: var(--text-sm); }
        .field .textarea { width: 100%; margin-top: var(--s1); }
        .remember { display: flex; align-items: center; gap: var(--s2); font-size: var(--text-sm); color: var(--text-dim); margin-bottom: var(--s4); margin-top: var(--s3); }
        .sheet footer { display: flex; align-items: center; gap: var(--s3); }
        .grow { flex: 1; }
      `}</style>
    </>
  );
}
