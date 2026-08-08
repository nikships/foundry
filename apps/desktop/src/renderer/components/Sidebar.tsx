import type { View } from '../App.js';
import { useApp } from '../stores/app.js';
import { Button } from './ui/Button.js';
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
  onOpenSettings,
  onOpenInterruptRun,
}: {
  view: View;
  openRunId: string;
  onNavigate: (view: View) => void;
  onAddProject: () => void;
  onOpenSettings: (pane: string) => void;
  /** Jump to the run that is waiting so the interrupt sheet has context behind it. */
  onOpenInterruptRun?: (runId: string) => void;
}): React.JSX.Element {
  const { projects, project, interrupts, selectProject } = useApp();
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
          <select
            className="select"
            value={project?.id ?? ''}
            onChange={(e) => selectProject(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <Button size="sm" onClick={onAddProject}>
          {projects.length ? 'Add another project…' : 'Add a project…'}
        </Button>
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
