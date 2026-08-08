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
import { Field, Select, TextInput, Textarea } from '../components/ui/Field.js';
import { Button } from '../components/ui/Button.js';
import { useDebouncedSave } from '../hooks/useDebouncedSave.js';
import styles from './SettingsScreen.module.css';

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
    <section className={styles.setSection}>
      <div className={styles.setSectionLabel}>
        <h2>{label}</h2>
        {note && <p>{note}</p>}
      </div>
      <div className={styles.setBody}>{children}</div>
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
    <label className={styles.setToggle}>
      <input
        type="checkbox"
        className={styles.setSwitch}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={styles.setToggleText}>
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
  // `requirePersisted` stops a save re-creating a project that was just removed;
  // `cancel` is called from removeProject for the same reason. The hook also
  // flushes on unmount so a pending edit is not lost when leaving Settings.
  const { cancel: cancelProjectSave } = useDebouncedSave<ProjectDef>({
    value: projectDraft,
    delay: 400,
    requirePersisted: true,
    compare: () => projectRef.current,
    save: (cur) => api.projects.save(cur),
    onSuccess: async (cur) => {
      setErrors([]);
      await refreshAll();
      void api.projects.check(cur.id).then(setProjectChecks);
    },
    onIssues: (issues) => setErrors(issues.map((i) => `${i.where}: ${i.message}`)),
    onError: (e) => setErrors([(e as Error).message]),
  });

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
    // A queued save for this project would re-create it moments after the remove.
    cancelProjectSave();
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

  if (!settings) return <div className={styles.setScreen} />;

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
      <div className={styles.setScreen}>
        {/* ── section strip: equal cells spanning the full window width ── */}
        <div className={styles.setStrip} role="tablist" aria-label="Settings sections">
          {PANES.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={pane === p.id}
              className={`${styles.setTab} ${pane === p.id ? styles.on : ''}`}
              onClick={() => setPaneLive(p.id)}
            >
              <span className={styles.setTabLabel}>{p.label}</span>
            </button>
          ))}
        </div>

        <div className={styles.setScroll}>
          <div className={styles.setPage}>
            {pane === 'general' && (
              <>
                <Section label="Identity" note="Attached to every run, so a trace says who asked.">
                  <div className={styles.setFields}>
                    <Field label="Your name">
                      <TextInput
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
                      <span className={styles.hint}>
                        Recorded on every run, so a trace says who asked for it. Saved when you
                        leave the field.
                      </span>
                      {nameHint && <span className={styles.setWarn}>{nameHint}</span>}
                    </Field>
                    <Field
                      label="Default agent CLI"
                      hint="What a new agent starts on, and what command detection uses. Each agent can choose its own in the Roster."
                    >
                      <div className={styles.cliPicker}>
                        <Select
                          value={settings.defaultCli}
                          onChange={(e) => void set({ defaultCli: e.target.value as CliVendor })}
                        >
                          {clis.map((cli) => (
                            <option key={cli.id} value={cli.id}>
                              {cli.label}
                            </option>
                          ))}
                        </Select>
                        <CliIcon vendor={settings.defaultCli} size={18} />
                      </div>
                    </Field>
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
                  <div className={styles.setToggles}>
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
                  <div className={styles.setSpread}>
                    <Field>
                      <strong className={styles.setStrong}>
                        Foundry {version ? `v${version}` : ''}
                      </strong>
                      {updateStatus.message && (
                        <span className={styles.hint}>{updateStatus.message}</span>
                      )}
                      {updateStatus.stage === 'available' && updateStatus.version && (
                        <span className={styles.hint}>
                          Foundry v{updateStatus.version} is available, download it when ready.
                        </span>
                      )}
                    </Field>
                    <span
                      className={`${styles.setPill} ${updateTone === 'ok' ? styles.ok : updateTone === 'bad' ? styles.bad : styles.info}`}
                    >
                      {updateText}
                    </span>
                  </div>
                  {(updateStatus.stage === 'downloading' || updateStatus.stage === 'ready') && (
                    <div
                      className={styles.setProgress}
                      aria-label={
                        updateStatus.stage === 'downloading'
                          ? `Downloading ${Math.round(updateStatus.percent ?? 0)} percent`
                          : 'Update ready to install'
                      }
                    >
                      <div className={styles.setTrack}>
                        <div
                          className={`${styles.setFill} ${updateStatus.stage === 'ready' ? styles.ready : ''}`}
                          style={{
                            width: `${updateStatus.stage === 'ready' ? 100 : Math.max(0, Math.min(100, updateStatus.percent ?? 0))}%`,
                          }}
                        />
                      </div>
                      <span className={`mono faint ${styles.setPct}`}>
                        {updateStatus.stage === 'ready'
                          ? 'ready'
                          : `${Math.round(updateStatus.percent ?? 0)}%`}
                      </span>
                    </div>
                  )}
                  <div className={styles.setSubrow}>
                    {updateStatus.stage === 'ready' ? (
                      <Button variant="primary" size="sm" onClick={() => void installUpdate()}>
                        Restart to install
                      </Button>
                    ) : updateStatus.stage === 'available' ? (
                      <Button variant="primary" size="sm" onClick={() => void downloadUpdate()}>
                        Download update
                      </Button>
                    ) : updateStatus.stage === 'downloading' ? (
                      <span className={styles.hint}>
                        Installing after the download finishes, you will be asked to restart.
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        disabled={updateStatus.stage === 'checking'}
                        onClick={() => void checkForUpdates()}
                      >
                        {updateStatus.stage === 'checking'
                          ? 'Checking for updates…'
                          : updateStatus.stage === 'error'
                            ? 'Try again'
                            : 'Check for updates'}
                      </Button>
                    )}
                  </div>
                </Section>

                <Section
                  label="Application"
                  note="Restart after changing settings or installing an update."
                >
                  <p className={styles.hint}>
                    Restart Foundry after changing settings or installing an update.
                  </p>
                  <div className={styles.setBtnrow}>
                    <Button size="sm" onClick={() => void relaunchApp()}>
                      Relaunch Foundry
                    </Button>
                    <Button size="sm" onClick={() => void quitApp()}>
                      Quit Foundry
                    </Button>
                  </div>
                </Section>
              </>
            )}
            {pane === 'clis' && (
              <>
                <Section label="Agent CLIs" note="One per agent phase.">
                  <p className={styles.setLead}>
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
                      <div className={styles.setCliHead}>
                        <CliIcon vendor={cli.id} size={18} />
                        <h3>{cli.label}</h3>
                        {found && (
                          <span
                            className={`${styles.setPill} ${found.ok ? styles.ok : styles.bad}`}
                          >
                            {found.ok ? 'found' : 'not found'}
                          </span>
                        )}
                      </div>
                      <div className={styles.setFields}>
                        <Field label="Executable">
                          <TextInput
                            mono
                            value={config.path}
                            onChange={(e) => void setCli(cli.id, { path: e.target.value })}
                          />
                          {found && <span className={styles.hint}>{found.detail}</span>}
                        </Field>
                        <Field
                          label="Extra arguments"
                          hint="For an option this release does not model yet. Passed through verbatim."
                        >
                          <TextInput
                            mono
                            value={config.extraArgs.join(' ')}
                            placeholder="appended to every turn"
                            onChange={(e) =>
                              void setCli(cli.id, {
                                extraArgs: e.target.value.split(/\s+/).filter(Boolean),
                              })
                            }
                          />
                        </Field>
                      </div>
                      {cli.caveats.length > 0 && (
                        <ul className={styles.caveats}>
                          {cli.caveats.map((caveat) => (
                            <li key={caveat}>{caveat}</li>
                          ))}
                        </ul>
                      )}
                      <div>
                        <Button size="sm" onClick={() => void api.app.openExternal(cli.docsUrl)}>
                          Install docs
                        </Button>
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
                  <div className={styles.setSpread}>
                    <p className={styles.setLead}>
                      Used by any agent set to inherit. A per-agent choice always wins.
                    </p>
                    <Button size="sm" onClick={() => void refreshModels()}>
                      Refresh models
                    </Button>
                  </div>
                </Section>
                <Section label="Model" note="Offered by whichever CLI is the default.">
                  <div className={styles.setFields}>
                    <Field label="Default model">
                      <ModelPicker
                        value={settings.defaultModel}
                        models={models}
                        emptyHint={`No models from ${settings.defaultCli}. Install and sign in under Agent CLIs, then refresh.`}
                        onChange={(v) => void set({ defaultModel: v })}
                        onRefresh={() => void refreshModels()}
                      />
                    </Field>
                    <Field label="Default reasoning effort">
                      <Select
                        value={settings.defaultReasoningEffort}
                        onChange={(e) =>
                          void set({ defaultReasoningEffort: e.target.value as never })
                        }
                      >
                        <option value="off">Off</option>
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                      </Select>
                    </Field>
                  </div>
                </Section>
                <Section label="Autonomy" note="What an agent stops to ask about.">
                  <Field
                    label="Autonomy"
                    hint="Foundry always reverts writes outside an agent's boundary, at every level. Autonomy only decides what it stops to ask about first."
                  >
                    <Select
                      value={settings.defaultAutonomy}
                      onChange={(e) => void set({ defaultAutonomy: e.target.value as never })}
                    >
                      <option value="low">Low: confirm every write and command</option>
                      <option value="medium">
                        Medium: writes inside the boundary run unattended
                      </option>
                      <option value="high">High: run unattended within the worktree</option>
                    </Select>
                  </Field>
                </Section>
                <Section label="Limits" note="How hard Foundry tries before a phase fails.">
                  <div className={styles.setFields}>
                    <Field
                      label="Envelope retries"
                      hint="Correction messages sent when a reply will not parse."
                    >
                      <TextInput
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
                    </Field>
                    <Field
                      label="Gate retries"
                      hint="Attempts to fix a gate violation before the phase fails."
                    >
                      <TextInput
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
                    </Field>
                    <Field label="Turn timeout (minutes)">
                      <TextInput
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
                    </Field>
                    <Field
                      label="Trace poll cadence (ms)"
                      hint="How often a live run's view refreshes."
                    >
                      <TextInput
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
                    </Field>
                  </div>
                </Section>
              </>
            )}
            {pane === 'project' && (
              <>
                {projectDraft ? (
                  <>
                    <Section label="Project" note="Where Foundry runs, and what it may touch.">
                      <Field
                        label="Project name"
                        hint="Just for you — rename freely. The path is where Foundry runs."
                      >
                        <TextInput
                          value={projectDraft.name}
                          onChange={(e) =>
                            setProjectDraft({ ...projectDraft, name: e.target.value })
                          }
                          placeholder="My project"
                        />
                      </Field>
                      <div className={styles.setSubrow}>
                        <span className={`mono faint ${styles.setPath}`}>{projectDraft.path}</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void api.projects.reveal(projectDraft.path)}
                        >
                          Reveal in Finder
                        </Button>
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
                      <div className={styles.setFields}>
                        <Field label="Base ref" hint="Every run branches from here.">
                          <TextInput
                            mono
                            value={projectDraft.baseRef}
                            onChange={(e) =>
                              setProjectDraft({ ...projectDraft, baseRef: e.target.value })
                            }
                          />
                        </Field>
                        <Field label="Merge policy">
                          <Select
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
                          </Select>
                        </Field>
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
                      <Field
                        label="Protected paths"
                        hint={
                          <>
                            One pattern per line. No agent may write these, whatever its own
                            boundary says. <code>.git/</code>, CI config, and lockfiles are always
                            protected.
                          </>
                        }
                      >
                        <Textarea
                          rows={3}
                          value={projectDraft.protectedPaths.join('\n')}
                          onChange={(e) =>
                            setProjectDraft({
                              ...projectDraft,
                              protectedPaths: e.target.value.split('\n').filter(Boolean),
                            })
                          }
                        />
                      </Field>
                      <Field
                        label="Auto-approved commands"
                        hint="Commands agents may run without stopping to ask. Prefix matching."
                      >
                        <Textarea
                          rows={3}
                          value={projectDraft.allowedCommands.join('\n')}
                          onChange={(e) =>
                            setProjectDraft({
                              ...projectDraft,
                              allowedCommands: e.target.value.split('\n').filter(Boolean),
                            })
                          }
                        />
                      </Field>
                    </Section>
                    <Section label="Scope" note="Keep configuration local to this project.">
                      <div className={styles.setFields}>
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
                    <div className={styles.setFoot}>
                      <Button variant="danger" onClick={() => void removeProject()}>
                        Remove project
                      </Button>
                      <span className={styles.setAutosave}>Changes save automatically</span>
                    </div>
                  </>
                ) : (
                  <div className={styles.setEmpty}>
                    <p className="faint">No project selected. Add a git repository to configure.</p>
                    <Button variant="primary" onClick={() => void addProject()}>
                      Add a project…
                    </Button>
                  </div>
                )}
              </>
            )}
            {pane === 'maintenance' && (
              <>
                <Section label="Retention" note="Nothing is deleted behind your back.">
                  <Field
                    label="Keep run history for"
                    className={styles.setNarrow}
                    hint="Applies when you press the button below. Nothing is deleted behind your back."
                  >
                    <Select
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
                    </Select>
                  </Field>
                  <div className={styles.setSubrow}>
                    <div className={styles.setBtnrow}>
                      <Button disabled={maintenanceBusy} onClick={() => void applyRetention()}>
                        {maintenanceBusy ? 'Working…' : 'Apply retention now'}
                      </Button>
                      <Button disabled={maintenanceBusy} onClick={() => void compact()}>
                        {maintenanceBusy ? 'Working…' : 'Compact trace databases'}
                      </Button>
                    </div>
                  </div>
                </Section>
                <Section label="Leftover worktrees" note="Left behind by a crashed or killed run.">
                  <p className={styles.hint}>
                    A worktree left behind by a crashed or killed run. Removing one deletes its
                    branch and any uncommitted work in it.
                  </p>
                  {orphans.length ? (
                    <ul className={styles.setOrphans}>
                      {orphans.map((orphan) => (
                        <li key={orphan.path}>
                          <span className={`mono ${styles.path}`}>{orphan.path}</span>
                          <span className="mono faint">{orphan.branch}</span>
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => void removeOrphan(orphan)}
                          >
                            Remove
                          </Button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="faint">None found.</p>
                  )}
                  {maintenanceNote && (
                    <p className={styles.setNote}>
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
                  <p className={styles.setLead}>
                    A software factory you can watch. Pipelines are data, agents are configuration,
                    and every phase leaves evidence you can read.
                  </p>
                </Section>
                <Section label="Build" note="What this copy of Foundry is running.">
                  <dl className={styles.setFacts}>
                    <div className={styles.setFact}>
                      <dt>Version</dt>
                      <dd className="mono">{version}</dd>
                    </div>
                    <div className={styles.setFact}>
                      <dt>Agent harness</dt>
                      <dd className="mono">droid CLI over stream JSON-RPC</dd>
                    </div>
                    <div className={styles.setFact}>
                      <dt>Projects</dt>
                      <dd className="mono">{projects.length}</dd>
                    </div>
                  </dl>
                </Section>
                <Section label="Elsewhere" note="Docs and the cinematic intro.">
                  <div className={styles.setBtnrow}>
                    <Button
                      size="sm"
                      onClick={() =>
                        void api.app.openExternal('https://docs.factory.ai/droid-exec/overview')
                      }
                    >
                      droid CLI documentation
                    </Button>
                    <Button size="sm" onClick={() => void replayIntro()}>
                      Replay intro
                    </Button>
                  </div>
                  <p className={styles.hint}>
                    Replay intro walks the cinematic onboarding again: agents, CLIs, environment
                    checks, and your first project.
                  </p>
                </Section>
              </>
            )}
            {errors.length > 0 && (
              <ul className={styles.setErrors} role="alert">
                {errors.map((error, i) => (
                  <li key={i}>{error}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
