/**
 * Creates a repository on the selected forge (GitHub or GitLab) and registers
 * the clone as a project.
 *
 * Four steps, one decision each, because the questions that matter for a new
 * repo are few: what it is called, who can see it, and where it lands. Anything
 * the forge can change later in two clicks is not asked here.
 *
 * The account is resolved before the first step: a form that collects four
 * answers and then says "not signed in" wasted all four. Provider comes from
 * Settings → forgeProvider (Auto → GitHub for create).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ForgeAccount, ProjectDef } from '@shared/types.js';
import type { NewRepoResult } from '@shared/ipc-contract.js';
import { DEFAULT_FORGE_PROVIDER, type ForgeProviderPreference } from '@shared/forge-cli.js';
import { api } from '../../api.js';
import { useApp } from '../../stores/app.js';
import { Button } from '../ui/Button.js';
import { Dropdown } from '../ui/Dropdown.js';
import { Field, TextInput, Textarea } from '../ui/Field.js';
import { ModalShell } from '../ui/ModalShell.js';
import { SegmentedControl } from '../ui/SegmentedControl.js';
import ProjectCommandsModal from './ProjectCommandsModal.js';
import styles from './NewProjectWizard.module.css';

type Visibility = 'private' | 'public';
type Step = 'name' | 'visibility' | 'location' | 'review';
type CreateProvider = 'github' | 'gitlab';

const STEPS: { id: Step; label: string }[] = [
  { id: 'name', label: 'Name' },
  { id: 'visibility', label: 'Visibility' },
  { id: 'location', label: 'Location' },
  { id: 'review', label: 'Review' },
];

/** Mirrored from `system/gh.ts` so typing gets an answer. */
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

function createProviderOf(preference: ForgeProviderPreference | undefined): CreateProvider {
  return preference === 'gitlab' ? 'gitlab' : 'github';
}

function providerLabel(provider: CreateProvider): string {
  return provider === 'gitlab' ? 'GitLab' : 'GitHub';
}

function cliName(provider: CreateProvider): string {
  return provider === 'gitlab' ? 'glab' : 'gh';
}

function authLoginUrl(provider: CreateProvider): string {
  return provider === 'gitlab'
    ? 'https://gitlab.com/gitlab-org/cli/-/blob/main/docs/source/auth/login.md'
    : 'https://cli.github.com/manual/gh_auth_login';
}

function tokenHint(provider: CreateProvider): string {
  return provider === 'gitlab' ? 'GITLAB_TOKEN' : 'GH_TOKEN / GITHUB_TOKEN';
}

function openRepoLabel(provider: CreateProvider): string {
  return provider === 'gitlab' ? 'Open on GitLab' : 'Open on GitHub';
}

function defaultHost(provider: CreateProvider): string {
  return provider === 'gitlab' ? 'gitlab.com' : 'github.com';
}

