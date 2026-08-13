import { useCallback, useEffect, useState } from 'react';
import type { View } from '../App.js';
import { useApp } from '../stores/app.js';
import { useAllProjectRuns } from '../stores/run.js';
import { since, statusColor, statusWord } from '../format.js';
import { safeGetItem, safeSetItem } from '../local-store.js';
import {
  CollapseEmblem,
  ExpandEmblem,
  InspectorEmblem,
  PendingEmblem,
  PipelinesEmblem,
  ProjectEmblem,
  PullRequestsEmblem,
  RosterEmblem,
  RunsEmblem,
  SettingsEmblem,
  SmithEmblem,
  type Emblem,
} from './SidebarEmblems.js';
import { Dropdown, type DropdownOption } from './ui/Dropdown.js';
import styles from './Sidebar.module.css';

const SIDEBAR_COLLAPSED_KEY = 'foundry.sidebarCollapsed';

const items: { id: View; label: string; key: string; Emblem: Emblem }[] = [
  { id: 'runs', label: 'Runs', key: '1', Emblem: RunsEmblem },
  { id: 'pipelines', label: 'Pipelines', key: '2', Emblem: PipelinesEmblem },
  { id: 'roster', label: 'Roster', key: '3', Emblem: RosterEmblem },
  { id: 'inspector', label: 'Inspector', key: '4', Emblem: InspectorEmblem },
  { id: 'prs', label: 'Pull Requests', key: '5', Emblem: PullRequestsEmblem },
];

function SplitProjectOption({
  onAdd,
  onNew,
  close,
}: {
  onAdd: () => void;
  onNew?: () => void;
  close: () => void;
}): React.JSX.Element {
  const [hoverSide, setHoverSide] = useState<'left' | 'right' | null>(null);

  const handleAdd = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    close();
    onAdd();
  };

  const handleNew = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (onNew) {
      close();
      onNew();
    }
  };

  const handleRowClick = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    close();
    const rect = e.currentTarget.getBoundingClientRect();
    const isLeft = e.clientX - rect.left < rect.width / 2;
    if (isLeft) {
      onAdd();
    } else if (onNew) {
      onNew();
    }
  };

  return (
    <div className={styles.splitOptionRow} onClick={handleRowClick}>
      <div
        className={`${styles.splitOptionHalf} ${hoverSide === 'left' ? styles.splitOptionHalfActive : ''}`}
        onMouseEnter={() => setHoverSide('left')}
        onMouseLeave={() => setHoverSide(null)}
        onClick={handleAdd}
        title="Add an existing project folder"
      >
        <svg className={styles.splitIcon} width="12" height="12" viewBox="0 0 14 14" fill="none">
          <path
            d="M7 2.5v9M2.5 7h9"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
        <span>Add Project</span>
      </div>

      <div className={styles.splitDivider} />

      <div
        className={`${styles.splitOptionHalf} ${hoverSide === 'right' ? styles.splitOptionHalfActive : ''} ${!onNew ? styles.disabled : ''}`}
        onMouseEnter={() => setHoverSide('right')}
        onMouseLeave={() => setHoverSide(null)}
        onClick={handleNew}
        title="Create a new project repository"
      >
        <svg className={styles.splitIcon} width="12" height="12" viewBox="0 0 14 14" fill="none">
          <path
            d="M7 2.5v9M2.5 7h9"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
        <span>Create New</span>
      </div>
    </div>
  );
}

