import { useEffect, useState } from 'react';
import { ModalShell } from '../ui/ModalShell.js';
import { Button } from '../ui/Button.js';
import { confirmManager, type ConfirmRequest } from '../../hooks/useConfirmAction.js';
import styles from './ConfirmModal.module.css';

/** One frame past --fast (120ms): how long the exit animation runs before the
 * dialog actually unmounts. Matches SideSheet's leave window. */
const LEAVE_MS = 140;

export default function ConfirmModal(): React.JSX.Element | null {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  /** The request still on display; held through the exit animation after resolution. */
  const [shown, setShown] = useState<ConfirmRequest | null>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    return confirmManager.subscribe(setRequest);
  }, []);

  useEffect(() => {
    if (request) {
      setShown(request);
      setLeaving(false);
      return;
    }
    if (!shown) return;
    setLeaving(true);
    const t = setTimeout(() => {
      setLeaving(false);
      setShown(null);
    }, LEAVE_MS);
    return () => clearTimeout(t);
  }, [request, shown]);

  if (!shown) return null;

  const isDanger =
    shown.opts?.variant === 'danger' ||
    (shown.opts?.variant === undefined && /delete|remove|discard|compact/i.test(shown.message));
  const confirmLabel =
    shown.opts?.confirmLabel ??
    (isDanger ? (/delete/i.test(shown.message) ? 'Delete' : 'Remove') : 'Confirm');
  const cancelLabel = shown.opts?.cancelLabel ?? 'Cancel';
  const title = shown.opts?.title ?? (isDanger ? 'Confirmation Required' : 'Confirmation');
  const resolve = (accepted: boolean) => (): void => confirmManager.resolve(shown.id, accepted);

  return (
    <ModalShell
      highPriority
      leaving={leaving}
      onClose={resolve(false)}
      ariaLabelledBy="confirm-dialog-title"
    >
      <div className={styles.dialog}>
        <div className={styles.body}>
          <h3 id="confirm-dialog-title" className={styles.title}>
            {title}
          </h3>
          <p className={styles.message}>{shown.message}</p>
        </div>
        <div className={styles.actions}>
          <Button
            variant="ghost"
            onClick={resolve(false)}
            data-testid="confirm-cancel"
            {...(isDanger && { autoFocus: true })}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={isDanger ? 'danger' : 'primary'}
            onClick={resolve(true)}
            data-testid="confirm-accept"
            {...(!isDanger && { autoFocus: true })}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}
