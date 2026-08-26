import { useEffect, useMemo, useState } from 'react';
import type {
  LinearIssueSnapshot,
  LinearStatusMapping,
  LinearWorkflowState,
  ValidationIssue,
} from '@shared/types.js';
import type { LinearConnectionState } from '@shared/ipc-contract.js';
import { api } from '../../api.js';
import { useApp } from '../../stores/app.js';
import { Button } from '../ui/Button.js';
import { Dropdown } from '../ui/Dropdown.js';
import { Field, TextInput } from '../ui/Field.js';
import PipelineRibbon from '../pipeline/PipelineRibbon.js';
import styles from './LinearComposer.module.css';

const EMPTY_MAPPING: LinearStatusMapping = { started: null, completed: null, failed: null };

function suggestedMapping(
  saved: LinearStatusMapping,
  states: LinearWorkflowState[],
): LinearStatusMapping {
  const known = new Set(states.map((state) => state.id));
  const byType = (type: string): string | null =>
    states.find((state) => state.type === type)?.id ?? null;
  return {
    started: saved.started && known.has(saved.started) ? saved.started : byType('started'),
    completed:
      saved.completed && known.has(saved.completed) ? saved.completed : byType('completed'),
    failed:
      saved.failed && known.has(saved.failed)
        ? saved.failed
        : (byType('canceled') ?? byType('cancelled')),
  };
}

function mappingComplete(mapping: LinearStatusMapping): boolean {
  return Boolean(mapping.started && mapping.completed && mapping.failed);
}

