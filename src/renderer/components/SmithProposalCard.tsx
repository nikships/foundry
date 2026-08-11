/**
 * The Smith proposal preview card. A `foundry-cli create|edit` blocks its droid
 * until a human decides here: the card shows the entity kind, whether approving
 * creates or overwrites, the full definition, any non-blocking validation
 * warnings, and Approve / Reject. A reject simply unblocks the CLI — the user
 * describes the desired change to droid in the terminal itself.
 *
 * Mounted unconditionally at the end of `App.tsx` (like `InterruptSheet`); it
 * renders nothing until a proposal is pending. On approve, main saves the entity
 * through the store layer and the card asks the host to open that entity's
 * editor — roster for agents, pipelines for pipelines, the envelopes settings
 * pane for envelopes.
 *
 * Stacking: an engineer interrupt outranks this card, and this card renders
 * above the Smith terminal modal.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SmithProposal } from '@shared/types.js';
import { api } from '../api.js';
import { Button } from './ui/Button.js';
import { ModalShell } from './ui/ModalShell.js';
import styles from './SmithProposalCard.module.css';

/** Where a saved proposal should take the user. Consumed by App's deep-link nav. */
export interface SmithNavTarget {
  kind: SmithProposal['kind'];
  /** Agent/envelope name or pipeline id — whatever the editor selects by. */
  name: string;
}

const KIND_LABEL: Record<SmithProposal['kind'], string> = {
  agent: 'agent',
  pipeline: 'pipeline',
  envelope: 'envelope',
};

export default function SmithProposalCard({
  onApproved,
}: {
  /** Navigates to the saved entity's editor; called only after a successful save. */
  onApproved: (target: SmithNavTarget) => void;
}): React.JSX.Element | null {
  const [proposal, setProposal] = useState<SmithProposal | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useRef<HTMLElement>(null);
  const approveRef = useRef<HTMLButtonElement>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const list = await api.smith.proposalsList();
    setProposal(list[0] ?? null);
  }, []);

  useEffect(() => {
    void refresh();
    return api.on('smith-proposals-changed', () => void refresh());
  }, [refresh]);

  // A new proposal must not inherit a stale error from the last one.
  const proposalId = proposal?.id ?? '';
  useEffect(() => {
    if (!proposalId) return;
    setError('');
    setSending(false);
    approveRef.current?.focus();
  }, [proposalId]);

  if (!proposal) return null;

  const answer = async (approved: boolean): Promise<void> => {
    if (sending) return;
    setSending(true);
    setError('');
    try {
      const ok = await api.smith.proposalAnswer(proposal.id, { approved });
      if (!ok) {
        // A refused save leaves the proposal pending: surface why, stay open.
        setError(
          approved
            ? 'The store refused this entity. droid can revise and re-propose, or you can reject.'
            : 'Could not send that answer. Try again.',
        );
        setSending(false);
        return;
      }
      if (approved) onApproved({ kind: proposal.kind, name: proposal.name });
      await refresh();
    } catch (e) {
      setError((e as Error).message || 'Could not send that answer. Try again.');
      setSending(false);
    }
  };

  const pretty = JSON.stringify(proposal.spec, null, 2);

  return (
    <ModalShell
      dismissible={false}
      highPriority
      ariaLabelledBy="smith-proposal-title"
      modalRef={dialogRef}
      tabIndex={-1}
      className={styles.dialog}
    >
      <header className={styles.header}>
        <span className={styles.kind}>{KIND_LABEL[proposal.kind]}</span>
        <span className={`${styles.mode} ${proposal.overwrites ? styles.modeOverwrite : ''}`}>
          {proposal.overwrites ? 'overwrite' : 'create'}
        </span>
        <h2 className={styles.title} id="smith-proposal-title">
          Smith wants to {proposal.overwrites ? 'overwrite' : 'create'}{' '}
          <span className={styles.name}>{proposal.name}</span>
        </h2>
      </header>

      {proposal.overwrites && (
        <p className={styles.overwriteNote}>
          A {KIND_LABEL[proposal.kind]} named <strong>{proposal.name}</strong> already exists.
          Approving replaces its current definition.
        </p>
      )}

      <pre className={`${styles.spec} selectable`}>{pretty}</pre>

      {proposal.validation.length > 0 && (
        <div className={styles.warnings}>
          {proposal.validation.map((issue, i) => (
            <span key={`${issue.where}-${i}`} className={styles.warning}>
              <span className={styles.warningWhere}>{issue.where}</span>
              {issue.message}
            </span>
          ))}
        </div>
      )}

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <footer className={styles.footer}>
        <Button disabled={sending} onClick={() => void answer(false)}>
          {sending ? 'Sending…' : 'Reject'}
        </Button>
        <span className={styles.spacer} />
        <Button
          ref={approveRef}
          variant="primary"
          disabled={sending}
          onClick={() => void answer(true)}
        >
          {sending ? 'Saving…' : 'Approve'}
        </Button>
      </footer>
    </ModalShell>
  );
}
