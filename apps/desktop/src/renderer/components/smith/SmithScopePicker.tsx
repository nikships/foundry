import { useApp } from '../../stores/app.js';
import styles from './SmithScopePicker.module.css';

const ALL = '__all__';

export default function SmithScopePicker({ running }: { running: boolean }): React.JSX.Element {
  const { projects, smithProjectId, selectSmithProject } = useApp();

  return (
    <label className={styles.scope}>
      <select
        className={styles.select}
        value={smithProjectId ?? ALL}
        disabled={running}
        onChange={(event) =>
          selectSmithProject(event.currentTarget.value === ALL ? null : event.currentTarget.value)
        }
        aria-label="Smith scope"
        data-testid="smith-scope"
      >
        <option value={ALL}>All projects</option>
        {projects.map((project) => (
          <option key={project.id} value={project.id} title={project.path}>
            {project.name} — {project.path}
          </option>
        ))}
      </select>
    </label>
  );
}