export default function LinearComposer({
  onOpen,
  onOpenSettings,
  baseSyncing,
}: {
  onOpen: (runId: string) => void;
  onOpenSettings?: (pane: string) => void;
  baseSyncing: boolean;
}): React.JSX.Element {
  const { settings, pipelines, project, projectId, patchSettings, refreshAll } = useApp();
  const [connection, setConnection] = useState<LinearConnectionState | null>(null);
  const [query, setQuery] = useState('');
  const [issues, setIssues] = useState<LinearIssueSnapshot[]>([]);
  const [selectedIssueId, setSelectedIssueId] = useState('');
  const [states, setStates] = useState<LinearWorkflowState[]>([]);
  const [mapping, setMapping] = useState<LinearStatusMapping>(EMPTY_MAPPING);
  const [selectedPipeline, setSelectedPipeline] = useState('');
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [note, setNote] = useState('');
  const [startIssues, setStartIssues] = useState<ValidationIssue[]>([]);

  const issue = useMemo(
    () => issues.find((candidate) => candidate.id === selectedIssueId) ?? issues[0] ?? null,
    [issues, selectedIssueId],
  );
  const pipeline = useMemo(
    () => pipelines.find((candidate) => candidate.id === selectedPipeline) ?? pipelines[0] ?? null,
    [pipelines, selectedPipeline],
  );

  useEffect(() => {
    void api.linear.state().then(setConnection);
  }, []);

  useEffect(() => {
    if (!connection?.keySet) return;
    let cancelled = false;
    setLoading(true);
    void api.linear
      .issues('')
      .then((next) => {
        if (!cancelled) setIssues(next);
      })
      .catch((error: Error) => {
        if (!cancelled) setNote(error.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connection?.keySet]);

  useEffect(() => {
    if (!issues.some((candidate) => candidate.id === selectedIssueId)) {
      setSelectedIssueId(issues[0]?.id ?? '');
    }
  }, [issues, selectedIssueId]);

  useEffect(() => {
    if (!pipelines.some((candidate) => candidate.id === selectedPipeline)) {
      setSelectedPipeline(pipelines[0]?.id ?? '');
    }
  }, [pipelines, selectedPipeline]);

  useEffect(() => {
    if (!issue) {
      setStates([]);
      setMapping(EMPTY_MAPPING);
      return;
    }
    let cancelled = false;
    setNote('Loading team workflow…');
    void api.linear
      .workflowStates(issue.team.id)
      .then((next) => {
        if (cancelled) return;
        setStates(next);
        setMapping(suggestedMapping(settings?.linearStatusMapping ?? EMPTY_MAPPING, next));
        setNote('');
      })
      .catch((error: Error) => {
        if (!cancelled) setNote(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [issue, settings?.linearStatusMapping]);

  const browse = async (): Promise<void> => {
    if (!connection?.keySet || loading) return;
    setLoading(true);
    setNote('');
    setStartIssues([]);
    try {
      const next = await api.linear.issues(query);
      setIssues(next);
      if (!next.length) setNote('No accessible Linear issues matched.');
    } catch (error) {
      setNote((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const saveMapping = async (): Promise<boolean> => {
    if (!mappingComplete(mapping)) {
      setNote('Choose all three workflow statuses before starting.');
      return false;
    }
    const errors = await patchSettings({ linearStatusMapping: mapping });
    if (errors.length) {
      setNote(errors.join(' · '));
      return false;
    }
    setNote('Workflow mapping saved.');
    return true;
  };

  const start = async (): Promise<void> => {
    if (!issue || !pipeline || starting || baseSyncing) return;
    setStarting(true);
    setStartIssues([]);
    try {
      if (!(await saveMapping())) return;
      const result = await api.linear.startRun({
        projectId,
        pipelineId: pipeline.id,
        issueId: issue.id,
      });
      if (!result.ok) {
        setStartIssues(result.issues);
        await refreshAll();
        return;
      }
      await refreshAll();
      if (result.runId) onOpen(result.runId);
    } catch (error) {
      setStartIssues([{ level: 'error', where: 'linear', message: (error as Error).message }]);
    } finally {
      setStarting(false);
    }
  };

  if (connection && !connection.keySet) {
    return (
      <section className={`${styles.composer} card`} data-testid="linear-composer">
        <h2>Connect Linear to start from an issue</h2>
        <p className="faint">
          Add a personal API key, then return here to browse issues and map team workflow states.
        </p>
        <Button variant="primary" onClick={() => onOpenSettings?.('integrations')}>
          Open Integrations
        </Button>
      </section>
    );
  }

  return (
    <section className={`${styles.composer} card`} data-testid="linear-composer">
      <div className={styles.searchRow}>
        <TextInput
          value={query}
          placeholder="Issue key or title; leave empty for recent issues"
          aria-label="Find Linear issue"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void browse();
          }}
        />
        <Button disabled={loading || !connection?.keySet} onClick={() => void browse()}>
          {loading ? 'Loading…' : 'Find issues'}
        </Button>
      </div>

      <Field label="Linear issue">
        <Dropdown
          value={issue?.id ?? ''}
          options={issues.map((candidate) => ({
            value: candidate.id,
            label: `${candidate.identifier} · ${candidate.title}`,
            description: `${candidate.team.name} · ${candidate.state.name}`,
          }))}
          onChange={setSelectedIssueId}
          aria-label="Linear issue"
        />
      </Field>

      {issue && (
        <div className={styles.issueCard} data-testid="linear-issue-detail">
          <div className={styles.issueHead}>
            <strong>{issue.identifier}</strong>
            <span>{issue.state.name}</span>
            <Button size="sm" variant="ghost" onClick={() => void api.app.openExternal(issue.url)}>
              Open in Linear
            </Button>
          </div>
          <h2>{issue.title}</h2>
          <p>{issue.description || 'No description.'}</p>
        </div>
      )}

      {issue && states.length > 0 && (
        <div className={styles.mapping}>
          <p className={styles.mappingTitle}>{issue.team.name} workflow mapping</p>
          {(
            [
              ['started', 'Run started'],
              ['completed', 'Run accepted'],
              ['failed', 'Run failed / rejected / killed'],
            ] as const
          ).map(([stage, label]) => (
            <Field key={stage} label={label}>
              <Dropdown
                value={mapping[stage] ?? ''}
                options={states.map((state) => ({
                  value: state.id,
                  label: state.name,
                  description: state.type,
                }))}
                onChange={(stateId) => setMapping((current) => ({ ...current, [stage]: stateId }))}
                aria-label={label}
              />
            </Field>
          ))}
          <Button size="sm" disabled={!mappingComplete(mapping)} onClick={() => void saveMapping()}>
            Save mapping
          </Button>
        </div>
      )}

      <div className={styles.startRow}>
        <Dropdown
          className={styles.pipeline}
          value={pipeline?.id ?? ''}
          options={pipelines.map((candidate) => ({
            value: candidate.id,
            label: candidate.name,
            description: candidate.description || undefined,
          }))}
          onChange={setSelectedPipeline}
          aria-label="Pipeline"
        />
        {pipeline && <PipelineRibbon pipeline={pipeline} />}
        <Button
          variant="primary"
          disabled={
            !project || !issue || !pipeline || !mappingComplete(mapping) || starting || baseSyncing
          }
          title={baseSyncing ? `Updating ${project?.baseRef ?? 'base branch'} first` : undefined}
          onClick={() => void start()}
        >
          {starting ? 'Starting…' : 'Start from issue'}
        </Button>
      </div>

      {note && <p className={styles.note}>{note}</p>}
      {startIssues.length > 0 && (
        <ul className={styles.issues} role="alert">
          {startIssues.map((problem, index) => (
            <li key={`${problem.where}-${index}`}>
              <strong>{problem.where}</strong> {problem.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
