import { useCallback, useEffect, useState } from 'react';
import { api, menu } from './api.js';
import { AppProvider, useApp } from './stores/app.js';
import Sidebar from './components/Sidebar.js';
import RunsScreen from './screens/RunsScreen.js';
import RunDetailScreen from './screens/RunDetailScreen.js';
import InspectorScreen from './screens/InspectorScreen.js';
import PipelinesScreen from './screens/PipelinesScreen.js';
import RosterScreen from './screens/RosterScreen.js';
import SettingsScreen from './screens/SettingsScreen.js';
import OnboardingScreen from './screens/OnboardingScreen.js';
import InterruptSheet from './components/InterruptSheet.js';

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

  const needsOnboarding = ready && settings != null && !settings.onboarded;
  const activeInterrupt = interrupts[0] ?? null;

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
      <div className="titlebar" />

      {needsOnboarding ? (
        <OnboardingScreen onDone={finishOnboarding} />
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
          />
          <main className="content">{main}</main>
        </>
      ) : (
        <div className="booting">
          <span className="spinner" />
        </div>
      )}

      {activeInterrupt && <InterruptSheet interrupt={activeInterrupt} />}
      <style>{`
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
