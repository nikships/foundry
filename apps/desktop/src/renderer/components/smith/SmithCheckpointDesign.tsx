/**
 * Engineer-checkpoint design body for Smith's chat.
 *
 * Reuses `InterruptSheet`'s vocabulary — the `checkpoint` badge, the `·`-joined
 * run/phase context, the question body, the editable answer, and Approve /
 * Reject — so the operator recognises the same checkpoint in either surface.
 *
 * It is not a second answer path. Nothing here calls `interrupts.answer`:
 * choosing a decision hands the edited answer to the chat composer, and the
 * write still goes through `smith_interrupts answer` and the queue's approval
 * card, which stays the only element in the conversation waiting on a human.
 */

import { useEffect, useState } from 'react';
import type { CheckpointDef } from '@shared/types.js';
import {
  checkpointActions,
  checkpointAnswerEditable,
  checkpointContext,
  checkpointStatusLabel,
} from '../../view-models/smith-artifact-view.js';
import { cx } from '../ui/cx.js';
import styles from './SmithCheckpointDesign.module.css';

export function CheckpointDesign({
  checkpoint,
  compact,
}: {
  checkpoint: CheckpointDef;
  compact?: boolean;
}): React.JSX.Element {
  const [answer, setAnswer] = useState(checkpoint.draftAnswer ?? '');
  // A restored transcript can hand the same card a new draft; the edit box
  // must follow the artifact rather than keep the first draft it ever saw.
  useEffect(() => {
    setAnswer(checkpoint.draftAnswer ?? '');
  }, [checkpoint.interruptId, checkpoint.draftAnswer]);

  const actions = checkpointActions(checkpoint);
  const editable = checkpointAnswerEditable(checkpoint);
  const context = checkpointContext(checkpoint);
  const statusLabel = checkpointStatusLabel(checkpoint);

  return (
    <div
      className={cx(styles.checkpoint, compact && styles.compact)}
      data-testid="checkpoint-design"
    >
      <div className={styles.headerBar}>
        <span className={styles.kindBadge}>checkpoint</span>
        {context && (
          <span className={cx(styles.context, 'mono')} data-testid="checkpoint-context">
            {context}
          </span>
        )}
        <span
          className={cx(
            styles.statusBadge,
            checkpoint.answered ? styles.statusBadgeSettled : styles.statusBadgePending,
          )}
          aria-label={`Status: ${statusLabel}`}
          data-testid="checkpoint-status"
        >
          {statusLabel}
        </span>
      </div>

      <p className={cx(styles.question, 'selectable')} data-testid="checkpoint-question">
        {checkpoint.question}
      </p>

      {editable ? (
        <label className={styles.answerField}>
          <span className={styles.answerLabel}>Answer for the agent</span>
          <textarea
            className={styles.answerInput}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            rows={compact ? 2 : 3}
            placeholder="Edit the answer, then approve or reject through the approval card."
            data-testid="checkpoint-answer"
          />
        </label>
      ) : (
        answer.trim() && (
          <div className={styles.answerReadOnly} data-testid="checkpoint-answer-readonly">
            <span className={styles.answerLabel}>Answer</span>
            <p className={cx(styles.answerText, 'selectable')}>{answer}</p>
          </div>
        )
      )}

      <div className={styles.actions} role="group" aria-label="Checkpoint decisions">
        {actions
          .filter((action) => action.kind !== 'edit')
          .map((action) => (
            <span
              key={action.id}
              className={cx(
                styles.action,
                action.kind === 'approve' ? styles.actionApprove : styles.actionReject,
                checkpoint.decision === action.kind && styles.actionTaken,
              )}
              data-testid={`checkpoint-action-${action.kind}`}
            >
              {action.label}
            </span>
          ))}
      </div>

      <p className={styles.gateNote} data-testid="checkpoint-gate-note">
        {checkpoint.answered
          ? 'This checkpoint has been answered; the card is a record of it.'
          : 'Approving or rejecting is a write: it goes through the approval card, not this card.'}
      </p>
    </div>
  );
}

export default CheckpointDesign;
