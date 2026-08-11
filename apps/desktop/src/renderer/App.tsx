import { useCallback, useEffect, useRef, useState } from 'react';
import { api, menu } from './api.js';
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts.js';
import { AppProvider, useApp } from './stores/app.js';
import Sidebar from './components/Sidebar.js';
import WindowTrafficLights from './components/WindowTrafficLights.js';
import { DroidGlyph } from './components/BrandIcon.js';
import RunsScreen from './screens/RunsScreen.js';
import RunDetailScreen from './screens/RunDetailScreen.js';
import InspectorScreen from './screens/InspectorScreen.js';
import PipelinesScreen from './screens/PipelinesScreen.js';
import RosterScreen from './screens/RosterScreen.js';
import PullRequestsScreen from './screens/PullRequestsScreen.js';
import SettingsScreen from './screens/SettingsScreen.js';
import OnboardingShell from './screens/onboarding/OnboardingShell.js';
import InterruptSheet from './components/InterruptSheet.js';
import NewProjectWizard from './components/NewProjectWizard.js';
import ConfirmModal from './components/ConfirmModal.js';
import UpdateBanner from './components/UpdateBanner.js';
import SmithModal from './components/SmithModal.js';
import SmithProposalCard, { type SmithNavTarget } from './components/SmithProposalCard.js';
import type { ProjectDef, SmithStatus, UpdateStatus } from '@shared/types.js';
import styles from './App.module.css';

export type View = 'runs' | 'inspector' | 'pipelines' | 'roster' | 'prs' | 'settings';

const MENU_VIEWS: Record<string, View> = {
  'menu:settings': 'settings',
  'menu:view-runs': 'runs',
  'menu:view-inspector': 'inspector',
  'menu:view-pipelines': 'pipelines',
  'menu:view-roster': 'roster',
  'menu:view-prs': 'prs',
};

function AppInner(): React.JSX.Element {
  const { ready, settings, interrupts, project, refreshAll, refreshScoped, selectProject } =
    useApp();
  const [view, setView] = useState<View>('runs');
  const [creatingProject, setCreatingProject] = useState(false);
  const [openRunId, setOpenRunId] = useState('');
  const [inspectorRunId, setInspectorRunId] = useState('');
  const [settingsPane, setSettingsPane] = useState('general');
  const [smithOpen, setSmithOpen] = useState(false);
  const [smithBusy, setSmithBusy] = useState(false);
  // Deep link for the active project's roster/pipelines/envelope editors after a
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
        setToast(msg ?? "You're up to date");
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        toastTimerRef.current = setTimeout(() => setToast(null), 4000);
      }
      prevStageRef.current = next.stage;
      setUpdateStatus(next);
    });
  }, []);

  // The Smith activity dot on the sidebar: best-effort, driven by the status
  // broadcast so it shows even when the modal is closed. Scoped to the active
  // project — other projects' sessions keep running but do not light this dot.
  const projectId = project?.id ?? '';
  useEffect(() => {
    if (!projectId) {
      setSmithBusy(false);
      return;
    }
    let cancelled = false;
    void api.smith.status(projectId).then((s) => {
      if (!cancelled) setSmithBusy(s.state === 'busy');
    });
    const off = api.on('smith-status-changed', (data) => {
      const next = data as SmithStatus | undefined;
      if (next && next.projectId === projectId) setSmithBusy(next.state === 'busy');
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [projectId]);

  const openSmith = useCallback((): void => setSmithOpen(true), []);

  // A Smith approve saved the entity; open its editor. The store save already
  // broadcast settings-changed (which refreshes the app), but refresh scoped
  // data too so the target is present before the screen's deep-link effect runs.
  const onSmithApproved = useCallback(
    async (target: SmithNavTarget): Promise<void> => {
      await refreshScoped();
      setSmithNav({ ...target, nonce: Date.now() });
      if (target.kind === 'agent') {
        setView('roster');
      } else if (target.kind === 'pipeline') {
        setView('pipelines');
      } else {
        setSettingsPane('envelopes');
        setView('settings');
      }
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

  useGlobalShortcuts({
    onNavigate: go,
    onEscape: escapeBack,
    onOpenSmith: openSmith,
    enabled: ready && !needsOnboarding,
  });

  useEffect(() => {
    return menu.on((command) => {
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
  }, [go, addProject]);

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
        onOpen={openRun}
        onAddProject={() => void addProject()}
        onNewProject={newProject}
        onOpenSettings={(pane) => {
          setSettingsPane(pane);
          go('settings');
        }}
      />
    );
  } else if (view === 'inspector') {
    main = <InspectorScreen pinnedRunId={inspectorRunId} />;
  } else if (view === 'pipelines') {
    main = (
      <PipelinesScreen
        onOpenSettings={(pane) => {
          setSettingsPane(pane);
          go('settings');
        }}
        openPipeline={smithNav?.kind === 'pipeline' ? smithNav.name : undefined}
        openNonce={smithNav?.kind === 'pipeline' ? smithNav.nonce : undefined}
      />
    );
  } else if (view === 'roster') {
    main = (
      <RosterScreen
        onOpenSettings={(pane) => {
          setSettingsPane(pane);
          go('settings');
        }}
        openAgent={smithNav?.kind === 'agent' ? smithNav.name : undefined}
        openNonce={smithNav?.kind === 'agent' ? smithNav.nonce : undefined}
      />
    );
  } else if (view === 'prs') {
    main = <PullRequestsScreen onOpenRun={openRun} />;
  } else if (view === 'settings') {
    main = (
      <SettingsScreen
        pane={settingsPane}
        onNewProject={newProject}
        openEnvelope={smithNav?.kind === 'envelope' ? smithNav.name : undefined}
        openNonce={smithNav?.kind === 'envelope' ? smithNav.nonce : undefined}
      />
    );
  }

  return (
    <div className={styles.shell}>
      <div className={styles.titlebar}>
        {ready && !needsOnboarding && (
          <div className={styles.wordmark} aria-hidden>
            <DroidGlyph size={13} />
            <span className={styles.wordmarkText}>Foundry</span>
          </div>
        )}
        {(needsOnboarding || !ready) && <WindowTrafficLights />}
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
            smithBusy={smithBusy}
            inspectorRunId={inspectorRunId}
          />
          <div className={styles.sidebarDivider} aria-hidden />
          <main className={styles.content}>{main}</main>
        </>
      ) : (
        <div className={styles.loading}>
          <span className={styles.spinner} />
        </div>
      )}

      {/*
       * Stacking (bottom to top): the Smith terminal modal (z-90) sits below
       * the proposal card, which sits below an engineer interrupt. Both the
       * card and the interrupt use ModalShell `highPriority` (z-100), so DOM
       * order breaks the tie — the interrupt renders last to stay on top.
       */}
      {smithOpen && <SmithModal onClose={() => setSmithOpen(false)} />}
      <SmithProposalCard onApproved={(target) => void onSmithApproved(target)} />
      {activeInterrupt && <InterruptSheet interrupt={activeInterrupt} />}
      {creatingProject && (
        <NewProjectWizard onClose={() => setCreatingProject(false)} onCreated={projectCreated} />
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
