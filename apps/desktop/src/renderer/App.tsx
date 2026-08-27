import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, menu } from './api.js';
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts.js';
import { useOrchestratorPlan } from './hooks/useOrchestratorPlan.js';
import { AppProvider, useApp } from './stores/app.js';
import Sidebar from './components/layout/Sidebar.js';
import { FoundryGlyph } from './components/media/BrandIcon.js';
import { loadOrchestratorChoice } from './components/run/OrchestratorPicker.js';
import RunsScreen from './screens/RunsScreen.js';
import RunDetailScreen from './screens/RunDetailScreen.js';
import InspectorScreen from './screens/InspectorScreen.js';
import DesignScreen from './screens/DesignScreen.js';
import PullRequestsScreen from './screens/PullRequestsScreen.js';
import SettingsScreen from './screens/SettingsScreen.js';
import OnboardingShell from './screens/onboarding/OnboardingShell.js';
import NewProjectWizard from './components/project/NewProjectWizard.js';
import ConfirmModal from './components/common/ConfirmModal.js';
import UpdateBanner from './components/layout/UpdateBanner.js';
import SmithScreen from './screens/SmithScreen.js';
import SmithBubble from './components/smith/SmithBubble.js';
import { type SmithNavTarget } from './components/smith/SmithProposalCard.js';
import type { ProjectDef, SmithReceiptLink, UpdateStatus } from '@shared/types.js';
import type { SmithScreenContext } from '@shared/ipc-contract.js';
import {
  MENU_DESIGN_TABS,
  MENU_VIEWS,
  designTabForEntity,
  type DesignTab,
  type View,
} from './utils/navigation.js';
import { describeScreen } from './view-models/smith-chat-view.js';
import { cx } from './components/ui/cx.js';
import styles from './App.module.css';

/**
 * The line a finished check should show. An unpackaged build and a real
 * failure both carry their own message; "No update available" is the updater's
 * word for nothing to do, which reads better as a plain reassurance.
 */
function checkCompleteToast(message: string | undefined): string {
  if (!message || message === 'No update available') return "You're up to date";
  return message;
}

