/**
 * Creates a repository on GitHub and registers the clone as a project.
 *
 * Four steps, one decision each, because the questions that matter for a new
 * repo are few: what it is called, who can see it, and where it lands. Anything
 * GitHub can change later in two clicks is not asked here.
 *
 * The account is resolved before the first step: a form that collects four
 * answers and then says "gh is not signed in" wasted all four.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { GithubAccount, ProjectDef } from '@shared/types.js';
import type { NewRepoResult } from '@shared/ipc-contract.js';
import { api } from '../../api.js';
import { Button } from '../ui/Button.js';
import { Dropdown } from '../ui/Dropdown.js';
import { Field, TextInput, Textarea } from '../ui/Field.js';
import { ModalShell } from '../ui/ModalShell.js';
import { SegmentedControl } from '../ui/SegmentedControl.js';
import ProjectCommandsModal from './ProjectCommandsModal.js';
import styles from './NewProjectWizard.module.css';

type Visibility = 'private' | 'public';
type Step = 'name' | 'visibility' | 'location' | 'review';

const STEPS: { id: Step; label: string }[] = [
  { id: 'name', label: 'Name' },
  { id: 'visibility', label: 'Visibility' },
  { id: 'location', label: 'Location' },
  { id: 'review', label: 'Review' },
];

/** GitHub's own rule, mirrored from `system/gh.ts` so typing gets an answer. */
const REPO_NAME = /^[A-Za-z0-9._-]+$/;

function nameIssue(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  if (trimmed === '.' || trimmed === '..') return `"${trimmed}" is not a repository name`;
  if (!REPO_NAME.test(trimmed)) {
    return 'Use letters, numbers, dots, hyphens and underscores only. Spaces are not allowed.';
  }
  if (trimmed.length > 100) return 'Keep the name under 100 characters.';
  return '';
}

