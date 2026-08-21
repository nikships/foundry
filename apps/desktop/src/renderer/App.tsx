import { useCallback, useEffect, useRef, useState } from 'react';
import { api, menu } from './api.js';
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts.js';
import { AppProvider, useApp } from './stores/app.js';
import Sidebar from './components/layout/Sidebar.js';
import { FoundryGlyph } from './components/media/BrandIcon.js';
import RunsScreen from './screens/RunsScreen.js';
import RunDetailScreen from './screens/RunDetailScreen.js';
import InspectorScreen from './screens/InspectorScreen.js';
import DesignScreen from './screens/DesignScreen.js';
import PullRequestsScreen from './screens/PullRequestsScreen.js';
import SettingsScreen from './screens/SettingsScreen.js';
import OnboardingShell from './screens/onboarding/OnboardingShell.js';
import InterruptSheet from './components/run/InterruptSheet.js';
import NewProjectWizard from './components/project/NewProjectWizard.js';
import ReadinessFlow from './components/readiness/ReadinessFlow.js';
import ConfirmModal from './components/common/ConfirmModal.js';
import UpdateBanner from './components/layout/UpdateBanner.js';
import SmithScreen from './screens/SmithScreen.js';
import { type SmithNavTarget } from './components/smith/SmithProposalCard.js';
import type { ProjectDef, UpdateStatus } from '@shared/types.js';
import type { SmithScreenContext } from '@shared/ipc-contract.js';
import {
  MENU_DESIGN_TABS,
  MENU_VIEWS,
  designTabForEntity,
  type DesignTab,
  type View,
} from './utils/navigation.js';
import { describeScreen } from './view-models/smith-chat-view.js';
import styles from './App.module.css';

