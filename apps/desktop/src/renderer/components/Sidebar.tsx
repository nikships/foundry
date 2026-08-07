import type { View } from '../App.js';
import { useApp } from '../stores/app.js';

const items: { id: View; label: string; key: string }[] = [
  { id: 'runs', label: 'Runs', key: '1' },
  { id: 'pipelines', label: 'Pipelines', key: '2' },
  { id: 'roster', label: 'Roster', key: '3' },
  { id: 'inspector', label: 'Inspector', key: '4' },
];

export default function Sidebar({
  view,
  openRunId: _openRunId,
  onNavigate,
  onAddProject,
  onOpenSettings: _onOpenSettings,
}: {
  view: View;
  openRunId: string;
  onNavigate: (view: View) => void;
  onAddProject: () => void;
  onOpenSettings: (pane: string) => void;
}): React.JSX.Element {
  const { projects, project, interrupts, selectProject } = useApp();
  const pendingCount = interrupts.length;

  // CSS ellipsis truncates the wrong end of a path, and the `direction: rtl`
  // workaround visually relocates the leading slash. Eliding the middle keeps
  // both the root and the folder that identifies the project.
  const shortPath = ((path?: string): string => {
    if (!path) return '';
    const parts = path.split('/').filter(Boolean);
    return parts.length <= 3 ? path : `/${parts[0]}/…/${parts.slice(-2).join('/')}`;
  })(project?.path);

  return (
    <>
      <aside className="sidebar">
        <div className="drag-pad" />
        <div className="project-picker">
          <label className="faint">Project</label>
          {projects.length > 0 && (
            <select className="select" value={project?.id ?? ''} onChange={(e) => selectProject(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <button className="btn sm" onClick={onAddProject}>
            {projects.length ? 'Add another project…' : 'Add a project…'}
          </button>
          {project && (
            <p className="path mono faint" title={project.path}>
              {shortPath}
            </p>
          )}
        </div>
        <nav>
          {items.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id ? 'active' : ''}`}
              onClick={() => onNavigate(item.id)}
            >
              <span>{item.label}</span>
              <kbd>⌘{item.key}</kbd>
            </button>
          ))}
        </nav>
        <div className="spacer" />
        {pendingCount > 0 && (
          <div className="pending">
            {pendingCount} {pendingCount === 1 ? 'run needs' : 'runs need'} you
          </div>
        )}
        <button
          className={`nav-item settings ${view === 'settings' ? 'active' : ''}`}
          onClick={() => onNavigate('settings')}
        >
          <span>Settings</span>
          <kbd>⌘,</kbd>
        </button>
      </aside>
      <style>{`
        .sidebar { width: var(--sidebar-w); flex: none; display: flex; flex-direction: column; padding: 0 var(--s3) var(--s3); background: var(--bg-sidebar); }
        .drag-pad { height: var(--titlebar-h); flex: none; }
        .project-picker { display: flex; flex-direction: column; gap: var(--s2); padding: var(--s2) var(--s2) var(--s4); }
        .project-picker label { font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.08em; }
        .path { font-size: var(--text-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .sidebar nav { display: flex; flex-direction: column; gap: 2px; }
        .nav-item { display: flex; align-items: center; justify-content: space-between; height: 34px; padding: 0 var(--s3); border: none; border-radius: var(--r-sm); background: transparent; color: var(--text-dim); font: inherit; font-size: var(--text-sm); cursor: default; transition: background var(--fast) var(--ease), color var(--fast) var(--ease); }
        .nav-item:hover { background: var(--bg-hover); color: var(--text); }
        .nav-item.active { background: var(--bg-active); color: var(--text); font-weight: 500; }
        .nav-item kbd { font-family: var(--font); font-size: var(--text-xs); color: var(--text-ghost); }
        .spacer { flex: 1; }
        .pending { margin-bottom: var(--s2); padding: var(--s2) var(--s3); border-radius: var(--r-sm); background: var(--amber-dim); color: var(--amber); font-size: var(--text-xs); animation: pulse 2s var(--ease) infinite; }
      `}</style>
    </>
  );
}
