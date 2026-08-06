import { useEffect, useState } from 'react';
import type { DoctorCheck } from '@shared/types.js';
import { api } from '../api.js';
import { useApp } from '../stores/app.js';
import DoctorList from '../components/DoctorList.js';

export default function OnboardingScreen({ onDone }: { onDone: () => void }): React.JSX.Element {
  const { projects, settings, refreshAll } = useApp();
  const [step, setStep] = useState(0);
  const [checks, setChecks] = useState<DoctorCheck[]>([]);
  const [hero, setHero] = useState('');
  const [name, setName] = useState('');
  const [checking, setChecking] = useState(true);

  const blocking = checks.filter((c) => !c.ok && (c.id === 'droid' || c.id === 'git'));

  useEffect(() => {
    void api.app.assetUrl('scenes/onboarding-hero.png').then(setHero);
    setName(settings?.engineerName ?? '');
    void api.doctor.run().then((c) => { setChecks(c); setChecking(false); });
  }, [settings?.engineerName]);

  const recheck = async (): Promise<void> => {
    setChecking(true);
    setChecks(await api.doctor.run());
    setChecking(false);
  };
  const addProject = async (): Promise<void> => {
    await api.projects.add();
    await refreshAll();
  };
  const finish = async (): Promise<void> => {
    if (name.trim()) await api.settings.patch({ engineerName: name.trim() });
    onDone();
  };

  return (
    <>
      <div className="onboarding">
        <div className="panel">
          {hero && <img src={hero} alt="" className="hero" />}
          {step === 0 && (
            <>
              <h1>Foundry</h1>
              <p className="lead">A software factory you can watch work. You describe a change, a pipeline of agents carries it out in an isolated git worktree, and every phase leaves evidence you can read.</p>
              <ul className="points">
                <li><strong>Pipelines are data.</strong> Reorder phases, add a reviewer, change a model, without writing code.</li>
                <li><strong>Every phase is judged.</strong> Typed replies, gates that produce evidence, write boundaries that are enforced.</li>
                <li><strong>Nothing is hidden.</strong> Prompts, tool calls, corrections, and cost are all on the record.</li>
              </ul>
              <footer>
                <div className="grow" />
                <button className="btn primary" onClick={() => setStep(1)}>Get started</button>
              </footer>
            </>
          )}
          {step === 1 && (
            <>
              <h1>Check the environment</h1>
              <p className="lead">Foundry drives Factory's droid CLI for every agent phase, and git for isolation. Both need to work before a pipeline can run.</p>
              <DoctorList checks={checks} onRecheck={() => void recheck()} />
              {blocking.length > 0 && <p className="warn">Fix the items above and press Re-check. Foundry can be configured now, but a run will fail until droid and git both work.</p>}
              <footer>
                <button className="btn ghost" onClick={() => setStep(0)}>Back</button>
                <div className="grow" />
                <button className="btn primary" disabled={checking} onClick={() => setStep(2)}>Continue</button>
              </footer>
            </>
          )}
          {step === 2 && (
            <>
              <h1>Add your first project</h1>
              <p className="lead">A project is a git repository. Each run gets its own worktree and branch, so your checkout is never touched until you merge.</p>
              <div className="field">
                <label>Your name</label>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="who is asking" />
                <span className="hint">Recorded on every run.</span>
              </div>
              {projects.length ? (
                <div className="added">
                  <span className="mark">✓</span>
                  <div>
                    <strong>{projects[0]!.name}</strong>
                    <em className="faint mono">{projects[0]!.path}</em>
                  </div>
                </div>
              ) : (
                <button className="btn" onClick={() => void addProject()}>Choose a repository…</button>
              )}
              <footer>
                <button className="btn ghost" onClick={() => setStep(1)}>Back</button>
                <div className="grow" />
                <button className="btn primary" onClick={() => void finish()}>{projects.length ? 'Start using Foundry' : 'Skip for now'}</button>
              </footer>
            </>
          )}
        </div>
      </div>
      <style>{`
        .onboarding { flex: 1; display: grid; place-items: center; padding: var(--s8); overflow-y: auto; }
        .panel { width: min(640px, 100%); display: flex; flex-direction: column; animation: fade-in var(--slow) var(--ease); }
        .hero { width: 260px; height: 260px; object-fit: contain; align-self: center; margin-bottom: var(--s5); }
        .panel h1 { font-size: var(--text-3xl); font-weight: 600; letter-spacing: -0.03em; margin-bottom: var(--s3); }
        .lead { font-size: var(--text-base); color: var(--text-dim); line-height: var(--leading-loose); margin-bottom: var(--s5); }
        .points { list-style: none; display: flex; flex-direction: column; gap: var(--s3); margin-bottom: var(--s6); }
        .points li { font-size: var(--text-sm); color: var(--text-dim); line-height: var(--leading); padding-left: var(--s4); border-left: 2px solid var(--cyan-dim); }
        .points strong { color: var(--text); }
        .warn { padding: var(--s3); border-radius: var(--r-sm); background: var(--amber-dim); color: var(--amber); font-size: var(--text-sm); line-height: var(--leading); }
        .added { display: flex; align-items: center; gap: var(--s3); padding: var(--s3); border: 1px solid var(--green-dim); border-radius: var(--r-sm); background: var(--green-dim); font-size: var(--text-sm); }
        .added .mark { color: var(--green); }
        .added em { display: block; font-style: normal; font-size: var(--text-xs); }
        .panel footer { display: flex; align-items: center; gap: var(--s3); margin-top: var(--s8); }
        .grow { flex: 1; }
        .field { display: flex; flex-direction: column; gap: var(--s1); margin: var(--s4) 0; }
        .field label { font-size: var(--text-sm); font-weight: 500; }
        .hint { font-size: var(--text-xs); color: var(--text-faint); }
      `}</style>
    </>
  );
}
