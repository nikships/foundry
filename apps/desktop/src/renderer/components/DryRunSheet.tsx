import { useState } from 'react';
import type { DryRunPrompt } from '@shared/types.js';
import { modelLabel } from '../format.js';
import AgentAvatar from './AgentAvatar.js';

export default function DryRunSheet({ prompts, onClose }: { prompts: DryRunPrompt[]; onClose: () => void }): React.JSX.Element {
  const [selected, setSelected] = useState(0);
  const current = prompts[selected];

  return (
    <>
      <div className="scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <section className="sheet card">
          <header className="spread">
            <div>
              <h2>Dry run</h2>
              <p className="faint sub">Exactly what each agent would receive, rendered against a sample request. Nothing was sent and nothing was spent.</p>
            </div>
            <button className="btn sm ghost" onClick={onClose}>Close</button>
          </header>
          <div className="split">
            <nav className="steps">
              {prompts.map((prompt, i) => (
                <button key={i} className={`step ${selected === i ? 'on' : ''}`} onClick={() => setSelected(i)}>
                  <AgentAvatar name={prompt.agent} size={26} />
                  <span className="step-name">{prompt.phase}</span>
                  <span className="faint mono step-model">{modelLabel(prompt.model)}</span>
                </button>
              ))}
              {!prompts.length && <p className="faint none">This pipeline has no agent phases.</p>}
            </nav>
            {current && (
              <div className="detail scroll">
                <h3>System</h3>
                <pre className="block selectable">{current.systemPrompt}</pre>
                <h3>User</h3>
                <pre className="block selectable">{current.userPrompt}</pre>
              </div>
            )}
          </div>
        </section>
      </div>
      <style>{`
        .scrim { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center; background: rgba(4, 6, 12, 0.7); backdrop-filter: blur(6px); }
        .sheet { width: min(980px, calc(100vw - 80px)); height: min(720px, calc(100vh - 100px)); display: flex; flex-direction: column; padding: var(--s5); box-shadow: var(--shadow-lg); background: var(--bg-panel); border-radius: var(--r-lg); border: 1px solid var(--line); }
        .spread { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--s4); }
        .sheet h2 { font-size: var(--text-lg); font-weight: 600; }
        .sub { font-size: var(--text-xs); max-width: 60ch; margin-top: 2px; }
        .split { flex: 1; min-height: 0; display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: var(--s4); margin-top: var(--s4); }
        .steps { display: flex; flex-direction: column; gap: 2px; overflow-y: auto; border-right: 1px solid var(--line-faint); padding-right: var(--s2); }
        .step { display: flex; align-items: center; gap: var(--s2); padding: var(--s2); border: none; border-radius: var(--r-sm); background: transparent; color: inherit; font: inherit; text-align: left; cursor: default; }
        .step:hover { background: var(--bg-hover); }
        .step.on { background: var(--bg-active); }
        .step-name { flex: 1; font-size: var(--text-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .step-model { font-size: 10px; }
        .detail { min-height: 0; overflow-y: auto; }
        .detail h3 { font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-faint); margin: var(--s4) 0 var(--s2); }
        .detail h3:first-child { margin-top: 0; }
        .block { padding: var(--s3); border-radius: var(--r-sm); background: var(--bg-void); font-family: var(--font-mono); font-size: var(--text-xs); line-height: var(--leading); white-space: pre-wrap; word-break: break-word; color: var(--text-dim); }
        .none { font-size: var(--text-sm); padding: var(--s3); }
        .scroll { overflow-y: auto; }
        .card { background: var(--bg-panel); border: 1px solid var(--line); border-radius: var(--r-lg); }
      `}</style>
    </>
  );
}