function AppInner(): React.JSX.Element {
  const { ready, settings, refreshAll, selectProject, projects, projectId } = useApp();
  const [view, setView] = useState<View>('runs');
  const [runRequest, setRunRequest] = useState('');
  const [orchestratorChoice, setOrchestratorChoice] = useState(loadOrchestratorChoice);
  // A planning turn can take minutes and its proposal awaits an explicit
  // operator decision. Keep it at the same view-independent lifetime as the
  // composer text instead of cancelling it when Runs briefly unmounts.
  const orchestrator = useOrchestratorPlan(projectId, orchestratorChoice);
  const [creatingProject, setCreatingProject] = useState(false);
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
  /** True during the toast's exit animation, before it unmounts. */
  const [toastLeaving, setToastLeaving] = useState(false);
  const toastHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastGoneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevStageRef = useRef<UpdateStatus['stage']>('idle');

  const needsOnboarding = ready && settings != null && !settings.onboarded;
  const bannerKey = `${updateStatus.stage}:${updateStatus.version ?? ''}`;
  const showBanner = updateStatus.stage !== 'idle' && updateDismissedKey !== bannerKey;

  /**
   * One transient status line, replacing whatever it was showing. It leaves
   * through a short exit animation (faster than its entrance) before the
   * element unmounts at the full timeout.
   */
  const showToast = useCallback((message: string): void => {
    setToast(message);
    setToastLeaving(false);
    if (toastHideTimerRef.current) clearTimeout(toastHideTimerRef.current);
    if (toastGoneTimerRef.current) clearTimeout(toastGoneTimerRef.current);
    toastHideTimerRef.current = setTimeout(() => setToastLeaving(true), 3600);
    toastGoneTimerRef.current = setTimeout(() => {
      setToast(null);
      setToastLeaving(false);
    }, 4000);
  }, []);

  useEffect(
    () => () => {
      if (toastHideTimerRef.current) clearTimeout(toastHideTimerRef.current);
      if (toastGoneTimerRef.current) clearTimeout(toastGoneTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    void api.updater.getStatus().then((s) => {
      setUpdateStatus(s);
      prevStageRef.current = s.stage;
    });
    return api.on('updater-status', (data) => {
      if (!data) return;
      const next = data as UpdateStatus;
      if (prevStageRef.current === 'checking' && next.stage === 'idle') {
        showToast(checkCompleteToast(next.message));
      }
      prevStageRef.current = next.stage;
      setUpdateStatus(next);
    });
  }, [showToast]);

  // Refresh all registries after any Smith action. Entity completions also open
  // the saved item after refreshAll has loaded its current scope.
  const onSmithCompleted = useCallback(
    async (target?: SmithNavTarget): Promise<void> => {
      await refreshAll();
      if (!target) return;
      setSmithNav({ ...target, nonce: Date.now() });
      setDesignTab(designTabForEntity(target.kind));
      setView('design');
    },
    [refreshAll],
  );

  /**
   * Follow an action receipt's link. Navigation only: the receipt is a
   * snapshot of something that already happened, so this opens what the action
   * affected and never re-runs it. A link naming a project that has since been
   * removed lands nowhere rather than switching to the wrong one.
   */
  const openReceiptLink = useCallback(
    (link: SmithReceiptLink): void => {
      if (link.kind === 'url') {
        void api.app.openExternal(link.url);
        return;
      }
      if (link.kind === 'run') {
        if (!projects.some((project) => project.id === link.projectId)) return;
        selectProject(link.projectId);
        setOpenRunId(link.runId);
        setView('runs');
        return;
      }
      setSmithNav({ kind: link.entity, name: link.name, nonce: Date.now() });
      setDesignTab(designTabForEntity(link.entity));
      setView('design');
    },
    [projects, selectProject],
  );

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

  /**
   * What the operator is looking at right now. The mini chat bubble sends this
   * live with every message; the dedicated screen sends the snapshot taken on
   * entry (`smithContext`), because once the Smith screen is up the live value
   * describes only Smith itself.
   */
  const liveScreenContext = useMemo(
    () => describeScreen(view, { openRunId, inspectorRunId, designTab, settingsPane }),
    [view, openRunId, inspectorRunId, designTab, settingsPane],
  );

  /** The sidebar's Smith click: snapshot where the operator was, then open the chat. */
  const openSmith = useCallback((): void => {
    if (view !== 'smith') setSmithContext(liveScreenContext);
    go('smith');
  }, [view, liveScreenContext, go]);

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
    }
  }, [refreshAll, selectProject]);

  const newProject = useCallback((): void => setCreatingProject(true), []);

  // The wizard has already registered the project; this makes it the one the
  // rest of the app is looking at, so "created" and "selected" are one step.
  const projectCreated = useCallback(
    async (project: ProjectDef): Promise<void> => {
      await refreshAll();
      selectProject(project.id);
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

  const openSettingsPane = useCallback(
    (pane: string): void => {
      setSettingsPane(pane);
      go('settings');
    },
    [go],
  );

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

  function renderMain(): React.JSX.Element | null {
    switch (view) {
      case 'runs':
        return openRunId ? (
          <RunDetailScreen
            key={openRunId}
            runId={openRunId}
            onBack={() => setOpenRunId('')}
            onOpenInspector={openInspector}
          />
        ) : (
          <RunsScreen
            request={runRequest}
            onRequestChange={setRunRequest}
            orchestratorChoice={orchestratorChoice}
            onOrchestratorChoiceChange={setOrchestratorChoice}
            orchestrator={orchestrator}
            onOpen={openRun}
            onAddProject={() => void addProject()}
            onNewProject={newProject}
            onOpenSettings={openSettingsPane}
          />
        );
      case 'inspector':
        return <InspectorScreen pinnedRunId={inspectorRunId} />;
      case 'design':
        return (
          <DesignScreen
            tab={designTab}
            onTabChange={setDesignTab}
            openTarget={smithNav?.name}
            openNonce={smithNav?.nonce}
          />
        );
      case 'prs':
        return <PullRequestsScreen onOpenRun={openRun} />;
      case 'smith':
        return (
          <SmithScreen
            screenContext={smithContext}
            onCompleted={(target) => void onSmithCompleted(target)}
            onOpenInspector={openInspector}
            onOpenReceiptLink={openReceiptLink}
          />
        );
      case 'settings':
        return (
          <SettingsScreen
            pane={settingsPane}
            onPaneChange={setSettingsPane}
            onNewProject={newProject}
            paletteNonce={settingsPaletteNonce}
          />
        );
    }
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
            onOpenSettings={openSettingsPane}
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
            <div key={`${view}:${openRunId}`} className={styles.screenHost}>
              {renderMain()}
            </div>
          </main>
        </>
      ) : (
        <div className={styles.loading}>
          <span className={styles.spinner} />
        </div>
      )}

      {/*
       * The Smith mini chat: a launcher docked in the titlebar band on other
       * screens, hidden when already viewing the dedicated Smith screen.
       */}
      {ready && !needsOnboarding && view !== 'smith' && (
        <SmithBubble
          screenContext={liveScreenContext}
          onExpand={openSmith}
          onCompleted={(target) => void onSmithCompleted(target)}
          onOpenInspector={openInspector}
          onOpenReceiptLink={openReceiptLink}
        />
      )}
      {creatingProject && (
        <NewProjectWizard onClose={() => setCreatingProject(false)} onCreated={projectCreated} />
      )}
      <ConfirmModal />
      {showBanner && (
        <UpdateBanner
          status={updateStatus}
          onDownload={() => void api.updater.download()}
          onRestart={() => void api.updater.quitAndInstall()}
          onRetry={() => void handleUpdateRetry()}
          onDismiss={handleUpdateDismiss}
        />
      )}
      {toast && (
        <div
          className={cx(styles.toast, toastLeaving && styles.toastLeaving)}
          role="status"
          aria-live="polite"
        >
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
