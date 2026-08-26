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
  performRestore,
  restoreActionState,
  restoreEmptyCopy,
  restoreOptions,
  restoreOutcome,
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
  runId,
  list,
  refreshing = false,
  onClose,
  onRestored,
}: {
  open: boolean;
  projectId: string;
  /**
   * The run on display, and the reset key below.
   *
   * Deliberately not `list?.runId`: a restore asks for a re-read, and the
   * re-read nulls the list while it is in flight, which would reset the sheet
   * and wipe the report of the restore that asked for it. The run is what
   * "this is a different subject now" actually means.
   */
  runId: string;
  list: RestorableCheckpointList | null;
  /** A checkpoint re-read is in flight, so what is on screen may be stale. */
  refreshing?: boolean;
  onClose: () => void;
  /** A completed restore changed the worktree, so the caller re-reads it. */
  onRestored: () => void;
}): React.JSX.Element {
  const options = restoreOptions(list);
  const [selectedId, setSelectedId] = useState('');
  /** True from the moment Restore is pressed until the call settles. */
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RestoreResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelectedId('');
    setBusy(false);
    setResult(null);
  }, [open, runId]);

  const selected: RestorableCheckpoint | null =
    list?.checkpoints.find((checkpoint) => checkpoint.checkpointId === selectedId) ?? null;
  const outcome = restoreOutcome(result);
  const action = restoreActionState({ busy, refreshing, hasSelection: !!selected });
  // A restore in flight has already moved the branch by the time it returns,
  // and its shas exist nowhere else in the UI. Closing over that would discard
  // the only report of a destructive act, so every dismissal path waits.
  const closeIfIdle = (): void => {
    if (!busy) onClose();
  };

  const restore = async (checkpoint: RestorableCheckpoint): Promise<void> => {
    // Set before the confirmation is raised, not after it resolves: the
    // footer button and every radio stay disabled for the whole window, so
    // the selection cannot move under a pending confirmation and a second
    // press cannot queue a second restore behind the first.
    setBusy(true);
    setResult(null);
    try {
      const outcome = await performRestore(
        {
          confirm: (confirmation) =>
            confirmManager.ask(confirmation.message, {
              title: confirmation.title,
              confirmLabel: confirmation.confirmLabel,
              variant: 'danger',
            }),
          call: (input) => api.runs.restoreCheckpoint(projectId, input),
        },
        checkpoint,
      );
      // Null is a declined confirmation: nothing was called, so there is
      // nothing to report and no re-read to ask for.
      if (!outcome) return;
      setResult(outcome);
      onRestored();
    } catch (error) {
      setResult({ ok: false, detail: (error as Error).message });
      onRestored();
    } finally {
      setBusy(false);
    }
  };

  return (
    <SideSheet
      open={open}
      onClose={closeIfIdle}
      label="Restore a phase checkpoint"
      eyebrow="Run recovery"
      title="Restore to a phase checkpoint"
      footer={
        <>
          <span className={styles.count}>
            {options.length === 1 ? '1 checkpoint' : `${options.length} checkpoints`}
          </span>
          <div className={styles.footerActions}>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              title={busy ? 'A restore is in flight; its report is not on screen yet' : undefined}
              onClick={closeIfIdle}
              data-testid="restore-close"
            >
              Close
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={action.disabled}
              onClick={() => selected && void restore(selected)}
              data-testid="restore-confirm"
            >
              {action.label}
            </Button>
          </div>
        </>
      }
    >
      <p className={styles.intro}>
        Each phase recorded where it began. Restoring puts this run’s worktree back to one of them
        and stops there — nothing is resumed, and Continue run stays a separate act of yours.
      </p>
      {outcome && (
        <div className={styles.outcome} data-tone={outcome.tone} role="status">
          <p className={styles.outcomeDetail}>{outcome.detail}</p>
          {outcome.standing && <p>{outcome.standing}</p>}
          {outcome.nextStep && <p>{outcome.nextStep}</p>}
        </div>
      )}
      {options.length === 0 ? (
        <p className={styles.empty}>{restoreEmptyCopy(list)}</p>
      ) : (
        <div className={styles.optionList}>
          {options.map((option) => (
            <CheckpointRow
              key={option.checkpointId}
              option={option}
              selected={option.checkpointId === selectedId}
              disabled={busy || refreshing}
              onSelect={() => setSelectedId(option.checkpointId)}
            />
          ))}
        </div>
      )}
    </SideSheet>
  );
}
