import AgentAvatar from '../../components/AgentAvatar.js';
import { useOnboarding } from './OnboardingContext.js';
import { BUILTIN_AGENTS, SceneArt } from './shared.js';

export default function RosterScreen(): React.JSX.Element {
  const { next, back } = useOnboarding();
  return (
    <div className="ob-roster">
      <div className="ob-roster-media">
        <div className="ob-frame"><SceneArt path="scenes/run-success.png" className="ob-hero-shot" /></div>
        <p className="ob-caption faint">Five specialists. One request. Isolated git worktrees.</p>
      </div>
      <div className="ob-roster-copy">
        <p className="ob-eyebrow">The roster</p>
        <h1 className="ob-title">Meet the crew</h1>
        <p className="ob-lead">Built-in agents cover plan, build, scout, review, and docs. Edit them, or bring your own. Each one can ride a different CLI.</p>
        <div className="ob-roster-grid">
          {BUILTIN_AGENTS.map((agent) => (
            <div key={agent.name} className="ob-roster-card"><AgentAvatar name={agent.name} size={52} /><div><strong>{agent.name}</strong><span className="faint">{agent.role}</span></div></div>
          ))}
        </div>
        <div className="ob-foot"><button className="btn ghost" onClick={back}>Back</button><span className="ob-grow" /><button className="btn primary" onClick={next}>Continue</button></div>
      </div>
      <style>{`
        .ob-roster{ flex:1; min-height:0; display:grid; grid-template-columns: minmax(280px,0.95fr) minmax(340px,1.05fr); gap: var(--s6); padding: var(--s3) var(--s6) var(--s6); }
        .ob-roster-media{ display:flex; flex-direction:column; gap: var(--s3); min-width:0; }
        .ob-frame{ position:relative; flex:1; min-height:280px; border-radius: calc(var(--r-lg) + 4px); border:1px solid var(--line); background: color-mix(in srgb, var(--bg-void) 80%, transparent); overflow:hidden; box-shadow: var(--shadow-lg), var(--glow-cyan); }
        .ob-hero-shot{ width:100%; height:100%; object-fit:cover; display:block; opacity:0.92; }
        .ob-caption{ font-size: var(--text-sm); line-height: var(--leading); max-width:42ch; }
        .ob-roster-copy{ display:flex; flex-direction:column; min-width:0; }
        .ob-roster-grid{ display:grid; grid-template-columns: 1fr 1fr; gap: var(--s3); }
        .ob-roster-card{ display:flex; align-items:center; gap: var(--s3); padding: var(--s3); border:1px solid var(--line); border-radius: var(--r); background: var(--bg-raised); }
        .ob-roster-card strong{ display:block; font-size: var(--text-sm); text-transform: capitalize; }
        .ob-roster-card span{ font-size: var(--text-xs); }
        @media (max-width: 960px){ .ob-roster{ grid-template-columns:1fr; } }
      `}</style>
    </div>
  );
}
