import { useEffect, useRef, useState } from 'react';
import type { SmithPermissionMode } from '@shared/ipc-contract.js';
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
      if (mounted.current) await onChange(bypass ? 'ask' : 'bypass');
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
        aria-label="YOLO"
        disabled={disabled || busy || (running && !bypass)}
        onClick={() => void toggle()}
        title={error ?? (running && !bypass ? 'Stop the turn before enabling YOLO.' : undefined)}
        data-testid="smith-permission-mode"
      >
        YOLO
      </Button>
    </section>
  );
}
