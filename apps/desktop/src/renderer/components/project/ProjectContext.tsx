import { useState } from 'react';
import type { ProjectDef } from '@shared/types.js';
import { api } from '../../api.js';
import { Button } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import styles from './ProjectCommands.module.css';

export default function ProjectContext({
  project,
  onChange,
}: {
  project: ProjectDef;
  onChange: (patch: Pick<ProjectDef, 'contextSummary' | 'contextSummarySha'>) => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState('');
  const [error, setError] = useState('');
  const card = project.contextSummary?.trim() ?? '';

  const refresh = async (): Promise<void> => {
    setBusy(true);
    setError('');
    setDetail('');
    try {
      const result = await api.projects.refreshContext(project.id);
      if (!result.ok || !result.value) {
        setError(result.issues[0]?.message ?? 'could not refresh the repository card');
        return;
      }
      onChange({
        contextSummary: result.value.contextSummary,
        contextSummarySha: result.value.contextSummarySha,
      });
      const next = result.value.contextSummary?.trim() ?? '';
      setDetail(
        next
          ? `Refreshed (${next.length} characters).`
          : 'The helper did not return a complete card.',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="hint">
        {card
          ? `Present (${card.length} characters). Run agents receive stack, layout, conventions, verification, and setup before any tool call.`
          : 'Not generated yet. Starting a run will generate one, or refresh now.'}
      </p>
      <div className={cx(styles.commandActionsRow, styles.actionsRowSpaced)}>
        <Button size="sm" disabled={busy} onClick={() => void refresh()}>
          {busy ? 'Refreshing…' : 'Refresh repository card'}
        </Button>
      </div>
      {detail && <span className={`hint ${styles.sniffDetail}`}>{detail}</span>}
      {error && <span className={styles.detectError}>{error}</span>}
    </>
  );
}
