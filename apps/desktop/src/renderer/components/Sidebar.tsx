import type { View } from '../App.js';
import { useApp } from '../stores/app.js';
import { useAllProjectRuns } from '../stores/run.js';
import { since, statusColor, statusWord } from '../format.js';
import { Button } from './ui/Button.js';
import { Dropdown } from './ui/Dropdown.js';
import styles from './Sidebar.module.css';

const items: { id: View; label: string; key: string }[] = [
  { id: 'runs', label: 'Runs', key: '1' },
  { id: 'pipelines', label: 'Pipelines', key: '2' },
  { id: 'roster', label: 'Roster', key: '3' },
  { id: 'inspector', label: 'Inspector', key: '4' },
  { id: 'prs', label: 'Pull Requests', key: '5' },
];

export default function Sidebar({
  view,
  openRunId: _openRunId,
  onNavigate,
  onAddProject,
  onNewProject,
  onOpenSettings,
  onOpenInterruptRun,
  onOpenInspector,
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
  /** The run the Inspector is pinned to, so its activity row reads as selected. */
  inspectorRunId?: string;
}): React.JSX.Element {
  const { projects, project, interrupts, selectProject } = useApp();
  const { runs: pipelineRuns } = useAllProjectRuns();
  const pendingCount = interrupts.length;
  const firstWaiting = interrupts[0] ?? null;

  // CSS ellipsis truncates the wrong end of a path, and the `direction: rtl`
  // workaround visually relocates the leading slash. Eliding the middle keeps
  // both the root and the folder that identifies the project.
  const shortPath = ((path?: string): string => {
    if (!path) return '';
    const parts = path.split('/').filter(Boolean);
    return parts.length <= 3 ? path : `/${parts[0]}/…/${parts.slice(-2).join('/')}`;
  })(project?.path);

  return (
    <aside className={styles.sidebar}>
      <div className={styles.dragPad} />
      <div className={styles.projectPicker}>
        <label className="faint">Project</label>
        {projects.length > 0 && (
          <Dropdown
            value={project?.id ?? ''}
            options={projects.map((p) => {
              const parts = p.path.split('/').filter(Boolean);
              const short =
                parts.length <= 3 ? p.path : `/${parts[0]}/…/${parts.slice(-2).join('/')}`;
              return {
                value: p.id,
                label: p.name,
                description: short,
              };
            })}
            onChange={(next) => selectProject(next)}
            aria-label="Project"
          />
        )}
        <Button size="sm" onClick={onAddProject}>
          {projects.length ? 'Add another project…' : 'Add a project…'}
        </Button>
        {onNewProject && (
          <Button size="sm" onClick={onNewProject}>
            Create a new project…
          </Button>
        )}
        {project && (
          <p className={`${styles.path} mono faint`} title={project.path}>
            {shortPath}
          </p>
        )}
      </div>
      <nav>
        {items.map((item) => (
          <button
            key={item.id}
            className={`${styles.navItem} ${view === item.id ? styles.active : ''}`}
            onClick={() => onNavigate(item.id)}
          >
            <span>{item.label}</span>
            <kbd>⌘{item.key}</kbd>
          </button>
        ))}
      </nav>
      {pipelineRuns.length > 0 && (
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
      {pendingCount > 0 && firstWaiting && (
        <button
          type="button"
          className={styles.pending}
          title="Open the run waiting for you"
          onClick={() => onOpenInterruptRun?.(firstWaiting.runId)}
        >
          {pendingCount} {pendingCount === 1 ? 'run needs' : 'runs need'} you
        </button>
      )}
      <button
        className={`${styles.navItem} settings ${view === 'settings' ? styles.active : ''}`}
        onClick={() => onOpenSettings('general')}
      >
        <span>Settings</span>
        <kbd>⌘,</kbd>
      </button>
    </aside>
  );
}
