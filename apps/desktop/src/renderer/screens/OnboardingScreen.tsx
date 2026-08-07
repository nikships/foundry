import { useEffect, useMemo, useState } from 'react';
import type { CliDescriptor, DoctorCheck } from '@shared/types.js';
import { api } from '../api.js';
import { useApp } from '../stores/app.js';
import DoctorList from '../components/DoctorList.js';

export default function OnboardingScreen({ onDone }: { onDone: () => void }): React.JSX.Element {
  const { projects, settings, refreshAll } = useApp();
  const [step, setStep] = useState(0);
  const [checks, setChecks] = useState<DoctorCheck[]>([]);
  const [clis, setClis] = useState<CliDescriptor[]>([]);
  const [hero, setHero] = useState('');
  const [name, setName] = useState('');
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // The doctor decides what blocks: with five CLIs, only the default one and git
  // do, and a hardcoded id here would have gone stale the moment a CLI was added.
  const blocking = useMemo(() => checks.filter((c) => !c.ok && c.blocking), [checks]);
  const defaultCli = settings?.defaultCli ?? 'droid';
  const defaultCliLabel = clis.find((c) => c.id === defaultCli)?.label ?? defaultCli;
  // Continue must not walk past a machine that cannot run a phase: that only
  // postpones the failure until the first Start click.
  const canContinue = !checking && blocking.length === 0;
  const continueHint = checking
    ? 'Still checking the environment…'
    : blocking.length
      ? `Fix ${blocking.length === 1 ? 'the blocking check' : `${blocking.length} blocking checks`} above, then Re-check.`
      : '';

  useEffect(() => {
    void api.app.assetUrl('scenes/onboarding-hero.png').then(setHero);
    setName(settings?.engineerName ?? '');
    void Promise.all([api.doctor.run(), api.catalog.clis()]).then(([nextChecks, nextClis]) => {
      setChecks(nextChecks);
      setClis(nextClis);
      setChecking(false);
    });
  }, [settings?.engineerName]);

  const recheck = async (): Promise<void> => {
    setChecking(true);
    setError('');
    try {
      setChecks(await api.doctor.run());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };
  const addProject = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api.projects.add();
      await refreshAll();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const finish = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (name.trim()) await api.settings.patch({ engineerName: name.trim() });
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <>
      <div className="onboarding">
        <div className="panel">
          {hero && <img src={hero} alt="" className="hero" />}
          {step === 0 && (
            <>
              <h1>Foundry</h1>
              <p className="lead">
                A software factory you can watch work. You describe a change, a pipeline of agents
                carries it out in an isolated git worktree, and every phase leaves evidence you can
                read.
              </p>
              <ul className="points">
                <li>
                  <strong>Pipelines are data.</strong> Reorder phases, add a reviewer, change a
                  model, without writing code.
                </li>
                <li>
                  <strong>Every phase is judged.</strong> Typed replies, gates that produce
                  evidence, write boundaries that are enforced.
                </li>
                <li>
                  <strong>Nothing is hidden.</strong> Prompts, tool calls, corrections, and cost are
                  all on the record.
                </li>
              </ul>
              <footer>
                <div className="grow" />
                <button className="btn primary" onClick={() => setStep(1)}>
                  Get started
                </button>
              </footer>
            </>
          )}
          {step === 1 && (
            <>
              <h1>Check the environment</h1>
              <p className="lead">
                Foundry drives agent CLIs (droid, Claude Code, Codex, Junie, Grok) and git for
                isolation. Your default CLI is <strong>{defaultCliLabel}</strong>: it and git must
                both work before a pipeline can run. Other CLIs are optional until a roster agent
                picks them.
              </p>
              <DoctorList checks={checks} onRecheck={() => void recheck()} />
              {blocking.length > 0 && (
                <p className="warn">
                  {blocking.length === 1
                    ? 'One check is blocking'
                    : `${blocking.length} checks are blocking`}
                  : {blocking.map((c) => c.label).join(', ')}. Fix{' '}
                  {blocking.length === 1 ? 'it' : 'them'} and press Re-check. Continuing now would
                  only fail on the first run.
                </p>
              )}
              {error && <p className="err">{error}</p>}
              <footer>
                <button className="btn ghost" onClick={() => setStep(0)}>
                  Back
                </button>
                <div className="grow" />
                <button
                  className="btn primary"
                  disabled={!canContinue}
                  title={continueHint || undefined}
                  onClick={() => {
                    setError('');
                    setStep(2);
                  }}
                >
                  {checking ? 'Checking…' : 'Continue'}
                </button>
              </footer>
              {!canContinue && continueHint && <p className="hint-line faint">{continueHint}</p>}
            </>
          )}
          {step === 2 && (
            <>
              <h1>Add your first project</h1>
              <p className="lead">
                A project is a git repository. Each run gets its own worktree and branch, so your
                checkout is never touched until you merge. You can add one later from the sidebar if
                you skip now.
              </p>
              <div className="field">
                <label>Your name</label>
                <input
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="who is asking"
                />
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
                <button className="btn" disabled={busy} onClick={() => void addProject()}>
                  {busy ? 'Opening…' : 'Choose a repository…'}
                </button>
              )}
              {error && <p className="err">{error}</p>}
              <footer>
                <button className="btn ghost" disabled={busy} onClick={() => setStep(1)}>
                  Back
                </button>
                <div className="grow" />
                <button className="btn primary" disabled={busy} onClick={() => void finish()}>
                  {busy ? 'Saving…' : projects.length ? 'Start using Foundry' : 'Skip for now'}
                </button>
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
        .lead strong { color: var(--text); font-weight: 600; }
        .points { list-style: none; display: flex; flex-direction: column; gap: var(--s3); margin-bottom: var(--s6); }
        .points li { font-size: var(--text-sm); color: var(--text-dim); line-height: var(--leading); padding-left: var(--s4); border-left: 2px solid var(--cyan-dim); }
        .points strong { color: var(--text); }
        .warn { padding: var(--s3); border-radius: var(--r-sm); background: var(--amber-dim); color: var(--amber); font-size: var(--text-sm); line-height: var(--leading); }
        .err { margin-top: var(--s3); padding: var(--s3); border-radius: var(--r-sm); background: var(--red-dim); color: var(--red); font-size: var(--text-sm); line-height: var(--leading); }
        .hint-line { margin-top: var(--s2); font-size: var(--text-xs); }
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
