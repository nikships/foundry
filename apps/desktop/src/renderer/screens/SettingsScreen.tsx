import { useEffect, useState } from 'react';
import type { CliDescriptor, CliVendor, DoctorCheck, ModelInfo, OrphanWorktree, ProjectDef, UpdateStatus } from '@shared/types.js';
import { api, plain } from '../api.js';
import { useApp } from '../stores/app.js';
import ModelPicker from '../components/ModelPicker.js';
import DoctorList from '../components/DoctorList.js';
import ProjectCommands from '../components/ProjectCommands.js';

type Pane = 'general' | 'clis' | 'defaults' | 'project' | 'maintenance' | 'about';

const PANES: { id: Pane; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'clis', label: 'Agent CLIs' },
  { id: 'defaults', label: 'Agent defaults' },
  { id: 'project', label: 'Project' },
  { id: 'maintenance', label: 'Maintenance' },
  { id: 'about', label: 'About' },
];

const NOTIFY_LABELS: Record<'accepted' | 'rejected' | 'failed' | 'needsInput', string> = {
  accepted: 'A run was accepted',
  rejected: 'A run was not accepted',
  failed: 'A run failed',
  needsInput: 'A run is waiting on me',
};

export default function SettingsScreen({ pane: initialPane }: { pane: string }): React.JSX.Element {
  const { settings, project, projects, refreshAll, patchSettings } = useApp();
  const [pane, setPane] = useState<Pane>((initialPane as Pane) ?? 'general');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [clis, setClis] = useState<CliDescriptor[]>([]);
  const [checks, setChecks] = useState<DoctorCheck[]>([]);
  const [projectChecks, setProjectChecks] = useState<DoctorCheck[]>([]);
  const [orphans, setOrphans] = useState<OrphanWorktree[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [version, setVersion] = useState('');
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ stage: 'idle' });
  const [projectDraft, setProjectDraft] = useState<ProjectDef | null>(null);
  const [maintenanceNote, setMaintenanceNote] = useState('');

  useEffect(() => {
    setPane((initialPane as Pane) ?? 'general');
  }, [initialPane]);

  useEffect(() => {
    void Promise.all([api.catalog.clis(), api.doctor.run(), api.app.version(), api.updater.getStatus()]).then(([l, c, v, u]) => {
      setClis(l);
      setChecks(c);
      setVersion(v);
      setUpdateStatus(u);
    });
    return api.on('updater-status', (data) => {
      if (data) setUpdateStatus(data as UpdateStatus);
    });
  }, []);

  // The defaults pane offers the models of whichever CLI is the default, so
  // switching the default CLI has to reload the list rather than leave a stale
  // one that names models this CLI has never heard of.
  const defaultCli = settings?.defaultCli;
  useEffect(() => {
    if (!defaultCli) return;
    void api.catalog.models(defaultCli).then(setModels);
  }, [defaultCli]);

  useEffect(() => {
    setProjectDraft(project ? plain({ ...project }) : null);
    if (project) void api.projects.check(project.id).then(setProjectChecks);
    else setProjectChecks([]);
  }, [project]);

  const projectDirty = JSON.stringify(projectDraft) !== JSON.stringify(project);
  const set = async (patch: Parameters<typeof patchSettings>[0]): Promise<void> => {
    setErrors(await patchSettings(patch));
  };
  const saveProject = async (): Promise<void> => {
    if (!projectDraft) return;
    try {
      const result = await api.projects.save(projectDraft);
      if (result.ok) {
        await refreshAll();
        setProjectChecks(await api.projects.check(projectDraft.id));
      } else {
        setErrors(result.issues.map((i) => `${i.where}: ${i.message}`));
      }
    } catch (e) {
      setErrors([(e as Error).message]);
    }
  };
  const removeProject = async (): Promise<void> => {
    if (!project) return;
    await api.projects.remove(project.id);
    await refreshAll();
  };
  const refreshModels = async (): Promise<void> => {
    if (!settings) return;
    setModels(await api.catalog.models(settings.defaultCli, true));
  };
  const setCli = async (vendor: CliVendor, patch: { path?: string; extraArgs?: string[] }): Promise<void> => {
    if (!settings) return;
    await set({ clis: { ...settings.clis, [vendor]: { ...settings.clis[vendor], ...patch } } });
  };
  const loadOrphans = async (): Promise<void> => setOrphans(await api.maintenance.orphanWorktrees());
  const removeOrphan = async (orphan: OrphanWorktree): Promise<void> => {
    const result = await api.maintenance.removeWorktree(orphan.projectId, orphan.path);
    setMaintenanceNote(result.detail);
    await loadOrphans();
  };
  const applyRetention = async (): Promise<void> => {
    const report = await api.maintenance.applyRetention();
    setMaintenanceNote(`Deleted ${report.runsDeleted} run${report.runsDeleted === 1 ? '' : 's'}.`);
  };
  const compact = async (): Promise<void> => { await api.maintenance.compact(); setMaintenanceNote('Trace databases compacted.'); };
  useEffect(() => { if (pane === 'maintenance') void loadOrphans(); }, [pane]);

  if (!settings) return <div className="screen" />;

  return (
    <>
      <div className="screen">
        <aside className="panes">
          <h1>Settings</h1>
          {PANES.map((p) => (
            <button key={p.id} className={`pane-btn ${pane === p.id ? 'on' : ''}`} onClick={() => setPane(p.id)}>{p.label}</button>
          ))}
        </aside>
        <div className="body scroll">
          {pane === 'general' && (
            <>
              <h2>General</h2>
              <div className="field">
                <label>Your name</label>
                <input className="input" value={settings.engineerName} onChange={(e) => void set({ engineerName: e.target.value })} />
                <span className="hint">Recorded on every run, so a trace says who asked for it.</span>
              </div>
              <div className="field">
                <label>Default agent CLI</label>
                <select className="select" value={settings.defaultCli} onChange={(e) => void set({ defaultCli: e.target.value as CliVendor })}>
                  {clis.map((cli) => (
                    <option key={cli.id} value={cli.id}>{cli.label}</option>
                  ))}
                </select>
                <span className="hint">What a new agent starts on, and what command detection uses. Each agent can choose its own in the Roster.</span>
              </div>
              <DoctorList checks={checks} onRecheck={() => void api.doctor.run().then(setChecks)} />
              <h3>Notifications</h3>
              {(Object.keys(NOTIFY_LABELS) as Array<keyof typeof NOTIFY_LABELS>).map((key) => (
                <label key={key} className="toggle">
                  <input type="checkbox" checked={settings.notifications[key]} onChange={(e) => void set({ notifications: { ...settings.notifications, [key]: e.target.checked } })} />
                  <span>{NOTIFY_LABELS[key]}</span>
                </label>
              ))}
              <label className="toggle">
                <input type="checkbox" checked={settings.dockBadge} onChange={(e) => void set({ dockBadge: e.target.checked })} />
                <span>Show the number of live runs on the dock icon</span>
              </label>
              <h3>Software updates</h3>
              <div className="cli-card">
                <div className="spread">
                  <div>
                    <strong>Foundry {version ? `v${version}` : ''}</strong>
                    {updateStatus.message && <p className="hint">{updateStatus.message}</p>}
                  </div>
                  <span className={`cli-state ${updateStatus.stage === 'ready' || updateStatus.stage === 'available' ? 'ok' : updateStatus.stage === 'error' ? 'off' : ''}`}>
                    {updateStatus.stage === 'idle' ? 'up to date' : updateStatus.stage}
                  </span>
                </div>
                {updateStatus.stage === 'downloading' && (
                  <div className="field" style={{ marginTop: 'var(--s3)' }}>
                    <div className="spread">
                      <span className="hint">Downloading update…</span>
                      <span className="hint">{updateStatus.percent ?? 0}%</span>
                    </div>
                    <progress value={updateStatus.percent ?? 0} max={100} style={{ width: '100%', marginTop: '4px' }} />
                  </div>
                )}
                <div className="actions" style={{ marginTop: 'var(--s3)', paddingTop: 'var(--s3)' }}>
                  {updateStatus.stage === 'ready' ? (
                    <button className="btn primary sm" onClick={() => void api.updater.quitAndInstall()}>
                      Restart to update
                    </button>
                  ) : updateStatus.stage === 'available' ? (
                    <button className="btn primary sm" onClick={() => void api.updater.download()}>
                      Download update
                    </button>
                  ) : (
                    <button
                      className="btn sm"
                      disabled={updateStatus.stage === 'checking' || updateStatus.stage === 'downloading'}
                      onClick={() => void api.updater.check()}
                    >
                      {updateStatus.stage === 'checking' ? 'Checking for updates…' : 'Check for updates'}
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
          {pane === 'clis' && (
            <>
              <h2>Agent CLIs</h2>
              <p className="lead faint">Foundry drives one of these per agent phase. A path is filled in from your PATH at first launch; correct it here if you keep a CLI somewhere unusual.</p>
              {clis.map((cli) => {
                const config = settings.clis[cli.id];
                const found = checks.find((c) => c.id === `cli:${cli.id}`);
                return (
                  <div key={cli.id} className="cli-card">
                    <div className="spread">
                      <h3>{cli.label}</h3>
                      {found && <span className={`cli-state ${found.ok ? 'ok' : 'off'}`}>{found.ok ? 'found' : 'not found'}</span>}
                    </div>
                    <div className="field">
                      <label>Executable</label>
                      <input className="input mono" value={config.path} onChange={(e) => void setCli(cli.id, { path: e.target.value })} />
                      {found && <span className="hint">{found.detail}</span>}
                    </div>
                    <div className="field">
                      <label>Extra arguments</label>
                      <input
                        className="input mono"
                        value={config.extraArgs.join(' ')}
                        placeholder="appended to every turn"
                        onChange={(e) => void setCli(cli.id, { extraArgs: e.target.value.split(/\s+/).filter(Boolean) })}
                      />
                      <span className="hint">For an option this release does not model yet. Passed through verbatim.</span>
                    </div>
                    {cli.caveats.length > 0 && (
                      <ul className="caveats">
                        {cli.caveats.map((caveat) => (
                          <li key={caveat}>{caveat}</li>
                        ))}
                      </ul>
                    )}
                    <button className="btn sm" onClick={() => void api.app.openExternal(cli.docsUrl)}>Install docs</button>
                  </div>
                );
              })}
              <DoctorList checks={checks} onRecheck={() => void api.doctor.run().then(setChecks)} />
            </>
          )}
          {pane === 'defaults' && (
            <>
              <div className="spread">
                <h2>Agent defaults</h2>
                <button className="btn sm" onClick={() => void refreshModels()}>Refresh models</button>
              </div>
              <p className="lead faint">Used by any agent set to inherit. A per-agent choice always wins.</p>
              <div className="field">
                <label>Default model</label>
                <ModelPicker value={settings.defaultModel} models={models} onChange={(v) => void set({ defaultModel: v })} />
              </div>
              <div className="field">
                <label>Default reasoning effort</label>
                <select className="select" value={settings.defaultReasoningEffort} onChange={(e) => void set({ defaultReasoningEffort: e.target.value as never })}>
                  <option value="off">Off</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </div>
              <div className="field">
                <label>Autonomy</label>
                <select className="select" value={settings.defaultAutonomy} onChange={(e) => void set({ defaultAutonomy: e.target.value as never })}>
                  <option value="low">Low: confirm every write and command</option>
                  <option value="medium">Medium: writes inside the boundary run unattended</option>
                  <option value="high">High: run unattended within the worktree</option>
                </select>
                <span className="hint">Foundry always reverts writes outside an agent's boundary, at every level. Autonomy only decides what it stops to ask about first.</span>
              </div>
              <div className="two">
                <div className="field">
                  <label>Envelope retries</label>
                  <input className="input" type="number" min={0} max={5} value={settings.envelopeRetries} onChange={(e) => void set({ envelopeRetries: Number(e.target.value) })} />
                  <span className="hint">Correction messages sent when a reply will not parse.</span>
                </div>
                <div className="field">
                  <label>Gate retries</label>
                  <input className="input" type="number" min={0} max={5} value={settings.gateRetries} onChange={(e) => void set({ gateRetries: Number(e.target.value) })} />
                  <span className="hint">Attempts to fix a gate violation before the phase fails.</span>
                </div>
              </div>
              <div className="two">
                <div className="field">
                  <label>Turn timeout (minutes)</label>
                  <input className="input" type="number" min={5} max={60} value={Math.round(settings.turnTimeoutMs / 60000)} onChange={(e) => void set({ turnTimeoutMs: Number(e.target.value) * 60000 })} />
                </div>
                <div className="field">
                  <label>Trace poll cadence (ms)</label>
                  <input className="input" type="number" min={250} max={2000} step={50} value={settings.pollCadenceMs} onChange={(e) => void set({ pollCadenceMs: Number(e.target.value) })} />
                  <span className="hint">How often a live run's view refreshes.</span>
                </div>
              </div>
            </>
          )}
          {pane === 'project' && (
            <>
              {projectDraft ? (
                <>
                  <div className="spread">
                    <h2>{projectDraft.name}</h2>
                    <button className="btn sm ghost" onClick={() => void api.projects.reveal(projectDraft!.path)}>Reveal in Finder</button>
                  </div>
                  <p className="lead faint mono">{projectDraft.path}</p>
                  <DoctorList checks={projectChecks} onRecheck={() => void api.projects.check(projectDraft!.id).then(setProjectChecks)} />
                  <div className="two">
                    <div className="field">
                      <label>Base ref</label>
                      <input className="input mono" value={projectDraft.baseRef} onChange={(e) => setProjectDraft({ ...projectDraft, baseRef: e.target.value })} />
                      <span className="hint">Every run branches from here.</span>
                    </div>
                    <div className="field">
                      <label>Merge policy</label>
                      <select className="select" value={projectDraft.mergePolicy} onChange={(e) => setProjectDraft({ ...projectDraft, mergePolicy: e.target.value as ProjectDef['mergePolicy'] })}>
                        <option value="never">Never merge automatically</option>
                        <option value="on_accept">Merge when a run is accepted</option>
                        <option value="ask">Ask me each time</option>
                      </select>
                    </div>
                  </div>
                  <ProjectCommands project={projectDraft} />
                  <div className="field">
                    <label>Protected paths</label>
                    <textarea className="textarea" rows={3} value={projectDraft.protectedPaths.join('\n')} onChange={(e) => setProjectDraft({ ...projectDraft, protectedPaths: e.target.value.split('\n').filter(Boolean) })} />
                    <span className="hint">One pattern per line. No agent may write these, whatever its own boundary says. <code>.git/</code>, CI config, and lockfiles are always protected.</span>
                  </div>
                  <div className="field">
                    <label>Auto-approved commands</label>
                    <textarea className="textarea" rows={3} value={projectDraft.allowedCommands.join('\n')} onChange={(e) => setProjectDraft({ ...projectDraft, allowedCommands: e.target.value.split('\n').filter(Boolean) })} />
                    <span className="hint">Commands agents may run without stopping to ask. Prefix matching.</span>
                  </div>
                  <div className="two">
                    <label className="toggle">
                      <input type="checkbox" checked={projectDraft.ownRoster} onChange={(e) => setProjectDraft({ ...projectDraft, ownRoster: e.target.checked })} />
                      <span>Use a project-specific roster<em className="faint">Starts as a copy of the global roster; changes stay in this project.</em></span>
                    </label>
                    <label className="toggle">
                      <input type="checkbox" checked={projectDraft.ownPipelines} onChange={(e) => setProjectDraft({ ...projectDraft, ownPipelines: e.target.checked })} />
                      <span>Use project-specific pipelines<em className="faint">Same idea, for pipelines.</em></span>
                    </label>
                  </div>
                  <footer className="actions">
                    <button className="btn danger" onClick={() => void removeProject()}>Remove project</button>
                    <div className="grow" />
                    <button className="btn primary" disabled={!projectDirty} onClick={() => void saveProject()}>Save project</button>
                  </footer>
                </>
              ) : (
                <p className="faint">No project selected.</p>
              )}
            </>
          )}
          {pane === 'maintenance' && (
            <>
              <h2>Maintenance</h2>
              <div className="field">
                <label>Keep run history for</label>
                <select className="select" value={settings.retentionDays ?? ''} onChange={(e) => void set({ retentionDays: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">Forever</option>
                  <option value="7">7 days</option>
                  <option value="30">30 days</option>
                  <option value="90">90 days</option>
                  <option value="365">A year</option>
                </select>
                <span className="hint">Applies when you press the button below. Nothing is deleted behind your back.</span>
              </div>
              <div className="row">
                <button className="btn" onClick={() => void applyRetention()}>Apply retention now</button>
                <button className="btn" onClick={() => void compact()}>Compact trace databases</button>
              </div>
              <h3>Leftover worktrees</h3>
              <p className="hint">A worktree left behind by a crashed or killed run. Removing one deletes its branch and any uncommitted work in it.</p>
              {orphans.length ? (
                <ul className="orphans">
                  {orphans.map((orphan) => (
                    <li key={orphan.path}>
                      <span className="mono">{orphan.path}</span>
                      <span className="faint">{orphan.branch}</span>
                      <button className="btn sm danger" onClick={() => void removeOrphan(orphan)}>Remove</button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="faint">None found.</p>
              )}
              {maintenanceNote && <p className="note">{maintenanceNote}</p>}
            </>
          )}
          {pane === 'about' && (
            <>
              <h2>Foundry</h2>
              <p className="lead">A software factory you can watch. Pipelines are data, agents are configuration, and every phase leaves evidence you can read.</p>
              <dl className="about">
                <dt>Version</dt>
                <dd className="mono">{version}</dd>
                <dt>Agent harness</dt>
                <dd className="mono">droid CLI over stream JSON-RPC</dd>
                <dt>Projects</dt>
                <dd className="mono">{projects.length}</dd>
              </dl>
              <button className="btn sm" onClick={() => void api.app.openExternal('https://docs.factory.ai/droid-exec/overview')}>droid CLI documentation</button>
            </>
          )}
          {errors.length > 0 && (
            <ul className="errors">
              {errors.map((error, i) => <li key={i}>{error}</li>)}
            </ul>
          )}
        </div>
      </div>
      <style>{`
        .screen { display: grid; grid-template-columns: 200px minmax(0, 1fr); height: 100%; min-height: 0; }
        .panes { display: flex; flex-direction: column; gap: 2px; padding: calc(var(--titlebar-h) + var(--s2)) var(--s3) var(--s4); border-right: 1px solid var(--line); background: var(--bg-panel); }
        .panes h1 { font-size: var(--text-xl); font-weight: 600; padding: 0 var(--s2) var(--s3); }
        .pane-btn { padding: var(--s2) var(--s3); border: none; border-radius: var(--r-sm); background: transparent; color: var(--text-dim); font: inherit; font-size: var(--text-sm); text-align: left; cursor: default; }
        .pane-btn:hover { background: var(--bg-hover); color: var(--text); }
        .pane-btn.on { background: var(--bg-active); color: var(--text); }
        .body { min-height: 0; padding: calc(var(--titlebar-h) + var(--s2)) var(--s8) var(--s16); max-width: 780px; overflow-y: auto; }
        .body h2 { font-size: var(--text-xl); font-weight: 600; margin-bottom: var(--s2); }
        .body h3 { font-size: var(--text-sm); font-weight: 600; margin: var(--s6) 0 var(--s3); }
        .lead { font-size: var(--text-sm); line-height: var(--leading); margin-bottom: var(--s5); }
        .two { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s4); }
        .field { display: flex; flex-direction: column; gap: var(--s1); margin-bottom: var(--s4); }
        .field label { font-size: var(--text-sm); font-weight: 500; }
        .hint { font-size: var(--text-xs); color: var(--text-faint); }
        .spread { display: flex; align-items: center; justify-content: space-between; }
        .toggle { display: flex; gap: var(--s2); margin-bottom: var(--s3); font-size: var(--text-sm); }
        .toggle em { display: block; font-style: normal; font-size: var(--text-xs); margin-top: 1px; }
        .toggle span { flex: 1; }
        .field code { font-family: var(--font-mono); font-size: 11px; padding: 1px 4px; border-radius: 4px; background: var(--bg-raised); color: var(--cyan); }
        .actions { display: flex; gap: var(--s3); margin-top: var(--s6); padding-top: var(--s4); border-top: 1px solid var(--line-faint); }
        .grow { flex: 1; }
        .orphans { list-style: none; display: flex; flex-direction: column; gap: var(--s2); }
        .orphans li { display: flex; align-items: center; gap: var(--s3); padding: var(--s2) var(--s3); border: 1px solid var(--line); border-radius: var(--r-sm); font-size: var(--text-xs); }
        .orphans span:first-child { flex: 1; overflow: hidden; text-overflow: ellipsis; }
        .note { margin-top: var(--s4); padding: var(--s3); border-radius: var(--r-sm); background: var(--green-dim); color: var(--green); font-size: var(--text-sm); }
        .about { display: grid; grid-template-columns: 140px 1fr; gap: var(--s2) var(--s4); margin: var(--s5) 0; font-size: var(--text-sm); }
        .about dt { color: var(--text-faint); }
        .errors { margin-top: var(--s4); padding: var(--s3); border-radius: var(--r-sm); background: var(--red-dim); color: var(--red); font-size: var(--text-sm); list-style: none; }
        .scroll { overflow-y: auto; }
        .row { display: flex; gap: var(--s3); }
        .cli-card { border: 1px solid var(--line); border-radius: var(--r-sm); padding: var(--s4); margin-bottom: var(--s4); }
        .cli-card h3 { margin: 0 0 var(--s3); }
        .cli-state { font-size: var(--text-xs); padding: 1px 6px; border-radius: 4px; }
        .cli-state.ok { background: var(--green-dim); color: var(--green); }
        .cli-state.off { background: var(--red-dim); color: var(--red); }
        .caveats { list-style: none; margin: 0 0 var(--s3); padding: 0; display: flex; flex-direction: column; gap: var(--s1); }
        .caveats li { font-size: var(--text-xs); color: var(--text-faint); padding-left: var(--s3); border-left: 2px solid var(--line); }
      `}</style>
    </>
  );
}
