import { useCallback, useEffect, useState } from 'react';
import { NAV_ITEMS, type NavView, type View } from '../../utils/navigation.js';
import { useApp } from '../../stores/app.js';
import { useActivityRuns } from '../../stores/run.js';
import { since, statusColor, statusWord } from '../../utils/format.js';
import { safeGetItem, safeSetItem } from '../../utils/local-store.js';
import {
  CollapseEmblem,
  ExpandEmblem,
  NAV_EMBLEMS,
  ProjectEmblem,
  SettingsEmblem,
  SmithEmblem,
  type Emblem,
} from './SidebarEmblems.js';
import { Dropdown, type DropdownOption } from '../ui/Dropdown.js';
import { cx } from '../ui/cx.js';
import styles from './Sidebar.module.css';

const SIDEBAR_COLLAPSED_KEY = 'foundry.sidebarCollapsed';
/** Sentinel value for the Add / Create row, which is an action rather than a project. */
const ADD_OR_CREATE = '__split_add_create__';

const items: { id: NavView; label: string; key: string; Emblem: Emblem }[] = NAV_ITEMS.map(
  (item) => ({ ...item, Emblem: NAV_EMBLEMS[item.id] }),
);

function PlusIcon(): React.JSX.Element {
  return (
    <svg className={styles.splitIcon} width="12" height="12" viewBox="0 0 14 14" fill="none">
      <path d="M7 2.5v9M2.5 7h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

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

  const run = (action?: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!action) return;
    close();
    action();
  };

  // Only fires for the gap between the halves; each half stops propagation.
  const handleRowClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    e.stopPropagation();
    e.preventDefault();
    close();
    const rect = e.currentTarget.getBoundingClientRect();
    const isLeft = e.clientX - rect.left < rect.width / 2;
    if (isLeft) onAdd();
    else onNew?.();
  };

  const half = (
    side: 'left' | 'right',
    action: (() => void) | undefined,
    title: string,
    label: string,
  ): React.JSX.Element => (
    <div
      role="button"
      tabIndex={action ? 0 : -1}
      aria-disabled={!action || undefined}
      className={cx(
        styles.splitOptionHalf,
        hoverSide === side && styles.splitOptionHalfActive,
        !action && styles.disabled,
      )}
      onMouseEnter={() => setHoverSide(side)}
      onMouseLeave={() => setHoverSide(null)}
      onClick={run(action)}
      onKeyDown={(e) => {
        if (!action || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        e.stopPropagation();
        close();
        action();
      }}
      title={title}
    >
      <PlusIcon />
      <span>{label}</span>
    </div>
  );

  return (
    <div className={styles.splitOptionRow} onClick={handleRowClick}>
      {half('left', onAdd, 'Add an existing project folder', 'Add Project')}
      <div className={styles.splitDivider} />
      {half('right', onNew, 'Create a new project repository', 'Create New')}
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
  onOpenInspector,
  onOpenSmith,
  inspectorRunId = '',
}: {
  view: View;
  openRunId: string;
  onNavigate: (view: NavView) => void;
  onAddProject: () => void;
  /** Create a repository on GitHub instead of pointing at an existing checkout. */
  onNewProject?: () => void;
  onOpenSettings: (pane: string) => void;
  /** Pin the Inspector to a run from the selected project. */
  onOpenInspector?: (runId: string) => void;
  /** Opens the Smith chat screen. Not a numbered nav item, so it takes its own handler. */
  onOpenSmith?: () => void;
  /** The run the Inspector is pinned to, so its activity row reads as selected. */
  inspectorRunId?: string;
}): React.JSX.Element {
  const { projects, project, projectId, selectProject } = useApp();
  const { runs: pipelineRuns } = useActivityRuns(projectId);

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
      value: ADD_OR_CREATE,
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

  const projectAriaLabel = project ? `Project: ${project.name}` : 'Project';
  const chooseProject = (next: string): void => {
    if (next === ADD_OR_CREATE) onAddProject();
    else selectProject(next);
  };
  const navItemClass = (active: boolean, extra?: string): string =>
    cx(styles.navItem, active && styles.active, collapsed && styles.navItemCollapsed, extra);

  return (
    <aside className={cx(styles.sidebar, collapsed && styles.collapsed)}>
      {collapsed ? (
        <div className={styles.projectPickerCollapsed}>
          <Dropdown
            value={project?.id ?? ''}
            options={dropdownOptions}
            onChange={chooseProject}
            aria-label={projectAriaLabel}
            placeholder={project?.name ?? 'Project'}
            triggerClassName={styles.emblemProjectTrigger}
            renderValue={() => <ProjectEmblem className={styles.navEmblem} />}
            data-testid="project-selector"
          />
        </div>
      ) : (
        <div className={styles.projectPicker}>
          <label className="faint">Project</label>
          <Dropdown
            value={project?.id ?? ''}
            options={dropdownOptions}
            onChange={chooseProject}
            aria-label={projectAriaLabel}
            placeholder="Select or add project…"
            data-testid="project-selector"
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
              className={navItemClass(active)}
              onClick={() => onNavigate(item.id)}
              title={collapsed ? `${item.label} (⌘${item.key})` : undefined}
              aria-label={collapsed ? `${item.label} ⌘${item.key}` : undefined}
              aria-current={active ? 'page' : undefined}
              data-testid={`nav-${item.id}`}
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
         * Smith sits below the views and opens the native chat screen. It has
         * no ⌘-digit chord, so it stays outside NAV_ITEMS with its own handler.
         */}
        <button
          type="button"
          className={navItemClass(view === 'smith')}
          onClick={() => onOpenSmith?.()}
          title={collapsed ? 'Smith' : undefined}
          aria-label="Smith"
          aria-current={view === 'smith' ? 'page' : undefined}
          data-testid="nav-smith"
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
              const running = run.status === 'running';
              const pinned = view === 'inspector' && inspectorRunId === run.runId;
              return (
                <button
                  key={run.runId}
                  type="button"
                  className={cx(styles.runItem, pinned && styles.active)}
                  aria-current={pinned || undefined}
                  title={`${run.request}\n${run.pipelineName} · ${statusWord(run.status)}`}
                  data-testid={`sidebar-run-${run.runId}`}
                  onClick={() => {
                    onOpenInspector?.(run.runId);
                  }}
                >
                  <span
                    className={cx(styles.runDot, running && styles.runDotLive)}
                    style={{ background: statusColor(run.status) }}
                  />
                  <span className={styles.runBody}>
                    <span className={styles.runName}>{run.request}</span>
                    <span className={`${styles.runMeta} faint`}>
                      {run.pipelineName} ·{' '}
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
      <button
        type="button"
        className={cx(styles.collapseToggle, collapsed && styles.collapseToggleCollapsed)}
        onClick={toggleCollapsed}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        data-testid="sidebar-collapse"
      >
        {collapsed ? (
          <ExpandEmblem className={styles.navEmblem} />
        ) : (
          <CollapseEmblem size={16} className={styles.navEmblem} />
        )}
      </button>
      <button
        className={navItemClass(view === 'settings', styles.settingsItem)}
        onClick={() => onOpenSettings('general')}
        title={collapsed ? 'Settings (⌘,)' : undefined}
        aria-label={collapsed ? 'Settings ⌘,' : undefined}
        aria-current={view === 'settings' ? 'page' : undefined}
        data-testid="nav-settings"
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
