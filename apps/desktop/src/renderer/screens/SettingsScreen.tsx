import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppTheme,
  DoctorCheck,
  ModelInfo,
  OrphanWorktree,
  ProjectDef,
  ReadinessInspectResult,
  UpdateStatus,
} from '@shared/types.js';
import { FIXED_ENGINE_DEFAULTS } from '@shared/types.js';
import {
  BRIDGE_UNAVAILABLE_COPY,
  type BridgeState,
  type LinearConnectionState,
  type StoredProviderKey,
} from '@shared/ipc-contract.js';
import type { CompanionHostState, CompanionPairingPayload } from '@shared/companion.js';
import { MODEL_UNSET, MODEL_UNSET_MESSAGE } from '@shared/model-choice.js';
import { modelLabel } from '@shared/model-label.js';
import {
  modelForEffortPicker,
  normalizeReasoningEffortForModelChoice,
} from '@shared/reasoning-effort.js';
import { api, plain } from '../api.js';
import { isKnownPrWriter, prWriterOptions } from '../view-models/pr-draft.js';
import { useApp } from '../stores/app.js';
import { useAgentModels } from '../hooks/useAgentModels.js';
import ModelPicker from '../components/common/ModelPicker.js';
import ReasoningEffortPicker from '../components/common/ReasoningEffortPicker.js';
import { ProviderIcon } from '../components/media/BrandIcon.js';
import DoctorList from '../components/readiness/DoctorList.js';
import ProjectCommands from '../components/project/ProjectCommands.js';
import ProjectSetup from '../components/project/ProjectSetup.js';
import BaseSyncBar from '../components/project/BaseSyncBar.js';
import QrCode from '../components/media/QrCode.js';
import { Field, TextInput, Textarea } from '../components/ui/Field.js';
import { Button } from '../components/ui/Button.js';
import { Dropdown } from '../components/ui/Dropdown.js';
import { useConfirmAction } from '../hooks/useConfirmAction.js';
import { useDebouncedSave } from '../hooks/useDebouncedSave.js';
import { useTablistNav } from '../hooks/useTablistNav.js';
import {
  SETTINGS_PANES,
  SETTINGS_TOGGLES,
  Highlight,
  paneMatchesQuery,
  searchSettings,
  sectionId,
  type SettingsHit,
  type SettingsPaneId,
  type SettingsToggleDef,
} from '../view-models/settings-search.js';
import { SMITH_MODEL_UNSET_LABEL } from '../view-models/smith-chat-view.js';
import { SMITH_NO_PROVIDER_COPY } from '../view-models/smith-copy.js';
import styles from './SettingsScreen.module.css';

// Envelopes is deliberately absent: it is an authoring surface, not a
// preference, and lives in Design alongside the editors that reference it.
type Pane = SettingsPaneId;

/** Old pane ids from saved navigation state still land somewhere sensible. */
function normalizePane(value: string): Pane {
  if (value === 'project') return 'project';
  if (value === 'integrations') return 'integrations';
  if (value === 'general' || value === 'maintenance' || value === 'about' || value === 'app') {
    return 'app';
  }
  return 'models';
}

/**
 * Tests pin these literals (tests/design-navigation.test.ts reads this source),
 * so the rail renders from this list rather than the search registry's own
 * pane metadata. Keep the two in step when a pane is added or renamed.
 */
const PANES: { id: Pane; label: string }[] = [
  { id: 'models', label: 'Models & Providers' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'project', label: 'Project' },
  { id: 'app', label: 'App' },
];

/**
 * The rail groups panes by whose stuff they configure — the app and its agents,
 * the repo in front of you, and housekeeping. Group heads hide while the rail
 * search is narrowing the list.
 */
const RAIL_GROUPS: { label: string; items: Pane[] }[] = [
  { label: 'Settings', items: ['models', 'integrations', 'project', 'app'] },
];

/**
 * The compaction threshold is stored as a fraction and shown as a percentage,
 * because "compact at 80%" is what the lane's context meter reads. The band
 * mirrors the settings schema: below it a run compacts more than it works, and
 * at 100% it never compacts before hitting the context wall.
 */
const COMPACTION_PERCENT = { min: 50, max: 95 } as const;

/**
 * Providers offered a direct-key row, keyed by pi's own provider id — that id is
 * what `bridge.setApiKey` passes to pi's credential store, so a wrong spelling
 * would store a key nothing reads.
 *
 * Deliberately a short list of the ones an operator is likely to hold a key
 * for rather than pi's full provider table: a key row for every provider pi
 * knows would bury the four that matter. A provider outside this list that
 * already has a stored key still gets a row, so nothing is unreachable.
 */
const KEY_PROVIDERS: { id: string; label: string; icon: string }[] = [
  { id: 'anthropic', label: 'Anthropic', icon: 'anthropic' },
  { id: 'openai', label: 'OpenAI', icon: 'openai' },
  { id: 'google', label: 'Google AI Studio', icon: 'google' },
  { id: 'openrouter', label: 'OpenRouter', icon: 'openrouter' },
  { id: 'xai', label: 'xAI', icon: 'xai' },
];