export default function NewProjectWizard({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  /** The registered project, so the host can select it and refresh. */
  onCreated: (project: ProjectDef) => void | Promise<void>;
}): React.JSX.Element {
  const [account, setAccount] = useState<GithubAccount | null>(null);
  const [step, setStep] = useState<Step>('name');
  const [name, setName] = useState('');
  const [owner, setOwner] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [description, setDescription] = useState('');
  const [parentDir, setParentDir] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<NewRepoResult | null>(null);
  const [configuringCommands, setConfiguringCommands] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void api.projects.githubAccount().then((next) => {
      if (cancelled) return;
      setAccount(next);
      if (next.login) setOwner(next.login);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (step === 'name') nameRef.current?.focus();
  }, [step, account?.available]);

  const trimmedName = name.trim();
  const issue = nameIssue(name);
  const owners = account?.owners ?? [];
  const target = `${owner || account?.login || 'you'}/${trimmedName || 'name'}`;
  const clonePath = parentDir && trimmedName ? `${parentDir}/${trimmedName}` : '';

  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const canAdvance = useMemo(() => {
    if (step === 'name') return !!trimmedName && !issue;
    if (step === 'location') return !!parentDir;
    return true;
  }, [step, trimmedName, issue, parentDir]);

  const pickFolder = async (): Promise<void> => {
    setError('');
    try {
      const chosen = await api.projects.chooseParentDir();
      if (chosen) setParentDir(chosen);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const create = async (): Promise<void> => {
    if (creating) return;
    setCreating(true);
    setError('');
    try {
      const result = await api.projects.createGithub({
        name: trimmedName,
        owner: owner || undefined,
        visibility,
        description: description.trim() || undefined,
        parentDir,
      });
      if (!result.ok || !result.project) {
        setError(result.detail || 'Could not create the repository.');
        return;
      }
      setCreated(result);
      await onCreated(result.project);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  // gh missing or signed out: say so with the fix, rather than collecting four
  // answers that cannot be used.
  if (account && !account.available) {
    return (
      <ModalShell onClose={onClose} ariaLabelledBy="new-project-title" className={styles.modal}>
        <header className={styles.head}>
          <h2 id="new-project-title">Create a new project</h2>
        </header>
        <div className={styles.blocked} role="alert">
          <p className={styles.blockedTitle}>GitHub is not reachable</p>
          <p className={styles.blockedBody}>{account.detail}</p>
          <p className={styles.blockedBody}>
            Foundry creates repositories through your own <code>gh</code> CLI and stores no GitHub
            token of its own.
          </p>
        </div>
        <footer className={styles.foot}>
          <Button
            onClick={() => void api.app.openExternal('https://cli.github.com/manual/gh_auth_login')}
          >
            How to sign in
          </Button>
          <div className={styles.spacer} />
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </footer>
      </ModalShell>
    );
  }

  if (created?.project && configuringCommands) {
    return (
      <ProjectCommandsModal
        project={created.project}
        commandNames={['test']}
        onClose={() => setConfiguringCommands(false)}
        onSaved={async (project) => {
          setCreated((current) => (current ? { ...current, project } : current));
          await onCreated(project);
        }}
      />
    );
  }

  if (created) {
    return (
      <ModalShell onClose={onClose} ariaLabelledBy="new-project-title" className={styles.modal}>
        <header className={styles.head}>
          <h2 id="new-project-title">Repository created</h2>
          <p className={`faint ${styles.sub}`}>
            {created.nameWithOwner} is {visibility} and cloned to your machine. It is now the
            selected project.
          </p>
        </header>
        <dl className={styles.summary}>
          <div className={styles.summaryRow}>
            <dt>Repository</dt>
            <dd className="mono">{created.nameWithOwner}</dd>
          </div>
          <div className={styles.summaryRow}>
            <dt>Visibility</dt>
            <dd>{visibility === 'private' ? 'Private' : 'Public'}</dd>
          </div>
          <div className={styles.summaryRow}>
            <dt>Local path</dt>
            <dd className="mono">{created.path}</dd>
          </div>
        </dl>
        <p className={`faint ${styles.note}`}>
          The repo starts with a README and nothing else, so Foundry cannot detect a test command
          yet. Set the command for your stack now, or detect it after the project has manifests.
          Until then, a phase that needs it is recorded as skipped.
        </p>
        <footer className={styles.foot}>
          {created.url && (
            <Button onClick={() => void api.app.openExternal(created.url!)}>Open on GitHub</Button>
          )}
          {created.path && (
            <Button onClick={() => void api.projects.reveal(created.path!)}>
              Reveal in Finder
            </Button>
          )}
          {created.project && (
            <Button
              onClick={() => setConfiguringCommands(true)}
              data-testid="new-project-configure-commands"
            >
              Set up test command
            </Button>
          )}
          <div className={styles.spacer} />
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </footer>
      </ModalShell>
    );
  }

  return (
    <ModalShell
      onClose={creating ? undefined : onClose}
      dismissible={!creating}
      ariaLabelledBy="new-project-title"
      className={styles.modal}
    >
      <header className={styles.head}>
        <h2 id="new-project-title">Create a new project</h2>
        <p className={`faint ${styles.sub}`}>
          Foundry creates the repository on GitHub with your own <code>gh</code> CLI, clones it, and
          points itself at the clone.
        </p>
        <ol className={styles.rail}>
          {STEPS.map((s, i) => (
            <li
              key={s.id}
              className={`${styles.railStep} ${i === stepIndex ? styles.on : ''} ${i < stepIndex ? styles.done : ''}`}
            >
              <span className={styles.railNum}>{i + 1}</span>
              <span>{s.label}</span>
            </li>
          ))}
        </ol>
      </header>

      <div className={styles.body}>
        {!account && <p className="faint">Checking who you are signed in as…</p>}

        {account && step === 'name' && (
          <>
            <Field
              label="Repository name"
              htmlFor="new-repo-name"
              hint="This is the repository name on GitHub and the folder name on disk."
              error={issue || undefined}
            >
              <TextInput
                id="new-repo-name"
                ref={nameRef}
                mono
                value={name}
                spellCheck={false}
                autoComplete="off"
                placeholder="my-service"
                className={issue ? 'invalid' : undefined}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canAdvance) setStep('visibility');
                }}
              />
            </Field>
            {owners.length > 1 ? (
              <Field
                label="Owner"
                htmlFor="new-repo-owner"
                hint="Your account, or an organisation you can create repositories in."
              >
                <Dropdown
                  id="new-repo-owner"
                  value={owner}
                  options={owners.map((o) => ({ value: o, label: o }))}
                  onChange={setOwner}
                />
              </Field>
            ) : null}
            <p className={`faint mono ${styles.preview}`}>github.com/{target}</p>
          </>
        )}

        {account && step === 'visibility' && (
          <Field label="Who can see this repository?">
            <SegmentedControl
              className={styles.segments}
              options={[
                {
                  label: 'Private',
                  on: visibility === 'private',
                  onClick: () => setVisibility('private'),
                },
                {
                  label: 'Public',
                  on: visibility === 'public',
                  onClick: () => setVisibility('public'),
                },
              ]}
            />
            <p className={`faint ${styles.choiceNote}`}>
              {visibility === 'private'
                ? 'Only you and people you grant access can see it. This is the default.'
                : 'Anyone on the internet can see it. You can still choose who can push.'}
            </p>
          </Field>
        )}

        {account && step === 'location' && (
          <>
            <Field
              label="Where should the clone live?"
              hint="Foundry creates the repository folder inside this one."
            >
              <div className={styles.pathRow}>
                <TextInput
                  mono
                  readOnly
                  value={parentDir}
                  placeholder="Choose a folder…"
                  aria-label="Parent folder"
                />
                <Button onClick={() => void pickFolder()}>Choose…</Button>
              </div>
              {clonePath && <span className={`hint mono ${styles.clonePath}`}>{clonePath}</span>}
            </Field>
            <Field
              label={
                <>
                  Description <em className="faint">(optional)</em>
                </>
              }
              htmlFor="new-repo-description"
              hint="One line, shown on the repository page. You can change it later."
            >
              <Textarea
                id="new-repo-description"
                rows={2}
                value={description}
                placeholder="What this repository is for."
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
          </>
        )}

        {account && step === 'review' && (
          <dl className={styles.summary}>
            <div className={styles.summaryRow}>
              <dt>Repository</dt>
              <dd className="mono">{target}</dd>
            </div>
            <div className={styles.summaryRow}>
              <dt>Visibility</dt>
              <dd>{visibility === 'private' ? 'Private' : 'Public'}</dd>
            </div>
            <div className={styles.summaryRow}>
              <dt>Clones to</dt>
              <dd className="mono">{clonePath}</dd>
            </div>
            {description.trim() && (
              <div className={styles.summaryRow}>
                <dt>Description</dt>
                <dd>{description.trim()}</dd>
              </div>
            )}
          </dl>
        )}

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>

      <footer className={styles.foot}>
        <Button
          disabled={creating || stepIndex === 0}
          onClick={() => setStep(STEPS[Math.max(0, stepIndex - 1)]!.id)}
        >
          Back
        </Button>
        <div className={styles.spacer} />
        <Button variant="ghost" disabled={creating} onClick={onClose}>
          Cancel
        </Button>
        {step === 'review' ? (
          <Button
            variant="primary"
            disabled={creating || !parentDir || !trimmedName}
            onClick={() => void create()}
          >
            {creating ? 'Creating…' : 'Create repository'}
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={!account?.available || !canAdvance}
            onClick={() => setStep(STEPS[stepIndex + 1]!.id)}
          >
            Next
          </Button>
        )}
      </footer>
    </ModalShell>
  );
}
