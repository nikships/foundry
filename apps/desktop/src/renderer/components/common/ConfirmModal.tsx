import { useEffect, useState } from 'react';
import { ModalShell } from '../ui/ModalShell.js';
import { Button } from '../ui/Button.js';
import { confirmManager, type ConfirmRequest } from '../../hooks/useConfirmAction.js';
import styles from './ConfirmModal.module.css';

export default function ConfirmModal(): React.JSX.Element | null {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);

  useEffect(() => {
    return confirmManager.subscribe(setRequest);
  }, []);

  if (!request) return null;

  const isDanger =
    request.opts?.variant === 'danger' ||
    (request.opts?.variant === undefined && /delete|remove|discard|compact/i.test(request.message));
  const confirmLabel =
    request.opts?.confirmLabel ??
    (isDanger ? (/delete/i.test(request.message) ? 'Delete' : 'Remove') : 'Confirm');
  const cancelLabel = request.opts?.cancelLabel ?? 'Cancel';
  const title = request.opts?.title ?? (isDanger ? 'Confirmation Required' : 'Confirmation');
  const resolve = (accepted: boolean) => (): void => confirmManager.resolve(request.id, accepted);

  return (
    <ModalShell highPriority onClose={resolve(false)} ariaLabelledBy="confirm-dialog-title">
      <div className={styles.dialog}>
        <div className={styles.body}>
          <h3 id="confirm-dialog-title" className={styles.title}>
            {title}
          </h3>
          <p className={styles.message}>{request.message}</p>
        </div>
        <div className={styles.actions}>
          <Button variant="ghost" onClick={resolve(false)} data-testid="confirm-cancel">
            {cancelLabel}
          </Button>
          <Button
            variant={isDanger ? 'danger' : 'primary'}
            onClick={resolve(true)}
            data-testid="confirm-accept"
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}
