import { useEffect, useRef, useState } from 'react';
import type {
  AppSettings,
  CliDescriptor,
  CliVendor,
  DoctorCheck,
  ModelInfo,
  OrphanWorktree,
  ProjectDef,
  ReadinessInspectResult,
  UpdateStatus,
  UserMcpServer,
} from '@shared/types.js';
import { TERMINAL_APPS } from '@shared/types.js';
import { api, plain } from '../api.js';
import { isKnownPrWriter, prWriterOptions } from '../pr-draft.js';
import { useApp } from '../stores/app.js';
import ModelPicker from '../components/ModelPicker.js';
import { CliIcon } from '../components/BrandIcon.js';
import DoctorList from '../components/DoctorList.js';
import ProjectCommands from '../components/ProjectCommands.js';
import ProjectSetup from '../components/ProjectSetup.js';
import { Field, TextInput, Textarea } from '../components/ui/Field.js';
import { Button } from '../components/ui/Button.js';
import { Dropdown } from '../components/ui/Dropdown.js';
import { useConfirmAction } from '../hooks/useConfirmAction.js';
import { useDebouncedSave } from '../hooks/useDebouncedSave.js';
import { useTablistNav } from '../hooks/useTablistNav.js';
import styles from './SettingsScreen.module.css';

// Envelopes is deliberately absent: it is an authoring surface, not a
// preference, and lives in Design alongside the editors that reference it.
type Pane = 'general' | 'clis' | 'defaults' | 'mcp' | 'project' | 'maintenance' | 'about';

const PANES: { id: Pane; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'clis', label: 'Agent CLI' },
  { id: 'defaults', label: 'Agent defaults' },
  { id: 'mcp', label: 'MCP Servers' },
  { id: 'project', label: 'Project' },
  { id: 'maintenance', label: 'Maintenance' },
  { id: 'about', label: 'About' },
];

/**
 * The compaction threshold is stored as a fraction and shown as a percentage,
 * because "compact at 80%" is what the lane's context meter reads. The band
 * mirrors the settings schema: below it a run compacts more than it works, and
 * at 100% it never compacts before hitting the context wall.
 */
const COMPACTION_PERCENT = { min: 50, max: 95 } as const;

const REWIND_BAND = { min: 0, max: 20 } as const;

const DAEMON_PORT_BAND = { min: 37_600, max: 37_699 } as const;

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
    <section className={styles.settingsSection}>
      <div className={styles.settingsSectionLabel}>
        <p className="eyebrow">
          <span className="index" aria-hidden />
          {label}
        </p>
        {note && <p>{note}</p>}
      </div>
      <div className={styles.settingsBody}>{children}</div>
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
    <label className={styles.settingsToggle}>
      <input
        type="checkbox"
        className={styles.settingsSwitch}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={styles.settingsToggleText}>
        {label}
        {hint && <em>{hint}</em>}
      </span>
    </label>
  );
}

