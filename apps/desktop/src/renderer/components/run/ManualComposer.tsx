import { useEffect, useMemo, useState } from 'react';
import type { ValidationIssue } from '@shared/types.js';
import { api } from '../../api.js';
import { useApp } from '../../stores/app.js';
import PipelineRibbon from '../pipeline/PipelineRibbon.js';
import { Button } from '../ui/Button.js';
import { Dropdown } from '../ui/Dropdown.js';
import styles from './ManualComposer.module.css';

function startAvailability(input: {
  hasProject: boolean;
  hasPipeline: boolean;
  requestOk: boolean;
  blockingErrors: number;
  baseSyncing: boolean;
  baseRef: string;
}): { canStart: boolean; reason: string } {
  if (!input.hasProject) return { canStart: false, reason: 'Add a project first' };
  if (!input.hasPipeline) return { canStart: false, reason: 'No pipeline available' };
  if (!input.requestOk) return { canStart: false, reason: 'Describe what to build' };
  if (input.blockingErrors) return { canStart: false, reason: 'Fix pipeline errors first' };
  if (input.baseSyncing) {
    return { canStart: false, reason: `Updating ${input.baseRef} first` };
  }
  return { canStart: true, reason: '' };
}

/**
 * The classic pipeline-picker composer: choose a stored pipeline, write the
 * brief, start. Extracted whole from the Runs screen when the Orchestrator
 * became the default path; behavior is unchanged.
 */
export default function ManualComposer({
  request,
  onRequestChange,
  onOpen,
  onOpenSettings,
  baseSyncing,
}: {
  request: string;
  onRequestChange: (request: string) => void;
  onOpen: (runId: string) => void;
  onOpenSettings?: (pane: string) => void;
  baseSyncing: boolean;
}): React.JSX.Element {
  const { pipelines, project, projectId, refreshAll } = useApp();
  const [selectedPipeline, setSelectedPipeline] = useState(
    () => localStorage.getItem('foundry.pipeline') ?? '',
  );
  const [starting, setStarting] = useState(false);
  const [startNote, setStartNote] = useState('');
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [preflight, setPreflight] = useState<ValidationIssue[]>([]);

  const pipeline = useMemo(
    () => pipelines.find((p) => p.id === selectedPipeline) ?? pipelines[0] ?? null,
    [pipelines, selectedPipeline],
  );

  useEffect(() => {
    if (!pipelines.some((p) => p.id === selectedPipeline))
      setSelectedPipeline(pipelines[0]?.id ?? '');
  }, [pipelines, selectedPipeline]);

  useEffect(() => {
    if (selectedPipeline) localStorage.setItem('foundry.pipeline', selectedPipeline);
  }, [selectedPipeline]);

  // Live preflight so missing commands and broken refs show before Start is hit.
  useEffect(() => {
    if (!pipeline) {
      setPreflight([]);
      return;
    }
    let cancelled = false;
    void api.pipelines.validate(pipeline, projectId || undefined).then((next) => {
      if (!cancelled) setPreflight(next);
    });
    return () => {
      cancelled = true;
    };
  }, [pipeline, projectId, project?.commands]);

  const missingCommands = useMemo(
    () =>
      preflight.filter(
        (i) =>
          i.level === 'warning' &&
          i.message.includes('project command') &&
          i.message.includes('not configured'),
      ),
    [preflight],
  );
  const blockingPreflight = useMemo(
    () => preflight.filter((i) => i.level === 'error'),
    [preflight],
  );

  const requestOk = request.trim().length > 0;
  const { canStart, reason: startDisabledReason } = startAvailability({
    hasProject: Boolean(project),
    hasPipeline: Boolean(pipeline),
    requestOk,
    blockingErrors: blockingPreflight.length,
    baseSyncing,
    baseRef: project?.baseRef ?? 'base branch',
  });

  const start = async (): Promise<void> => {
    if (!canStart || starting) return;
    setStarting(true);
    setIssues([]);
    setStartNote(
      missingCommands.length
        ? 'Checking project commands (detecting from the repo if needed)…'
        : '',
    );
    try {
      const result = await api.runs.start({
        projectId,
        pipelineId: pipeline!.id,
        request: request.trim(),
      });
      if (!result.ok) {
        setIssues(result.issues);
        setStartNote('');
        // Project commands may have been partially filled; refresh so Settings matches.
        await refreshAll();
        return;
      }
      onRequestChange('');
      setStartNote('');
      await refreshAll();
      if (result.runId) onOpen(result.runId);
    } catch (e) {
      setIssues([{ level: 'error', where: 'start', message: (e as Error).message }]);
      setStartNote('');
    } finally {
      setStarting(false);
    }
  };

  const onKeydown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void start();
    }
  };

  const openProjectCommands = (): void => onOpenSettings?.('project');

  return (
    <div className={styles.composer}>
      <textarea
        className={`textarea ${styles.request}`}
        value={request}
        onChange={(e) => onRequestChange(e.target.value)}
        rows={3}
        placeholder="What should the factory build? Be specific: the request is the whole brief."
        onKeyDown={onKeydown}
        aria-label="Run request"
        data-testid="run-request"
      />
      <div className={styles.controls}>
        <Dropdown
          className={styles.pipeline}
          value={selectedPipeline || pipeline?.id || ''}
          options={pipelines.map((p) => ({
            value: p.id,
            label: p.name,
            description: p.description || undefined,
          }))}
          onChange={(next) => setSelectedPipeline(next)}
          aria-label="Pipeline"
          data-testid="run-pipeline"
        />
        {pipeline && <PipelineRibbon pipeline={pipeline} />}
        <Button
          variant="primary"
          className={styles.startButton}
          disabled={!canStart || starting}
          title={startDisabledReason || undefined}
          onClick={() => void start()}
          data-testid="run-start"
        >
          {starting ? 'Starting…' : 'Start run'}
          {canStart && !starting && <kbd>⌘↵</kbd>}
        </Button>
      </div>
      {!canStart && startDisabledReason && (
        <p className={`${styles.hintLine} faint`}>{startDisabledReason}</p>
      )}
      {pipeline && <p className={`${styles.desc} faint`}>{pipeline.description}</p>}
      {missingCommands.length > 0 && (
        <div className={styles.notice}>
          <p>
            This pipeline needs project command
            {missingCommands.length === 1 ? '' : 's'} that are not configured yet
            {missingCommands.length === 1
              ? ` (${missingCommands[0]!.message.match(/"([^"]+)"/)?.[1] ?? 'test'})`
              : ''}
            . Starting will detect them from the repo (and ask an agent if needed).
          </p>
          <Button size="sm" onClick={openProjectCommands}>
            Configure commands
          </Button>
        </div>
      )}
      {blockingPreflight.length > 0 && (
        <ul className={`${styles.issues} ${styles.warn}`}>
          {blockingPreflight.map((issue, i) => (
            <li key={i}>
              <strong>{issue.where}</strong> {issue.message}
            </li>
          ))}
        </ul>
      )}
      {startNote && <p className={`${styles.hintLine} faint`}>{startNote}</p>}
      {issues.length > 0 && (
        <ul className={styles.issues}>
          {issues.map((issue, i) => (
            <li key={i}>
              <strong>{issue.where}</strong> {issue.message}
            </li>
          ))}
        </ul>
      )}
      {issues.some((i) => i.message.includes('project command')) && (
        <Button size="sm" className={styles.fix} onClick={openProjectCommands}>
          Open project commands
        </Button>
      )}
    </div>
  );
}
