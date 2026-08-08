import { CLI_VENDOR_IDS } from '@shared/types.js';
import type { CliDescriptor } from '@shared/types.js';
import { CliIcon } from '../../components/BrandIcon.js';
import { useOnboarding } from './OnboardingContext.js';

export default function CliScreen(): React.JSX.Element {
  const { next, back, clis, checks, defaultCli, pickCli, error } = useOnboarding();
  return (
    <div className="ob-cli">
      <div className="ob-cli-media">
        <div className="ob-frame">
          <img className="ob-hero-shot" src="" alt="" style={{ display: 'none' }} />
          <div className="ob-cli-ring">
            {CLI_VENDOR_IDS.map((id) => (
              <span key={id} className={`ob-cli-chip ${id === defaultCli ? 'on' : ''}`}><CliIcon vendor={id} size={28} /></span>
            ))}
          </div>
        </div>
        <p className="ob-caption faint">Pick the harness that runs new agents by default.</p>
      </div>
      <div className="ob-cli-copy">
        <p className="ob-eyebrow">Agent CLIs</p>
        <h1 className="ob-title">Choose your default harness</h1>
        <p className="ob-lead">Foundry drives five CLIs. The default is what new agents and command detection use. You can still mix vendors per agent in the Roster.</p>
        <div className="ob-cli-grid">
          {(clis.length ? clis : CLI_VENDOR_IDS.map((id) => ({ id, label: id } as CliDescriptor))).map((cli) => {
            const ok = checks.find((c) => c.id === `cli:${cli.id}`)?.ok;
            const authed = checks.find((c) => c.id === `auth:${cli.id}`)?.ok;
            const selected = cli.id === defaultCli;
            return (
              <button key={cli.id} type="button" className={`ob-cli-card ${selected ? 'on' : ''}`} onClick={() => void pickCli(cli.id)}>
                <CliIcon vendor={cli.id} size={32} />
                <div className="ob-cli-meta"><strong>{cli.label}</strong><span className="faint">{ok === false ? 'Not installed' : authed === false ? 'Needs sign-in' : ok ? 'Ready' : 'Detected at setup'}</span></div>
                {selected && <span className="ob-badge">Default</span>}
              </button>
            );
          })}
        </div>
        {error && <p className="ob-err">{error}</p>}
        <div className="ob-foot"><button className="btn ghost" onClick={back}>Back</button><span className="ob-grow" /><button className="btn primary" onClick={next}>Continue</button></div>
      </div>
      <style>{`
        .ob-cli{ flex:1; min-height:0; display:grid; grid-template-columns: minmax(280px,0.95fr) minmax(340px,1.05fr); gap: var(--s6); padding: var(--s3) var(--s6) var(--s6); }
        .ob-cli-media{ display:flex; flex-direction:column; gap: var(--s3); min-width:0; }
        .ob-frame{ position:relative; flex:1; min-height:280px; border-radius: calc(var(--r-lg) + 4px); border:1px solid var(--line); background: color-mix(in srgb, var(--bg-void) 80%, transparent); overflow:hidden; box-shadow: var(--shadow-lg), var(--glow-cyan); }
        .ob-hero-shot{ width:100%; height:100%; object-fit:cover; display:block; opacity:0.92; }
        .ob-cli-ring{ position:absolute; inset:auto 0 18px 0; display:flex; justify-content:center; gap:10px; padding:0 var(--s3); }
        .ob-cli-chip{ width:48px; height:48px; border-radius: var(--r-full); display:grid; place-items:center; background: color-mix(in srgb, var(--bg-panel) 88%, transparent); border:1px solid var(--line); backdrop-filter: blur(8px); }
        .ob-cli-chip.on{ border-color: var(--cyan); box-shadow: var(--glow-cyan); }
        .ob-caption{ font-size: var(--text-sm); line-height: var(--leading); max-width:42ch; }
        .ob-cli-copy{ display:flex; flex-direction:column; min-width:0; overflow: auto; }
        .ob-cli-grid{ display:grid; grid-template-columns: 1fr; gap: var(--s2); }
        .ob-cli-card{ display:flex; align-items:center; gap: var(--s3); width:100%; padding: var(--s3) var(--s4); border:1px solid var(--line); border-radius: var(--r); background: var(--bg-raised); color:inherit; font:inherit; text-align:left; }
        .ob-cli-card:hover{ border-color: var(--line-strong); background: var(--bg-hover); }
        .ob-cli-card.on{ border-color: var(--cyan); box-shadow: var(--glow-cyan); }
        .ob-cli-meta{ flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
        .ob-cli-meta strong{ font-size: var(--text-sm); }
        .ob-cli-meta span{ font-size: var(--text-xs); }
        .ob-badge{ font-size:10px; text-transform:uppercase; letter-spacing:0.08em; padding:3px 7px; border-radius: var(--r-full); background: var(--cyan-dim); color: var(--cyan); font-weight:600; }
        .ob-err{ margin-top: var(--s3); padding: var(--s3); border-radius: var(--r-sm); background: var(--red-dim); color: var(--red); font-size: var(--text-sm); line-height: var(--leading); }
        @media (max-width: 960px){ .ob-cli{ grid-template-columns:1fr; } }
      `}</style>
    </div>
  );
}
