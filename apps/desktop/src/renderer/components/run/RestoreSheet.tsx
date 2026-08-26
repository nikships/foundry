import { useEffect, useState } from 'react';
import type {
  RestorableCheckpoint,
  RestorableCheckpointList,
  RestoreResult,
} from '@shared/types.js';
import { api } from '../../api.js';
import { confirmManager } from '../../hooks/useConfirmAction.js';
import { clockTime } from '../../utils/format.js';
import {
  restoreConfirmation,
  restoreOptions,
  restoreOutcome,
  restoreRequest,
  type RestoreOptionView,
} from '../../view-models/restore-view.js';
import { Button } from '../ui/Button.js';
import { SideSheet } from '../ui/SideSheet.js';
import styles from './RestoreSheet.module.css';

function CheckpointRow({
  option,
  selected,
  disabled,
  onSelect,
}: {
  option: RestoreOptionView;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <label
      className={styles.option}
      data-selected={selected || undefined}
      data-exact={option.exact ? 'true' : 'false'}
      data-blocked={option.selectable ? undefined : 'true'}
    >
      <input
        type="radio"
        name="restore-checkpoint"
        checked={selected}
        disabled={disabled || !option.selectable}
        onChange={onSelect}
        data-testid={`restore-option-${option.checkpointId}`}
      />
      <span className={styles.optionHead}>
        <strong>{option.label}</strong>
        <span className={styles.exactness} data-exact={option.exact ? 'true' : 'false'}>
          {option.exactnessLabel}
        </span>
      </span>
      <span className={`${styles.meta} mono faint`}>
        {clockTime(option.createdAt)} · {option.sha} · {option.scope}
        {option.attribution ? ` · ${option.attribution}` : ''}
      </span>
      <span className={styles.detail}>{option.exactnessDetail}</span>
      {option.commitNote && <span className={styles.commitNote}>{option.commitNote}</span>}
      {option.blockedReason && (
        <span className={styles.blocked}>Cannot be restored: {option.blockedReason}</span>
      )}
    </label>
  );
}

/**
 * The picker and its confirmation.
 *
 * Nothing here decides anything: `restore-view.ts` says how a checkpoint
 * reads, what the operator is warned about, and whether the call may carry
 * `acceptPartial`. This component shows that and calls the IPC seam.
 */
export default function RestoreSheet({
  open,
  projectId,
  list,
  onClose,
  onRestored,
}: {
  open: boolean;
  projectId: string;
  list: RestorableCheckpointList | null;
  onClose: () => void;
  /** A completed restore changed the worktree, so the caller re-reads it. */
  onRestored: () => void;
}): React.JSX.Element {
  const options = restoreOptions(list);
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RestoreResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelectedId('');
    setBusy(false);
    setResult(null);
  }, [open, list?.runId]);

  const selected: RestorableCheckpoint | null =
    list?.checkpoints.find((checkpoint) => checkpoint.checkpointId === selectedId) ?? null;
  const outcome = restoreOutcome(result);

  const restore = async (checkpoint: RestorableCheckpoint): Promise<void> => {
    const confirmation = restoreConfirmation(checkpoint);
    const accepted = await confirmManager.ask(confirmation.message, {
      title: confirmation.title,
      confirmLabel: confirmation.confirmLabel,
      variant: 'danger',
    });
    // Only an accepted confirmation produces a request, and only a request
    // whose confirmation named the unrecoverable paths carries acceptPartial.
    const input = restoreRequest(checkpoint, accepted);
    if (!input) return;
    setBusy(true);
    setResult(null);
    try {
      setResult(await api.runs.restoreCheckpoint(projectId, input));
    } catch (error) {
      setResult({ ok: false, detail: (error as Error).message });
    } finally {
      setBusy(false);
      onRestored();
    }
  };

  return (
    <SideSheet
      open={open}
      onClose={onClose}
      label="Restore a phase checkpoint"
      eyebrow="Run recovery"
      title="Restore to a phase checkpoint"
      footer={
        <>
          <span className={styles.count}>
            {options.length === 1 ? '1 checkpoint' : `${options.length} checkpoints`}
          </span>
          <div className={styles.footerActions}>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={busy || !selected}
              onClick={() => selected && void restore(selected)}
              data-testid="restore-confirm"
            >
              {busy ? 'Restoring…' : 'Restore…'}
            </Button>
          </div>
        </>
      }
    >
      <p className={styles.intro}>
        Each phase recorded where it began. Restoring puts this run’s worktree back to one of them
        and stops there — the run is not resumed, and Continue run stays your call.
      </p>
      {outcome && (
        <div className={styles.outcome} data-tone={outcome.tone} role="status">
          <p className={styles.outcomeDetail}>{outcome.detail}</p>
          {outcome.standing && <p>{outcome.standing}</p>}
          {outcome.nextStep && <p>{outcome.nextStep}</p>}
        </div>
      )}
      {options.length === 0 ? (
        <p className={styles.empty}>{list?.detail || 'This run recorded no phase checkpoints.'}</p>
      ) : (
        <div className={styles.optionList}>
          {options.map((option) => (
            <CheckpointRow
              key={option.checkpointId}
              option={option}
              selected={option.checkpointId === selectedId}
              disabled={busy}
              onSelect={() => setSelectedId(option.checkpointId)}
            />
          ))}
        </div>
      )}
    </SideSheet>
  );
}
