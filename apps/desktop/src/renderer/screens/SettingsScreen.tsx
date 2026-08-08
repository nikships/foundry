import { useEffect, useRef, useState } from 'react';
import type {
  CliDescriptor,
  CliVendor,
  DoctorCheck,
  ModelInfo,
  OrphanWorktree,
  ProjectDef,
  UpdateStatus,
} from '@shared/types.js';
import { api, plain } from '../api.js';
import { useApp } from '../stores/app.js';
import ModelPicker from '../components/ModelPicker.js';
import { CliIcon } from '../components/BrandIcon.js';
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

/**
 * Number inputs fire on every keystroke. Clearing a field yields `Number('') === 0`
 * in some browsers and `NaN` for partial junk; neither should be written into
 * settings and then round-tripped back into the controlled value.
 */
function readBoundedInt(
  raw: string,
  opts: { min: number; max: number; emptyAs?: number },
): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return opts.emptyAs ?? null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return Math.min(opts.max, Math.max(opts.min, Math.round(n)));
}

/** Gutter-labelled section: mono micro-label left, fields right, hairlines between. */
function Section({
  label,
  note,
  children,
}: {
  label: string;
  note?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="set-section">
      <div className="set-section-label">
        <h2>{label}</h2>
        {note && <p>{note}</p>}
      </div>
      <div className="set-body">{children}</div>
    </section>
  );
}

