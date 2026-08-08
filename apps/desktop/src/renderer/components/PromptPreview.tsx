import { useMemo } from 'react';
import type { AgentDef } from '@shared/types.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';
import { Button } from './ui/Button.js';
import styles from './PromptPreview.module.css';

const SAMPLE = {
  request: 'Add rate limiting to the public API',
  worktree: '/Users/you/repo/.foundry-worktrees/run_260806_a1b2c3',
  runId: 'run_260806_a1b2c3',
};

export default function PromptPreview({
  agent,
  onClose,
}: {
  agent: AgentDef;
  onClose: () => void;
}): React.JSX.Element {
  useEscapeToClose(onClose);
  const rendered = useMemo(
    () =>
      agent.userPrompt
        .replace(/\{\{\s*request\s*\}\}/g, SAMPLE.request)
        .replace(/\{\{\s*worktree\s*\}\}/g, SAMPLE.worktree)
        .replace(/\{\{\s*run_id\s*\}\}/g, SAMPLE.runId)
        .replace(/\{\{\s*([\w.]+)\s*\}\}/g, '«$1»'),
    [agent.userPrompt],
  );

  return (
    <div className={styles.scrim} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section className={`card ${styles.sheet}`}>
        <header className="spread">
          <h2>Prompt preview: {agent.name}</h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </header>
        <div className={`scroll ${styles.body}`}>
          <h3>System</h3>
          <pre className={`selectable ${styles.block}`}>{agent.systemPrompt}</pre>
          <h3>User</h3>
          <pre className={`selectable ${styles.block}`}>{rendered}</pre>
          <h3>Appended by the engine</h3>
          <p className={`faint ${styles.note}`}>
            The declared inputs for the phase, then the exact JSON shape of the{' '}
            <strong>{agent.envelope}</strong> envelope, generated from the schema the reply is
            validated against.
          </p>
        </div>
      </section>
    </div>
  );
}
