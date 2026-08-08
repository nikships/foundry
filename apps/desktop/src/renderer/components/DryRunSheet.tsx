import { useState } from 'react';
import type { DryRunPrompt } from '@shared/types.js';
import { modelLabel } from '../format.js';
import AgentAvatar from './AgentAvatar.js';
import { Button } from './ui/Button.js';
import { ModalShell } from './ui/ModalShell.js';
import styles from './DryRunSheet.module.css';

export default function DryRunSheet({
  prompts,
  onClose,
}: {
  prompts: DryRunPrompt[];
  onClose: () => void;
}): React.JSX.Element {
  const [selected, setSelected] = useState(0);
  const current = prompts[selected];

  return (
    <ModalShell onClose={onClose} ariaLabelledBy="dry-run-title" className={styles.sheet}>
      <header className="spread">
        <div>
          <h2 id="dry-run-title">Dry run</h2>
          <p className={`faint ${styles.sub}`}>
            Exactly what each agent would receive, rendered against a sample request. Nothing was
            sent and nothing was spent.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} title="Close (Esc)">
          Close
        </Button>
      </header>
      <div className={styles.split}>
        <nav className={styles.steps}>
          {prompts.map((prompt, i) => (
            <button
              key={i}
              className={`${styles.step} ${selected === i ? styles.on : ''}`}
              onClick={() => setSelected(i)}
            >
              <AgentAvatar name={prompt.agent} size={26} />
              <span className={styles.stepName}>{prompt.phase}</span>
              <span className={`faint mono ${styles.stepModel}`}>{modelLabel(prompt.model)}</span>
            </button>
          ))}
          {!prompts.length && (
            <p className={`faint ${styles.none}`}>This pipeline has no agent phases.</p>
          )}
        </nav>
        {current && (
          <div className={`${styles.detail} scroll`}>
            <h3>System</h3>
            <pre className={`${styles.block} selectable`}>{current.systemPrompt}</pre>
            <h3>User</h3>
            <pre className={`${styles.block} selectable`}>{current.userPrompt}</pre>
          </div>
        )}
      </div>
      <p className={`${styles.escHint} faint`}>Esc to close</p>
    </ModalShell>
  );
}
