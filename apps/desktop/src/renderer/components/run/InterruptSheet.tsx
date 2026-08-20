import { useEffect, useRef, useState } from 'react';
import type { PendingInterrupt } from '@shared/types.js';
import { api } from '../../api.js';
import { useApp } from '../../stores/app.js';
import { Button } from '../ui/Button.js';
import { ModalShell } from '../ui/ModalShell.js';
import styles from './InterruptSheet.module.css';

/**
 * The engineer checkpoint. Only a pipeline that declares an engineer phase
 * raises this — a run never stops here to ask permission.
 */
export default function InterruptSheet({
  interrupt,
}: {
  interrupt: PendingInterrupt;
}): React.JSX.Element {
  const { refreshInterrupts } = useApp();
  const [notes, setNotes] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useRef<HTMLElement>(null);
  const approveRef = useRef<HTMLButtonElement>(null);

  // A new interrupt must not inherit notes or a stale error from the last one.
  useEffect(() => {
    setNotes('');
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
      });
      setNotes('');
      await refreshInterrupts();
    } catch (e) {
      setError((e as Error).message || 'Could not send that answer. Try again.');
    } finally {
      setSending(false);
    }
  };

  // Escape denies rather than silently closing: an unanswered interrupt would
  // leave the run parked with no UI if the dialog just vanished.
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
    <ModalShell
      dismissible={false}
      highPriority
      ariaLabelledBy="interrupt-title"
      modalRef={dialogRef}
      tabIndex={-1}
      className={styles.dialog}
    >
      <header>
        <span className={`badge ${styles.kind}`}>checkpoint</span>
        <h2 id="interrupt-title">{interrupt.title}</h2>
      </header>
      {contextBits.length > 0 && (
        <p className={`${styles.context} mono faint`}>{contextBits.join(' · ')}</p>
      )}
      <p className={`${styles.body} selectable`}>{interrupt.body}</p>
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
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <footer>
        <Button disabled={sending} onClick={() => void answer('reject')} title="Reject (Esc)">
          {sending ? 'Sending…' : 'Reject'}
        </Button>
        <div className={styles.spacer} />
        <span className={`${styles.escHint} faint`}>Esc rejects</span>
        <Button
          ref={approveRef}
          variant="primary"
          disabled={sending}
          onClick={() => void answer('approve')}
        >
          {sending ? 'Sending…' : 'Approve'}
        </Button>
      </footer>
    </ModalShell>
  );
}
