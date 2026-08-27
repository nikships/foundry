import { useState } from 'react';
import type { ProjectDef } from '@shared/types.js';
import { api, plain } from '../../api.js';
import {
  projectCommandsReady,
  seedMissingProjectCommands,
} from '../../view-models/project-commands-view.js';
import { Button } from '../ui/Button.js';
import { ModalShell } from '../ui/ModalShell.js';
import ProjectCommands from './ProjectCommands.js';
import styles from './ProjectCommandsModal.module.css';

export default function ProjectCommandsModal({
  project,
  commandNames,
  onClose,
  onSaved,
}: {
  project: ProjectDef;
  commandNames: string[];
  onClose: () => void;
  onSaved: (project: ProjectDef) => void | Promise<void>;
}): React.JSX.Element {
  const [draft, setDraft] = useState(() => seedMissingProjectCommands(project, commandNames));
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const ready = projectCommandsReady(draft.commands);

  const save = async (): Promise<void> => {
    if (!ready || saving) return;
    setSaving(true);
    setErrors([]);
    try {
      const result = await api.projects.save(plain(draft));
      if (!result.ok) {
        setErrors(result.issues.map((issue) => `${issue.where}: ${issue.message}`));
        return;
      }
      const saved = result.value?.find((candidate) => candidate.id === draft.id) ?? draft;
      await onSaved(saved);
      onClose();
    } catch (error) {
      setErrors([(error as Error).message]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell
      onClose={saving ? undefined : onClose}
      dismissible={!saving}
      ariaLabelledBy="project-commands-modal-title"
      className={styles.modal}
      highPriority
    >
      <header className={styles.head}>
        <h2 id="project-commands-modal-title">Configure project commands</h2>
        <p>
          Set the named commands pipeline gates can run. Detect from manifests understands common
          Node, Cargo, Go, Python, Gradle, Swift, Xcode, and Make projects; an empty repo gets no
          guessed default.
        </p>
      </header>
      <div className={styles.body}>
        <ProjectCommands
          project={draft}
          onChange={(commands) => setDraft({ ...draft, commands })}
        />
        {errors.length > 0 && (
          <ul className={styles.errors} role="alert">
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        )}
      </div>
      <footer className={styles.foot}>
        {!ready && <span>Enter an executable and any arguments before saving.</span>}
        <div className={styles.spacer} />
        <Button disabled={saving} onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!ready || saving}
          onClick={() => void save()}
          data-testid="project-commands-save"
        >
          {saving ? 'Saving…' : 'Save commands'}
        </Button>
      </footer>
    </ModalShell>
  );
}