export default function SettingsScreen({
  pane: initialPane,
  onPaneChange,
  onNewProject,
  onOpenReadiness,
}: {
  pane: string;
  /** Keep the shell's `data-settings-pane` marker in sync with tab clicks. */
  onPaneChange?: (pane: string) => void;
  /** Create a repository on GitHub instead of pointing at an existing checkout. */
  onNewProject?: () => void;
  onOpenReadiness?: (projectId: string) => void;
}): React.JSX.Element {
  const { settings, project, projects, agents, refreshAll, patchSettings, selectProject } =
    useApp();
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
  const [readiness, setReadiness] = useState<ReadinessInspectResult | null>(null);
  const [maintenanceNote, setMaintenanceNote] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  const [nameHint, setNameHint] = useState('');
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [apiKeyHint, setApiKeyHint] = useState('');
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
      setReadiness(null);
      lastProjectSyncedIdRef.current = null;
      return;
    }
    if (lastProjectSyncedIdRef.current !== project.id) {
      setProjectDraft(plain({ ...project }));
      lastProjectSyncedIdRef.current = project.id;
      void api.projects.check(project.id).then(setProjectChecks);
      void api.readiness.inspect(project.id).then(setReadiness);
      return;
    }
    void api.projects.check(project.id).then(setProjectChecks);
    void api.readiness.inspect(project.id).then(setReadiness);
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

  useEffect(() => {
    setApiKeyDraft(settings?.factoryApiKey ?? '');
    setApiKeyHint('');
  }, [settings?.factoryApiKey]);

  // Drives the error banner `patchSettings` returns. Kept locally so a
  // non-range invalid value (e.g. "abc" parsed as null) that never reaches
  // Zod can still show the operator why nothing saved.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const setPaneLive = (next: Pane): void => {
    setPane(next);
    onPaneChange?.(next);
  };
  const onTablistKey = useTablistNav();
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
  const removeProject = useConfirmAction(
    () => `Remove project “${project?.name}” from Foundry? The git repo on disk is not deleted.`,
    async (): Promise<void> => {
      if (!project) return;
      // A queued save for this project would re-create it moments after the remove.
      cancelProjectSave();
      try {
        await api.projects.remove(project.id);
        setErrors([]);
        await refreshAll();
      } catch (e) {
        setErrors([(e as Error).message]);
      }
    },
  );
  const replayIntro = async (): Promise<void> => {
    await runAppAction(async () => {
      await api.settings.patch({ onboarded: false });
      await refreshAll();
    });
  };
  const addProject = async (): Promise<void> => {
    await runAppAction(async () => {
      const added = await api.projects.add();
      await refreshAll();
      if (added) {
        selectProject(added.id);
        onOpenReadiness?.(added.id);
      }
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
  const removeOrphan = useConfirmAction(
    (orphan: OrphanWorktree) =>
      `Remove leftover worktree at ${orphan.path}? Its branch and any uncommitted work in it are deleted.`,
    async (orphan: OrphanWorktree): Promise<void> => {
      try {
        const result = await api.maintenance.removeWorktree(orphan.projectId, orphan.path);
        setMaintenanceNote(result.detail);
        if (result.ok === false) setErrors([result.detail]);
        else setErrors([]);
        await loadOrphans();
      } catch (e) {
        setErrors([(e as Error).message]);
      }
    },
  );
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

  const commitApiKey = async (): Promise<void> => {
    const next = apiKeyDraft.trim();
    if (next === (settings?.factoryApiKey ?? '').trim()) {
      setApiKeyHint('');
      setApiKeyDraft(next);
      return;
    }
    if (next.length > 2048) {
      setApiKeyHint('Keep it under 2048 characters.');
      return;
    }
    setApiKeyHint(
      next
        ? 'Saved. The next run will use this key.'
        : 'Cleared. Foundry will use FACTORY_API_KEY or a droid login session.',
    );
    await set({ factoryApiKey: next });
    void api.doctor.run().then(setChecks);
  };

  const applyRetentionAction = useConfirmAction(
    () => {
      const days = settings?.retentionDays;
      return `Apply retention now? This permanently deletes run history older than ${days} day${days === 1 ? '' : 's'}. Trace data cannot be restored.`;
    },
    async (): Promise<void> => {
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
    },
  );

  const applyRetention = async (): Promise<void> => {
    if (maintenanceBusy) return;
    const days = settings?.retentionDays;
    if (days == null) {
      setErrors(['Set a retention window before applying. Forever means nothing is deleted.']);
      return;
    }
    await applyRetentionAction();
  };

  const compact = useConfirmAction(
    'Compact trace databases now? This rewrites SQLite files and can take a moment; leave Foundry open until it finishes.',
    async (): Promise<void> => {
      if (maintenanceBusy) return;
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
    },
  );

  useEffect(() => {
    if (pane === 'maintenance') void loadOrphans();
  }, [pane]);

  if (!settings) return <div className={styles.settingsScreen} />;

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
      <div className={styles.settingsScreen}>
        <header className={styles.settingsHeader}>
          <p className="eyebrow">
            <span className="index">06</span>Settings
          </p>
        </header>
        {/* ── section strip: equal cells spanning the full window width ── */}
        <div
          className={styles.settingsTabs}
          role="tablist"
          aria-label="Settings sections"
          onKeyDown={onTablistKey}
        >
          {PANES.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={pane === p.id}
              tabIndex={pane === p.id ? 0 : -1}
              className={`${styles.settingsTab} ${pane === p.id ? styles.on : ''}`}
              onClick={() => setPaneLive(p.id)}
              data-testid={`settings-tab-${p.id}`}
            >
              <span className={styles.settingsTabLabel}>{p.label}</span>
            </button>
          ))}
        </div>

        <div className={styles.settingsScroll}>
          <div className={styles.settingsPage}>
            {pane === 'general' && (
              <>
                <Section label="Identity" note="Attached to every run, so a trace says who asked.">
                  <div className={styles.settingsFields}>
                    <Field label="Your name" htmlFor="engineer-name-input">
                      <TextInput
                        id="engineer-name-input"
                        aria-label="Your name"
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
                      {nameHint && <span className={styles.settingsWarn}>{nameHint}</span>}
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
                  <div className={styles.settingsToggles}>
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
                  <div className={styles.settingsSpread}>
                    <Field>
                      <strong className={styles.settingsStrong}>
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
                      className={`${styles.settingsPill} ${updateTone === 'ok' ? styles.ok : updateTone === 'bad' ? styles.bad : styles.info}`}
                    >
                      {updateText}
                    </span>
                  </div>
                  {(updateStatus.stage === 'downloading' || updateStatus.stage === 'ready') && (
                    <div
                      className={styles.settingsProgress}
                      aria-label={
                        updateStatus.stage === 'downloading'
                          ? `Downloading ${Math.round(updateStatus.percent ?? 0)} percent`
                          : 'Update ready to install'
                      }
                    >
                      <div className={styles.settingsTrack}>
                        <div
                          className={`${styles.settingsFill} ${updateStatus.stage === 'ready' ? styles.ready : ''}`}
                          style={{
                            width: `${updateStatus.stage === 'ready' ? 100 : Math.max(0, Math.min(100, updateStatus.percent ?? 0))}%`,
                          }}
                        />
                      </div>
                      <span className={`mono faint ${styles.settingsPct}`}>
                        {updateStatus.stage === 'ready'
                          ? 'ready'
                          : `${Math.round(updateStatus.percent ?? 0)}%`}
                      </span>
                    </div>
                  )}
                  <div className={styles.settingsSubrow}>
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
                  label="Terminal"
                  note="Where Foundry hands you a shell — Smith sessions and Open in terminal."
                >
                  <div className={styles.settingsFields}>
                    <Field
                      label="Preferred terminal"
                      hint="Used by Smith's launcher. Ghostty is handed a ready-made session; the others open your project directory and you paste the bootstrap line."
                    >
                      <Dropdown
                        value={settings.terminalApp}
                        options={TERMINAL_APPS.map((terminal) => ({
                          value: terminal.id,
                          label: terminal.label,
                          description: terminal.prepared
                            ? `Starts the Smith session for you — must be installed.`
                            : terminal.id === 'terminal'
                              ? 'Ships with macOS, so it always resolves.'
                              : `Opens ${terminal.appName}.app — must be installed.`,
                        }))}
                        onChange={(next) => {
                          void patchSettings({
                            terminalApp: next as AppSettings['terminalApp'],
                          });
                        }}
                      />
                    </Field>
                  </div>
                </Section>

                <Section
                  label="Application"
                  note="Restart after changing settings or installing an update."
                >
                  <p className={styles.hint}>
                    Restart Foundry after changing settings or installing an update.
                  </p>
                  <div className={styles.settingsBtnrow}>
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
                <Section label="Agent CLI" note="Drives agent phases.">
                  <p className={styles.settingsLead}>
                    Foundry drives Factory Droid for agent phases. A path is filled in from your
                    PATH at first launch; correct it here if you keep the binary somewhere unusual.
                  </p>
                </Section>
                <Section
                  label="Authentication"
                  note="The droid daemon will not start without a Factory credential."
                >
                  <div className={styles.settingsFields}>
                    <Field
                      label="Factory API key"
                      htmlFor="factory-api-key-input"
                      hint="Used to authenticate the local droid daemon. Takes precedence over FACTORY_API_KEY and a droid login session. Stored only on this Mac."
                    >
                      <TextInput
                        id="factory-api-key-input"
                        aria-label="Factory API key"
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        mono
                        value={apiKeyDraft}
                        placeholder="fk-…"
                        onChange={(e) => {
                          setApiKeyDraft(e.target.value);
                          setApiKeyHint('');
                        }}
                        onBlur={() => void commitApiKey()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            (e.target as HTMLInputElement).blur();
                          }
                        }}
                      />
                      {apiKeyHint && (
                        <span
                          className={
                            apiKeyHint === 'Keep it under 2048 characters.'
                              ? styles.settingsWarn
                              : styles.hint
                          }
                        >
                          {apiKeyHint}
                        </span>
                      )}
                    </Field>
                  </div>
                  <div className={styles.settingsBtnrow}>
                    <Button
                      size="sm"
                      onClick={() =>
                        void api.app.openExternal('https://app.factory.ai/settings/api-keys')
                      }
                    >
                      Get a key
                    </Button>
                    {!!settings.factoryApiKey && (
                      <Button
                        size="sm"
                        onClick={() => {
                          setApiKeyDraft('');
                          void (async () => {
                            setApiKeyHint(
                              'Cleared. Foundry will use FACTORY_API_KEY or a droid login session.',
                            );
                            await set({ factoryApiKey: '' });
                            void api.doctor.run().then(setChecks);
                          })();
                        }}
                      >
                        Clear key
                      </Button>
                    )}
                  </div>
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
                      <div className={styles.settingsCliHead}>
                        <CliIcon vendor={cli.id} size={18} />
                        <h3>{cli.label}</h3>
                        {found && (
                          <span
                            className={`${styles.settingsPill} ${found.ok ? styles.ok : styles.bad}`}
                          >
                            {found.ok ? 'found' : 'not found'}
                          </span>
                        )}
                      </div>
                      <div className={styles.settingsFields}>
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
                  <div className={styles.settingsSpread}>
                    <p className={styles.settingsLead}>
                      Used by any agent that inherits model or reasoning. A per-agent choice always
                      wins.
                    </p>
                    <Button size="sm" onClick={() => void refreshModels()}>
                      Refresh models
                    </Button>
                  </div>
                </Section>
                <Section label="Model" note="Offered by whichever CLI is the default.">
                  <div className={styles.settingsFields}>
                    <Field label="Default model">
                      <ModelPicker
                        value={settings.defaultModel}
                        models={models}
                        allowInherit
                        emptyHint={`No models from ${settings.defaultCli}. Install and sign in under Agent CLIs, then refresh.`}
                        onChange={(v) => void set({ defaultModel: v })}
                        onRefresh={() => void refreshModels()}
                      />
                    </Field>
                    <Field label="Default reasoning effort">
                      <Dropdown
                        value={settings.defaultReasoningEffort}
                        options={[
                          { value: 'off', label: 'Off' },
                          { value: 'low', label: 'Low' },
                          { value: 'medium', label: 'Medium' },
                          { value: 'high', label: 'High' },
                          { value: 'xhigh', label: 'X-High' },
                          { value: 'max', label: 'Max' },
                        ]}
                        onChange={(next) => void set({ defaultReasoningEffort: next as never })}
                      />
                    </Field>
                  </div>
                </Section>
                <Section
                  label="Readiness"
                  note="What the Agent Readiness Check uses when a repo is added."
                >
                  <div className={styles.settingsFields}>
                    <Field label="Readiness model">
                      <ModelPicker
                        value={settings.readinessModel}
                        models={models}
                        allowInherit
                        emptyHint={`No models from ${settings.defaultCli}.`}
                        onChange={(v) => void set({ readinessModel: v })}
                        onRefresh={() => void refreshModels()}
                      />
                    </Field>
                    <Field label="Readiness reasoning effort">
                      <Dropdown
                        value={settings.readinessReasoningEffort}
                        options={[
                          { value: 'off', label: 'Off' },
                          { value: 'low', label: 'Low' },
                          { value: 'medium', label: 'Medium' },
                          { value: 'high', label: 'High' },
                          { value: 'xhigh', label: 'X-High' },
                          { value: 'max', label: 'Max' },
                        ]}
                        onChange={(next) => void set({ readinessReasoningEffort: next as never })}
                      />
                    </Field>
                  </div>
                </Section>
                <Section label="Pull requests" note="Who drafts a PR when a pipeline asks for one.">
                  <div className={styles.settingsFields}>
                    <Field
                      label="PR writer"
                      hint="Roster agent used when adding a PR phase. A pipeline that names an agent still wins."
                      error={
                        isKnownPrWriter(settings.prAgent, agents)
                          ? undefined
                          : "Not in this project's roster. Settings still load; pick a writer that exists."
                      }
                    >
                      <Dropdown
                        value={settings.prAgent}
                        options={prWriterOptions(agents, settings.prAgent)}
                        aria-label="PR writer"
                        onChange={(next) => void set({ prAgent: next })}
                      />
                    </Field>
                  </div>
                </Section>
                <Section label="Autonomy" note="How a run behaves once it starts.">
                  <p className={styles.hint}>
                    Runs are fully autonomous: once a run starts it never stops to ask permission.
                    Writes outside an agent&rsquo;s boundary are always reverted, and every decision
                    the engine makes on your behalf is recorded in the run&rsquo;s timeline.
                  </p>
                </Section>
                <Section label="Limits" note="How hard Foundry tries before a phase fails.">
                  <div className={styles.settingsFields}>
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
                    <Field
                      label="Compact context at (%)"
                      hint="Between phases, an agent this full of context is compacted so the next phase has room."
                    >
                      <TextInput
                        type="number"
                        min={COMPACTION_PERCENT.min}
                        max={COMPACTION_PERCENT.max}
                        value={Math.round(settings.compactionThreshold * 100)}
                        onChange={(e) =>
                          void setInt(e.target.value, COMPACTION_PERCENT, (percent) => ({
                            compactionThreshold: percent / 100,
                          }))
                        }
                      />
                    </Field>
                    <Field
                      label="Rewind after (corrections)"
                      hint="After this many failed corrections, rewind the session to its phase-start state instead of appending another fix. Set to 0 to disable — the phase simply retries in place."
                      error={fieldErrors.rewindAfterCorrections}
                    >
                      <TextInput
                        type="number"
                        min={REWIND_BAND.min}
                        max={REWIND_BAND.max}
                        step={1}
                        value={settings.rewindAfterCorrections}
                        aria-invalid={fieldErrors.rewindAfterCorrections ? 'true' : undefined}
                        aria-describedby={
                          fieldErrors.rewindAfterCorrections
                            ? 'field-rewindAfterCorrections-error'
                            : undefined
                        }
                        onChange={(e) => {
                          const raw = e.target.value.trim();
                          if (raw === '') {
                            setFieldErrors((m) => ({
                              ...m,
                              rewindAfterCorrections:
                                'Enter 0–20, or clear to keep the last value.',
                            }));
                            return;
                          }
                          const n = Number(raw);
                          if (!Number.isFinite(n)) {
                            setFieldErrors((m) => ({
                              ...m,
                              rewindAfterCorrections: 'That is not a number — enter 0–20.',
                            }));
                            return;
                          }
                          const clamped = Math.min(
                            REWIND_BAND.max,
                            Math.max(REWIND_BAND.min, Math.round(n)),
                          );
                          if (Math.round(n) !== n) {
                            setFieldErrors((m) => ({
                              ...m,
                              rewindAfterCorrections: `Rounded to ${clamped}.`,
                            }));
                          } else if (n < REWIND_BAND.min || n > REWIND_BAND.max) {
                            setFieldErrors((m) => ({
                              ...m,
                              rewindAfterCorrections: `Clamped to ${clamped}.`,
                            }));
                          } else if (n === 0) {
                            setFieldErrors((m) => ({
                              ...m,
                              rewindAfterCorrections:
                                'Rewind disabled — corrections append in place.',
                            }));
                          } else {
                            setFieldErrors((m) => {
                              const next = { ...m };
                              delete next.rewindAfterCorrections;
                              return next;
                            });
                          }
                          void (async () => {
                            const issues = await patchSettings({
                              rewindAfterCorrections: clamped,
                            });
                            if (issues.length) setErrors(issues);
                            else setErrors([]);
                            // Do not clear fieldErrors on success here — the
                            // clamped/disabled notes must survive to explain
                            // why the input now shows a different number.
                          })();
                        }}
                        onBlur={(e) => {
                          const raw = e.target.value.trim();
                          if (!raw) {
                            setFieldErrors((m) => {
                              const next = { ...m };
                              delete next.rewindAfterCorrections;
                              return next;
                            });
                            e.target.value = String(settings.rewindAfterCorrections);
                            // Force React to treat the re-populated value as
                            // the current committed one on next onChange.
                            const tracker = (
                              e.target as HTMLInputElement & {
                                _valueTracker?: { setValue(v: string): void };
                              }
                            )._valueTracker;
                            if (tracker) tracker.setValue(e.target.value);
                          }
                        }}
                      />
                      {fieldErrors.rewindAfterCorrections && (
                        <span
                          id="field-rewindAfterCorrections-error"
                          role="status"
                          className={styles.settingsWarn}
                        >
                          {fieldErrors.rewindAfterCorrections}
                        </span>
                      )}
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
                <Section label="Transport" note="Where the app-owned droid daemon listens.">
                  <div className={styles.settingsFields}>
                    <Field
                      label="Daemon port"
                      hint="Preferred port for the app-owned daemon. Must be 37600–37699; if busy, the daemon tries the next free port in that band. Change takes effect on next daemon launch."
                      error={fieldErrors.daemonPort}
                    >
                      <TextInput
                        type="number"
                        min={DAEMON_PORT_BAND.min}
                        max={DAEMON_PORT_BAND.max}
                        value={settings.daemonPort}
                        aria-invalid={fieldErrors.daemonPort ? 'true' : undefined}
                        aria-describedby={
                          fieldErrors.daemonPort ? 'field-daemonPort-error' : undefined
                        }
                        onChange={(e) => {
                          const raw = e.target.value.trim();
                          if (raw === '') {
                            setFieldErrors((m) => ({
                              ...m,
                              daemonPort: 'Enter 37600–37699, or clear to keep the current port.',
                            }));
                            return;
                          }
                          const n = Number(raw);
                          if (!Number.isFinite(n)) {
                            setFieldErrors((m) => ({
                              ...m,
                              daemonPort: 'That is not a number — enter 37600–37699.',
                            }));
                            return;
                          }
                          const rounded = Math.round(n);
                          const clamped = Math.min(
                            DAEMON_PORT_BAND.max,
                            Math.max(DAEMON_PORT_BAND.min, rounded),
                          );
                          if (rounded !== n) {
                            setFieldErrors((m) => ({
                              ...m,
                              daemonPort: `Rounded to ${rounded}.`,
                            }));
                          } else if (
                            rounded < DAEMON_PORT_BAND.min ||
                            rounded > DAEMON_PORT_BAND.max
                          ) {
                            setFieldErrors((m) => ({
                              ...m,
                              daemonPort: `Clamped to ${clamped} — the allowed band is ${DAEMON_PORT_BAND.min}–${DAEMON_PORT_BAND.max}.`,
                            }));
                          } else {
                            setFieldErrors((m) => {
                              const next = { ...m };
                              delete next.daemonPort;
                              return next;
                            });
                          }
                          void (async () => {
                            const result = await patchSettings({ daemonPort: clamped });
                            // patchSettings already surfaced range errors in the banner;
                            // clamp-away handling kept our field note visible instead.
                            if (result.length) setErrors(result);
                          })();
                        }}
                        onBlur={(e) => {
                          const raw = e.target.value.trim();
                          if (!raw) {
                            setFieldErrors((m) => {
                              const next = { ...m };
                              delete next.daemonPort;
                              return next;
                            });
                            e.target.value = String(settings.daemonPort);
                            const tracker = (
                              e.target as HTMLInputElement & {
                                _valueTracker?: { setValue(v: string): void };
                              }
                            )._valueTracker;
                            if (tracker) tracker.setValue(e.target.value);
                          }
                        }}
                      />
                      {fieldErrors.daemonPort && (
                        <span
                          id="field-daemonPort-error"
                          role="status"
                          className={styles.settingsWarn}
                        >
                          {fieldErrors.daemonPort}
                        </span>
                      )}
                    </Field>
                  </div>
                </Section>
              </>
            )}
            {pane === 'mcp' && <McpSettings settings={settings} onPatch={set} />}

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
                      <div className={styles.settingsSubrow}>
                        <span className={`mono faint ${styles.settingsPath}`}>
                          {projectDraft.path}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void api.projects.reveal(projectDraft.path)}
                        >
                          Reveal in Finder
                        </Button>
                      </div>
                    </Section>
                    <Section
                      label="Readiness"
                      note="The marker file is truth. Cached app state never overrides it."
                    >
                      <p className={styles.hint}>
                        {readiness?.ready
                          ? readiness.marker?.summary ||
                            'This repository has a valid .agents/agent-ready.json.'
                          : readiness?.skipped
                            ? 'Readiness was skipped. The Agent Readiness process can be run again anytime from here.'
                            : readiness?.markerDetail ||
                              'No valid .agents/agent-ready.json yet. Pipeline runs may fail until the repo is ready.'}
                      </p>
                      {onOpenReadiness && projectDraft && (
                        <div className={styles.settingsBtnrow}>
                          <Button size="sm" onClick={() => onOpenReadiness(projectDraft.id)}>
                            {readiness?.ready ? 'View readiness report' : 'Run readiness check'}
                          </Button>
                        </div>
                      )}
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
                      <div className={styles.settingsFields}>
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
                          <Dropdown
                            value={projectDraft.mergePolicy}
                            options={[
                              { value: 'never', label: 'Never merge automatically' },
                              { value: 'on_accept', label: 'Merge when a run is accepted' },
                              { value: 'ask', label: 'Ask me each time' },
                            ]}
                            onChange={(next) =>
                              setProjectDraft({
                                ...projectDraft,
                                mergePolicy: next as ProjectDef['mergePolicy'],
                              })
                            }
                          />
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
                      label="Setup"
                      note="Script that installs deps in every new worktree, so agents find their binaries."
                    >
                      <ProjectSetup
                        project={projectDraft}
                        onChange={(setupScript) =>
                          setProjectDraft({ ...projectDraft, setupScript })
                        }
                      />
                    </Section>
                    <Section
                      label="Boundaries"
                      note="Hard limits, whatever an agent's own boundary says."
                    >
                      <Field
                        label="Protected paths"
                        htmlFor="project-protected-paths"
                        hint={
                          <>
                            One pattern per line. No agent may write these, whatever its own
                            boundary says. <code>.git/</code>, CI config, and lockfiles are always
                            protected.
                          </>
                        }
                      >
                        <Textarea
                          id="project-protected-paths"
                          aria-label="Protected paths"
                          rows={3}
                          placeholder="e.g. src/**/*.secret&#10;.env*"
                          value={projectDraft.protectedPaths.join('\n')}
                          onChange={(e) =>
                            setProjectDraft({
                              ...projectDraft,
                              protectedPaths: e.target.value.split('\n').filter(Boolean),
                            })
                          }
                        />
                      </Field>
                    </Section>
                    {/*
                      Read-only on purpose. Scope decides where an edit lands, so
                      it belongs where the editing happens; the control moved to
                      the Design header and this is the status it reports.
                    */}
                    <Section
                      label="Scope"
                      note="Where this project's agents and pipelines are saved."
                    >
                      <div className={styles.settingsFields}>
                        <Field label="Agents">
                          <p className={styles.settingsStatic}>
                            {projectDraft.ownRoster ? 'This project only' : 'Global'}
                          </p>
                          <span className="hint">
                            {projectDraft.ownRoster
                              ? 'A copy belonging to this project. Later changes to the global agents do not reach it.'
                              : 'Shared by every project.'}
                          </span>
                        </Field>
                        <Field label="Pipelines">
                          <p className={styles.settingsStatic}>
                            {projectDraft.ownPipelines ? 'This project only' : 'Global'}
                          </p>
                          <span className="hint">
                            {projectDraft.ownPipelines
                              ? 'A copy belonging to this project. Later changes to the global pipelines do not reach it.'
                              : 'Shared by every project.'}
                          </span>
                        </Field>
                        <Field label="Change it" className={styles.span2}>
                          <span className="hint">
                            Change scope in <strong>Design</strong> (<kbd>⌘3</kbd>), on the Agents
                            or Pipelines tab — the badge beside the heading. It is set there because
                            that is where the edits it affects are made.
                          </span>
                        </Field>
                      </div>
                    </Section>
                    <div className={styles.settingsFoot}>
                      <Button variant="danger" onClick={() => void removeProject()}>
                        Remove project
                      </Button>
                      <span className={styles.settingsAutosave}>Changes save automatically</span>
                    </div>
                  </>
                ) : (
                  <div className={styles.settingsEmpty}>
                    <p className="faint">
                      No project selected. Add a git repository you already have, or create a new
                      one on GitHub.
                    </p>
                    <Button variant="primary" onClick={() => void addProject()}>
                      Add a project…
                    </Button>
                    {onNewProject && <Button onClick={onNewProject}>Create a new project…</Button>}
                  </div>
                )}
              </>
            )}
            {pane === 'maintenance' && (
              <>
                <Section label="Retention" note="Nothing is deleted behind your back.">
                  <Field
                    label="Keep run history for"
                    className={styles.settingsNarrow}
                    hint="Applies when you press the button below. Nothing is deleted behind your back."
                  >
                    <Dropdown
                      value={String(settings.retentionDays ?? '')}
                      options={[
                        { value: '', label: 'Forever' },
                        { value: '7', label: '7 days' },
                        { value: '30', label: '30 days' },
                        { value: '90', label: '90 days' },
                        { value: '365', label: 'A year' },
                      ]}
                      onChange={(next) =>
                        void set({
                          retentionDays: next ? Number(next) : null,
                        })
                      }
                    />
                  </Field>
                  <div className={styles.settingsSubrow}>
                    <div className={styles.settingsBtnrow}>
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
                    <ul className={styles.settingsOrphans}>
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
                    <p className={styles.settingsNote}>
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
                  <p className={styles.settingsLead}>
                    A software factory you can watch. Pipelines are data, agents are configuration,
                    and every phase leaves evidence you can read.
                  </p>
                </Section>
                <Section label="Build" note="What this copy of Foundry is running.">
                  <dl className={styles.settingsFacts}>
                    <div className={styles.settingsFact}>
                      <dt>Version</dt>
                      <dd className="mono">{version}</dd>
                    </div>
                    <div className={styles.settingsFact}>
                      <dt>Agent harness</dt>
                      <dd className="mono">droid CLI over stream JSON-RPC</dd>
                    </div>
                    <div className={styles.settingsFact}>
                      <dt>Projects</dt>
                      <dd className="mono">{projects.length}</dd>
                    </div>
                  </dl>
                </Section>
                <Section label="Elsewhere" note="Docs and the cinematic intro.">
                  <div className={styles.settingsBtnrow}>
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
              <ul className={styles.settingsErrors} role="alert">
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

function newMcpId(): string {
  const bytes = globalThis.crypto?.getRandomValues
    ? globalThis.crypto.getRandomValues(new Uint8Array(4))
    : null;
  if (bytes)
    return `mcp_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 7)}`;
  return `mcp_${Math.random().toString(36).slice(2, 9)}`;
}

function McpSettings({
  settings,
  onPatch,
}: {
  settings: AppSettings;
  onPatch: (patch: Partial<AppSettings>) => Promise<void>;
}): React.JSX.Element {
  const servers = settings.mcpServers ?? [];
  const [draft, setDraft] = useState<UserMcpServer | null>(null);
  const [error, setError] = useState('');

  const saveServers = (next: UserMcpServer[]): void => {
    void onPatch({ mcpServers: next });
  };

  const startAdd = (type: UserMcpServer['type']): void => {
    if (type === 'stdio') {
      setDraft({ id: newMcpId(), name: '', disabled: false, type: 'stdio', command: '' });
    } else {
      setDraft({ id: newMcpId(), name: '', disabled: false, type, url: '' });
    }
    setError('');
  };

  const isHttpUrl = (raw: string): boolean => {
    try {
      const parsed = new URL(raw);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  };

  const validate = (s: UserMcpServer): string | null => {
    if (!s.name.trim()) return 'Name is required.';
    if (s.name.trim().length > 80) return 'Name must be 80 characters or fewer.';
    if (s.type === 'stdio' && !s.command.trim()) return 'Command is required for stdio servers.';
    if ((s.type === 'http' || s.type === 'sse') && !s.url.trim()) return 'URL is required.';
    if ((s.type === 'http' || s.type === 'sse') && !isHttpUrl(s.url.trim()))
      return 'Enter a valid http(s) URL.';
    if (
      servers.some(
        (x) => x.id !== s.id && x.name.trim().toLowerCase() === s.name.trim().toLowerCase(),
      )
    )
      return 'Name must be unique.';
    return null;
  };

  const commitDraft = (): void => {
    if (!draft) return;
    const trimmed: UserMcpServer =
      draft.type === 'stdio'
        ? {
            ...draft,
            name: draft.name.trim(),
            command: draft.command.trim(),
            args: draft.args?.filter(Boolean),
            env: draft.env && Object.keys(draft.env).length ? draft.env : undefined,
          }
        : { ...draft, name: draft.name.trim(), url: draft.url.trim() };
    const msg = validate(trimmed);
    if (msg) {
      setError(msg);
      return;
    }
    const exists = servers.some((s) => s.id === trimmed.id);
    const next = exists
      ? servers.map((s) => (s.id === trimmed.id ? trimmed : s))
      : [...servers, trimmed];
    saveServers(next);
    setDraft(null);
    setError('');
  };

  return (
    <>
      <Section label="MCP Servers" note="Tools your agents can use via the Model Context Protocol.">
        <p className={styles.settingsLead}>
          Add MCP servers to extend what agents can do. Supports stdio (local command), HTTP, and
          SSE transports. Disabled servers are not passed to the agent.
        </p>
        {servers.length === 0 && !draft && (
          <p className="faint">No MCP servers configured. Add one below.</p>
        )}
        {servers.length > 0 && (
          <div className={styles.mcpList}>
            {servers.map((s) => (
              <div
                key={s.id}
                className={`${styles.mcpCard} ${s.disabled ? styles.off : styles.on}`}
              >
                <span className={styles.mcpCardMain}>
                  <strong className={`mono ${styles.mcpCardName}`}>{s.name}</strong>{' '}
                  <span className={`mono faint ${styles.mcpCardType}`}>{s.type}</span>
                  <br />
                  <span className={`mono faint ${styles.mcpDetail}`}>
                    {s.type === 'stdio'
                      ? s.command + (s.args?.length ? ` ${s.args.join(' ')}` : '')
                      : s.url}
                  </span>
                </span>
                <label className={styles.mcpEnable}>
                  <input
                    type="checkbox"
                    checked={!s.disabled}
                    onChange={(e) =>
                      saveServers(
                        servers.map((x) =>
                          x.id === s.id ? { ...x, disabled: !e.target.checked } : x,
                        ),
                      )
                    }
                  />
                  Enabled
                </label>
                <Button
                  size="sm"
                  onClick={() => {
                    setDraft({ ...s });
                    setError('');
                  }}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => saveServers(servers.filter((x) => x.id !== s.id))}
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
        )}
      </Section>

      {draft ? (
        <Section
          label={servers.some((s) => s.id === draft.id) ? 'Edit server' : 'Add server'}
          note="All fields are validated before saving."
        >
          <div className={styles.mcpForm}>
            <Field label="Name">
              <TextInput
                value={draft.name}
                placeholder="my-mcp-server"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </Field>
            <Field label="Transport">
              <Dropdown
                value={draft.type}
                options={[
                  { value: 'stdio', label: 'stdio — local command' },
                  { value: 'http', label: 'http — HTTP streaming' },
                  { value: 'sse', label: 'sse — Server-Sent Events' },
                ]}
                onChange={(v) => {
                  const next = v as UserMcpServer['type'];
                  if (next === 'stdio') {
                    setDraft({
                      id: draft.id,
                      name: draft.name,
                      disabled: draft.disabled,
                      type: 'stdio',
                      command: '',
                    });
                  } else {
                    setDraft({
                      id: draft.id,
                      name: draft.name,
                      disabled: draft.disabled,
                      type: next,
                      url: '',
                    });
                  }
                }}
              />
            </Field>
            {draft.type === 'stdio' ? (
              <>
                <Field
                  label="Command"
                  hint="Executable path or command name (e.g. npx, node, python3)"
                >
                  <TextInput
                    mono
                    value={draft.command}
                    placeholder="npx"
                    onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                  />
                </Field>
                <Field label="Arguments" hint="Space-separated arguments (optional)">
                  <TextInput
                    mono
                    value={(draft.args ?? []).join(' ')}
                    placeholder="mcp-server-package --port 3000"
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        args: e.target.value
                          ? e.target.value.split(/\s+/).filter(Boolean)
                          : undefined,
                      })
                    }
                  />
                </Field>
                <Field label="Environment" hint="KEY=value per line (optional)">
                  <Textarea
                    rows={3}
                    placeholder="API_KEY=secret&#10;DEBUG=1"
                    value={Object.entries(draft.env ?? {})
                      .map(([k, v]) => `${k}=${v}`)
                      .join('\n')}
                    onChange={(e) => {
                      const env: Record<string, string> = {};
                      for (const line of e.target.value.split('\n')) {
                        const idx = line.indexOf('=');
                        if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
                      }
                      setDraft({ ...draft, env: Object.keys(env).length ? env : undefined });
                    }}
                  />
                </Field>
              </>
            ) : (
              <Field label="URL" hint="Full URL to the MCP endpoint">
                <TextInput
                  mono
                  value={draft.url}
                  placeholder={
                    draft.type === 'sse' ? 'https://example.com/sse' : 'https://example.com/mcp'
                  }
                  onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                />
              </Field>
            )}
            {error && (
              <span role="alert" className={styles.settingsWarn}>
                {error}
              </span>
            )}
            <div className={styles.settingsBtnrow}>
              <Button variant="primary" onClick={commitDraft}>
                {servers.some((s) => s.id === draft.id) ? 'Save' : 'Add server'}
              </Button>
              <Button
                onClick={() => {
                  setDraft(null);
                  setError('');
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        </Section>
      ) : (
        <Section label="Add" note="Choose a transport and configure the server.">
          <div className={styles.settingsBtnrow}>
            <Button onClick={() => startAdd('stdio')}>Add stdio server</Button>
            <Button onClick={() => startAdd('http')}>Add HTTP server</Button>
            <Button onClick={() => startAdd('sse')}>Add SSE server</Button>
          </div>
        </Section>
      )}
    </>
  );
}
