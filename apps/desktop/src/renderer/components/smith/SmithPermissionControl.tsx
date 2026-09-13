import { useEffect, useRef, useState } from 'react';
import type { SmithPermissionMode } from '@shared/ipc-contract.js';
import { confirmManager } from '../../hooks/useConfirmAction.js';
import {
  SMITH_YOLO_ACTIVE_COPY,
  SMITH_YOLO_OFF_COPY,
  SMITH_YOLO_WARNING,
} from '../../view-models/smith-copy.js';
import { Button } from '../ui/Button.js';
import styles from './SmithPermissionControl.module.css';

export default function SmithPermissionControl({
  mode,
  running,
  disabled,
  onChange,
}: {
  mode: SmithPermissionMode;
  running: boolean;
  disabled: boolean;
  onChange: (mode: SmithPermissionMode) => Promise<void>;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const bypass = mode === 'bypass';
  const status = error ?? (bypass ? SMITH_YOLO_ACTIVE_COPY : SMITH_YOLO_OFF_COPY);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const toggle = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const accepted =
        bypass ||
        (await confirmManager.ask(SMITH_YOLO_WARNING, {
          title: 'Enable YOLO mode for this chat?',
          confirmLabel: 'Enable YOLO mode',
          variant: 'danger',
        }));
      if (accepted && mounted.current) await onChange(bypass ? 'ask' : 'bypass');
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <section className={styles.control} aria-label="Smith permissions">
      <Button
        type="button"
        size="sm"
        variant={bypass ? 'danger' : 'ghost'}
        aria-pressed={bypass}
        aria-label="Bypass Smith action approvals"
        disabled={disabled || busy || (running && !bypass)}
        onClick={() => void toggle()}
        title={
          running && !bypass
            ? 'Stop the turn before enabling YOLO mode.'
            : 'Change Smith action approvals'
        }
        data-testid="smith-permission-mode"
      >
        YOLO: {bypass ? 'on' : 'off'}
      </Button>
      <p
        className={error || bypass ? styles.warning : styles.detail}
        role={error ? 'alert' : 'status'}
        title={status}
      >
        {status}
      </p>
    </section>
  );
}
