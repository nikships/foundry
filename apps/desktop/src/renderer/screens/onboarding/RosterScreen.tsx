import AgentAvatar from '../../components/AgentAvatar.js';
import { BUILTIN_AGENTS, StepFooter } from './shared.js';

const HINTS: Record<string, string> = {
  planner: 'Breaks a prompt into an ordered, reviewable task list.',
  builder: 'Implements each task inside its own isolated worktree.',
  scout: 'Finds the files, patterns, and owners that matter.',
  reviewer: 'Blocks the merge until the change reads clean.',
  documenter: 'Records intent, decisions, and follow-ups in the PR.',
};

const ACCENTS: Record<string, string> = {
  planner: 'var(--cyan)',
  builder: 'var(--purple)',
  scout: 'var(--amber)',
  reviewer: 'var(--green)',
  documenter: 'var(--blue)',
};

export default function RosterScreen(): React.JSX.Element {
  return (
    <div className="rs">
      <div className="rs-body">
        <div className="rs-intro">
          <p className="ob-eyebrow">03 — The roster</p>
          <h1 className="ob-title">Meet the crew</h1>
          <p className="ob-lead">
            Built-in agents cover plan, build, scout, review, and docs. Edit them, or bring your
            own. Each one can ride a different CLI.
          </p>
          <div className="rs-rule" aria-hidden />
          <p className="rs-stat">Five specialists. One request. Isolated git worktrees.</p>
          <div className="rs-flow" aria-hidden>
            {BUILTIN_AGENTS.map((a, i) => (
              <span key={a.name} className="rs-flow-item">
                {i > 0 && <span className="rs-flow-arrow">→</span>}
                <span className="rs-flow-name" style={{ color: ACCENTS[a.name] }}>
                  {a.name}
                </span>
              </span>
            ))}
          </div>
          <p className="rs-clarify">
            Pipelines wire them in sequence — each phase runs in order, leaves a typed envelope, and
            is judged by code before the next begins.
          </p>
        </div>

        <div className="rs-listWrap">
          <div className="rs-listhead">
            <span>Agents</span>
            <span className="rs-listhead-right">Any CLI</span>
          </div>
          <ol className="rs-lanes">
            <span className="rs-connector" aria-hidden />
            {BUILTIN_AGENTS.map((agent, idx) => (
              <li
                key={agent.name}
                className="rs-lane"
                style={
                  {
                    borderLeftColor: ACCENTS[agent.name],
                    ['--accent' as string]: ACCENTS[agent.name],
                    ['--i' as string]: String(idx),
                  } as React.CSSProperties
                }
              >
                <span className="rs-num">{String(idx + 1).padStart(2, '0')}</span>
                <span className="rs-avatar-wrap">
                  <AgentAvatar name={agent.name} size={36} />
                </span>
                <span className="rs-main">
                  <span className="rs-nameRow">
                    <span className="rs-name">{agent.name}</span>
                    <span className="rs-sep">/</span>
                    <span className="rs-role">{agent.role}</span>
                  </span>
                  <span className="rs-hint">{HINTS[agent.name]}</span>
                </span>
                <span className="rs-cli">
                  <span
                    className="rs-dot"
                    style={{ background: ACCENTS[agent.name] }}
                    aria-hidden
                  />
                  any CLI
                </span>
              </li>
            ))}
          </ol>
          <p className="rs-footnote">
            Tune names, prompts, and harnesses in the Roster after setup. The factory runs whatever
            you wire — these five are just a sharp default.
          </p>
        </div>
      </div>

      <StepFooter />

      <style>{`
        .rs{
          flex:1;
          min-height:0;
          display:flex;
          flex-direction:column;
          gap: var(--s6);
          padding: var(--s3) var(--s6) var(--s6);
        }
        .rs-body{
          flex:1;
          min-height:0;
          display:grid;
          grid-template-columns: minmax(300px, 0.9fr) minmax(420px, 1.08fr);
          gap: var(--s10);
          align-items:start;
        }
        .rs-intro{
          display:flex;
          flex-direction:column;
          min-width:0;
          position: sticky;
          top: 0;
        }
        .rs-rule{
          height: 1px;
          background: var(--line);
          margin-top: var(--s1);
        }
        .rs-stat{
          margin-top: var(--s4);
          font-family: var(--font-mono);
          font-size: var(--text-xs);
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--text-faint);
          line-height: var(--leading);
          max-width: 36ch;
        }
        .rs-flow{
          margin-top: var(--s5);
          display:flex;
          flex-wrap:wrap;
          align-items:center;
          gap: 2px 0;
          font-family: var(--font-mono);
          font-size: 11px;
          letter-spacing: 0.04em;
          text-transform: lowercase;
          color: var(--text-faint);
          line-height: 1;
        }
        .rs-flow-item{
          display:inline-flex;
          align-items:center;
          gap: 6px;
        }
        .rs-flow-arrow{
          color: var(--line-strong);
          font-size: 11px;
          margin: 0 4px;
        }
        .rs-flow-name{
          font-weight: 600;
          opacity: 0.95;
        }
        .rs-clarify{
          margin-top: var(--s5);
          font-size: var(--text-sm);
          color: var(--text-dim);
          line-height: var(--leading-loose);
          max-width: 42ch;
        }

        .rs-listWrap{
          display:flex;
          flex-direction:column;
          min-width:0;
          min-height:0;
        }
        .rs-listhead{
          display:flex;
          align-items:baseline;
          justify-content:space-between;
          gap: var(--s3);
          padding-bottom: var(--s3);
          border-bottom: 1px solid var(--line-strong);
          font-family: var(--font-mono);
          font-size: 11px;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: var(--text-faint);
        }
        .rs-listhead-right{
          font-size: 11px;
          letter-spacing: 0.1em;
          opacity: 0.9;
        }
        .rs-lanes{
          list-style:none;
          margin:0;
          padding:0;
          position:relative;
        }
        .rs-connector{
          position:absolute;
          left: 51px;
          top: 22px;
          bottom: 22px;
          width: 1px;
          background: var(--line);
          pointer-events:none;
        }
        .rs-lane{
          position:relative;
          display:grid;
          grid-template-columns: 28px 36px minmax(0,1fr) auto;
          gap: var(--s4);
          align-items:center;
          padding: var(--s5) var(--s3) var(--s5) var(--s4);
          border-bottom: 1px solid var(--line);
          border-left: 2px solid transparent;
          background: transparent;
          transition:
            background 120ms var(--ease),
            border-left-color 120ms var(--ease);
          animation: rs-in 420ms var(--ease) both;
          animation-delay: calc(var(--i) * 45ms);
        }
        .rs-lane:hover{
          background: var(--bg-hover);
        }
        .rs-lane:hover .rs-num{
          color: var(--text-dim);
        }
        .rs-num{
          font-family: var(--font-mono);
          font-size: var(--text-xs);
          color: var(--text-faint);
          letter-spacing: 0.05em;
          font-variant-numeric: tabular-nums;
          line-height: 1;
        }
        .rs-avatar-wrap{
          position:relative;
          z-index:1;
          display:flex;
          align-items:center;
          justify-content:center;
        }
        .rs-main{
          display:flex;
          flex-direction:column;
          gap: 2px;
          min-width:0;
        }
        .rs-nameRow{
          display:flex;
          align-items:baseline;
          gap: 6px;
          flex-wrap:wrap;
          min-width:0;
        }
        .rs-name{
          font-size: var(--text-sm);
          font-weight: 600;
          letter-spacing: -0.01em;
          color: var(--text);
          text-transform: capitalize;
          line-height: 1.2;
        }
        .rs-sep{
          color: var(--text-faint);
          font-size: var(--text-xs);
          font-weight: 400;
        }
        .rs-role{
          font-size: var(--text-sm);
          color: var(--text-dim);
          line-height: 1.2;
        }
        .rs-hint{
          font-size: var(--text-sm);
          color: var(--text-faint);
          line-height: var(--leading);
          display:block;
        }
        .rs-cli{
          display:inline-flex;
          align-items:center;
          gap: 6px;
          font-family: var(--font-mono);
          font-size: 11px;
          letter-spacing: 0.06em;
          color: var(--text-faint);
          white-space:nowrap;
          align-self:center;
          text-transform: lowercase;
        }
        .rs-dot{
          width: 6px;
          height: 6px;
          border-radius: var(--r-full);
          flex:none;
          box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent, var(--cyan)) 18%, transparent);
        }
        .rs-footnote{
          margin-top: var(--s4);
          font-size: var(--text-xs);
          color: var(--text-faint);
          line-height: var(--leading);
          max-width: 56ch;
        }

        @keyframes rs-in{
          from{ opacity:0; transform: translateY(4px); }
          to{ opacity:1; transform:none; }
        }

        @media (max-width: 960px){
          .rs-body{
            grid-template-columns: 1fr;
            gap: var(--s8);
          }
          .rs-intro{ position: static; }
          .rs-connector{ left: 46px; }
        }
        @media (max-width: 640px){
          .rs{ padding: var(--s3) var(--s4) var(--s4); }
          .rs-lane{
            grid-template-columns: 24px 32px minmax(0,1fr);
            gap: var(--s3);
            padding: var(--s4) var(--s2) var(--s4) var(--s3);
          }
          .rs-cli{
            grid-column: 3;
            justify-self:start;
            margin-top: 2px;
          }
          .rs-connector{ left: 40px; }
          .rs-flow{ gap: 4px 0; }
        }
        @media (prefers-reduced-motion: reduce){
          .rs-lane{ animation: none !important; }
        }
      `}</style>
    </div>
  );
}