function AppInner(): React.JSX.Element {
  const { ready, settings, interrupts, project, refreshAll, refreshScoped, selectProject } =
    useApp();
  const [view, setView] = useState<View>('runs');
  const [runRequest, setRunRequest] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);
  const [readinessProjectId, setReadinessProjectId] = useState('');
  const [openRunId, setOpenRunId] = useState('');
  const [inspectorRunId, setInspectorRunId] = useState('');
  const [settingsPane, setSettingsPane] = useState('general');
  /** ⌘K opens Settings' search palette; the nonce re-raises it on every press. */
  const [settingsPaletteNonce, setSettingsPaletteNonce] = useState(0);
  const [designTab, setDesignTab] = useState<DesignTab>('pipelines');
  /**
   * A descriptor of the screen the operator was on before opening Smith, sent
   * with each `smith:send` so "why did this run fail?" resolves without naming
   * the run. Snapshotted on entry — the Smith screen itself describes nothing.
   */
  const [smithContext, setSmithContext] = useState<SmithScreenContext>({ route: 'runs' });
  // Deep link for the active project's pipeline/agent/envelope editors after a
  // Smith approve. The nonce re-fires the target screen's effect on a repeat.
  const [smithNav, setSmithNav] = useState<(SmithNavTarget & { nonce: number }) | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ stage: 'idle' });
  const [updateDismissedKey, setUpdateDismissedKey] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevStageRef = useRef<UpdateStatus['stage']>('idle');

  const needsOnboarding = ready && settings != null && !settings.onboarded;
  const activeInterrupt = interrupts[0] ?? null;
  const bannerKey = `${updateStatus.stage}:${updateStatus.version ?? ''}`;
  const showBanner = updateStatus.stage !== 'idle' && updateDismissedKey !== bannerKey;

  /** One transient status line, replacing whatever it was showing. */
  const showToast = useCallback((message: string): void => {
    setToast(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(() => {
    void api.updater.getStatus().then((s) => {
      setUpdateStatus(s);
      prevStageRef.current = s.stage;
    });
    return api.on('updater-status', (data) => {
      if (!data) return;
      const next = data as UpdateStatus;
      const prev = prevStageRef.current;
      if (prev === 'checking' && next.stage === 'idle') {
        const isUnpackaged = next.message === 'Updates are disabled in unpackaged builds';
        const msg = isUnpackaged
          ? next.message
          : next.message && next.message !== 'No update available'
            ? next.message
            : "You're up to date";
        showToast(msg ?? "You're up to date");
      }
      prevStageRef.current = next.stage;
      setUpdateStatus(next);
    });
  }, [showToast]);

  // A Smith approve saved the entity; open its editor. The store save already
  // broadcast settings-changed (which refreshes the app), but refresh scoped
  // data too so the target is present before the screen's deep-link effect runs.
  // Every kind Smith can write now has a Design tab, so this no longer detours
  // an envelope through Settings.
  const onSmithApproved = useCallback(
    async (target: SmithNavTarget): Promise<void> => {
      await refreshScoped();
      setSmithNav({ ...target, nonce: Date.now() });
      setDesignTab(designTabForEntity(target.kind));
      setView('design');
    },
    [refreshScoped],
  );

  const handleUpdateDownload = useCallback(async (): Promise<void> => {
    await api.updater.download();
  }, []);
  const handleUpdateRestart = useCallback(async (): Promise<void> => {
    await api.updater.quitAndInstall();
  }, []);
  const handleUpdateRetry = useCallback(async (): Promise<void> => {
    setUpdateDismissedKey(null);
    await api.updater.check();
  }, []);
  const handleUpdateDismiss = useCallback((): void => {
    setUpdateDismissedKey(bannerKey);
  }, [bannerKey]);

  const openRun = (runId: string): void => {
    setOpenRunId(runId);
    setView('runs');
  };

  const go = useCallback((next: View): void => {
    setView(next);
    if (next !== 'runs') setOpenRunId('');
    // Navigating to the Inspector bare means "follow whatever is live"; only
    // a deep link from a run pins it to one run.
    if (next === 'inspector') setInspectorRunId('');
  }, []);

  /** The sidebar's Smith click: snapshot where the operator was, then open the chat. */
  const openSmith = useCallback((): void => {
    if (view !== 'smith') {
      setSmithContext(describeScreen(view, { openRunId, inspectorRunId, designTab, settingsPane }));
    }
    go('smith');
  }, [view, openRunId, inspectorRunId, designTab, settingsPane, go]);

  /** Open Design on a specific tab — used by the menu and by cross-links. */
  const goDesign = useCallback(
    (tab: DesignTab): void => {
      setDesignTab(tab);
      go('design');
    },
    [go],
  );

  const openInspector = (runId: string): void => {
    setInspectorRunId(runId);
    setView('inspector');
  };

  const addProject = useCallback(async (): Promise<void> => {
    const added = await api.projects.add();
    if (added) {
      await refreshAll();
      selectProject(added.id);
      setReadinessProjectId(added.id);
    }
  }, [refreshAll, selectProject]);

  const newProject = useCallback((): void => setCreatingProject(true), []);

  // The wizard has already registered the project; this makes it the one the
  // rest of the app is looking at, so "created" and "selected" are one step.
  const projectCreated = useCallback(
    async (project: ProjectDef): Promise<void> => {
      await refreshAll();
      selectProject(project.id);
      setReadinessProjectId(project.id);
    },
    [refreshAll, selectProject],
  );

  const finishOnboarding = async (): Promise<void> => {
    await api.settings.patch({ onboarded: true });
    await refreshAll();
  };

  // Escape walks back up one level: run detail → the runs list.
  const escapeBack = useCallback((): void => {
    setOpenRunId('');
  }, []);

  const openSettingsSearch = useCallback((): void => {
    go('settings');
    setSettingsPaletteNonce((n) => n + 1);
  }, [go]);

  useGlobalShortcuts({
    onNavigate: go,
    onDesignTab: goDesign,
    onEscape: escapeBack,
    onSettingsSearch: openSettingsSearch,
    enabled: ready && !needsOnboarding,
  });

  useEffect(() => {
    return menu.on((command) => {
      const nextTab = MENU_DESIGN_TABS[command];
      if (nextTab) {
        goDesign(nextTab);
        return;
      }
      const nextView = MENU_VIEWS[command];
      if (nextView) {
        go(nextView);
        return;
      }
      if (command === 'menu:new-run') {
        setOpenRunId('');
        setView('runs');
      } else if (command === 'menu:add-project') {
        void addProject();
      }
    });
  }, [go, goDesign, addProject]);

  let main: React.JSX.Element | null = null;
  if (view === 'runs' && openRunId) {
    main = (
      <RunDetailScreen
        key={openRunId}
        runId={openRunId}
        onBack={() => setOpenRunId('')}
        onOpenInspector={openInspector}
      />
    );
  } else if (view === 'runs') {
    main = (
      <RunsScreen
        request={runRequest}
        onRequestChange={setRunRequest}
        onOpen={openRun}
        onAddProject={() => void addProject()}
        onNewProject={newProject}
        onOpenSettings={(pane) => {
          setSettingsPane(pane);
          go('settings');
        }}
        onOpenReadiness={() => {
          if (project?.id) setReadinessProjectId(project.id);
        }}
      />
    );
  } else if (view === 'inspector') {
    main = <InspectorScreen pinnedRunId={inspectorRunId} />;
  } else if (view === 'design') {
    main = (
      <DesignScreen
        tab={designTab}
        onTabChange={setDesignTab}
        openTarget={smithNav?.name}
        openNonce={smithNav?.nonce}
      />
    );
  } else if (view === 'prs') {
    main = <PullRequestsScreen onOpenRun={openRun} />;
  } else if (view === 'smith') {
    main = (
      <SmithScreen
        screenContext={smithContext}
        onApproved={(target) => void onSmithApproved(target)}
      />
    );
  } else if (view === 'settings') {
    main = (
      <SettingsScreen
        pane={settingsPane}
        onPaneChange={setSettingsPane}
        onNewProject={newProject}
        onOpenReadiness={(id) => setReadinessProjectId(id)}
        paletteNonce={settingsPaletteNonce}
      />
    );
  }

  return (
    <div className={styles.shell}>
      <div className={styles.titlebar}>
        {ready && !needsOnboarding && (
          <div className={styles.wordmark} aria-hidden>
            <FoundryGlyph size={13} />
            <span className={styles.wordmarkText}>Foundry</span>
          </div>
        )}
      </div>

      {needsOnboarding ? (
        <OnboardingShell onDone={finishOnboarding} />
      ) : ready ? (
        <>
          <Sidebar
            view={view}
            openRunId={openRunId}
            onNavigate={go}
            onAddProject={addProject}
            onNewProject={newProject}
            onOpenSettings={(pane) => {
              setSettingsPane(pane);
              go('settings');
            }}
            onOpenInterruptRun={openRun}
            onOpenInspector={openInspector}
            onOpenSmith={openSmith}
            inspectorRunId={inspectorRunId}
          />
          <div className={styles.sidebarDivider} aria-hidden />
          <main
            className={styles.content}
            data-testid="app-view"
            data-view={openRunId && view === 'runs' ? 'run-detail' : view}
            data-open-run={openRunId || undefined}
            data-design-tab={view === 'design' ? designTab : undefined}
            data-settings-pane={view === 'settings' ? settingsPane : undefined}
          >
            {main}
          </main>
        </>
      ) : (
        <div className={styles.loading}>
          <span className={styles.spinner} />
        </div>
      )}

      {/*
       * The Smith proposal card renders inline in the chat transcript, on the
       * Smith screen; only an engineer interrupt still overlays the app here.
       */}
      {activeInterrupt && <InterruptSheet interrupt={activeInterrupt} />}
      {creatingProject && (
        <NewProjectWizard onClose={() => setCreatingProject(false)} onCreated={projectCreated} />
      )}
      {readinessProjectId && (
        <ReadinessFlow projectId={readinessProjectId} onClose={() => setReadinessProjectId('')} />
      )}
      <ConfirmModal />
      {showBanner && (
        <UpdateBanner
          status={updateStatus}
          onDownload={() => void handleUpdateDownload()}
          onRestart={() => void handleUpdateRestart()}
          onRetry={() => void handleUpdateRetry()}
          onDismiss={handleUpdateDismiss}
        />
      )}
      {toast && (
        <div className={styles.toast} role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </div>
  );
}

export default function App(): React.JSX.Element {
  return (
    <AppProvider>
      <AppInner />
    </AppProvider>
  );
}
