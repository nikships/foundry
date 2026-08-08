import { useMemo } from 'react';
import type { AgentDef } from '@shared/types.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';

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
    <>
      <div className="scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <section className="sheet card">
          <header className="spread">
            <h2>Prompt preview: {agent.name}</h2>
            <button className="btn sm ghost" onClick={onClose}>
              Close
            </button>
          </header>
          <div className="scroll body">
            <h3>System</h3>
            <pre className="block selectable">{agent.systemPrompt}</pre>
            <h3>User</h3>
            <pre className="block selectable">{rendered}</pre>
            <h3>Appended by the engine</h3>
            <p className="faint note">
              The declared inputs for the phase, then the exact JSON shape of the{' '}
              <strong>{agent.envelope}</strong> envelope, generated from the schema the reply is
              validated against.
            </p>
          </div>
        </section>
      </div>
      <style>{`
        .scrim { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center; background: rgba(4, 6, 12, 0.7); backdrop-filter: blur(6px); }
        .sheet { width: min(820px, calc(100vw - 96px)); max-height: calc(100vh - 120px); display: flex; flex-direction: column; padding: var(--s5); box-shadow: var(--shadow-lg); background: var(--bg-panel); border: 1px solid var(--line); border-radius: var(--r-lg); }
        .spread { display: flex; justify-content: space-between; align-items: center; }
        .sheet h2 { font-size: var(--text-lg); font-weight: 600; }
        .body { min-height: 0; margin-top: var(--s4); overflow-y: auto; }
        .body h3 { font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-faint); margin: var(--s4) 0 var(--s2); }
        .body h3:first-child { margin-top: 0; }
        .block { padding: var(--s3); border-radius: var(--r-sm); background: var(--bg-void); font-family: var(--font-mono); font-size: var(--text-xs); line-height: var(--leading); white-space: pre-wrap; word-break: break-word; color: var(--text-dim); }
        .note { font-size: var(--text-xs); line-height: var(--leading); }
      `}</style>
    </>
  );
}
