import { useEffect, useMemo, useState } from 'react';
import type { AgentDef } from '@shared/types.js';
import { api } from '../api.js';
import { Button } from './ui/Button.js';
import { CodeBlock } from './ui/CodeBlock.js';
import { ModalShell } from './ui/ModalShell.js';
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
  const [example, setExample] = useState('');
  const rendered = useMemo(
    () =>
      agent.userPrompt
        .replace(/\{\{\s*request\s*\}\}/g, SAMPLE.request)
        .replace(/\{\{\s*worktree\s*\}\}/g, SAMPLE.worktree)
        .replace(/\{\{\s*run_id\s*\}\}/g, SAMPLE.runId)
        .replace(/\{\{\s*([\w.]+)\s*\}\}/g, '«$1»'),
    [agent.userPrompt],
  );

  // The effective envelope lives in main: the selected shape extended with this
  // agent's own fields. Re-read per envelope/field change so the preview shows
  // the draft being edited rather than the last saved agent.
  const fieldSignature = JSON.stringify(agent.customFields ?? []);
  useEffect(() => {
    let cancelled = false;
    void api.roster.preview(agent).then((json) => {
      if (!cancelled) setExample(json);
    });
    return () => {
      cancelled = true;
    };
    // `agent` is a fresh object per keystroke; the envelope and its fields are
    // what actually change the generated shape.
  }, [agent, agent.envelope, fieldSignature]);

  const extraCount = agent.customFields?.length ?? 0;

  return (
    <ModalShell onClose={onClose} className={styles.modal}>
      <header className="spread">
        <h2>Prompt preview: {agent.name}</h2>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </header>
      <div className={`scroll ${styles.body}`}>
        <h3>System</h3>
        <CodeBlock>{agent.systemPrompt}</CodeBlock>
        <h3>User</h3>
        <CodeBlock>{rendered}</CodeBlock>
        <h3>Appended by the engine</h3>
        <p className={`faint ${styles.note}`}>
          The declared inputs for the phase, then this exact JSON shape — the{' '}
          <strong>{agent.envelope}</strong> envelope
          {extraCount > 0 && (
            <>
              {' '}
              plus {extraCount} extra field{extraCount === 1 ? '' : 's'} from this agent
            </>
          )}
          , generated from the schema the reply is validated against.
        </p>
        <CodeBlock>{example || '…'}</CodeBlock>
      </div>
    </ModalShell>
  );
}
