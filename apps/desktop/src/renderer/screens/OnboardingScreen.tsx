import { useEffect, useMemo, useState } from 'react';
import type { CliDescriptor, CliVendor, DoctorCheck } from '@shared/types.js';
import { CLI_VENDOR_IDS } from '@shared/types.js';
import { api } from '../api.js';
import { useApp } from '../stores/app.js';
import AgentAvatar from '../components/AgentAvatar.js';
import { CliIcon } from '../components/BrandIcon.js';
import DoctorList from '../components/DoctorList.js';

type StepId = 'welcome' | 'factory' | 'roster' | 'clis' | 'doctor' | 'project';

const STEPS: { id: StepId; label: string }[] = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'factory', label: 'Factory' },
  { id: 'roster', label: 'Roster' },
  { id: 'clis', label: 'CLIs' },
  { id: 'doctor', label: 'Ready' },
  { id: 'project', label: 'Project' },
];

const BUILTIN_AGENTS: { name: string; role: string }[] = [
  { name: 'planner', role: 'Shapes the work' },
  { name: 'builder', role: 'Writes the code' },
  { name: 'scout', role: 'Maps the repo' },
  { name: 'reviewer', role: 'Judges the diff' },
  { name: 'documenter', role: 'Leaves the trail' },
];

const CONCEPTS: { art: string; title: string; body: string }[] = [
  {
    art: 'concepts/pipeline.png',
    title: 'Pipelines are data',
    body: 'Reorder phases, swap agents, add a reviewer. No scripts to rewrite.',
  },
  {
    art: 'concepts/envelope.png',
    title: 'Typed envelopes',
    body: 'Every agent reply is structured. Code decides if it counts.',
  },
  {
    art: 'concepts/gate.png',
    title: 'Gates leave evidence',
    body: 'A green gate says what it checked, not only that it passed.',
  },
];

