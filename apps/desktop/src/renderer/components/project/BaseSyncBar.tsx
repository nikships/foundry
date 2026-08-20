import { useCallback, useEffect, useRef, useState } from 'react';
import type { BaseSyncStatus } from '@shared/types.js';
import { api } from '../../api.js';
import {
  baseSyncBanner,
  showBaseSyncOnRuns,
  type BaseSyncBusy,
} from '../../view-models/base-sync-view.js';
import { Button } from '../ui/Button.js';
import styles from './BaseSyncBar.module.css';

function errorStatus(
  projectId: string,
  baseRef: string,
  message: string,
  prior?: BaseSyncStatus | null,
): BaseSyncStatus {
  return {
    projectId,
    baseRef,
    remote: prior?.remote ?? null,
    localSha: prior?.localSha ?? null,
    remoteSha: prior?.remoteSha ?? null,
    ahead: prior?.ahead ?? 0,
    behind: prior?.behind ?? 0,
    state: 'error',
    fetched: false,
    detail: message,
  };
}

export default function BaseSyncBar({
  projectId,
  baseRef,
  variant = 'banner',
  onSyncingChange,
}: {
  projectId: string;
  /** Re-inspect when the saved base ref changes. */
  baseRef: string;
  variant?: 'banner' | 'settings';
  onSyncingChange?: (syncing: boolean) => void;
}): React.JSX.Element | null {
  const [status, setStatus] = useState<BaseSyncStatus | null>(null);
  const [busy, setBusy] = useState<BaseSyncBusy | null>('checking');
  const requestRef = useRef(0);

  const inspect = useCallback(async (): Promise<void> => {
    const id = ++requestRef.current;
    setBusy('checking');
    try {
      const next = await api.projects.baseSyncInspect(projectId);
      if (id !== requestRef.current) return;
      setStatus(next);
    } catch (e) {
      if (id !== requestRef.current) return;
      setStatus(
        errorStatus(projectId, baseRef, (e as Error).message || 'could not check the remote'),
      );
    } finally {
      if (id === requestRef.current) setBusy(null);
    }
  }, [projectId, baseRef]);

  useEffect(() => {
    void inspect();
    return () => {
      requestRef.current += 1;
    };
  }, [inspect]);

  useEffect(() => {
    onSyncingChange?.(busy === 'syncing');
  }, [busy, onSyncingChange]);

  useEffect(() => () => onSyncingChange?.(false), [onSyncingChange]);

  const sync = async (): Promise<void> => {
    const id = ++requestRef.current;
    setBusy('syncing');
    try {
      const result = await api.projects.baseSync(projectId);
      if (id !== requestRef.current) return;
      setStatus(result?.status ?? null);
    } catch (e) {
      if (id !== requestRef.current) return;
      setStatus(
        errorStatus(
          projectId,
          baseRef,
          (e as Error).message || 'could not update the base ref',
          status,
        ),
      );
    } finally {
      if (id === requestRef.current) setBusy(null);
    }
  };

  if (variant === 'banner' && !showBaseSyncOnRuns(status, busy)) return null;

  const banner = baseSyncBanner(status, { busy });
  const primaryIsUpdate = banner.action?.startsWith('Update ');

  return (
    <div
      className={`${styles.bar} ${styles[banner.tone]} ${variant === 'banner' ? styles.banner : styles.settings}`}
      data-testid="base-sync"
      data-state={busy ?? status?.state ?? 'unknown'}
      role="status"
      aria-live="polite"
    >
      <p>{banner.message}</p>
      {banner.action && (
        <Button
          size="sm"
          disabled={!!busy}
          onClick={() => void (primaryIsUpdate ? sync() : inspect())}
          data-testid={primaryIsUpdate ? 'base-sync-update' : 'base-sync-check'}
        >
          {banner.action}
        </Button>
      )}
    </div>
  );
}
