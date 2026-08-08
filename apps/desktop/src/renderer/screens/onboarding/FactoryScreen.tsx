import { useOnboarding } from './OnboardingContext.js';
import { CONCEPTS, SceneArt } from './shared.js';

export default function FactoryScreen(): React.JSX.Element {
  const { next, back } = useOnboarding();
  return (
    <div className="ob-factory">
      <div className="ob-factory-media">
        <div className="ob-frame"><SceneArt path="scenes/pipeline-designer.png" className="ob-hero-shot" /></div>
        <p className="ob-caption faint">Phases, envelopes, and gates. Code owns the verdict.</p>
      </div>
      <div className="ob-factory-copy">
        <p className="ob-eyebrow">How it works</p>
        <h1 className="ob-title">The factory floor</h1>
        <p className="ob-lead">A run is a pipeline of phases. Agents propose; code disposes. Nothing green is a vibe check.</p>
        <div className="ob-concept-grid">
          {CONCEPTS.map((c) => (
            <article key={c.title} className="ob-concept">
              <SceneArt path={c.art} className="ob-concept-art" />
              <h3>{c.title}</h3><p>{c.body}</p>
            </article>
          ))}
        </div>
        <div className="ob-foot"><button className="btn ghost" onClick={back}>Back</button><span className="ob-grow" /><button className="btn primary" onClick={next}>Continue</button></div>
      </div>
      <style>{`
        .ob-factory { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(280px,0.95fr) minmax(340px,1.05fr); gap: var(--s6); padding: var(--s3) var(--s6) var(--s6); }
        .ob-factory-media { display:flex; flex-direction:column; gap: var(--s3); min-width:0; }
        .ob-frame { position:relative; flex:1; min-height:280px; border-radius: calc(var(--r-lg) + 4px); border:1px solid var(--line); background: color-mix(in srgb, var(--bg-void) 80%, transparent); overflow:hidden; box-shadow: var(--shadow-lg), var(--glow-cyan); }
        .ob-hero-shot { width:100%; height:100%; object-fit:cover; display:block; opacity:0.92; }
        .ob-caption { font-size: var(--text-sm); line-height: var(--leading); max-width:42ch; }
        .ob-factory-copy { display:flex; flex-direction:column; min-width:0; }
        .ob-concept-grid { display:grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: var(--s3); }
        .ob-concept { padding: var(--s3); border:1px solid var(--line); border-radius: var(--r); background: var(--bg-raised); display:flex; flex-direction:column; align-items:flex-start; }
        .ob-concept h3 { font-size: var(--text-sm); font-weight:600; margin-bottom:4px; }
        .ob-concept p { font-size: var(--text-xs); color: var(--text-faint); line-height: var(--leading); }
        .ob-concept-art { width:72px; height:72px; object-fit:contain; margin-bottom: var(--s2); opacity:0.95; }
        @media (max-width: 960px){ .ob-factory{ grid-template-columns:1fr; } .ob-concept-grid{ grid-template-columns:1fr; } }
      `}</style>
    </div>
  );
}