const NOTIFY_LABELS: Record<'accepted' | 'rejected' | 'failed', string> = {
  accepted: 'A run was accepted',
  rejected: 'A run was not accepted',
  failed: 'A run failed',
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
    <section className={styles.settingsSection} data-sec={sectionId(label)}>
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

/** Keeps each settings pane's conditional rendering isolated from the screen shell. */
function PaneBody({ children }: { children: () => React.ReactNode }): React.JSX.Element {
  return <>{children()}</>;
}

/** QR + copy/refresh block shared by the first-pairing and pair-another states. */
function PairingQr({
  payload,
  copied,
  onCopy,
  onRefresh,
  lead,
}: {
  payload: CompanionPairingPayload | null;
  copied: boolean;
  onCopy: () => void;
  onRefresh: () => void;
  lead: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={styles.qrContainer}>
      <div className={styles.qrFrame}>
        {payload ? (
          <QrCode
            value={`foundry://pair?origin=${encodeURIComponent(payload.origin)}&secret=${encodeURIComponent(payload.secret)}`}
            size={220}
            bgColor="#FFFFFF"
            fgColor="#000000"
            title="Foundry Companion Pairing QR"
          />
        ) : (
          <div className={styles.qrPlaceholder}>Generating pairing code…</div>
        )}
      </div>
      <div className={styles.qrDetails}>
        <div className={styles.qrLead}>{lead}</div>
        <div className={styles.settingsBtnrow}>
          <Button size="sm" disabled={!payload} onClick={onCopy}>
            {copied ? 'Copied to clipboard!' : 'Copy pairing code'}
          </Button>
          <Button size="sm" onClick={onRefresh}>
            Refresh QR code
          </Button>
        </div>
      </div>
    </div>
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
  paletteNonce = 0,
}: {
  pane: string;
  /** Keep the shell's `data-settings-pane` marker in sync with tab clicks. */
  onPaneChange?: (pane: string) => void;
  /** Create a repository on GitHub instead of pointing at an existing checkout. */
  onNewProject?: () => void;
  /** Bumped by the app shell's ⌘K chord; each bump opens the search palette. */
  paletteNonce?: number;
}): React.JSX.Element {
  const { settings, project, projects, agents, refreshAll, patchSettings, selectProject } =
    useApp();
  const [pane, setPane] = useState<Pane>(normalizePane(initialPane));
  const { models, refresh: refreshModels } = useAgentModels();
  const [modelFilter, setModelFilter] = useState('');
  const [checks, setChecks] = useState<DoctorCheck[]>([]);
  const [projectChecks, setProjectChecks] = useState<DoctorCheck[]>([]);
  const [orphans, setOrphans] = useState<OrphanWorktree[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [version, setVersion] = useState('');
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ stage: 'idle' });
  const [projectDraft, setProjectDraft] = useState<ProjectDef | null>(null);
  const [readiness, setReadiness] = useState<ReadinessInspectResult | null>(null);
  const [maintenanceNote, setMaintenanceNote] = useState('');
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const [bridge, setBridge] = useState<BridgeState | null>(null);
  const [companion, setCompanion] = useState<CompanionHostState | null>(null);
  const [companionBusy, setCompanionBusy] = useState(false);
  const [pairingPayload, setPairingPayload] = useState<CompanionPairingPayload | null>(null);
  const [copiedPayload, setCopiedPayload] = useState(false);
  const [showPairMore, setShowPairMore] = useState(false);
  const [storedKeys, setStoredKeys] = useState<StoredProviderKey[]>([]);
  const [providerBusy, setProviderBusy] = useState<string | null>(null);
  const [providerNotes, setProviderNotes] = useState<Record<string, string>>({});
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [linearConnection, setLinearConnection] = useState<LinearConnectionState | null>(null);
  const [linearKeyDraft, setLinearKeyDraft] = useState('');
  const [linearBusy, setLinearBusy] = useState(false);
  const [linearNote, setLinearNote] = useState('');
  const [searchQ, setSearchQ] = useState('');
  const [palOpen, setPalOpen] = useState(false);
  const [palQ, setPalQ] = useState('');
  const [palIdx, setPalIdx] = useState(0);
  /** Section id a search jump should scroll to once its pane has painted. */
  const scrollTargetRef = useRef<string | null>(null);

  useEffect(() => {
    setPane(normalizePane(initialPane));
  }, [initialPane]);

  useEffect(() => {
    void Promise.all([api.doctor.run(), api.app.version(), api.updater.getStatus()]).then(
      ([c, v, u]) => {
        setChecks(c);
        setVersion(v);
        setUpdateStatus(u);
      },
    );
    return api.on('updater-status', (data) => {
      if (data) setUpdateStatus(data as UpdateStatus);
    });
  }, []);

  /**
   * A login finishes in a browser long after `connect` returned, so the pane
   * re-reads its whole world on `bridge-changed` rather than trusting the
   * action's own result: the account, the stored keys, and the model catalog
   * all change together.
   */
  useEffect(() => {
    const reload = (): void => {
      void api.bridge.state().then(setBridge);
      void api.bridge.storedKeys().then(setStoredKeys);
    };
    reload();
    return api.on('bridge-changed', reload);
  }, []);

  useEffect(() => {
    void api.linear.state().then(setLinearConnection);
  }, []);

  const loadPairingPayload = useCallback(async (refresh = false): Promise<void> => {
    try {
      const payload = await api.companion.pairingPayload(refresh ? { refresh: true } : undefined);
      setPairingPayload(payload);
    } catch {
      setPairingPayload(null);
    }
  }, []);

  // A phone pairs over HTTP minutes after the host started, so the pane
  // re-reads on the push event rather than trusting its own action results.
  // Re-read must not mint a new secret — that rotates the QR under a scan.
  useEffect(() => {
    const reload = (): void => {
      void api.companion.state().then((st) => {
        setCompanion(st);
        if (st.running) void loadPairingPayload();
      });
    };
    reload();
    return api.on('companion-changed', reload);
  }, [loadPairingPayload]);

  const copyPairingPayload = (): void => {
    if (!pairingPayload) return;
    void navigator.clipboard.writeText(JSON.stringify(pairingPayload));
    setCopiedPayload(true);
    setTimeout(() => setCopiedPayload(false), 2000);
  };

  const toggleCompanion = async (on: boolean): Promise<void> => {
    setCompanionBusy(true);
    try {
      const next = on ? await api.companion.start() : await api.companion.stop();
      setCompanion(next);
      if (next.running) {
        void loadPairingPayload();
      } else {
        setPairingPayload(null);
      }
    } finally {
      setCompanionBusy(false);
    }
  };

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

  const setPaneLive = (next: Pane): void => {
    setPane(next);
    onPaneChange?.(next);
  };
  const onTablistKey = useTablistNav({ orientation: 'vertical' });

  /**
   * A search jump can land mid-pane. Switching panes is async paint, so the
   * section id waits in a ref for the effect below; a same-pane jump scrolls
   * on the next frame instead.
   */
  const flashSection = useCallback((id: string): void => {
    const el = document.querySelector(`[data-sec="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'start' });
    el.classList.add(styles.secFlash);
    window.setTimeout(() => el.classList.remove(styles.secFlash), 1000);
  }, []);
  const jumpTo = (targetPane: Pane, section: string | null): void => {
    setPalOpen(false);
    if (targetPane !== pane) {
      scrollTargetRef.current = section;
      setPaneLive(targetPane);
    } else if (section) {
      requestAnimationFrame(() => flashSection(section));
    }
  };

  // The shell bumps paletteNonce on every ⌘K; each bump reopens the palette.
  useEffect(() => {
    if (paletteNonce > 0) setPalOpen(true);
  }, [paletteNonce]);

  useEffect(() => {
    const id = scrollTargetRef.current;
    if (!id) return;
    scrollTargetRef.current = null;
    requestAnimationFrame(() => flashSection(id));
  }, [pane, flashSection]);

  const searchHits = useMemo(() => searchSettings(searchQ, 8), [searchQ]);

  /**
   * Palette entries: an empty query lists the panes as jump targets; typing
   * mixes the flippable booleans with matching sections, toggles first because
   * they act in place.
   */
  type PalEntry = { kind: 'hit'; hit: SettingsHit } | { kind: 'toggle'; def: SettingsToggleDef };
  const palEntries = useMemo<PalEntry[]>(() => {
    const q = palQ.trim();
    if (!q) {
      return SETTINGS_PANES.map((p) => ({
        kind: 'hit' as const,
        hit: { pane: p.id, paneLabel: p.label, sectionId: null, title: p.label, note: p.hint },
      }));
    }
    const lower = q.toLowerCase();
    const toggles = SETTINGS_TOGGLES.filter(
      (t) => t.title.toLowerCase().includes(lower) || t.keywords.includes(lower),
    ).map((def) => ({ kind: 'toggle' as const, def }));
    const hits = searchSettings(q, 8).map((hit) => ({ kind: 'hit' as const, hit }));
    return [...toggles, ...hits];
  }, [palQ]);
  /* Filtering can shrink the list under the cursor; clamp instead of resetting
     so an arrow-key walk does not jump back to the top mid-gesture. */
  const palSel = Math.min(palIdx, Math.max(0, palEntries.length - 1));
  const set = async (patch: Parameters<typeof patchSettings>[0]): Promise<void> => {
    // Always replace the banner: a successful patch must clear a prior failure.
    // An IPC failure rejects rather than returning validation issues; surface it
    // instead of leaving a picker (including Theme) looking like it saved.
    try {
      setErrors(await patchSettings(patch));
    } catch {
      setErrors(['Could not save your settings. Please try again.']);
    }
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
      }
    });
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
        setErrors(result.ok ? [] : [result.detail]);
        await loadOrphans();
      } catch (e) {
        setErrors([(e as Error).message]);
      }
    },
  );
  /**
   * Runs one provider or credential action with the pane's own busy/note state.
   *
   * Every provider action reports through the same two surfaces so the operator
   * never has to guess which card a message belongs to, and the doctor list is
   * re-run because connecting a provider is exactly what makes its blocking
   * "usable models" check pass.
   */
  const runProviderAction = async (
    key: string,
    action: () => Promise<{ ok: boolean; detail: string }>,
  ): Promise<void> => {
    if (providerBusy) return;
    setProviderBusy(key);
    try {
      const result = await action();
      setProviderNotes((notes) => ({ ...notes, [key]: result.detail }));
      setErrors(result.ok ? [] : [result.detail]);
    } catch (e) {
      setProviderNotes((notes) => ({ ...notes, [key]: (e as Error).message }));
      setErrors([(e as Error).message]);
    } finally {
      setProviderBusy(null);
      setBridge(await api.bridge.state());
      setStoredKeys(await api.bridge.storedKeys());
      await refreshModels();
      void api.doctor.run().then(setChecks);
    }
  };

  const cancelProviderLogin = async (providerId: string): Promise<void> => {
    await runProviderAction(`provider:${providerId}`, async () => {
      const cancelled = await api.bridge.cancelLogin(providerId);
      return {
        ok: cancelled,
        detail: cancelled ? 'sign-in cancelled' : 'no sign-in was in flight',
      };
    });
  };

  const disconnectProvider = useConfirmAction<[string, string]>(
    (_providerId, label) =>
      `Disconnect ${label}? Its accounts are removed from this Mac and its models leave every picker.`,
    async (providerId): Promise<void> => {
      await runProviderAction(`provider:${providerId}`, () => api.bridge.disconnect(providerId));
    },
  );

  const saveProviderKey = async (providerId: string): Promise<void> => {
    const key = (keyDrafts[providerId] ?? '').trim();
    if (!key) return;
    await runProviderAction(`key:${providerId}`, async () => {
      const result = await api.bridge.setApiKey(providerId, key);
      // Cleared on success only: a rejected key stays in the field so the
      // operator can fix a paste rather than retype the whole secret.
      if (result.ok) setKeyDrafts((drafts) => ({ ...drafts, [providerId]: '' }));
      return result;
    });
  };

  const clearProviderKey = useConfirmAction<[string, string]>(
    (_providerId, label) =>
      `Remove the stored ${label} key? Models that need it leave every picker.`,
    async (providerId): Promise<void> => {
      setKeyDrafts((drafts) => ({ ...drafts, [providerId]: '' }));
      await runProviderAction(`key:${providerId}`, () => api.bridge.clearApiKey(providerId));
    },
  );

  const runLinearAction = async (
    action: () => Promise<{ ok: boolean; detail: string }>,
  ): Promise<void> => {
    if (linearBusy) return;
    setLinearBusy(true);
    try {
      const result = await action();
      setLinearNote(result.detail);
      setErrors(result.ok ? [] : [result.detail]);
      if (result.ok) setLinearKeyDraft('');
    } catch (error) {
      const message = (error as Error).message;
      setLinearNote(message);
      setErrors([message]);
    } finally {
      setLinearConnection(await api.linear.state());
      setLinearBusy(false);
    }
  };

  const clearLinearKey = useConfirmAction(
    'Remove the stored Linear API key? New Linear-backed runs will be unavailable.',
    async (): Promise<void> => {
      await runLinearAction(() => api.linear.clearApiKey());
    },
  );

  const runMaintenance = async (work: () => Promise<string>): Promise<void> => {
    setMaintenanceBusy(true);
    try {
      setMaintenanceNote(await work());
      setErrors([]);
    } catch (e) {
      setErrors([(e as Error).message]);
    } finally {
      setMaintenanceBusy(false);
    }
  };

  const applyRetentionAction = useConfirmAction(
    () => {
      const days = settings?.retentionDays;
      return `Apply retention now? This permanently deletes run history older than ${days} day${days === 1 ? '' : 's'}. Trace data cannot be restored.`;
    },
    async (): Promise<void> => {
      await runMaintenance(async () => {
        const report = await api.maintenance.applyRetention();
        return `Deleted ${report.runsDeleted} run${report.runsDeleted === 1 ? '' : 's'}.`;
      });
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
      await runMaintenance(async () => {
        await api.maintenance.compact();
        return 'Trace databases compacted.';
      });
    },
  );

  useEffect(() => {
    if (pane === 'app') void loadOrphans();
  }, [pane]);

  const hiddenCount = settings?.hiddenModelIds?.length ?? 0;

  const resetHiddenModels = useConfirmAction(
    'Show all hidden models again? They will reappear in every picker.',
    async (): Promise<void> => {
      await patchSettings({ hiddenModelIds: [] });
      await refreshModels();
    },
    { confirmLabel: 'Reset' },
  );

  const hideModel = async (modelId: string): Promise<void> => {
    const current = settings?.hiddenModelIds ?? [];
    const next = [...new Set([...current, modelId])];
    await patchSettings({ hiddenModelIds: next });
    await refreshModels();
  };

  const filteredModels = useMemo(() => {
    const q = modelFilter.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) =>
        m.displayName.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q),
    );
  }, [models, modelFilter]);

  // Null for `inherit` or a model the catalog no longer offers, where the
  // effort picker has no capability list to filter by and shows every level.
  const defaultModelInfo = useMemo(
    () => modelForEffortPicker(settings?.defaultModel, models),
    [models, settings?.defaultModel],
  );
  const helperModelInfo = useMemo(
    () => modelForEffortPicker(settings?.helperModel, models, settings?.defaultModel),
    [models, settings?.helperModel, settings?.defaultModel],
  );
  const healingModelInfo = useMemo(
    () => modelForEffortPicker(settings?.healingModel, models, settings?.defaultModel),
    [models, settings?.healingModel, settings?.defaultModel],
  );
  const smithModelInfo = useMemo(
    () => modelForEffortPicker(settings?.smithModel, models),
    [models, settings?.smithModel],
  );

  const visibleGroups = useMemo(() => {
    const map = new Map<string, ModelInfo[]>();
    for (const model of filteredModels) {
      const list = map.get(model.provider) ?? [];
      list.push(model);
      map.set(model.provider, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filteredModels]);

  if (!settings) return <div className={styles.settingsScreen} />;

  /* Palette helpers live past the early return so `settings` is non-null. A
     toggle activates without closing the palette — flipping several booleans
     in one visit is the palette's whole point. */
  const toggleChecked = (id: SettingsToggleDef['id']): boolean =>
    id === 'dockBadge' ? settings.dockBadge : settings.notifications[id];
  const applyToggle = (def: SettingsToggleDef): void => {
    if (def.id === 'dockBadge') {
      void set({ dockBadge: !settings.dockBadge });
      return;
    }
    const key = def.id;
    void set({ notifications: { ...settings.notifications, [key]: !settings.notifications[key] } });
  };
  const palActivate = (entry: PalEntry): void => {
    if (entry.kind === 'toggle') {
      applyToggle(entry.def);
      return;
    }
    jumpTo(entry.hit.pane, entry.hit.sectionId);
  };
  const onPalKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (palEntries.length === 0) return;
      e.preventDefault();
      setPalIdx(
        (palSel + (e.key === 'ArrowDown' ? 1 : -1) + palEntries.length) % palEntries.length,
      );
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const entry = palEntries[palSel];
      if (entry) palActivate(entry);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setPalOpen(false);
    }
  };

  // The curated rows, plus any provider pi already holds a credential for, so a
  // key configured outside this pane is still visible and clearable. Bridge
  // providers are excluded: their credential is an account, not a key, and the
  // Subscriptions section above already owns it.
  const keyRows = [
    ...KEY_PROVIDERS,
    ...storedKeys
      .filter(
        (key) =>
          !KEY_PROVIDERS.some((known) => known.id === key.providerId) &&
          !key.providerId.startsWith('bridge-'),
      )
      .map((key) => ({ id: key.providerId, label: key.providerId, icon: key.providerId })),
  ];

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
        {/* ── rail: grouped panes with search; detail scrolls beside it ── */}
        <div className={styles.settingsLayout}>
          <aside className={styles.settingsRail}>
            <div className={styles.railSearch}>
              <input
                className={styles.railSearchInput}
                value={searchQ}
                placeholder="Search settings"
                aria-label="Search settings"
                aria-keyshortcuts="Meta+K Control+K"
                spellCheck={false}
                data-testid="settings-search"
                onChange={(e) => setSearchQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && searchHits[0]) {
                    jumpTo(searchHits[0].pane, searchHits[0].sectionId);
                  }
                  if (e.key === 'Escape' && searchQ) {
                    // A bare Escape blurs fields app-wide; clearing the query is
                    // the more specific intent here.
                    e.preventDefault();
                    e.stopPropagation();
                    setSearchQ('');
                  }
                }}
              />
              <kbd className={styles.railSearchKbd} aria-hidden>
                ⌘K
              </kbd>
              {searchQ.trim() && (
                <div className={styles.searchPop} role="listbox" aria-label="Matching settings">
                  {searchHits.length === 0 ? (
                    <p className={styles.searchEmpty}>Nothing matches “{searchQ.trim()}”.</p>
                  ) : (
                    searchHits.map((h) => (
                      <button
                        key={`${h.pane}:${h.sectionId ?? 'pane'}`}
                        type="button"
                        role="option"
                        aria-selected={false}
                        className={styles.searchItem}
                        onClick={() => jumpTo(h.pane, h.sectionId)}
                      >
                        <span className={styles.searchItemTitle}>
                          <Highlight text={h.title} q={searchQ} />
                        </span>
                        <span className={styles.searchItemMeta}>
                          {h.paneLabel}
                          {h.sectionId ? '' : ' · pane'}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
            <nav
              className={styles.settingsNav}
              role="tablist"
              aria-label="Settings sections"
              aria-orientation="vertical"
              onKeyDown={onTablistKey}
            >
              {RAIL_GROUPS.map((group) => {
                const items = PANES.filter(
                  (p) => group.items.includes(p.id) && paneMatchesQuery(p.id, searchQ),
                );
                if (items.length === 0) return null;
                return (
                  <div className={styles.railGroup} key={group.label}>
                    <p className={styles.railHead}>{group.label}</p>
                    {items.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        role="tab"
                        aria-selected={pane === p.id}
                        tabIndex={pane === p.id ? 0 : -1}
                        className={`${styles.railItem} ${pane === p.id ? styles.on : ''}`}
                        onClick={() => setPaneLive(p.id)}
                        data-testid={`settings-tab-${p.id}`}
                      >
                        <Highlight text={p.label} q={searchQ} />
                      </button>
                    ))}
                  </div>
                );
              })}
            </nav>
          </aside>

          <div className={styles.settingsScroll}>
            <div className={styles.settingsPage}>
              {pane === 'app' && (
                <PaneBody>
                  {() => (
                    <>
                      <Section label="Checks" note="What Foundry found on this machine at launch.">
                        <DoctorList
                          checks={checks}
                          title="Environment checks"
                          onRecheck={() => void api.doctor.run().then(setChecks)}
                          onOpenSettings={(next) => setPaneLive(next as Pane)}
                        />
                      </Section>

                      <Section
                        label="Appearance"
                        note="Choose the palette Foundry uses across the desktop."
                      >
                        <Field
                          label="Theme"
                          className={styles.settingsNarrow}
                          hint="Saved automatically and applied immediately."
                        >
                          <Dropdown
                            value={settings.theme}
                            options={[
                              { value: 'dark', label: 'Dark' },
                              { value: 'light', label: 'Light' },
                            ]}
                            aria-label="Theme"
                            data-testid="settings-theme"
                            onChange={(next) => void set({ theme: next as AppTheme })}
                          />
                        </Field>
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

                      <Section
                        label="Software updates"
                        note="Foundry checks only when you ask it to."
                      >
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
                                Foundry v{updateStatus.version} is available, download it when
                                ready.
                              </span>
                            )}
                          </Field>
                          <span
                            className={`${styles.settingsPill} ${updateTone === 'ok' ? styles.ok : updateTone === 'bad' ? styles.bad : styles.info}`}
                          >
                            {updateText}
                          </span>
                        </div>
                        {(updateStatus.stage === 'downloading' ||
                          updateStatus.stage === 'ready') && (
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
                            <Button
                              variant="primary"
                              size="sm"
                              onClick={() => void installUpdate()}
                            >
                              Restart to install
                            </Button>
                          ) : updateStatus.stage === 'available' ? (
                            <Button
                              variant="primary"
                              size="sm"
                              onClick={() => void downloadUpdate()}
                            >
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
                        label="Phone"
                        note="A paired phone can watch runs, start one, and open the PR."
                      >
                        <div className={styles.settingsToggles}>
                          <Toggle
                            label="Serve the companion host on this network"
                            hint={
                              companion?.running && companion.origin
                                ? `Serving on ${companion.origin} · Protocol v${companion.protocolVersion} — pairing is QR-only.${
                                    companion.detail ? ` Note: ${companion.detail}.` : ''
                                  }`
                                : (companion?.detail ??
                                  'Off. Nothing listens until you turn this on, and pairing is QR-only.')
                            }
                            checked={!!companion?.running}
                            onChange={(value) => {
                              if (!companionBusy) void toggleCompanion(value);
                            }}
                          />
                        </div>

                        {companion?.running && (
                          <>
                            {companion.devices.length === 0 ? (
                              <PairingQr
                                payload={pairingPayload}
                                copied={copiedPayload}
                                onCopy={copyPairingPayload}
                                onRefresh={() => void loadPairingPayload(true)}
                                lead={
                                  <>
                                    <span className={`${styles.settingsPill} ${styles.info}`}>
                                      Waiting for a phone…
                                    </span>
                                    <strong style={{ marginTop: '6px' }}>
                                      Pair your Android phone
                                    </strong>
                                    <p className={styles.hint}>
                                      Open Foundry on your Android phone and scan this code, or copy
                                      the pairing payload to paste.
                                    </p>
                                  </>
                                }
                              />
                            ) : (
                              <div className={styles.settingsFields}>
                                <div className={styles.pairedDevicesHeader}>
                                  <div
                                    style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
                                  >
                                    <strong className={styles.settingsStrong}>
                                      Paired devices ({companion.devices.length})
                                    </strong>
                                    <span className={`${styles.settingsPill} ${styles.ok}`}>
                                      Paired
                                    </span>
                                  </div>
                                  <span className={styles.hint}>
                                    Connected phones can watch runs and start new runs.
                                  </span>
                                </div>
                                {companion.devices.map((device) => (
                                  <div key={device.deviceId} className={styles.settingsSpread}>
                                    <Field>
                                      <strong className={styles.settingsStrong}>
                                        {device.name}
                                      </strong>
                                      <span className={styles.hint}>
                                        Paired {new Date(device.pairedAt).toLocaleDateString()}
                                        {device.lastSeenAt
                                          ? ` · last seen ${new Date(device.lastSeenAt).toLocaleString()}`
                                          : ' · never connected'}
                                      </span>
                                    </Field>
                                    <Button
                                      size="sm"
                                      onClick={() =>
                                        void api.companion
                                          .unpair(device.deviceId)
                                          .then(() => api.companion.state())
                                          .then((st) => {
                                            setCompanion(st);
                                            if (st.devices.length === 0) void loadPairingPayload();
                                          })
                                      }
                                    >
                                      Unpair
                                    </Button>
                                  </div>
                                ))}

                                <div style={{ marginTop: '8px' }}>
                                  <Button
                                    size="sm"
                                    onClick={() => {
                                      setShowPairMore((prev) => !prev);
                                      if (!showPairMore && !pairingPayload)
                                        void loadPairingPayload();
                                    }}
                                  >
                                    {showPairMore ? 'Hide pairing QR code' : 'Pair another phone…'}
                                  </Button>
                                </div>

                                {showPairMore && (
                                  <PairingQr
                                    payload={pairingPayload}
                                    copied={copiedPayload}
                                    onCopy={copyPairingPayload}
                                    onRefresh={() => void loadPairingPayload(true)}
                                    lead={
                                      <>
                                        <strong>Pair an additional phone</strong>
                                        <p className={styles.hint}>
                                          Scan this QR code in Foundry on another phone.
                                        </p>
                                      </>
                                    }
                                  />
                                )}
                              </div>
                            )}
                          </>
                        )}
                      </Section>

                      <Section label="Application" note="Quit or relaunch the desktop app.">
                        <p className={styles.hint}>
                          Theme and other preferences save automatically; relaunch only when you
                          need a fresh app process or have installed an update.
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
                </PaneBody>
              )}
              {pane === 'models' && (
                <PaneBody>
                  {() => (
                    <>
                      <Section
                        label="Providers"
                        note="Where the models an agent phase runs on come from."
                      >
                        <p className={styles.settingsLead}>
                          Foundry runs every agent phase in-process on pi, and a model reaches the
                          pickers only once pi can reach its provider. Connect a subscription
                          through the Bridge, or store a direct API key. Keys live in pi&rsquo;s own
                          credential store on this Mac, never in Foundry&rsquo;s settings file.
                        </p>
                        <div className={styles.settingsSubrow}>
                          <span
                            className={`${styles.settingsPill} ${
                              bridge ? (bridge.running ? styles.ok : styles.bad) : styles.plain
                            }`}
                            data-testid="bridge-status"
                          >
                            {bridge
                              ? bridge.running
                                ? `Bridge active · serving on ${bridge.port}`
                                : 'Bridge unavailable'
                              : 'Bridge starting…'}
                          </span>
                        </div>
                        {bridge && !bridge.running && (bridge.reason || bridge.detail) && (
                          <p className={styles.settingsWarn}>
                            {/* `detail` states only the remedy; the reason is prefixed
                          here rather than duplicated into it. */}
                            {bridge.reason
                              ? BRIDGE_UNAVAILABLE_COPY[bridge.reason]
                              : 'the Bridge is not serving'}
                            {bridge.detail ? `: ${bridge.detail}` : ''}
                          </p>
                        )}
                      </Section>

                      <Section
                        label="Subscriptions"
                        note="Sign in with a plan you already pay for. The Bridge holds the account; Foundry never sees a token."
                      >
                        <div className={styles.providerList}>
                          {(bridge?.providers ?? []).map((provider) => {
                            const busyKey = `provider:${provider.id}`;
                            const expired = provider.accounts.some((account) => account.expired);
                            const allDisabled =
                              provider.accounts.length > 0 &&
                              provider.accounts.every((account) => account.disabled);
                            const status = provider.loginInFlight
                              ? 'connecting'
                              : expired
                                ? 'expired'
                                : allDisabled
                                  ? 'disabled'
                                  : provider.authenticated
                                    ? 'connected'
                                    : 'not connected';
                            const tone = provider.loginInFlight
                              ? styles.info
                              : expired || allDisabled
                                ? styles.bad
                                : provider.authenticated
                                  ? styles.ok
                                  : styles.plain;
                            return (
                              <div
                                key={provider.id}
                                className={styles.providerCard}
                                data-testid={`provider-card-${provider.id}`}
                              >
                                <div className={styles.providerHead}>
                                  <ProviderIcon provider={provider.icon} size={18} />
                                  <h3>{provider.label}</h3>
                                  <span className={`${styles.settingsPill} ${tone}`}>{status}</span>
                                </div>
                                {provider.accounts.length > 0 ? (
                                  <ul className={styles.providerAccounts}>
                                    {provider.accounts.map((account) => (
                                      <li key={account.id}>
                                        <span className="mono">{account.label}</span>
                                        <span className="faint">
                                          {account.expired
                                            ? 'the sign-in expired'
                                            : account.expiresAt
                                              ? `valid until ${account.expiresAt}`
                                              : 'no expiry reported'}
                                          {account.disabled ? ' · disabled' : ''}
                                        </span>
                                      </li>
                                    ))}
                                  </ul>
                                ) : (
                                  <p className={styles.hint}>
                                    Connecting opens {provider.label} in your browser. The account
                                    lands here on its own once you finish signing in.
                                  </p>
                                )}
                                <div className={styles.settingsBtnrow}>
                                  {provider.loginInFlight ? (
                                    <Button
                                      size="sm"
                                      onClick={() => void cancelProviderLogin(provider.id)}
                                    >
                                      Cancel sign-in
                                    </Button>
                                  ) : (
                                    <Button
                                      size="sm"
                                      variant={provider.authenticated ? undefined : 'primary'}
                                      disabled={!!providerBusy || !bridge?.running}
                                      title={
                                        bridge?.running
                                          ? undefined
                                          : 'The Bridge did not start with Foundry. Relaunch to retry.'
                                      }
                                      onClick={() =>
                                        void runProviderAction(busyKey, () =>
                                          api.bridge.connect(provider.id),
                                        )
                                      }
                                    >
                                      {providerBusy === busyKey
                                        ? 'Opening…'
                                        : expired
                                          ? 'Reconnect'
                                          : provider.authenticated
                                            ? 'Add another account'
                                            : 'Connect'}
                                    </Button>
                                  )}
                                  {provider.accounts.length > 0 && (
                                    <Button
                                      size="sm"
                                      variant="danger"
                                      disabled={!!providerBusy}
                                      onClick={() =>
                                        void disconnectProvider(provider.id, provider.label)
                                      }
                                    >
                                      Disconnect
                                    </Button>
                                  )}
                                </div>
                                {providerNotes[busyKey] && (
                                  <p className={styles.hint}>{providerNotes[busyKey]}</p>
                                )}
                              </div>
                            );
                          })}
                          {!bridge?.providers.length && (
                            <p className="faint">
                              No subscription providers are available in this build. Direct API keys
                              still work.
                            </p>
                          )}
                        </div>
                      </Section>

                      <Section
                        label="API keys"
                        note="For a provider you hold a key for rather than a subscription."
                      >
                        <div className={styles.providerList}>
                          {keyRows.map((row) => {
                            const busyKey = `key:${row.id}`;
                            const stored = storedKeys.some((key) => key.providerId === row.id);
                            const draft = keyDrafts[row.id] ?? '';
                            return (
                              <div
                                key={row.id}
                                className={styles.providerCard}
                                data-testid={`provider-key-${row.id}`}
                              >
                                <div className={styles.providerHead}>
                                  <ProviderIcon provider={row.icon} size={18} />
                                  <h3>{row.label}</h3>
                                  <span
                                    className={`${styles.settingsPill} ${stored ? styles.ok : styles.plain}`}
                                  >
                                    {stored ? 'key set' : 'no key'}
                                  </span>
                                </div>
                                <Field
                                  label="API key"
                                  htmlFor={`provider-key-input-${row.id}`}
                                  hint={
                                    stored
                                      ? 'A key is stored. Typing a new one replaces it; the stored value is never shown.'
                                      : 'Stored by pi on this Mac. Foundry keeps no copy.'
                                  }
                                >
                                  <TextInput
                                    id={`provider-key-input-${row.id}`}
                                    aria-label={`${row.label} API key`}
                                    type="password"
                                    autoComplete="off"
                                    spellCheck={false}
                                    mono
                                    value={draft}
                                    placeholder={stored ? '••••••••' : 'paste a key'}
                                    onChange={(e) =>
                                      setKeyDrafts((drafts) => ({
                                        ...drafts,
                                        [row.id]: e.target.value,
                                      }))
                                    }
                                  />
                                </Field>
                                <div className={styles.settingsBtnrow}>
                                  <Button
                                    size="sm"
                                    variant="primary"
                                    disabled={!!providerBusy || !draft.trim()}
                                    onClick={() => void saveProviderKey(row.id)}
                                  >
                                    {providerBusy === busyKey
                                      ? 'Saving…'
                                      : stored
                                        ? 'Replace'
                                        : 'Save'}
                                  </Button>
                                  {stored && (
                                    <Button
                                      size="sm"
                                      variant="danger"
                                      disabled={!!providerBusy}
                                      onClick={() => void clearProviderKey(row.id, row.label)}
                                    >
                                      Clear
                                    </Button>
                                  )}
                                </div>
                                {providerNotes[busyKey] && (
                                  <p className={styles.hint}>{providerNotes[busyKey]}</p>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </Section>

                      <Section label="Models" note="What every picker in the app will offer.">
                        <p className={styles.settingsLead}>
                          Hide a model to remove it from every picker. Hidden models are gone until
                          you reset.
                        </p>
                        <div className={styles.settingsSubrow}>
                          <p className={styles.settingsStatic} data-testid="providers-model-count">
                            {models.length
                              ? `${models.length} model${models.length === 1 ? '' : 's'} reachable${
                                  hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ''
                                }`
                              : hiddenCount > 0
                                ? 'All models are hidden. Reset to show them again.'
                                : 'No models reachable yet — connect a provider or store a key above.'}
                          </p>
                          <div className={styles.settingsBtnrow}>
                            <Button
                              size="sm"
                              disabled={hiddenCount === 0}
                              data-testid="reset-hidden-models"
                              onClick={() => void resetHiddenModels()}
                            >
                              Reset hidden models
                            </Button>
                            <Button size="sm" onClick={() => void refreshModels()}>
                              Refresh models
                            </Button>
                          </div>
                        </div>
                        {models.length > 0 && (
                          <>
                            <TextInput
                              value={modelFilter}
                              placeholder="Filter models…"
                              onChange={(e) => setModelFilter(e.target.value)}
                            />
                            {filteredModels.length === 0 ? (
                              <p className={styles.hint}>No reachable models match that filter.</p>
                            ) : (
                              <div className={styles.modelHideList}>
                                {visibleGroups.map(([provider, groupModels]) => (
                                  <div key={provider} className={styles.modelHideGroup}>
                                    <div className={styles.modelHideGroupHeader}>
                                      <ProviderIcon provider={provider} size={14} />
                                      <span>{provider}</span>
                                    </div>
                                    <div className={styles.modelHideRows}>
                                      {groupModels.map((m) => (
                                        <div key={m.id} className={styles.modelHideRow}>
                                          <div className={styles.modelHideInfo}>
                                            <ProviderIcon provider={m.provider} size={16} />
                                            <span className={styles.modelHideName}>
                                              {m.displayName || modelLabel(m.id)}
                                            </span>
                                            {m.contextWindow ? (
                                              <span className={styles.modelHideContext}>
                                                {Math.round(m.contextWindow / 1000)}k context
                                              </span>
                                            ) : null}
                                          </div>
                                          <Button
                                            size="sm"
                                            data-testid={`hide-model-${m.id}`}
                                            onClick={() => void hideModel(m.id)}
                                          >
                                            Hide
                                          </Button>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </>
                        )}
                      </Section>
                      <Section label="Agent defaults" note="What an agent set to inherit gets.">
                        <p className={styles.settingsLead}>
                          Used by any agent that inherits model or reasoning. A per-agent choice
                          always wins. Changing a model resets an unsupported reasoning effort to
                          that model&rsquo;s default.
                        </p>
                      </Section>
                      <Section label="Model" note="Every model a connected provider offers.">
                        <div className={styles.settingsFields}>
                          <Field
                            label="Default model"
                            hint="The first model a connected provider offers, until you pin one."
                          >
                            <ModelPicker
                              value={settings.defaultModel}
                              models={models}
                              allowInherit
                              inheritLabel="First reachable model"
                              emptyHint="No models are reachable. Connect a provider or store an API key under Providers, then refresh."
                              onChange={(v) =>
                                void set({
                                  defaultModel: v,
                                  defaultReasoningEffort: normalizeReasoningEffortForModelChoice(
                                    settings.defaultReasoningEffort,
                                    v,
                                    models,
                                  ),
                                  ...(settings.helperModel === 'inherit' && {
                                    helperReasoningEffort: normalizeReasoningEffortForModelChoice(
                                      settings.helperReasoningEffort,
                                      'inherit',
                                      models,
                                      v,
                                    ),
                                  }),
                                  ...(settings.healingModel === 'inherit' && {
                                    healingReasoningEffort: normalizeReasoningEffortForModelChoice(
                                      settings.healingReasoningEffort,
                                      'inherit',
                                      models,
                                      v,
                                    ),
                                  }),
                                })
                              }
                            />
                          </Field>
                          <Field
                            label="Default reasoning effort"
                            hint="Only the levels the chosen model offers."
                          >
                            <ReasoningEffortPicker
                              value={settings.defaultReasoningEffort}
                              model={defaultModelInfo}
                              onChange={(effort) => void set({ defaultReasoningEffort: effort })}
                              data-testid="settings-default-effort"
                            />
                          </Field>
                        </div>
                      </Section>
                      <Section
                        label="Helper tasks"
                        note="Used for project detection and Agent Readiness."
                      >
                        <div className={styles.settingsFields}>
                          <Field label="Helper model">
                            <ModelPicker
                              value={settings.helperModel}
                              models={models}
                              allowInherit
                              inheritLabel="Same as default model"
                              emptyHint="No models are reachable. Connect a provider under Providers."
                              onChange={(v) =>
                                void set({
                                  helperModel: v,
                                  helperReasoningEffort: normalizeReasoningEffortForModelChoice(
                                    settings.helperReasoningEffort,
                                    v,
                                    models,
                                    settings.defaultModel,
                                  ),
                                })
                              }
                            />
                          </Field>
                          <Field
                            label="Helper reasoning effort"
                            hint="Only the levels the helper model offers."
                          >
                            <ReasoningEffortPicker
                              value={settings.helperReasoningEffort}
                              model={helperModelInfo}
                              onChange={(effort) => void set({ helperReasoningEffort: effort })}
                              data-testid="settings-helper-effort"
                            />
                          </Field>
                        </div>
                      </Section>
                      <Section
                        label="Healing"
                        note="Repairs a failed check before the failure escalates."
                      >
                        <p className={styles.settingsLead}>
                          When a command phase fails, this model gets a bounded turn in the
                          run&rsquo;s worktree to make the smallest fix. The exact command is re-run
                          after every attempt, and only exit 0 counts. If it cannot be fixed, the
                          failure escalates the way it always has.
                        </p>
                        <div className={styles.settingsFields}>
                          <Field label="Healing model">
                            <ModelPicker
                              value={settings.healingModel}
                              models={models}
                              allowInherit
                              inheritLabel="Same as default model"
                              emptyHint="No models are reachable. Connect a provider under Providers."
                              onChange={(v) =>
                                void set({
                                  healingModel: v,
                                  healingReasoningEffort: normalizeReasoningEffortForModelChoice(
                                    settings.healingReasoningEffort,
                                    v,
                                    models,
                                    settings.defaultModel,
                                  ),
                                })
                              }
                            />
                          </Field>
                          <Field
                            label="Healing reasoning effort"
                            hint="Only the levels the healing model offers."
                          >
                            <ReasoningEffortPicker
                              value={settings.healingReasoningEffort}
                              model={healingModelInfo}
                              onChange={(effort) => void set({ healingReasoningEffort: effort })}
                              data-testid="settings-healing-effort"
                            />
                          </Field>
                        </div>
                      </Section>
                      <Section label="Smith" note="The model the in-app chat runs on.">
                        <div className={styles.settingsFields}>
                          <Field
                            label="Model"
                            hint="What a new Smith chat opens on. The header picker can still switch mid-conversation. Smith does not pick for you: until this is set, it will not send."
                            error={
                              settings.smithModel === MODEL_UNSET ? MODEL_UNSET_MESSAGE : undefined
                            }
                          >
                            <ModelPicker
                              value={settings.smithModel}
                              models={models}
                              allowInherit
                              inheritLabel={SMITH_MODEL_UNSET_LABEL}
                              emptyHint={SMITH_NO_PROVIDER_COPY}
                              onChange={(v) =>
                                void set({
                                  smithModel: v,
                                  smithReasoningEffort: normalizeReasoningEffortForModelChoice(
                                    settings.smithReasoningEffort,
                                    v,
                                    models,
                                  ),
                                })
                              }
                            />
                          </Field>
                          <Field
                            label="Default reasoning effort"
                            hint="Only the levels the chosen model offers. A stored level it drops falls back to that model's default."
                          >
                            <ReasoningEffortPicker
                              value={settings.smithReasoningEffort}
                              model={smithModelInfo}
                              onChange={(effort) => void set({ smithReasoningEffort: effort })}
                              data-testid="settings-smith-effort"
                            />
                          </Field>
                        </div>
                      </Section>
                      <Section
                        label="Pull requests"
                        note="Who drafts a PR when a pipeline asks for one."
                      >
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
                      <Section label="Advanced" note="Stable engine policy and context limits.">
                        <div className={styles.settingsFields}>
                          <Field
                            label="Report retries"
                            hint="Correction messages sent when a report will not parse."
                          >
                            <TextInput
                              type="number"
                              min={0}
                              max={5}
                              value={FIXED_ENGINE_DEFAULTS.envelopeRetries}
                              disabled
                            />
                          </Field>
                          <Field
                            label="Check retries"
                            hint="Attempts to fix a check violation before the phase fails."
                          >
                            <TextInput
                              type="number"
                              min={0}
                              max={5}
                              value={FIXED_ENGINE_DEFAULTS.gateRetries}
                              disabled
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
                            hint="Fixed engine policy: rewind the session to its phase-start state after this many failed corrections."
                          >
                            <TextInput
                              type="number"
                              value={FIXED_ENGINE_DEFAULTS.rewindAfterCorrections}
                              disabled
                            />
                          </Field>
                          <Field
                            label="Run resilience"
                            hint="Pipeline work has no deadline. Transient model errors retry five times with exponential backoff, then continue on the next reachable model."
                          >
                            <TextInput value="No execution deadline" disabled />
                          </Field>
                        </div>
                      </Section>
                    </>
                  )}
                </PaneBody>
              )}

              {pane === 'integrations' && (
                <PaneBody>
                  {() => (
                    <Section
                      label="Linear"
                      note="Use an issue as the immutable source for a manual pipeline run."
                    >
                      <div className={styles.providerCard} data-testid="linear-integration">
                        <div className={styles.providerHead}>
                          <h3>Linear issue orchestration</h3>
                          <span
                            className={`${styles.settingsPill} ${
                              linearConnection?.keySet ? styles.ok : styles.plain
                            }`}
                          >
                            {linearConnection?.keySet ? 'key set' : 'not connected'}
                          </span>
                        </div>
                        <p className={styles.settingsLead}>
                          Foundry validates the key before saving it. The encrypted value uses this
                          Mac&rsquo;s credential storage and never enters settings.json or a run
                          trace.
                        </p>
                        <Field
                          label="Personal API key"
                          htmlFor="linear-api-key"
                          hint={
                            linearConnection?.keySet
                              ? 'A key is stored. Saving a new valid key replaces it; the old key remains if validation fails.'
                              : 'Create a personal API key in Linear → Security & access.'
                          }
                        >
                          <TextInput
                            id="linear-api-key"
                            type="password"
                            autoComplete="off"
                            spellCheck={false}
                            mono
                            value={linearKeyDraft}
                            placeholder={linearConnection?.keySet ? '••••••••' : 'lin_api_…'}
                            onChange={(event) => setLinearKeyDraft(event.target.value)}
                          />
                        </Field>
                        <div className={styles.settingsBtnrow}>
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={linearBusy || !linearKeyDraft.trim()}
                            onClick={() =>
                              void runLinearAction(() => api.linear.setApiKey(linearKeyDraft))
                            }
                          >
                            {linearBusy
                              ? 'Checking…'
                              : linearConnection?.keySet
                                ? 'Validate & replace'
                                : 'Validate & save'}
                          </Button>
                          {linearConnection?.keySet && (
                            <>
                              <Button
                                size="sm"
                                disabled={linearBusy}
                                onClick={() => void runLinearAction(() => api.linear.test())}
                              >
                                Test connection
                              </Button>
                              <Button
                                size="sm"
                                variant="danger"
                                disabled={linearBusy}
                                onClick={() => void clearLinearKey()}
                              >
                                Remove key
                              </Button>
                            </>
                          )}
                        </div>
                        {(linearNote || linearConnection?.detail) && (
                          <p className={styles.hint}>{linearNote || linearConnection?.detail}</p>
                        )}
                        <p className={styles.hint}>
                          Choose an issue and map its team workflow from Runs → Linear issue.
                          Foundry revalidates those state IDs before every start.
                        </p>
                      </div>
                    </Section>
                  )}
                </PaneBody>
              )}

              {pane === 'project' && (
                <PaneBody>
                  {() => (
                    <>
                      {projectDraft ? (
                        <>
                          <Section
                            label="Project"
                            note="Where Foundry runs, and what it may touch."
                          >
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
                          <Section
                            label="Git"
                            note="Every run branches from the base ref. Update it from the remote here."
                          >
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
                            <BaseSyncBar
                              projectId={projectDraft.id}
                              baseRef={project?.baseRef ?? projectDraft.baseRef}
                              variant="settings"
                            />
                          </Section>
                          <Section
                            label="Commands"
                            note="What a pipeline can run, and who detects it."
                          >
                            <ProjectCommands
                              project={projectDraft}
                              onChange={(commands) =>
                                setProjectDraft({ ...projectDraft, commands })
                              }
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
                                  boundary says. <code>.git/</code>, CI config, and lockfiles are
                                  always protected.
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
                                  Change scope in <strong>Design</strong> (<kbd>⌘3</kbd>), on the
                                  Agents or Pipelines tab — the badge beside the heading. It is set
                                  there because that is where the edits it affects are made.
                                </span>
                              </Field>
                            </div>
                          </Section>
                          <div className={styles.settingsFoot}>
                            <Button variant="danger" onClick={() => void removeProject()}>
                              Remove project
                            </Button>
                            <span className={styles.settingsAutosave}>
                              Changes save automatically
                            </span>
                          </div>
                        </>
                      ) : (
                        <div className={styles.settingsEmpty}>
                          <p className="faint">
                            No project selected. Add a git repository you already have, or create a
                            new one on GitHub.
                          </p>
                          <Button variant="primary" onClick={() => void addProject()}>
                            Add a project…
                          </Button>
                          {onNewProject && (
                            <Button onClick={onNewProject}>Create a new project…</Button>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </PaneBody>
              )}
              {pane === 'app' && (
                <PaneBody>
                  {() => (
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
                            <Button
                              disabled={maintenanceBusy}
                              onClick={() => void applyRetention()}
                            >
                              {maintenanceBusy ? 'Working…' : 'Apply retention now'}
                            </Button>
                            <Button disabled={maintenanceBusy} onClick={() => void compact()}>
                              {maintenanceBusy ? 'Working…' : 'Compact trace databases'}
                            </Button>
                          </div>
                        </div>
                      </Section>
                      <Section
                        label="Leftover worktrees"
                        note="Left behind by a crashed or killed run."
                      >
                        <p className={styles.hint}>
                          A worktree left behind by a crashed or killed run. Removing one deletes
                          its branch and any uncommitted work in it.
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
                      <Section label="Foundry" note="A software factory you can watch.">
                        <p className={styles.settingsLead}>
                          A software factory you can watch. Pipelines are data, agents are
                          configuration, and every phase leaves evidence you can read.
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
                            <dd className="mono">pi, in this process</dd>
                          </div>
                          <div className={styles.settingsFact}>
                            <dt>Reachable models</dt>
                            <dd className="mono">{models.length}</dd>
                          </div>
                          <div className={styles.settingsFact}>
                            <dt>Projects</dt>
                            <dd className="mono">{projects.length}</dd>
                          </div>
                        </dl>
                      </Section>
                      <Section label="Elsewhere" note="Providers and the cinematic intro.">
                        <div className={styles.settingsBtnrow}>
                          <Button size="sm" onClick={() => setPaneLive('models')}>
                            Manage providers
                          </Button>
                          <Button size="sm" onClick={() => void replayIntro()}>
                            Replay intro
                          </Button>
                        </div>
                        <p className={styles.hint}>
                          Replay intro walks the cinematic onboarding again: agents, providers,
                          environment checks, and your first project.
                        </p>
                      </Section>
                    </>
                  )}
                </PaneBody>
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

        {palOpen && (
          <div
            className={styles.palScrim}
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setPalOpen(false);
            }}
          >
            <div
              className={styles.pal}
              role="dialog"
              aria-modal="true"
              aria-label="Search settings"
              data-testid="settings-palette"
            >
              <div className={styles.palRow}>
                <input
                  className={styles.palInput}
                  autoFocus
                  value={palQ}
                  placeholder="Type a setting or action…"
                  aria-label="Search settings"
                  spellCheck={false}
                  data-testid="settings-palette-input"
                  onChange={(e) => {
                    setPalQ(e.target.value);
                    setPalIdx(0);
                  }}
                  onKeyDown={onPalKeyDown}
                />
                <kbd className={styles.palKbd}>esc</kbd>
              </div>
              <div className={styles.palList} role="listbox" aria-label="Settings results">
                {palEntries.length === 0 && (
                  <p className={styles.searchEmpty}>Nothing matches “{palQ.trim()}”.</p>
                )}
                {palEntries.map((entry, i) =>
                  entry.kind === 'toggle' ? (
                    <div
                      key={entry.def.id}
                      role="option"
                      aria-selected={i === palSel}
                      className={`${styles.palItem} ${i === palSel ? styles.on : ''}`}
                      onClick={() => palActivate(entry)}
                      onMouseEnter={() => setPalIdx(i)}
                    >
                      <span className={styles.palItemTitle}>{entry.def.title}</span>
                      <input
                        type="checkbox"
                        className={styles.settingsSwitch}
                        checked={toggleChecked(entry.def.id)}
                        onChange={() => palActivate(entry)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={entry.def.title}
                      />
                    </div>
                  ) : (
                    <div
                      key={`${entry.hit.pane}:${entry.hit.sectionId ?? 'pane'}`}
                      role="option"
                      aria-selected={i === palSel}
                      className={`${styles.palItem} ${i === palSel ? styles.on : ''}`}
                      onClick={() => palActivate(entry)}
                      onMouseEnter={() => setPalIdx(i)}
                    >
                      <span className={styles.palItemTitle}>
                        <Highlight text={entry.hit.title} q={palQ} />
                      </span>
                      <span className={styles.palItemMeta}>
                        {entry.hit.pane === pane && entry.hit.sectionId
                          ? 'This pane'
                          : entry.hit.paneLabel}
                      </span>
                    </div>
                  ),
                )}
              </div>
              <div className={styles.palFoot}>
                <span>
                  <kbd className={styles.palKbd}>↑↓</kbd> navigate
                </span>
                <span>
                  <kbd className={styles.palKbd}>↵</kbd> select
                </span>
                <span>
                  <kbd className={styles.palKbd}>esc</kbd> close
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