function useAsset(path: string | null): string {
  const [src, setSrc] = useState('');
  useEffect(() => {
    if (!path) {
      setSrc('');
      return;
    }
    let cancelled = false;
    void api.app.assetUrl(path).then((url) => {
      if (!cancelled) setSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [path]);
  return src;
}

function SceneArt({ path, className }: { path: string; className?: string }): React.JSX.Element {
  const src = useAsset(path);
  if (!src) return <div className={`scene-art placeholder ${className ?? ''}`} />;
  return <img className={`scene-art ${className ?? ''}`} src={src} alt="" />;
}

export default function OnboardingScreen({ onDone }: { onDone: () => void }): React.JSX.Element {
  const { projects, settings, refreshAll, patchSettings, selectProject, selectedProjectId } =
    useApp();
  const [stepIndex, setStepIndex] = useState(0);
  const [checks, setChecks] = useState<DoctorCheck[]>([]);
  const [clis, setClis] = useState<CliDescriptor[]>([]);
  const [name, setName] = useState('');
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [entered, setEntered] = useState(false);
  const [selectedId, setSelectedId] = useState<string>(
    () => selectedProjectId || projects[0]?.id || '',
  );
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(projects.map((p) => [p.id, p.name])),
  );
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const step = STEPS[stepIndex]!.id;
  const blocking = useMemo(() => checks.filter((c) => !c.ok && c.blocking), [checks]);
  const defaultCli = settings?.defaultCli ?? 'droid';
  const defaultCliLabel = clis.find((c) => c.id === defaultCli)?.label ?? defaultCli;
  const canLeaveDoctor = !checking && blocking.length === 0;
  const doctorHint = checking
    ? 'Still checking the environment…'
    : blocking.length
      ? `Fix ${blocking.length === 1 ? 'the blocking check' : `${blocking.length} blocking checks`}, then Re-check.`
      : '';

  useEffect(() => {
    const t = window.setTimeout(() => setEntered(true), 40);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    setName(settings?.engineerName ?? '');
    void Promise.all([api.doctor.run(), api.catalog.clis()]).then(([nextChecks, nextClis]) => {
      setChecks(nextChecks);
      setClis(nextClis);
      setChecking(false);
    });
  }, [settings?.engineerName]);

  // Keep name drafts in sync with persisted projects, without clobbering a live edit.
  useEffect(() => {
    setNameDrafts((prev) => {
      const next: Record<string, string> = { ...prev };
      for (const p of projects) {
        if (renamingId === p.id) {
          if (!(p.id in next)) next[p.id] = p.name;
          continue;
        }
        next[p.id] = p.name;
      }
      for (const id of Object.keys(next)) {
        if (!projects.some((p) => p.id === id)) delete next[id];
      }
      const prevKeys = Object.keys(prev);
      const nextKeys = Object.keys(next);
      if (
        prevKeys.length === nextKeys.length &&
        nextKeys.every((k) => prev[k] === next[k]) &&
        nextKeys.length === prevKeys.length
      ) {
        return prev;
      }
      return next;
    });
  }, [projects, renamingId]);

  // Seed or repair selection whenever the project list changes.
  useEffect(() => {
    if (!projects.length) {
      if (selectedId) setSelectedId('');
      return;
    }
    const stillThere = projects.some((p) => p.id === selectedId);
    if (!selectedId || !stillThere) {
      const preferred = selectedProjectId || projects[0]!.id;
      const exists = projects.some((p) => p.id === preferred);
      setSelectedId(exists ? preferred : projects[0]!.id);
    }
  }, [projects, selectedProjectId, selectedId]);

  // Re-run the doctor when the user lands on that step so a fix they made while
  // browsing earlier is already reflected without an extra click.
  useEffect(() => {
    if (step !== 'doctor') return;
    let cancelled = false;
    setChecking(true);
    void api.doctor.run().then((next) => {
      if (cancelled) return;
      setChecks(next);
      setChecking(false);
    });
    return () => {
      cancelled = true;
    };
  }, [step]);

  const go = (next: number): void => {
    setError('');
    setStepIndex(Math.max(0, Math.min(STEPS.length - 1, next)));
  };

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

  const pickCli = async (vendor: CliVendor): Promise<void> => {
    setError('');
    try {
      const issues = await patchSettings({ defaultCli: vendor });
      if (issues.length) setError(issues.join(' '));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const addProject = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const added = await api.projects.add();
      await refreshAll();
      if (added) {
        setSelectedId(added.id);
        selectProject(added.id);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const removeProject = async (id: string): Promise<void> => {
    if (busy) return;
    const target = projects.find((p) => p.id === id);
    if (!target) return;
    if (
      !window.confirm(
        `Remove project "${target.name}" from Foundry? The git repo on disk is not deleted.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.projects.remove(id);
      await refreshAll();
      // Selection fallback is handled by the projects sync effect, but clear immediately
      // if the removed project was selected so the button disables without waiting for refresh.
      if (selectedId === id) {
        const remaining = projects.filter((p) => p.id !== id);
        const next = remaining[0]?.id ?? '';
        setSelectedId(next);
        if (next) selectProject(next);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const commitProjectRename = async (id: string): Promise<void> => {
    const draft = (nameDrafts[id] ?? '').trim();
    const project = projects.find((p) => p.id === id);
    if (!project) return;
    if (!draft) {
      setError('Project name cannot be empty.');
      setNameDrafts((prev) => ({ ...prev, [id]: project.name }));
      setRenamingId(null);
      return;
    }
    if (draft.length > 80) {
      setError('Keep the project name under 80 characters.');
      return;
    }
    if (draft === project.name) {
      setRenamingId(null);
      return;
    }
    setRenamingId(null);
    setError('');
    try {
      const result = await api.projects.save({ ...project, name: draft });
      if (!result.ok) {
        setError(result.issues.map((i) => `${i.where}: ${i.message}`).join(' '));
        setNameDrafts((prev) => ({ ...prev, [id]: project.name }));
        return;
      }
      await refreshAll();
    } catch (e) {
      setError((e as Error).message);
      setNameDrafts((prev) => ({ ...prev, [id]: project.name }));
    }
  };

  const canEnterProject = useMemo(() => {
    if (busy) return false;
    if (!projects.length) return false;
    if (!selectedId) return false;
    return projects.some((p) => p.id === selectedId);
  }, [busy, projects, selectedId]);
  const projectBlockingHint = !projects.length
    ? 'Pick a project or add a repository to continue.'
    : !selectedId
      ? 'Select a project to continue.'
      : '';

  const finish = async (): Promise<void> => {
    if (busy) return;
    if (!canEnterProject) {
      setError(projectBlockingHint || 'Pick a project or add a repository to continue.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (name.trim()) await api.settings.patch({ engineerName: name.trim() });
      if (selectedId) selectProject(selectedId);
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const sceneForStep = (): string => {
    if (step === 'welcome') return 'scenes/onboarding-hero.png';
    if (step === 'factory') return 'scenes/pipeline-designer.png';
    if (step === 'roster') return 'scenes/run-success.png';
    if (step === 'clis') return 'scenes/onboarding-hero.png';
    if (step === 'doctor') return 'scenes/empty-state.png';
    return 'scenes/pipeline-designer.png';
  };

  return (
    <>
      <div className={`onboarding ${entered ? 'in' : ''}`}>
        <div className="stage" aria-hidden>
          <div className="orb orb-a" />
          <div className="orb orb-b" />
          <div className="orb orb-c" />
          <div className="grid" />
        </div>

        <header className="top">
          <div className="brand">
            <CliIcon vendor="droid" size={22} />
            <span>Foundry</span>
          </div>
          <nav className="steps" aria-label="Onboarding steps">
            {STEPS.map((s, i) => (
              <button
                key={s.id}
                type="button"
                className={`step-pill ${i === stepIndex ? 'on' : ''} ${i < stepIndex ? 'done' : ''}`}
                onClick={() => {
                  // Forward jumps past the doctor gate are blocked; back is free.
                  if (i > stepIndex && step === 'doctor' && !canLeaveDoctor) return;
                  if (i > stepIndex + 1) return;
                  go(i);
                }}
              >
                <span className="dot" />
                <span className="label">{s.label}</span>
              </button>
            ))}
          </nav>
        </header>

        <div className="layout" key={step}>
          <aside className="cinema">
            <div className="frame">
              <SceneArt path={sceneForStep()} className="hero-shot" />
              {step === 'welcome' && (
                <div className="orbit">
                  {BUILTIN_AGENTS.map((agent, i) => (
                    <span
                      key={agent.name}
                      className="orbit-item"
                      style={{ ['--i' as string]: String(i) }}
                    >
                      <AgentAvatar name={agent.name} size={44} />
                    </span>
                  ))}
                </div>
              )}
              {step === 'clis' && (
                <div className="cli-ring">
                  {CLI_VENDOR_IDS.map((id) => (
                    <span key={id} className={`cli-chip ${id === defaultCli ? 'on' : ''}`}>
                      <CliIcon vendor={id} size={28} />
                    </span>
                  ))}
                </div>
              )}
            </div>
            <p className="caption faint">
              {step === 'welcome' && 'A software factory you can watch work.'}
              {step === 'factory' && 'Phases, envelopes, and gates. Code owns the verdict.'}
              {step === 'roster' && 'Five specialists. One request. Isolated git worktrees.'}
              {step === 'clis' && 'Pick the harness that runs new agents by default.'}
              {step === 'doctor' && `${defaultCliLabel} and git must be ready before a run.`}
              {step === 'project' && 'Every run branches. Your checkout stays clean.'}
            </p>
          </aside>

          <section className="panel">
            {step === 'welcome' && (
              <>
                <p className="eyebrow">Introducing</p>
                <h1>Foundry</h1>
                <p className="lead">
                  Describe a change. A pipeline of agents carries it out in an isolated worktree.
                  Every phase leaves evidence you can read: prompts, tools, gates, and cost.
                </p>
                <ul className="bullets">
                  <li>
                    <strong>Watch it work</strong>
                    <span>Live transcripts, not a black box.</span>
                  </li>
                  <li>
                    <strong>Judge every phase</strong>
                    <span>Envelopes and gates decide success, not the agent.</span>
                  </li>
                  <li>
                    <strong>Stay in control</strong>
                    <span>Write boundaries, checkpoints, and merge on your terms.</span>
                  </li>
                </ul>
              </>
            )}

            {step === 'factory' && (
              <>
                <p className="eyebrow">How it works</p>
                <h1>The factory floor</h1>
                <p className="lead">
                  A run is a pipeline of phases. Agents propose; code disposes. Nothing green is a
                  vibe check.
                </p>
                <div className="concept-grid">
                  {CONCEPTS.map((c) => (
                    <article key={c.title} className="concept card">
                      <SceneArt path={c.art} className="concept-art" />
                      <h3>{c.title}</h3>
                      <p>{c.body}</p>
                    </article>
                  ))}
                </div>
              </>
            )}

            {step === 'roster' && (
              <>
                <p className="eyebrow">The roster</p>
                <h1>Meet the crew</h1>
                <p className="lead">
                  Built-in agents cover plan, build, scout, review, and docs. Edit them, or bring
                  your own. Each one can ride a different CLI.
                </p>
                <div className="roster-grid">
                  {BUILTIN_AGENTS.map((agent) => (
                    <div key={agent.name} className="roster-card card">
                      <AgentAvatar name={agent.name} size={52} />
                      <div>
                        <strong>{agent.name}</strong>
                        <span className="faint">{agent.role}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {step === 'clis' && (
              <>
                <p className="eyebrow">Agent CLIs</p>
                <h1>Choose your default harness</h1>
                <p className="lead">
                  Foundry drives five CLIs. The default is what new agents and command detection
                  use. You can still mix vendors per agent in the Roster.
                </p>
                <div className="cli-grid">
                  {(clis.length
                    ? clis
                    : CLI_VENDOR_IDS.map((id) => ({ id, label: id }) as CliDescriptor)
                  ).map((cli) => {
                    const ok = checks.find((c) => c.id === `cli:${cli.id}`)?.ok;
                    const authed = checks.find((c) => c.id === `auth:${cli.id}`)?.ok;
                    const selected = cli.id === defaultCli;
                    return (
                      <button
                        key={cli.id}
                        type="button"
                        className={`cli-card card ${selected ? 'on' : ''}`}
                        onClick={() => void pickCli(cli.id)}
                      >
                        <CliIcon vendor={cli.id} size={32} />
                        <div className="cli-meta">
                          <strong>{cli.label}</strong>
                          <span className="faint">
                            {ok === false
                              ? 'Not installed'
                              : authed === false
                                ? 'Needs sign-in'
                                : ok
                                  ? 'Ready'
                                  : 'Detected at setup'}
                          </span>
                        </div>
                        {selected && <span className="badge">Default</span>}
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {step === 'doctor' && (
              <>
                <p className="eyebrow">Environment</p>
                <h1>Make the floor safe</h1>
                <p className="lead">
                  Default CLI is <strong>{defaultCliLabel}</strong>. It and git block the rest of
                  setup until they work. Other CLIs can wait until an agent needs them.
                </p>
                <div className="status-row">
                  {CLI_VENDOR_IDS.map((id) => {
                    const cliOk = checks.find((c) => c.id === `cli:${id}`)?.ok;
                    const authOk = checks.find((c) => c.id === `auth:${id}`)?.ok;
                    const ready = cliOk && authOk;
                    return (
                      <div
                        key={id}
                        className={`status-chip ${ready ? 'ok' : cliOk === false || authOk === false ? 'bad' : ''}`}
                        title={id}
                      >
                        <CliIcon vendor={id} size={18} />
                        <span className="mark">{ready ? '✓' : '·'}</span>
                      </div>
                    );
                  })}
                </div>
                <DoctorList checks={checks} onRecheck={() => void recheck()} />
                {blocking.length > 0 && (
                  <p className="warn">
                    Blocking: {blocking.map((c) => c.label).join(', ')}. Fix{' '}
                    {blocking.length === 1 ? 'it' : 'them'} and Re-check before continuing.
                  </p>
                )}
              </>
            )}

            {step === 'project' && (
              <>
                <p className="eyebrow">First project</p>
                <h1>Point Foundry at a repo</h1>
                <p className="lead">
                  Each run gets its own worktree and branch. Merge when you accept.
                  {projects.length
                    ? ' Pick the one to start in — you can change it later from the sidebar.'
                    : ' Choose a git repository to get started.'}
                </p>
                <div className="field">
                  <label>Your name</label>
                  <input
                    className="input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="who is asking"
                  />
                  <span className="hint">Recorded on every run as the engineer.</span>
                </div>

                {projects.length ? (
                  <div className="field project-manager">
                    <label>Projects</label>
                    <span className="hint">
                      Name is just for you — type whatever you want. The path is where Foundry runs.
                    </span>
                    <div className="project-list" role="radiogroup" aria-label="Projects">
                      {projects.map((p) => {
                        const selected = p.id === selectedId;
                        const draft = nameDrafts[p.id] ?? p.name;
                        const isRenaming = renamingId === p.id;
                        return (
                          <label
                            key={p.id}
                            className={`project-row ${selected ? 'on' : ''} ${isRenaming ? 'editing' : ''}`}
                          >
                            <input
                              type="radio"
                              name="onboarding-project"
                              className="project-radio"
                              checked={selected}
                              onChange={() => {
                                setSelectedId(p.id);
                                selectProject(p.id);
                                setError('');
                              }}
                            />
                            <span className="project-radio-mark" aria-hidden />
                            <span className="project-main">
                              <input
                                className="input project-name-input"
                                value={draft}
                                onFocus={() => setRenamingId(p.id)}
                                onChange={(e) =>
                                  setNameDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))
                                }
                                onBlur={() => void commitProjectRename(p.id)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.preventDefault();
                                    (e.target as HTMLInputElement).blur();
                                  } else if (e.key === 'Escape') {
                                    setNameDrafts((prev) => ({ ...prev, [p.id]: p.name }));
                                    setRenamingId(null);
                                    (e.target as HTMLInputElement).blur();
                                  }
                                }}
                                placeholder="Project name"
                                aria-label={`Project name for ${p.path}`}
                              />
                              <span className="faint mono project-path" title={p.path}>
                                {p.path}
                              </span>
                            </span>
                            <button
                              type="button"
                              className="btn sm ghost project-remove"
                              disabled={busy}
                              onClick={(e) => {
                                e.preventDefault();
                                void removeProject(p.id);
                              }}
                              title="Remove from Foundry (repo on disk stays)"
                            >
                              Remove
                            </button>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <p className="faint empty-state">
                    No projects yet. Pick a git repository below — Foundry isolates each run in a
                    worktree, so the folder has to be a repo.
                  </p>
                )}

                <button
                  type="button"
                  className="btn project-btn"
                  disabled={busy}
                  onClick={() => void addProject()}
                >
                  {busy
                    ? 'Opening…'
                    : projects.length
                      ? 'Add another repository…'
                      : 'Choose a repository…'}
                </button>

                <SceneArt path="concepts/pipeline.png" className="project-art" />
              </>
            )}

            {error && <p className="err">{error}</p>}
            {step === 'project' && !canEnterProject && projectBlockingHint && (
              <p className="hint-line faint">{projectBlockingHint}</p>
            )}

            <footer className="foot">
              {stepIndex > 0 ? (
                <button className="btn ghost" disabled={busy} onClick={() => go(stepIndex - 1)}>
                  Back
                </button>
              ) : (
                <span />
              )}
              <div className="grow" />
              {step === 'doctor' ? (
                <button
                  className="btn primary"
                  disabled={!canLeaveDoctor}
                  title={doctorHint || undefined}
                  onClick={() => go(stepIndex + 1)}
                >
                  {checking ? 'Checking…' : 'Continue'}
                </button>
              ) : step === 'project' ? (
                <button
                  className="btn primary"
                  disabled={!canEnterProject}
                  title={projectBlockingHint || undefined}
                  onClick={() => void finish()}
                >
                  {busy ? 'Saving…' : 'Enter Foundry'}
                </button>
              ) : (
                <button className="btn primary" onClick={() => go(stepIndex + 1)}>
                  {step === 'welcome' ? 'Begin' : 'Continue'}
                </button>
              )}
            </footer>
            {step === 'doctor' && !canLeaveDoctor && doctorHint && (
              <p className="hint-line faint">{doctorHint}</p>
            )}
          </section>
        </div>
      </div>
      <style>{`
        .onboarding {
          position: relative;
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          opacity: 0;
          transform: translateY(8px);
          transition: opacity 480ms var(--ease), transform 480ms var(--ease);
        }
        .onboarding.in { opacity: 1; transform: none; }
        .stage { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
        .orb {
          position: absolute;
          border-radius: 50%;
          filter: blur(60px);
          opacity: 0.45;
          animation: drift 18s ease-in-out infinite alternate;
        }
        .orb-a { width: 420px; height: 420px; background: color-mix(in srgb, var(--cyan) 35%, transparent); top: -120px; left: -80px; }
        .orb-b { width: 360px; height: 360px; background: color-mix(in srgb, var(--purple, #c89bff) 28%, transparent); bottom: -100px; right: -60px; animation-delay: -6s; }
        .orb-c { width: 240px; height: 240px; background: color-mix(in srgb, var(--amber) 18%, transparent); top: 40%; left: 45%; animation-delay: -11s; }
        .grid {
          position: absolute; inset: 0;
          background-image:
            linear-gradient(color-mix(in srgb, var(--line) 55%, transparent) 1px, transparent 1px),
            linear-gradient(90deg, color-mix(in srgb, var(--line) 55%, transparent) 1px, transparent 1px);
          background-size: 48px 48px;
          mask-image: radial-gradient(ellipse at center, black 20%, transparent 72%);
          opacity: 0.35;
        }
        .top {
          position: relative;
          z-index: 2;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--s4);
          padding: calc(var(--titlebar-h) + var(--s3)) var(--s6) var(--s3);
        }
        .brand { display: flex; align-items: center; gap: var(--s2); font-weight: 600; letter-spacing: -0.02em; }
        .steps { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
        .step-pill {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 6px 10px; border-radius: var(--r-full);
          border: 1px solid transparent; background: transparent;
          color: var(--text-faint); font: inherit; font-size: var(--text-xs);
        }
        .step-pill .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--line-strong); }
        .step-pill.done { color: var(--text-dim); }
        .step-pill.done .dot { background: var(--cyan); }
        .step-pill.on { color: var(--text); background: var(--bg-panel); border-color: var(--line); box-shadow: var(--glow-cyan); }
        .step-pill.on .dot { background: var(--cyan); box-shadow: 0 0 0 3px var(--cyan-dim); }
        .layout {
          position: relative; z-index: 2;
          flex: 1; min-height: 0;
          display: grid;
          grid-template-columns: minmax(280px, 0.95fr) minmax(340px, 1.05fr);
          gap: var(--s6);
          padding: var(--s3) var(--s6) var(--s6);
          animation: fade-in 420ms var(--ease);
        }
        .cinema { display: flex; flex-direction: column; gap: var(--s3); min-width: 0; }
        .frame {
          position: relative;
          flex: 1;
          min-height: 280px;
          border-radius: calc(var(--r-lg) + 4px);
          border: 1px solid var(--line);
          background: color-mix(in srgb, var(--bg-void) 80%, transparent);
          overflow: hidden;
          box-shadow: var(--shadow-lg), var(--glow-cyan);
        }
        .scene-art { width: 100%; height: 100%; object-fit: cover; display: block; }
        .scene-art.placeholder { background: var(--bg-raised); min-height: 240px; }
        .scene-art.hero-shot { opacity: 0.92; }
        .scene-art.concept-art { width: 72px; height: 72px; object-fit: contain; margin-bottom: var(--s2); opacity: 0.95; }
        .scene-art.project-art { width: 120px; height: 120px; object-fit: contain; margin-top: var(--s4); opacity: 0.85; align-self: flex-start; }
        .caption { font-size: var(--text-sm); line-height: var(--leading); max-width: 42ch; }
        .orbit {
          position: absolute; inset: 0;
          display: grid; place-items: center;
          pointer-events: none;
        }
        .orbit-item {
          position: absolute;
          top: 50%; left: 50%;
          --angle: calc(var(--i) * 72deg);
          transform:
            translate(-50%, -50%)
            rotate(var(--angle))
            translateY(-108px)
            rotate(calc(-1 * var(--angle)));
          animation: float 5.5s ease-in-out infinite;
          animation-delay: calc(var(--i) * -0.7s);
          filter: drop-shadow(0 8px 18px rgba(0,0,0,0.35));
        }
        .cli-ring {
          position: absolute; inset: auto 0 18px 0;
          display: flex; justify-content: center; gap: 10px;
          padding: 0 var(--s3);
        }
        .cli-chip {
          width: 48px; height: 48px; border-radius: var(--r-full);
          display: grid; place-items: center;
          background: color-mix(in srgb, var(--bg-panel) 88%, transparent);
          border: 1px solid var(--line);
          backdrop-filter: blur(8px);
        }
        .cli-chip.on { border-color: var(--cyan); box-shadow: var(--glow-cyan); }
        .panel {
          min-height: 0;
          overflow-y: auto;
          padding: var(--s6);
          border-radius: calc(var(--r-lg) + 4px);
          border: 1px solid var(--line);
          background: color-mix(in srgb, var(--bg-panel) 92%, transparent);
          backdrop-filter: blur(14px);
          box-shadow: var(--shadow-lg);
          display: flex; flex-direction: column;
        }
        .eyebrow {
          font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.12em;
          color: var(--cyan); font-weight: 600; margin-bottom: var(--s2);
        }
        .panel h1 {
          font-size: clamp(1.75rem, 2.4vw, 2.35rem);
          font-weight: 600; letter-spacing: -0.03em; margin-bottom: var(--s3);
        }
        .lead {
          font-size: var(--text-base); color: var(--text-dim);
          line-height: var(--leading-loose); margin-bottom: var(--s5); max-width: 52ch;
        }
        .lead strong { color: var(--text); }
        .bullets { list-style: none; display: flex; flex-direction: column; gap: var(--s3); margin-bottom: var(--s4); }
        .bullets li {
          display: grid; gap: 2px; padding: var(--s3) var(--s4);
          border-radius: var(--r); border: 1px solid var(--line);
          background: var(--bg-raised);
        }
        .bullets strong { font-size: var(--text-sm); }
        .bullets span { font-size: var(--text-xs); color: var(--text-faint); line-height: var(--leading); }
        .concept-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s3); }
        .concept { padding: var(--s3); display: flex; flex-direction: column; align-items: flex-start; }
        .concept h3 { font-size: var(--text-sm); font-weight: 600; margin-bottom: 4px; }
        .concept p { font-size: var(--text-xs); color: var(--text-faint); line-height: var(--leading); }
        .roster-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s3); }
        .roster-card { display: flex; align-items: center; gap: var(--s3); padding: var(--s3); }
        .roster-card strong { display: block; font-size: var(--text-sm); text-transform: capitalize; }
        .roster-card span { font-size: var(--text-xs); }
        .cli-grid { display: grid; grid-template-columns: 1fr; gap: var(--s2); }
        .cli-card {
          display: flex; align-items: center; gap: var(--s3);
          width: 100%; padding: var(--s3) var(--s4);
          border: 1px solid var(--line); border-radius: var(--r);
          background: var(--bg-raised); color: inherit; font: inherit; text-align: left;
        }
        .cli-card:hover { border-color: var(--line-strong); background: var(--bg-hover); }
        .cli-card.on { border-color: var(--cyan); box-shadow: var(--glow-cyan); }
        .cli-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
        .cli-meta strong { font-size: var(--text-sm); }
        .cli-meta span { font-size: var(--text-xs); }
        .badge {
          font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
          padding: 3px 7px; border-radius: var(--r-full);
          background: var(--cyan-dim); color: var(--cyan); font-weight: 600;
        }
        .status-row { display: flex; flex-wrap: wrap; gap: var(--s2); margin-bottom: var(--s3); }
        .status-chip {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 6px 10px; border-radius: var(--r-full);
          border: 1px solid var(--line); background: var(--bg-raised);
        }
        .status-chip.ok { border-color: var(--green-dim); }
        .status-chip.ok .mark { color: var(--green); }
        .status-chip.bad { border-color: var(--red-dim); }
        .status-chip.bad .mark { color: var(--red); }
        .field { display: flex; flex-direction: column; gap: var(--s1); margin: var(--s2) 0 var(--s4); }
        .field label { font-size: var(--text-sm); font-weight: 500; }
        .hint { font-size: var(--text-xs); color: var(--text-faint); }
        .project-btn { align-self: flex-start; margin-top: var(--s2); }
        .project-manager { gap: var(--s2); }
        .project-list { display: flex; flex-direction: column; gap: var(--s2); margin-top: var(--s1); }
        .project-row {
          display: flex; align-items: center; gap: var(--s3);
          padding: var(--s3) var(--s3);
          border: 1px solid var(--line); border-radius: var(--r);
          background: var(--bg-raised);
          cursor: default;
          transition: border-color 140ms var(--ease), background 140ms var(--ease), box-shadow 140ms var(--ease);
        }
        .project-row:hover { border-color: var(--line-strong); background: var(--bg-hover); }
        .project-row.on { border-color: var(--cyan); box-shadow: var(--glow-cyan); background: color-mix(in srgb, var(--bg-raised) 88%, var(--cyan-dim) 12%); }
        .project-row.editing { border-color: var(--line-strong); }
        .project-radio { position: absolute; opacity: 0; pointer-events: none; width: 0; height: 0; }
        .project-radio-mark {
          flex: none; width: 16px; height: 16px; border-radius: var(--r-full);
          border: 1.5px solid var(--line-strong); background: var(--bg-void);
          display: grid; place-items: center;
        }
        .project-radio-mark::after { content: ''; width: 7px; height: 7px; border-radius: var(--r-full); background: var(--cyan); opacity: 0; transform: scale(0.6); transition: opacity 140ms var(--ease), transform 140ms var(--ease); }
        .project-row.on .project-radio-mark { border-color: var(--cyan); box-shadow: 0 0 0 3px var(--cyan-dim); }
        .project-row.on .project-radio-mark::after { opacity: 1; transform: scale(1); }
        .project-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
        .project-name-input { font-size: var(--text-sm); font-weight: 500; }
        .project-path { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .project-remove { flex: none; }
        .empty-state { font-size: var(--text-sm); line-height: var(--leading); margin: var(--s1) 0 var(--s2); }
        .warn {
          margin-top: var(--s3); padding: var(--s3); border-radius: var(--r-sm);
          background: var(--amber-dim); color: var(--amber);
          font-size: var(--text-sm); line-height: var(--leading);
        }
        .err {
          margin-top: var(--s3); padding: var(--s3); border-radius: var(--r-sm);
          background: var(--red-dim); color: var(--red);
          font-size: var(--text-sm); line-height: var(--leading);
        }
        .foot { display: flex; align-items: center; gap: var(--s3); margin-top: auto; padding-top: var(--s6); }
        .grow { flex: 1; }
        .hint-line { margin-top: var(--s2); font-size: var(--text-xs); }
        .card { border: 1px solid var(--line); border-radius: var(--r); background: var(--bg-raised); }
        @keyframes drift {
          from { transform: translate3d(0, 0, 0) scale(1); }
          to { transform: translate3d(24px, -18px, 0) scale(1.08); }
        }
        @keyframes float {
          0%, 100% { translate: 0 0; }
          50% { translate: 0 -6px; }
        }
        @media (max-width: 960px) {
          .layout { grid-template-columns: 1fr; }
          .cinema { min-height: 220px; }
          .frame { min-height: 200px; max-height: 260px; }
          .concept-grid { grid-template-columns: 1fr; }
          .step-pill .label { display: none; }
        }
      `}</style>
    </>
  );
}
