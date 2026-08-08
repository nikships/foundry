import { CLI_VENDOR_IDS } from '@shared/types.js';
import { CliIcon } from '../../components/BrandIcon.js';
import DoctorList from '../../components/DoctorList.js';
import { useOnboarding } from './OnboardingContext.js';

export default function DoctorScreen(): React.JSX.Element {
  const { next, back, checks, checking, recheck, canLeaveDoctor, doctorHint, defaultCliLabel, error } = useOnboarding();
  const blocking = checks.filter((c) => !c.ok && c.blocking);
  return (
    <div className="ob-doctor">
      <div className="ob-doctor-media">
        <div className="ob-frame"><div className="ob-doctor-art">◆</div></div>
        <p className="ob-caption faint">{defaultCliLabel} and git must be ready before a run.</p>
      </div>
      <div className="ob-doctor-copy">
        <p className="ob-eyebrow">Environment</p>
        <h1 className="ob-title">Make the floor safe</h1>
        <p className="ob-lead">Default CLI is <strong>{defaultCliLabel}</strong>. It and git block the rest of setup until they work. Other CLIs can wait until an agent needs them.</p>
        <div className="ob-status-row">
          {CLI_VENDOR_IDS.map((id) => {
            const cliOk = checks.find((c) => c.id === `cli:${id}`)?.ok;
            const authOk = checks.find((c) => c.id === `auth:${id}`)?.ok;
            const ready = cliOk && authOk;
            return <div key={id} className={`ob-status-chip ${ready ? 'ok' : cliOk === false || authOk === false ? 'bad' : ''}`} title={id}><CliIcon vendor={id} size={18} /><span className="ob-mark">{ready ? '✓' : '·'}</span></div>;
          })}
        </div>
        <DoctorList checks={checks} onRecheck={() => void recheck()} />
        {blocking.length > 0 && <p className="ob-warn">Blocking: {blocking.map((c) => c.label).join(', ')}. Fix {blocking.length === 1 ? 'it' : 'them'} and Re-check before continuing.</p>}
        {error && <p className="ob-err">{error}</p>}
        <div className="ob-foot">
          <button className="btn ghost" onClick={back}>Back</button><span className="ob-grow" />
          <button className="btn primary" disabled={!canLeaveDoctor} title={doctorHint || undefined} onClick={next}>{checking ? 'Checking…' : 'Continue'}</button>
        </div>
        {!canLeaveDoctor && doctorHint && <p className="ob-hint faint">{doctorHint}</p>}
      </div>
      <style>{`
        .ob-doctor{ flex:1; min-height:0; display:grid; grid-template-columns: minmax(280px,0.95fr) minmax(340px,1.05fr); gap: var(--s6); padding: var(--s3) var(--s6) var(--s6); }
        .ob-doctor-media{ display:flex; flex-direction:column; gap: var(--s3); min-width:0; }
        .ob-frame{ position:relative; flex:1; min-height:280px; border-radius: calc(var(--r-lg) + 4px); border:1px solid var(--line); background: color-mix(in srgb, var(--bg-void) 80%, transparent); overflow:hidden; box-shadow: var(--shadow-lg), var(--glow-cyan); display:grid; place-items:center; }
        .ob-doctor-art{ font-size: 64px; opacity:0.35; }
        .ob-caption{ font-size: var(--text-sm); line-height: var(--leading); max-width:42ch; }
        .ob-doctor-copy{ display:flex; flex-direction:column; min-width:0; overflow:auto; }
        .ob-status-row{ display:flex; flex-wrap:wrap; gap: var(--s2); margin-bottom: var(--s3); }
        .ob-status-chip{ display:inline-flex; align-items:center; gap:6px; padding:6px 10px; border-radius: var(--r-full); border:1px solid var(--line); background: var(--bg-raised); }
        .ob-status-chip.ok{ border-color: var(--green-dim); }
        .ob-status-chip.ok .ob-mark{ color: var(--green); }
        .ob-status-chip.bad{ border-color: var(--red-dim); }
        .ob-status-chip.bad .ob-mark{ color: var(--red); }
        .ob-warn{ margin-top: var(--s3); padding: var(--s3); border-radius: var(--r-sm); background: var(--amber-dim); color: var(--amber); font-size: var(--text-sm); line-height: var(--leading); }
        .ob-err{ margin-top: var(--s3); padding: var(--s3); border-radius: var(--r-sm); background: var(--red-dim); color: var(--red); font-size: var(--text-sm); line-height: var(--leading); }
        .ob-hint{ margin-top: var(--s2); font-size: var(--text-xs); }
        @media (max-width: 960px){ .ob-doctor{ grid-template-columns:1fr; } }
      `}</style>
    </div>
  );
}