export default function Sidebar({
  view,
  openRunId: _openRunId,
  onNavigate,
  onAddProject,
  onNewProject,
  onOpenSettings,
  onOpenInterruptRun,
  onOpenInspector,
  onOpenSmith,
  inspectorRunId = '',
}: {
  view: View;
  openRunId: string;
  onNavigate: (view: View) => void;
  onAddProject: () => void;
  /** Create a repository on GitHub instead of pointing at an existing checkout. */
  onNewProject?: () => void;
  onOpenSettings: (pane: string) => void;
  /** Jump to the run that is waiting so the interrupt sheet has context behind it. */
  onOpenInterruptRun?: (runId: string) => void;
  /** Pin the Inspector to a run; the run may live in any project. */
  onOpenInspector?: (runId: string) => void;
  /** Smith opens the launcher modal rather than switching the View, so it takes its own handler. */
  onOpenSmith?: () => void;
  /** The run the Inspector is pinned to, so its activity row reads as selected. */
  inspectorRunId?: string;
}): React.JSX.Element {
  const { projects, project, interrupts, selectProject } = useApp();
  const { runs: pipelineRuns } = useAllProjectRuns();
  const pendingCount = interrupts.length;
  const firstWaiting = interrupts[0] ?? null;

  const [collapsed, setCollapsed] = useState<boolean>(
    () => safeGetItem(SIDEBAR_COLLAPSED_KEY) === '1',
  );

  useEffect(() => {
    safeSetItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((v) => !v);
  }, []);

  const dropdownOptions: DropdownOption[] = [
    {
      value: '__split_add_create__',
      label: 'Add / Create New Project',
      divider: true,
      render: (_option, { close }) => (
        <SplitProjectOption onAdd={onAddProject} onNew={onNewProject} close={close} />
      ),
    },
    ...projects.map((p) => {
      const parts = p.path.split('/').filter(Boolean);
      const short = parts.length <= 3 ? p.path : `/${parts[0]}/…/${parts.slice(-2).join('/')}`;
      return {
        value: p.id,
        label: p.name,
        description: short,
      };
    }),
  ];

  const projectTitle = project?.name ?? 'Project';

  return (
    <aside className={`${styles.sidebar} ${collapsed ? styles.collapsed : ''}`}>
      {collapsed ? (
        <div className={styles.projectPickerCollapsed}>
          <Dropdown
            value={project?.id ?? ''}
            options={dropdownOptions}
            onChange={(next) => {
              if (next === '__split_add_create__') {
                onAddProject();
                return;
              }
              selectProject(next);
            }}
            aria-label="Project"
            placeholder={projectTitle}
            triggerClassName={styles.emblemProjectTrigger}
            renderValue={() => <ProjectEmblem className={styles.navEmblem} />}
          />
        </div>
      ) : (
        <div className={styles.projectPicker}>
          <label className="faint">Project</label>
          <Dropdown
            value={project?.id ?? ''}
            options={dropdownOptions}
            onChange={(next) => {
              if (next === '__split_add_create__') {
                onAddProject();
                return;
              }
              selectProject(next);
            }}
            aria-label="Project"
            placeholder="Select or add project…"
          />
        </div>
      )}
      <nav className={styles.nav} aria-label="Primary">
        {items.map((item) => {
          const active = view === item.id;
          const Emblem = item.Emblem;
          return (
            <button
              key={item.id}
              className={`${styles.navItem} ${active ? styles.active : ''} ${collapsed ? styles.navItemCollapsed : ''}`}
              onClick={() => onNavigate(item.id)}
              title={collapsed ? `${item.label} (⌘${item.key})` : undefined}
              aria-label={collapsed ? `${item.label} ⌘${item.key}` : undefined}
              aria-current={active ? 'page' : undefined}
            >
              {collapsed ? (
                <Emblem className={styles.navEmblem} />
              ) : (
                <>
                  <span className={styles.navLabel}>{item.label}</span>
                  <kbd>⌘{item.key}</kbd>
                </>
              )}
            </button>
          );
        })}
        {/*
         * Smith sits below the views but opens the launcher modal rather than
         * switching the View, so it is never `.active`. It is a handoff into the
         * user's own terminal — the app has not embedded one since the skill
         * replaced it.
         */}
        <button
          type="button"
          className={`${styles.navItem} ${collapsed ? styles.navItemCollapsed : ''}`}
          onClick={() => onOpenSmith?.()}
          title={collapsed ? 'Smith' : undefined}
          aria-label="Smith"
        >
          {collapsed ? (
            <SmithEmblem className={styles.navEmblem} />
          ) : (
            <span className={styles.navLabel}>Smith</span>
          )}
        </button>
      </nav>
      {!collapsed && pipelineRuns.length > 0 && (
        <div className={styles.runsSection}>
          <label className="faint">Activity</label>
          <div className={styles.runsList}>
            {pipelineRuns.map((run) => {
              const projectName = projects.find((p) => p.id === run.projectId)?.name ?? '';
              const running = run.status === 'running';
              const pinned = view === 'inspector' && inspectorRunId === run.runId;
              return (
                <button
                  key={run.runId}
                  type="button"
                  className={`${styles.runItem} ${pinned ? styles.active : ''}`}
                  aria-current={pinned || undefined}
                  title={`${run.request}\n${run.pipelineName} · ${projectName} · ${statusWord(run.status)}`}
                  onClick={() => {
                    if (run.projectId !== project?.id) selectProject(run.projectId);
                    onOpenInspector?.(run.runId);
                  }}
                >
                  <span
                    className={`${styles.runDot} ${running ? styles.runDotLive : ''}`}
                    style={{ background: statusColor(run.status) }}
                  />
                  <span className={styles.runBody}>
                    <span className={styles.runName}>{run.request}</span>
                    <span className={`${styles.runMeta} faint`}>
                      {projectName} ·{' '}
                      {running ? statusWord(run.status) : since(run.endedAt ?? run.startedAt)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div className={styles.spacer} />
      {pendingCount > 0 && firstWaiting ? (
        collapsed ? (
          <button
            type="button"
            className={styles.pendingCollapsed}
            title={`${pendingCount} ${pendingCount === 1 ? 'run needs' : 'runs need'} you — open`}
            aria-label={`${pendingCount} ${pendingCount === 1 ? 'run needs' : 'runs need'} you`}
            onClick={() => onOpenInterruptRun?.(firstWaiting.runId)}
          >
            <PendingEmblem className={styles.navEmblem} />
            <span className={styles.pendingBadge} aria-hidden>
              {pendingCount > 9 ? '9+' : String(pendingCount)}
            </span>
          </button>
        ) : (
          <button
            type="button"
            className={styles.pending}
            title="Open the run waiting for you"
            onClick={() => onOpenInterruptRun?.(firstWaiting.runId)}
          >
            {pendingCount} {pendingCount === 1 ? 'run needs' : 'runs need'} you
          </button>
        )
      ) : null}
      <button
        type="button"
        className={`${styles.collapseToggle} ${collapsed ? styles.collapseToggleCollapsed : ''}`}
        onClick={toggleCollapsed}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {collapsed ? (
          <ExpandEmblem className={styles.navEmblem} />
        ) : (
          <CollapseEmblem size={16} className={styles.navEmblem} />
        )}
      </button>
      <button
        className={`${styles.navItem} ${view === 'settings' ? styles.active : ''} ${collapsed ? styles.navItemCollapsed : ''} ${styles.settingsItem}`}
        onClick={() => onOpenSettings('general')}
        title={collapsed ? 'Settings (⌘,)' : undefined}
        aria-label={collapsed ? 'Settings ⌘,' : undefined}
        aria-current={view === 'settings' ? 'page' : undefined}
      >
        {collapsed ? (
          <SettingsEmblem className={styles.navEmblem} />
        ) : (
          <>
            <span>Settings</span>
            <kbd>⌘,</kbd>
          </>
        )}
      </button>
    </aside>
  );
}