function BlockedForgePanel({
  account,
  provider,
  onClose,
}: {
  account: ForgeAccount;
  provider: CreateProvider;
  onClose: () => void;
}): React.JSX.Element {
  const label = providerLabel(provider);
  const cli = cliName(provider);
  return (
    <ModalShell onClose={onClose} ariaLabelledBy="new-project-title" className={styles.modal}>
      <header className={styles.head}>
        <h2 id="new-project-title">Create a new project</h2>
      </header>
      <div className={styles.blocked} role="alert">
        <p className={styles.blockedTitle}>{label} is not reachable</p>
        <p className={styles.blockedBody}>{account.detail}</p>
        <p className={styles.blockedBody}>
          Foundry creates repositories through your own <code>{cli}</code> CLI and stores no {label}{' '}
          token of its own. Sign in with <code>{cli} auth login</code>, or set{' '}
          <code>{tokenHint(provider)}</code> in your shell profile (Foundry imports it at launch).
        </p>
      </div>
      <footer className={styles.foot}>
        <Button onClick={() => void api.app.openExternal(authLoginUrl(provider))}>
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

function CreatedForgePanel({
  created,
  visibility,
  provider,
  onClose,
  onConfigureCommands,
}: {
  created: NewRepoResult;
  visibility: Visibility;
  provider: CreateProvider;
  onClose: () => void;
  onConfigureCommands: () => void;
}): React.JSX.Element {
  return (
    <ModalShell onClose={onClose} ariaLabelledBy="new-project-title" className={styles.modal}>
      <header className={styles.head}>
        <h2 id="new-project-title">Repository created</h2>
        <p className={`faint ${styles.sub}`}>
          {created.nameWithOwner} is {visibility} and cloned to your machine. It is now the selected
          project.
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
        The repo starts with a README and nothing else, so Foundry cannot detect a test command yet.
        Set the command for your stack now, or detect it after the project has manifests. Until
        then, a phase that needs it is recorded as skipped.
      </p>
      <footer className={styles.foot}>
        {created.url && (
          <Button onClick={() => void api.app.openExternal(created.url!)}>
            {openRepoLabel(provider)}
          </Button>
        )}
        {created.path && (
          <Button onClick={() => void api.projects.reveal(created.path!)}>Reveal in Finder</Button>
        )}
        {created.project && (
          <Button onClick={onConfigureCommands} data-testid="new-project-configure-commands">
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

function WizardStepBody({
  step,
  account,
  provider,
  host,
  name,
  setName,
  owner,
  setOwner,
  owners,
  issue,
  target,
  visibility,
  setVisibility,
  parentDir,
  clonePath,
  description,
  setDescription,
  pickFolder,
  canAdvance,
  nameRef,
  setStep,
}: {
  step: Step;
  account: ForgeAccount;
  provider: CreateProvider;
  host: string;
  name: string;
  setName: (v: string) => void;
  owner: string;
  setOwner: (v: string) => void;
  owners: string[];
  issue: string;
  target: string;
  visibility: Visibility;
  setVisibility: (v: Visibility) => void;
  parentDir: string;
  clonePath: string;
  description: string;
  setDescription: (v: string) => void;
  pickFolder: () => void;
  canAdvance: boolean;
  nameRef: React.RefObject<HTMLInputElement | null>;
  setStep: (s: Step) => void;
}): React.JSX.Element | null {
  const label = providerLabel(provider);
  if (step === 'name') {
    return (
      <>
        <Field
          label="Repository name"
          htmlFor="new-repo-name"
          hint={`This is the repository name on ${label} and the folder name on disk.`}
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
            hint={
              provider === 'gitlab'
                ? 'Your account, or a group you can create projects in.'
                : 'Your account, or an organisation you can create repositories in.'
            }
          >
            <Dropdown
              id="new-repo-owner"
              value={owner}
              options={owners.map((o) => ({ value: o, label: o }))}
              onChange={setOwner}
            />
          </Field>
        ) : null}
        <p className={`faint mono ${styles.preview}`}>
          {host}/{target}
        </p>
      </>
    );
  }
  if (step === 'visibility') {
    return (
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
    );
  }
  if (step === 'location') {
    return (
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
            <Button onClick={pickFolder}>Choose…</Button>
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
    );
  }
  if (step === 'review') {
    return (
      <dl className={styles.summary}>
        <div className={styles.summaryRow}>
          <dt>Repository</dt>
          <dd className="mono">
            {host}/{target}
          </dd>
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
    );
  }
  void account;
  return null;
}

export default function NewProjectWizard({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  /** The registered project, so the host can select it and refresh. */
  onCreated: (project: ProjectDef) => void | Promise<void>;
}): React.JSX.Element {
  const { settings } = useApp();
  const provider = createProviderOf(settings?.forgeProvider ?? DEFAULT_FORGE_PROVIDER);
  const [account, setAccount] = useState<ForgeAccount | null>(null);
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
    void api.projects.forgeAccount().then((next) => {
      if (cancelled) return;
      setAccount(next);
      if (next.login) setOwner(next.login);
    });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  useEffect(() => {
    if (step === 'name') nameRef.current?.focus();
  }, [step, account?.available]);

  const trimmedName = name.trim();
  const issue = nameIssue(name);
  const owners = account?.owners ?? [];
  const activeProvider: CreateProvider = account?.provider ?? provider;
  const host = account?.host ?? defaultHost(activeProvider);
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
      const result = await api.projects.createRepo({
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

  if (account && !account.available) {
    return <BlockedForgePanel account={account} provider={activeProvider} onClose={onClose} />;
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
      <CreatedForgePanel
        created={created}
        visibility={visibility}
        provider={activeProvider}
        onClose={onClose}
        onConfigureCommands={() => setConfiguringCommands(true)}
      />
    );
  }

  const label = providerLabel(activeProvider);
  const cli = cliName(activeProvider);

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
          Foundry creates the repository on {label} with your own <code>{cli}</code> CLI, clones it,
          and points itself at the clone.
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
        {account && (
          <WizardStepBody
            step={step}
            account={account}
            provider={activeProvider}
            host={host}
            name={name}
            setName={setName}
            owner={owner}
            setOwner={setOwner}
            owners={owners}
            issue={issue}
            target={target}
            visibility={visibility}
            setVisibility={setVisibility}
            parentDir={parentDir}
            clonePath={clonePath}
            description={description}
            setDescription={setDescription}
            pickFolder={() => void pickFolder()}
            canAdvance={canAdvance}
            nameRef={nameRef}
            setStep={setStep}
          />
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