/** Checkbox styled as a switch, so the whole row stays click-to-toggle. */
function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
}): React.JSX.Element {
  return (
    <label className="set-toggle">
      <input
        type="checkbox"
        className="set-switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="set-toggle-text">
        {label}
        {hint && <em>{hint}</em>}
      </span>
    </label>
  );
}

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
  const [nameDraft, setNameDraft] = useState('');
  const [nameHint, setNameHint] = useState('');
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);

  useEffect(() => {
    setPane((initialPane as Pane) ?? 'general');
  }, [initialPane]);

  useEffect(() => {
    void Promise.all([
      api.catalog.clis(),
      api.doctor.run(),
      api.app.version(),
      api.updater.getStatus(),
    ]).then(([l, c, v, u]) => {
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

  const projectSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projectDraftRef = useRef<ProjectDef | null>(null);
  projectDraftRef.current = projectDraft;
  const projectRef = useRef<ProjectDef | null>(null);
  projectRef.current = project;
  const lastProjectSyncedIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!project) {
      setProjectDraft(null);
      setProjectChecks([]);
      lastProjectSyncedIdRef.current = null;
      return;
    }
    if (lastProjectSyncedIdRef.current !== project.id) {
      setProjectDraft(plain({ ...project }));
      lastProjectSyncedIdRef.current = project.id;
      void api.projects.check(project.id).then(setProjectChecks);
      return;
    }
    void api.projects.check(project.id).then(setProjectChecks);
  }, [project]);

  // Live auto-save for the Project pane. Visual state is the source of truth,
  // no Save button. Debounced so typing does not spam disk and refreshAll.
  useEffect(() => {
    if (!projectDraft) return;
    const persisted = projectRef.current;
    if (!persisted) return;
    if (JSON.stringify(projectDraft) === JSON.stringify(persisted)) return;
    if (projectSaveTimer.current) clearTimeout(projectSaveTimer.current);
    projectSaveTimer.current = setTimeout(() => {
      const cur = projectDraftRef.current;
      const base = projectRef.current;
      if (!cur || !base) return;
      if (JSON.stringify(cur) === JSON.stringify(base)) return;
      void (async () => {
        try {
          const result = await api.projects.save(cur);
          if (result.ok) {
            setErrors([]);
            await refreshAll();
            void api.projects.check(cur.id).then(setProjectChecks);
          } else {
            setErrors(result.issues.map((i) => `${i.where}: ${i.message}`));
          }
        } catch (e) {
          setErrors([(e as Error).message]);
        }
      })();
    }, 400);
    return () => {
      if (projectSaveTimer.current) clearTimeout(projectSaveTimer.current);
    };
  }, [projectDraft, project, refreshAll]);

  // Local draft so clearing the field for a rewrite does not POST an empty
  // engineerName that Zod rejects and paints a sticky settings error.
  useEffect(() => {
    setNameDraft(settings?.engineerName ?? '');
    setNameHint('');
  }, [settings?.engineerName]);

  const setPaneLive = (next: Pane): void => setPane(next);
  const set = async (patch: Parameters<typeof patchSettings>[0]): Promise<void> => {
    // Always replace the banner: a successful patch must clear a prior failure.
    setErrors(await patchSettings(patch));
  };
  const setInt = async (
    raw: string,
    bounds: { min: number; max: number; emptyAs?: number },
    apply: (value: number) => Parameters<typeof patchSettings>[0],
  ): Promise<void> => {
    const value = readBoundedInt(raw, bounds);
    if (value == null) return;
    await set(apply(value));
  };
  const runAppAction = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action();
      setErrors([]);
    } catch (e) {
      setErrors([(e as Error).message]);
    }
  };
  const checkForUpdates = async (): Promise<void> => {
    await runAppAction(async () => setUpdateStatus(await api.updater.check()));
  };
  const downloadUpdate = async (): Promise<void> => {
    await runAppAction(async () => setUpdateStatus(await api.updater.download()));
  };
  const installUpdate = async (): Promise<void> => {
    await runAppAction(() => api.updater.quitAndInstall());
  };
  const quitApp = async (): Promise<void> => {
    await runAppAction(() => api.app.quit());
  };
  const relaunchApp = async (): Promise<void> => {
    await runAppAction(() => api.app.relaunch());
  };
  const removeProject = async (): Promise<void> => {
    if (!project) return;
    if (
      !window.confirm(
        `Remove project “${project.name}” from Foundry? The git repo on disk is not deleted.`,
      )
    ) {
      return;
    }
    try {
      await api.projects.remove(project.id);
      setErrors([]);
      await refreshAll();
    } catch (e) {
      setErrors([(e as Error).message]);
    }
  };
  const replayIntro = async (): Promise<void> => {
    await runAppAction(async () => {
      await api.settings.patch({ onboarded: false });
      await refreshAll();
    });
  };
  const addProject = async (): Promise<void> => {
    await runAppAction(async () => {
      await api.projects.add();
      await refreshAll();
    });
  };
  const refreshModels = async (): Promise<void> => {
    if (!settings) return;
    setModels(await api.catalog.models(settings.defaultCli, true));
  };
  const setCli = async (
    vendor: CliVendor,
    patch: { path?: string; extraArgs?: string[] },
  ): Promise<void> => {
    if (!settings) return;
    await set({ clis: { ...settings.clis, [vendor]: { ...settings.clis[vendor], ...patch } } });
  };
  const loadOrphans = async (): Promise<void> =>
    setOrphans(await api.maintenance.orphanWorktrees());
  const removeOrphan = async (orphan: OrphanWorktree): Promise<void> => {
    if (
      !window.confirm(
        `Remove leftover worktree at ${orphan.path}? Its branch and any uncommitted work in it are deleted.`,
      )
    ) {
      return;
    }
    try {
      const result = await api.maintenance.removeWorktree(orphan.projectId, orphan.path);
      setMaintenanceNote(result.detail);
      if (result.ok === false) setErrors([result.detail]);
      else setErrors([]);
      await loadOrphans();
    } catch (e) {
      setErrors([(e as Error).message]);
    }
  };
  const commitName = async (): Promise<void> => {
    const next = nameDraft.trim();
    if (!next) {
      setNameHint('Name cannot be empty. Recorded on every run.');
      setNameDraft(settings?.engineerName ?? '');
      return;
    }
    if (next === settings?.engineerName) {
      setNameHint('');
      return;
    }
    if (next.length > 80) {
      setNameHint('Keep it under 80 characters.');
      return;
    }
    setNameHint('');
    await set({ engineerName: next });
  };

  const applyRetention = async (): Promise<void> => {
    if (maintenanceBusy) return;
    const days = settings?.retentionDays;
    if (days == null) {
      setErrors(['Set a retention window before applying. Forever means nothing is deleted.']);
      return;
    }
    if (
      !window.confirm(
        `Apply retention now? This permanently deletes run history older than ${days} day${days === 1 ? '' : 's'}. Trace data cannot be restored.`,
      )
    ) {
      return;
    }
    setMaintenanceBusy(true);
    try {
      const report = await api.maintenance.applyRetention();
      setMaintenanceNote(
        `Deleted ${report.runsDeleted} run${report.runsDeleted === 1 ? '' : 's'}.`,
      );
      setErrors([]);
    } catch (e) {
      setErrors([(e as Error).message]);
    } finally {
      setMaintenanceBusy(false);
    }
  };
  const compact = async (): Promise<void> => {
    if (maintenanceBusy) return;
    if (
      !window.confirm(
        'Compact trace databases now? This rewrites SQLite files and can take a moment; leave Foundry open until it finishes.',
      )
    ) {
      return;
    }
    setMaintenanceBusy(true);
    try {
      await api.maintenance.compact();
      setMaintenanceNote('Trace databases compacted.');
      setErrors([]);
    } catch (e) {
      setErrors([(e as Error).message]);
    } finally {
      setMaintenanceBusy(false);
    }
  };

  useEffect(() => {
    if (pane === 'maintenance') void loadOrphans();
  }, [pane]);

  if (!settings) return <div className="set-screen" />;

  const updateTone =
    updateStatus.stage === 'error'
      ? 'bad'
      : updateStatus.stage === 'downloading' || updateStatus.stage === 'checking'
        ? 'info'
        : 'ok';
  const updateText =
    updateStatus.stage === 'idle'
      ? 'up to date'
      : updateStatus.stage === 'downloading'
        ? `downloading ${Math.round(updateStatus.percent ?? 0)}%`
        : updateStatus.stage;

  return (
    <>
      <div className="set-screen">
        {/* ── section strip: equal cells spanning the full window width ── */}
        <div className="set-strip" role="tablist" aria-label="Settings sections">
          {PANES.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={pane === p.id}
              className={`set-tab ${pane === p.id ? 'on' : ''}`}
              onClick={() => setPaneLive(p.id)}
            >
              <span className="set-tab-label">{p.label}</span>
            </button>
          ))}
        </div>

        <div className="set-scroll">
          <div className="set-page">
            {pane === 'general' && (
              <>
                <Section label="Identity" note="Attached to every run, so a trace says who asked.">
                  <div className="set-fields">
                    <div className="field">
                      <label>Your name</label>
                      <input
                        className="input"
                        value={nameDraft}
                        onChange={(e) => {
                          setNameDraft(e.target.value);
                          setNameHint('');
                        }}
                        onBlur={() => void commitName()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            (e.target as HTMLInputElement).blur();
                          }
                        }}
                      />
                      <span className="hint">
                        Recorded on every run, so a trace says who asked for it. Saved when you
                        leave the field.
                      </span>
                      {nameHint && <span className="set-warn">{nameHint}</span>}
                    </div>
                    <div className="field">
                      <label>Default agent CLI</label>
                      <div className="cli-picker">
                        <select
                          className="select"
                          value={settings.defaultCli}
                          onChange={(e) => void set({ defaultCli: e.target.value as CliVendor })}
                        >
                          {clis.map((cli) => (
                            <option key={cli.id} value={cli.id}>
                              {cli.label}
                            </option>
                          ))}
                        </select>
                        <CliIcon vendor={settings.defaultCli} size={18} />
                      </div>
                      <span className="hint">
                        What a new agent starts on, and what command detection uses. Each agent can
                        choose its own in the Roster.
                      </span>
                    </div>
                  </div>
                </Section>

                <Section label="Checks" note="What Foundry found on this machine at launch.">
                  <DoctorList
                    checks={checks}
                    title="Environment checks"
                    onRecheck={() => void api.doctor.run().then(setChecks)}
                    onOpenSettings={(next) => setPaneLive(next as Pane)}
                  />
                </Section>

                <Section label="Notifications" note="Only the moments that need you.">
                  <div className="set-toggles">
                    {(Object.keys(NOTIFY_LABELS) as Array<keyof typeof NOTIFY_LABELS>).map(
                      (key) => (
                        <Toggle
                          key={key}
                          label={NOTIFY_LABELS[key]}
                          checked={settings.notifications[key]}
                          onChange={(value) =>
                            void set({
                              notifications: { ...settings.notifications, [key]: value },
                            })
                          }
                        />
                      ),
                    )}
                    <Toggle
                      label="Show the number of live runs on the dock icon"
                      checked={settings.dockBadge}
                      onChange={(value) => void set({ dockBadge: value })}
                    />
                  </div>
                </Section>

                <Section label="Software updates" note="Foundry checks only when you ask it to.">
                  <div className="set-spread">
                    <div className="field">
                      <strong className="set-strong">Foundry {version ? `v${version}` : ''}</strong>
                      {updateStatus.message && <span className="hint">{updateStatus.message}</span>}
                      {updateStatus.stage === 'available' && updateStatus.version && (
                        <span className="hint">
                          Foundry v{updateStatus.version} is available, download it when ready.
                        </span>
                      )}
                    </div>
                    <span className={`set-pill ${updateTone}`}>{updateText}</span>
                  </div>
                  {(updateStatus.stage === 'downloading' || updateStatus.stage === 'ready') && (
                    <div
                      className="set-progress"
                      aria-label={
                        updateStatus.stage === 'downloading'
                          ? `Downloading ${Math.round(updateStatus.percent ?? 0)} percent`
                          : 'Update ready to install'
                      }
                    >
                      <div className="set-track">
                        <div
                          className={`set-fill ${updateStatus.stage === 'ready' ? 'ready' : ''}`}
                          style={{
                            width: `${updateStatus.stage === 'ready' ? 100 : Math.max(0, Math.min(100, updateStatus.percent ?? 0))}%`,
                          }}
                        />
                      </div>
                      <span className="mono faint set-pct">
                        {updateStatus.stage === 'ready'
                          ? 'ready'
                          : `${Math.round(updateStatus.percent ?? 0)}%`}
                      </span>
                    </div>
                  )}
                  <div className="set-subrow">
                    {updateStatus.stage === 'ready' ? (
                      <button className="btn primary sm" onClick={() => void installUpdate()}>
                        Restart to install
                      </button>
                    ) : updateStatus.stage === 'available' ? (
                      <button className="btn primary sm" onClick={() => void downloadUpdate()}>
                        Download update
                      </button>
                    ) : updateStatus.stage === 'downloading' ? (
                      <span className="hint">
                        Installing after the download finishes, you will be asked to restart.
                      </span>
                    ) : (
                      <button
                        className="btn sm"
                        disabled={updateStatus.stage === 'checking'}
                        onClick={() => void checkForUpdates()}
                      >
                        {updateStatus.stage === 'checking'
                          ? 'Checking for updates…'
                          : updateStatus.stage === 'error'
                            ? 'Try again'
                            : 'Check for updates'}
                      </button>
                    )}
                  </div>
                </Section>

                <Section
                  label="Application"
                  note="Restart after changing settings or installing an update."
                >
                  <p className="hint">
                    Restart Foundry after changing settings or installing an update.
                  </p>
                  <div className="set-btnrow">
                    <button className="btn sm" onClick={() => void relaunchApp()}>
                      Relaunch Foundry
                    </button>
                    <button className="btn sm" onClick={() => void quitApp()}>
                      Quit Foundry
                    </button>
                  </div>
                </Section>
              </>
            )}
            {pane === 'clis' && (
              <>
                <Section label="Agent CLIs" note="One per agent phase.">
                  <p className="set-lead">
                    Foundry drives one of these per agent phase. A path is filled in from your PATH
                    at first launch; correct it here if you keep a CLI somewhere unusual.
                  </p>
                </Section>
                {clis.map((cli) => {
                  const config = settings.clis[cli.id];
                  const found = checks.find((c) => c.id === `cli:${cli.id}`);
                  return (
                    <Section
                      key={cli.id}
                      label={cli.label}
                      note={
                        found
                          ? found.ok
                            ? 'On PATH, ready to drive.'
                            : 'Not where Foundry expected it.'
                          : 'Checking…'
                      }
                    >
                      <div className="set-cli-head">
                        <CliIcon vendor={cli.id} size={18} />
                        <h3>{cli.label}</h3>
                        {found && (
                          <span className={`set-pill ${found.ok ? 'ok' : 'bad'}`}>
                            {found.ok ? 'found' : 'not found'}
                          </span>
                        )}
                      </div>
                      <div className="set-fields">
                        <div className="field">
                          <label>Executable</label>
                          <input
                            className="input mono"
                            value={config.path}
                            onChange={(e) => void setCli(cli.id, { path: e.target.value })}
                          />
                          {found && <span className="hint">{found.detail}</span>}
                        </div>
                        <div className="field">
                          <label>Extra arguments</label>
                          <input
                            className="input mono"
                            value={config.extraArgs.join(' ')}
                            placeholder="appended to every turn"
                            onChange={(e) =>
                              void setCli(cli.id, {
                                extraArgs: e.target.value.split(/\s+/).filter(Boolean),
                              })
                            }
                          />
                          <span className="hint">
                            For an option this release does not model yet. Passed through verbatim.
                          </span>
                        </div>
                      </div>
                      {cli.caveats.length > 0 && (
                        <ul className="caveats">
                          {cli.caveats.map((caveat) => (
                            <li key={caveat}>{caveat}</li>
                          ))}
                        </ul>
                      )}
                      <div>
                        <button
                          className="btn sm"
                          onClick={() => void api.app.openExternal(cli.docsUrl)}
                        >
                          Install docs
                        </button>
                      </div>
                    </Section>
                  );
                })}
                <Section label="Checks" note="Re-run after installing or moving a CLI.">
                  <DoctorList
                    checks={checks}
                    title="Environment checks"
                    onRecheck={() => void api.doctor.run().then(setChecks)}
                    onOpenSettings={(next) => setPaneLive(next as Pane)}
                  />
                </Section>
              </>
            )}
            {pane === 'defaults' && (
              <>
                <Section label="Agent defaults" note="What an agent set to inherit gets.">
                  <div className="set-spread">
                    <p className="set-lead">
                      Used by any agent set to inherit. A per-agent choice always wins.
                    </p>
                    <button className="btn sm" onClick={() => void refreshModels()}>
                      Refresh models
                    </button>
                  </div>
                </Section>
                <Section label="Model" note="Offered by whichever CLI is the default.">
                  <div className="set-fields">
                    <div className="field">
                      <label>Default model</label>
                      <ModelPicker
                        value={settings.defaultModel}
                        models={models}
                        emptyHint={`No models from ${settings.defaultCli}. Install and sign in under Agent CLIs, then refresh.`}
                        onChange={(v) => void set({ defaultModel: v })}
                        onRefresh={() => void refreshModels()}
                      />
                    </div>
                    <div className="field">
                      <label>Default reasoning effort</label>
                      <select
                        className="select"
                        value={settings.defaultReasoningEffort}
                        onChange={(e) =>
                          void set({ defaultReasoningEffort: e.target.value as never })
                        }
                      >
                        <option value="off">Off</option>
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                      </select>
                    </div>
                  </div>
                </Section>
                <Section label="Autonomy" note="What an agent stops to ask about.">
                  <div className="field">
                    <label>Autonomy</label>
                    <select
                      className="select"
                      value={settings.defaultAutonomy}
                      onChange={(e) => void set({ defaultAutonomy: e.target.value as never })}
                    >
                      <option value="low">Low: confirm every write and command</option>
                      <option value="medium">
                        Medium: writes inside the boundary run unattended
                      </option>
                      <option value="high">High: run unattended within the worktree</option>
                    </select>
                    <span className="hint">
                      Foundry always reverts writes outside an agent's boundary, at every level.
                      Autonomy only decides what it stops to ask about first.
                    </span>
                  </div>
                </Section>
                <Section label="Limits" note="How hard Foundry tries before a phase fails.">
                  <div className="set-fields">
                    <div className="field">
                      <label>Envelope retries</label>
                      <input
                        className="input"
                        type="number"
                        min={0}
                        max={5}
                        value={settings.envelopeRetries}
                        onChange={(e) =>
                          void setInt(e.target.value, { min: 0, max: 5 }, (envelopeRetries) => ({
                            envelopeRetries,
                          }))
                        }
                      />
                      <span className="hint">
                        Correction messages sent when a reply will not parse.
                      </span>
                    </div>
                    <div className="field">
                      <label>Gate retries</label>
                      <input
                        className="input"
                        type="number"
                        min={0}
                        max={5}
                        value={settings.gateRetries}
                        onChange={(e) =>
                          void setInt(e.target.value, { min: 0, max: 5 }, (gateRetries) => ({
                            gateRetries,
                          }))
                        }
                      />
                      <span className="hint">
                        Attempts to fix a gate violation before the phase fails.
                      </span>
                    </div>
                    <div className="field">
                      <label>Turn timeout (minutes)</label>
                      <input
                        className="input"
                        type="number"
                        min={5}
                        max={60}
                        value={Math.round(settings.turnTimeoutMs / 60000)}
                        onChange={(e) =>
                          void setInt(e.target.value, { min: 5, max: 60 }, (minutes) => ({
                            turnTimeoutMs: minutes * 60_000,
                          }))
                        }
                      />
                    </div>
                    <div className="field">
                      <label>Trace poll cadence (ms)</label>
                      <input
                        className="input"
                        type="number"
                        min={250}
                        max={2000}
                        step={50}
                        value={settings.pollCadenceMs}
                        onChange={(e) =>
                          void setInt(e.target.value, { min: 250, max: 2000 }, (pollCadenceMs) => ({
                            pollCadenceMs,
                          }))
                        }
                      />
                      <span className="hint">How often a live run's view refreshes.</span>
                    </div>
                  </div>
                </Section>
              </>
            )}
            {pane === 'project' && (
              <>
                {projectDraft ? (
                  <>
                    <Section label="Project" note="Where Foundry runs, and what it may touch.">
                      <div className="field">
                        <label>Project name</label>
                        <input
                          className="input"
                          value={projectDraft.name}
                          onChange={(e) =>
                            setProjectDraft({ ...projectDraft, name: e.target.value })
                          }
                          placeholder="My project"
                        />
                        <span className="hint">
                          Just for you — rename freely. The path is where Foundry runs.
                        </span>
                      </div>
                      <div className="set-subrow">
                        <span className="mono faint set-path">{projectDraft.path}</span>
                        <button
                          className="btn sm ghost"
                          onClick={() => void api.projects.reveal(projectDraft.path)}
                        >
                          Reveal in Finder
                        </button>
                      </div>
                    </Section>
                    <Section label="Checks" note="Run against this repository.">
                      <DoctorList
                        checks={projectChecks}
                        title="Repository checks"
                        onRecheck={() =>
                          void api.projects.check(projectDraft.id).then(setProjectChecks)
                        }
                        onOpenSettings={(next) => setPaneLive(next as Pane)}
                      />
                    </Section>
                    <Section label="Git" note="Every run branches from the base ref.">
                      <div className="set-fields">
                        <div className="field">
                          <label>Base ref</label>
                          <input
                            className="input mono"
                            value={projectDraft.baseRef}
                            onChange={(e) =>
                              setProjectDraft({ ...projectDraft, baseRef: e.target.value })
                            }
                          />
                          <span className="hint">Every run branches from here.</span>
                        </div>
                        <div className="field">
                          <label>Merge policy</label>
                          <select
                            className="select"
                            value={projectDraft.mergePolicy}
                            onChange={(e) =>
                              setProjectDraft({
                                ...projectDraft,
                                mergePolicy: e.target.value as ProjectDef['mergePolicy'],
                              })
                            }
                          >
                            <option value="never">Never merge automatically</option>
                            <option value="on_accept">Merge when a run is accepted</option>
                            <option value="ask">Ask me each time</option>
                          </select>
                        </div>
                      </div>
                    </Section>
                    <Section label="Commands" note="What a pipeline can run, and who detects it.">
                      <ProjectCommands
                        project={projectDraft}
                        onChange={(commands) => setProjectDraft({ ...projectDraft, commands })}
                      />
                    </Section>
                    <Section
                      label="Boundaries"
                      note="Hard limits, whatever an agent's own boundary says."
                    >
                      <div className="field">
                        <label>Protected paths</label>
                        <textarea
                          className="textarea"
                          rows={3}
                          value={projectDraft.protectedPaths.join('\n')}
                          onChange={(e) =>
                            setProjectDraft({
                              ...projectDraft,
                              protectedPaths: e.target.value.split('\n').filter(Boolean),
                            })
                          }
                        />
                        <span className="hint">
                          One pattern per line. No agent may write these, whatever its own boundary
                          says. <code>.git/</code>, CI config, and lockfiles are always protected.
                        </span>
                      </div>
                      <div className="field">
                        <label>Auto-approved commands</label>
                        <textarea
                          className="textarea"
                          rows={3}
                          value={projectDraft.allowedCommands.join('\n')}
                          onChange={(e) =>
                            setProjectDraft({
                              ...projectDraft,
                              allowedCommands: e.target.value.split('\n').filter(Boolean),
                            })
                          }
                        />
                        <span className="hint">
                          Commands agents may run without stopping to ask. Prefix matching.
                        </span>
                      </div>
                    </Section>
                    <Section label="Scope" note="Keep configuration local to this project.">
                      <div className="set-fields">
                        <Toggle
                          label="Use a project-specific roster"
                          hint="Starts as a copy of the global roster; changes stay in this project."
                          checked={projectDraft.ownRoster}
                          onChange={(value) =>
                            setProjectDraft({ ...projectDraft, ownRoster: value })
                          }
                        />
                        <Toggle
                          label="Use project-specific pipelines"
                          hint="Same idea, for pipelines."
                          checked={projectDraft.ownPipelines}
                          onChange={(value) =>
                            setProjectDraft({ ...projectDraft, ownPipelines: value })
                          }
                        />
                      </div>
                    </Section>
                    <div className="set-foot">
                      <button className="btn danger" onClick={() => void removeProject()}>
                        Remove project
                      </button>
                      <span className="set-autosave">Changes save automatically</span>
                    </div>
                  </>
                ) : (
                  <div className="set-empty">
                    <p className="faint">No project selected. Add a git repository to configure.</p>
                    <button className="btn primary" onClick={() => void addProject()}>
                      Add a project…
                    </button>
                  </div>
                )}
              </>
            )}
            {pane === 'maintenance' && (
              <>
                <Section label="Retention" note="Nothing is deleted behind your back.">
                  <div className="field set-narrow">
                    <label>Keep run history for</label>
                    <select
                      className="select"
                      value={settings.retentionDays ?? ''}
                      onChange={(e) =>
                        void set({ retentionDays: e.target.value ? Number(e.target.value) : null })
                      }
                    >
                      <option value="">Forever</option>
                      <option value="7">7 days</option>
                      <option value="30">30 days</option>
                      <option value="90">90 days</option>
                      <option value="365">A year</option>
                    </select>
                    <span className="hint">
                      Applies when you press the button below. Nothing is deleted behind your back.
                    </span>
                  </div>
                  <div className="set-subrow">
                    <div className="set-btnrow">
                      <button
                        className="btn"
                        disabled={maintenanceBusy}
                        onClick={() => void applyRetention()}
                      >
                        {maintenanceBusy ? 'Working…' : 'Apply retention now'}
                      </button>
                      <button
                        className="btn"
                        disabled={maintenanceBusy}
                        onClick={() => void compact()}
                      >
                        {maintenanceBusy ? 'Working…' : 'Compact trace databases'}
                      </button>
                    </div>
                  </div>
                </Section>
                <Section label="Leftover worktrees" note="Left behind by a crashed or killed run.">
                  <p className="hint">
                    A worktree left behind by a crashed or killed run. Removing one deletes its
                    branch and any uncommitted work in it.
                  </p>
                  {orphans.length ? (
                    <ul className="set-orphans">
                      {orphans.map((orphan) => (
                        <li key={orphan.path}>
                          <span className="mono path">{orphan.path}</span>
                          <span className="mono faint">{orphan.branch}</span>
                          <button
                            className="btn sm danger"
                            onClick={() => void removeOrphan(orphan)}
                          >
                            Remove
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="faint">None found.</p>
                  )}
                  {maintenanceNote && (
                    <p className="set-note">
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 14 14"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                      >
                        <path d="M2.5 7.5 5.5 10.5 11.5 3.5" />
                      </svg>
                      {maintenanceNote}
                    </p>
                  )}
                </Section>
              </>
            )}
            {pane === 'about' && (
              <>
                <Section label="Foundry" note="A software factory you can watch.">
                  <p className="set-lead">
                    A software factory you can watch. Pipelines are data, agents are configuration,
                    and every phase leaves evidence you can read.
                  </p>
                </Section>
                <Section label="Build" note="What this copy of Foundry is running.">
                  <dl className="set-facts">
                    <div className="set-fact">
                      <dt>Version</dt>
                      <dd className="mono">{version}</dd>
                    </div>
                    <div className="set-fact">
                      <dt>Agent harness</dt>
                      <dd className="mono">droid CLI over stream JSON-RPC</dd>
                    </div>
                    <div className="set-fact">
                      <dt>Projects</dt>
                      <dd className="mono">{projects.length}</dd>
                    </div>
                  </dl>
                </Section>
                <Section label="Elsewhere" note="Docs and the cinematic intro.">
                  <div className="set-btnrow">
                    <button
                      className="btn sm"
                      onClick={() =>
                        void api.app.openExternal('https://docs.factory.ai/droid-exec/overview')
                      }
                    >
                      droid CLI documentation
                    </button>
                    <button className="btn sm" onClick={() => void replayIntro()}>
                      Replay intro
                    </button>
                  </div>
                  <p className="hint">
                    Replay intro walks the cinematic onboarding again: agents, CLIs, environment
                    checks, and your first project.
                  </p>
                </Section>
              </>
            )}
            {errors.length > 0 && (
              <ul className="set-errors" role="alert">
                {errors.map((error, i) => (
                  <li key={i}>{error}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
      <style>{`
        /* One continuous surface — structure from hairlines + type, never tinted columns. */
        .set-screen { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg-base); }

        /* strip — equal flex cells span the full window width and rescale with it */
        .set-strip {
          flex: none; display: flex; align-items: stretch;
          padding: var(--titlebar-h) var(--s4) 0;
          border-bottom: 1px solid var(--line); background: var(--bg-base);
        }
        .set-tab {
          flex: 1 1 0; min-width: 0; display: flex; justify-content: center;
          padding: var(--s3) var(--s2) 0; border: none; background: transparent;
          font: inherit; font-size: var(--text-sm); color: var(--text-faint);
          cursor: default; white-space: nowrap;
          transition: color var(--fast) var(--ease);
        }
        .set-tab:hover { color: var(--text-dim); }
        .set-tab.on { color: var(--cyan); }
        .set-tab-label {
          position: relative; max-width: 100%;
          overflow: hidden; text-overflow: ellipsis; padding-bottom: var(--s3);
        }
        .set-tab.on .set-tab-label::after {
          content: ''; position: absolute; left: -2px; right: -2px; bottom: -1px;
          height: 2px; background: var(--cyan);
        }

        /* page — single centered column */
        .set-scroll { flex: 1; min-height: 0; overflow-y: auto; }
        .set-page { max-width: 860px; margin: 0 auto; padding: 0 var(--s6) var(--s16); }
        .set-section {
          display: grid; grid-template-columns: 220px minmax(0, 1fr);
          gap: var(--s4) var(--s12);
          border-top: 1px solid var(--line); padding: var(--s8) 0;
        }
        .set-section:first-child { border-top: none; }
        .set-section-label h2 {
          margin: 0; font-family: var(--font-mono); font-size: 10px; font-weight: 500;
          text-transform: uppercase; letter-spacing: 0.22em; color: var(--text-dim);
        }
        .set-section-label p {
          margin: var(--s2) 0 0; font-size: var(--text-xs);
          line-height: var(--leading); color: var(--text-faint); max-width: 24ch;
        }
        .set-body { min-width: 0; display: flex; flex-direction: column; gap: var(--s5); }
        .set-body p { margin: 0; }
        .set-fields { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s5) var(--s8); }
        .two { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s4); }

        .field { display: flex; flex-direction: column; gap: var(--s1); }
        .field label { font-size: var(--text-sm); font-weight: 500; }
        .hint { font-size: var(--text-xs); color: var(--text-faint); line-height: var(--leading); }
        .set-lead { margin: 0; font-size: var(--text-sm); line-height: var(--leading); color: var(--text-dim); max-width: 62ch; }
        .set-spread { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--s4); }
        .set-subrow {
          display: flex; align-items: center; justify-content: space-between; gap: var(--s4);
          padding-top: var(--s4); border-top: 1px solid var(--line-faint);
        }
        .set-btnrow { display: flex; gap: var(--s3); }
        .set-narrow { max-width: 280px; }
        .field code { font-family: var(--font-mono); font-size: 11px; padding: 1px 4px; border-radius: 4px; background: var(--bg-raised); color: var(--cyan); }

        /* switch — a real checkbox under the paint, so rows stay click-to-toggle */
        .set-toggles { display: flex; flex-direction: column; gap: var(--s4); }
        .set-toggle { display: flex; align-items: flex-start; gap: var(--s3); cursor: default; }
        .set-switch {
          appearance: none; -webkit-appearance: none;
          position: relative; flex: none; width: 28px; height: 16px; margin: 2px 0 0; padding: 0;
          border-radius: 999px; border: 1px solid var(--line-strong); background: transparent;
          cursor: default;
          transition: background var(--fast) var(--ease), border-color var(--fast) var(--ease);
        }
        .set-switch::after {
          content: ''; position: absolute; top: 2px; left: 2px; width: 10px; height: 10px;
          border-radius: 999px; background: var(--text-faint);
          transition: left var(--fast) var(--ease), background var(--fast) var(--ease);
        }
        .set-switch:checked { background: var(--cyan); border-color: var(--cyan); }
        .set-switch:checked::after { left: 14px; background: var(--bg-void); }
        .set-toggle-text { min-width: 0; font-size: var(--text-sm); color: var(--text); }
        .set-toggle-text em {
          display: block; font-style: normal; margin-top: 1px;
          font-size: var(--text-xs); color: var(--text-faint); line-height: var(--leading);
        }

        /* status pill */
        .set-pill {
          flex: none; font-family: var(--font-mono); font-size: 10px;
          letter-spacing: 0.08em; text-transform: uppercase;
          padding: 1px 8px; border-radius: 999px;
        }
        .set-pill.ok { color: var(--green); background: var(--green-dim); }
        .set-pill.bad { color: var(--red); background: var(--red-dim); }
        .set-pill.info { color: var(--cyan); background: var(--cyan-dim); }
        .set-pill.plain { color: var(--text-faint); border: 1px solid var(--line); }

        /* cli blocks */
        .set-cli-head { display: flex; align-items: center; gap: var(--s2); }
        .set-cli-head h3 { margin: 0; font-size: var(--text-sm); font-weight: 600; }
        .set-cli-head .set-pill { margin-left: auto; }
        .caveats { list-style: none; display: flex; flex-direction: column; gap: var(--s1); }
        .caveats li { font-size: var(--text-xs); color: var(--text-faint); padding-left: var(--s3); border-left: 2px solid var(--line); }
        .cli-picker { display: flex; align-items: center; gap: var(--s2); }
        .cli-picker .select { flex: 1; }

        .set-warn { font-size: var(--text-xs); color: var(--amber); }

        /* updates */
        .set-strong { display: block; font-size: var(--text-sm); font-weight: 600; }
        .set-progress { display: flex; align-items: center; gap: var(--s3); }
        .set-track { flex: 1; height: 6px; border-radius: 999px; background: var(--bg-void); border: 1px solid var(--line-faint); overflow: hidden; }
        .set-fill { height: 100%; background: var(--cyan); border-radius: 999px; transition: width 220ms var(--ease); }
        .set-fill.ready { background: var(--green); }
        .set-pct { font-size: var(--text-xs); min-width: 44px; text-align: right; }

        /* maintenance */
        .set-orphans { list-style: none; }
        .set-orphans li { display: flex; align-items: center; gap: var(--s4); border-top: 1px solid var(--line-faint); padding: var(--s2) 0; font-size: var(--text-xs); }
        .set-orphans .path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-dim); }
        .set-note { display: flex; align-items: center; gap: var(--s2); font-size: var(--text-xs); color: var(--green); }

        /* about */
        .set-facts { margin: 0; }
        .set-fact { display: flex; align-items: baseline; gap: var(--s6); border-top: 1px solid var(--line-faint); padding: var(--s2) 0; }
        .set-fact dt { width: 140px; flex: none; font-size: var(--text-sm); color: var(--text-faint); }
        .set-fact dd { margin: 0; font-size: var(--text-xs); }

        /* project footer / empty / errors */
        .set-foot { display: flex; align-items: center; justify-content: space-between; gap: var(--s4); border-top: 1px solid var(--line); padding: var(--s6) 0; }
        .set-autosave { font-family: var(--font-mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.18em; color: var(--text-faint); }
        .set-empty { display: flex; flex-direction: column; align-items: flex-start; gap: var(--s3); padding-top: var(--s8); }
        .set-empty p { margin: 0; }
        .set-path { font-size: var(--text-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
        .set-errors { margin: var(--s5) 0 0; padding: var(--s3); border-radius: var(--r-sm); background: var(--red-dim); color: var(--red); font-size: var(--text-sm); list-style: none; }
      `}</style>
    </>
  );
}
