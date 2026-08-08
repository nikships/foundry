import { useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react';
import { api, menu } from './api.js';
import { AppProvider, useApp } from './stores/app.js';
import Sidebar from './components/Sidebar.js';
import RunsScreen from './screens/RunsScreen.js';
import RunDetailScreen from './screens/RunDetailScreen.js';
import InspectorScreen from './screens/InspectorScreen.js';
import PipelinesScreen from './screens/PipelinesScreen.js';
import RosterScreen from './screens/RosterScreen.js';
import SettingsScreen from './screens/SettingsScreen.js';
import OnboardingShell from './screens/onboarding/OnboardingShell.js';
import InterruptSheet from './components/InterruptSheet.js';
import UpdateBanner from './components/UpdateBanner.js';
import { useBrand } from './hooks/useBrand.js';
import type { UpdateStatus } from '@shared/types.js';

const PrismField = lazy(() => import('./components/prism/PrismField.js'));

export type View = 'runs' | 'inspector' | 'pipelines' | 'roster' | 'settings';

const MENU_VIEWS: Record<string, View> = {
  'menu:settings': 'settings',
  'menu:view-runs': 'runs',
  'menu:view-inspector': 'inspector',
  'menu:view-pipelines': 'pipelines',
  'menu:view-roster': 'roster',
};

function AppInner(): React.JSX.Element {
  const { ready, settings, interrupts, refreshAll } = useApp();
  const [view, setView] = useState<View>('runs');
  const [openRunId, setOpenRunId] = useState('');
  const [inspectorRunId, setInspectorRunId] = useState('');
  const [settingsPane, setSettingsPane] = useState('general');
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
    if (added) await refreshAll();
  }, [refreshAll]);

  const finishOnboarding = async (): Promise<void> => {
    await api.settings.patch({ onboarded: true });
    await refreshAll();
  };

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

  const brand = useBrand();
  const isPrism = brand === 'prism';

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
        onOpenSettings={(pane) => {
          setSettingsPane(pane);
          go('settings');
        }}
      />
    );
  } else if (view === 'inspector') {
    main = <InspectorScreen pinnedRunId={inspectorRunId} />;
  } else if (view === 'pipelines') {
    main = <PipelinesScreen />;
  } else if (view === 'roster') {
    main = <RosterScreen />;
  } else if (view === 'settings') {
    main = <SettingsScreen pane={settingsPane} />;
  }

  return (
    <div className="shell">
      {isPrism && (
        <Suspense fallback={null}>
          <PrismField variant="background" />
        </Suspense>
      )}
      <div className="titlebar">{isPrism && <div className="prism-header-rule" aria-hidden />}</div>

      {needsOnboarding ? (
        <OnboardingShell onDone={finishOnboarding} />
      ) : ready ? (
        <>
          <Sidebar
            view={view}
            openRunId={openRunId}
            onNavigate={go}
            onAddProject={addProject}
            onOpenSettings={(pane) => {
              setSettingsPane(pane);
              go('settings');
            }}
            onOpenInterruptRun={openRun}
          />
          <main className="content">{main}</main>
        </>
      ) : (
        <div className="booting">
          <span className="spinner" />
        </div>
      )}

      {activeInterrupt && <InterruptSheet interrupt={activeInterrupt} />}
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
        <div className="toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
      <style>{`
        .toast {
          position: fixed;
          bottom: 22px;
          left: 50%;
          transform: translateX(-50%);
          padding: var(--s2) var(--s4);
          background: var(--bg-raised);
          border: 1px solid var(--line);
          border-radius: var(--r-full);
          color: var(--text);
          font-size: var(--text-sm);
          box-shadow: var(--shadow);
          z-index: 80;
          animation: fade-in 140ms var(--ease);
        }
        .shell {
          display: flex;
          height: 100%;
          background: var(--bg-base);
        }
        .titlebar {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          height: var(--titlebar-h);
          -webkit-app-region: drag;
          z-index: 50;
          pointer-events: none;
        }
        .content {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          background: var(--bg-base);
          border-left: 1px solid var(--line);
        }
        .booting {
          flex: 1;
          display: grid;
          place-items: center;
        }
        .spinner {
          width: 22px;
          height: 22px;
          border: 2px solid var(--line-strong);
          border-top-color: var(--cyan);
          border-radius: var(--r-full);
          animation: spin 700ms linear infinite;
        }
      `}</style>
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
