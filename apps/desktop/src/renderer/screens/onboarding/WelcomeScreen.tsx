import { Suspense, lazy } from 'react';
import { useBrand } from '../../hooks/useBrand.js';
import { useOnboarding } from './OnboardingContext.js';
import { BUILTIN_AGENTS, SceneArt, sceneForStep } from './shared.js';
import AgentAvatar from '../../components/AgentAvatar.js';
const PrismField = lazy(() => import('../../components/prism/PrismField.js'));
const MurmurFlock = lazy(() => import('../../components/MurmurFlock.js'));

export default function WelcomeScreen(): React.JSX.Element {
  const { next } = useOnboarding();
  const brand = useBrand();
  return (
    <div className="ob-welcome">
      <div className="ob-welcome-media">
        <div className="ob-welcome-frame">
          {brand === 'prism' ? (
            <Suspense fallback={<SceneArt path={sceneForStep('welcome')} className="ob-hero-shot" />}> 
              <div className="ob-prism-hero"><PrismField variant="hero" /></div>
            </Suspense>
          ) : (
            <SceneArt path={sceneForStep('welcome')} className="ob-hero-shot" />
          )}
          {brand === 'murmur' && (
            <Suspense fallback={null}><MurmurFlock /></Suspense>
          )}
          {brand === 'murmur' && (
            <div className="ob-orbit">
              {BUILTIN_AGENTS.map((a, i) => (
                <span key={a.name} className="ob-orbit-item" style={{ ['--i' as string]: String(i) }}>
                  <AgentAvatar name={a.name} size={44} />
                </span>
              ))}
            </div>
          )}
        </div>
        <p className="ob-caption faint">A software factory you can watch work.</p>
      </div>
      <div className="ob-welcome-copy">
        <p className="ob-eyebrow">Introducing</p>
        <h1 className="ob-title">Foundry</h1>
        <p className="ob-lead">Describe a change. A pipeline of agents carries it out in an isolated worktree. Every phase leaves evidence you can read: prompts, tools, gates, and cost.</p>
        <ul className="ob-bullets">
          <li><strong>Watch it work</strong><span>Live transcripts, not a black box.</span></li>
          <li><strong>Judge every phase</strong><span>Envelopes and gates decide success, not the agent.</span></li>
          <li><strong>Stay in control</strong><span>Write boundaries, checkpoints, and merge on your terms.</span></li>
        </ul>
        <div className="ob-foot"><span /><span className="ob-grow" /><button className="btn primary" onClick={next}>Begin</button></div>
      </div>
      <style>{`
        .ob-welcome { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(280px,0.95fr) minmax(340px,1.05fr); gap: var(--s6); padding: var(--s3) var(--s6) var(--s6); }
        .ob-welcome-media { display: flex; flex-direction: column; gap: var(--s3); min-width: 0; }
        .ob-welcome-frame { position: relative; flex: 1; min-height: 280px; border-radius: calc(var(--r-lg) + 4px); border: 1px solid var(--line); background: color-mix(in srgb, var(--bg-void) 80%, transparent); overflow: hidden; box-shadow: var(--shadow-lg), var(--glow-cyan); }
        .ob-hero-shot { width: 100%; height: 100%; object-fit: cover; display: block; opacity: 0.92; }
        .ob-prism-hero { width: 100%; height: 100%; }
        .ob-caption { font-size: var(--text-sm); line-height: var(--leading); max-width: 42ch; }
        .ob-orbit { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
        .ob-orbit-item { position: absolute; top: 50%; left: 50%; --angle: calc(var(--i) * 72deg); transform: translate(-50%,-50%) rotate(var(--angle)) translateY(-108px) rotate(calc(-1 * var(--angle))); animation: ob-float 5.5s ease-in-out infinite; animation-delay: calc(var(--i) * -0.7s); filter: drop-shadow(0 8px 18px rgba(0,0,0,0.35)); }
        .ob-welcome-copy { display: flex; flex-direction: column; min-width: 0; padding: var(--s1) 0; }
        .ob-bullets { list-style: none; display: flex; flex-direction: column; gap: var(--s3); margin-bottom: var(--s4); }
        .ob-bullets li { display: grid; gap: 2px; padding: var(--s3) var(--s4); border-radius: var(--r); border: 1px solid var(--line); background: var(--bg-raised); }
        .ob-bullets strong { font-size: var(--text-sm); }
        .ob-bullets span { font-size: var(--text-xs); color: var(--text-faint); line-height: var(--leading); }
        @keyframes ob-float { 0%,100%{ translate:0 0; } 50%{ translate:0 -6px; } }
        @media (max-width: 960px){ .ob-welcome{ grid-template-columns: 1fr; } }
      `}</style>
    </div>
  );
}
