import {
  AlertTriangle,
  Check,
  LoaderCircle,
  PlugZap,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { linearIssueBrief, linearIssueEvidence } from '@shared/linear.js';
import type {
  GeneratedRunPlan,
  LinearIssueSnapshot,
  LinearStatusMapping,
  LinearWorkflowState,
  PipelineDef,
  ValidationIssue,
} from '@shared/types.js';
import type { LinearConnectionState } from '@shared/ipc-contract.js';
import { api } from '../../api.js';
import { useOrchestratorPlan } from '../../hooks/useOrchestratorPlan.js';
import { useApp } from '../../stores/app.js';
import { safeGetItem, safeSetItem } from '../../utils/local-store.js';
import PanelTranscript from '../readiness/PanelTranscript.js';
import PipelineRibbon from '../pipeline/PipelineRibbon.js';
import { Button } from '../ui/Button.js';
import { Dropdown } from '../ui/Dropdown.js';
import { TextInput } from '../ui/Field.js';
import LinearIssueResults from './LinearIssueResults.js';
import LinearSelectedIssue from './LinearSelectedIssue.js';
import LinearStatusMappingPanel from './LinearStatusMapping.js';
import { OrchestratorControls, type OrchestratorChoice } from './OrchestratorPicker.js';
import PlanCard from './PlanCard.js';
import styles from './LinearComposer.module.css';

const EMPTY_MAPPING: LinearStatusMapping = { started: null, completed: null, failed: null };
const SEARCH_DEBOUNCE_MS = 250;
const EXECUTION_KEY = 'foundry.linear.execution';
type LinearExecution = 'orchestrator' | 'pipeline';

function loadExecution(): LinearExecution {
  return safeGetItem(EXECUTION_KEY) === 'pipeline' ? 'pipeline' : 'orchestrator';
}

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

function blockedReason(input: {
  hasProject: boolean;
  hasIssue: boolean;
  hasPipeline: boolean;
  requirePipeline: boolean;
  baseSyncing: boolean;
  baseRef: string;
}): string | null {
  if (!input.hasProject) return 'Add a project first';
  if (!input.hasIssue) return 'Choose a Linear issue';
  if (input.requirePipeline && !input.hasPipeline) return 'No pipeline available';
  if (input.baseSyncing) return `Updating ${input.baseRef} first`;
  return null;
}

function lifecycleSummary(
  issue: LinearIssueSnapshot,
  states: LinearWorkflowState[],
  mapping: LinearStatusMapping,
  complete: boolean,
): string {
  if (!complete) {
    return `${issue.identifier} lifecycle mapping is incomplete — set it in the composer before starting.`;
  }
  const name = (id: string | null): string => states.find((state) => state.id === id)?.name ?? '—';
  return `${issue.identifier} moves to ${name(mapping.started)} on start, ${name(
    mapping.completed,
  )} when accepted, ${name(mapping.failed)} if it fails.`;
}

function ValidationIssues({ issues }: { issues: ValidationIssue[] }): React.JSX.Element | null {
  if (!issues.length) return null;
  return (
    <ul className={styles.issues} role="alert">
      {issues.map((problem, index) => (
        <li key={`${problem.where}-${index}`}>
          <strong>{problem.where}</strong> {problem.message}
        </li>
      ))}
    </ul>
  );
}

function LinearIssuePicker({
  issue,
  locked,
  query,
  issues,
  searching,
  searchError,
  activeIndex,
  searchRef,
  onChangeIssue,
  onOpenIssue,
  onQueryChange,
  onSearchKeyDown,
  onActiveIndex,
  onSelect,
  onRetry,
  onClearSearch,
}: {
  issue: LinearIssueSnapshot | null;
  locked: boolean;
  query: string;
  issues: LinearIssueSnapshot[];
  searching: boolean;
  searchError: string;
  activeIndex: number;
  searchRef: RefObject<HTMLInputElement | null>;
  onChangeIssue: () => void;
  onOpenIssue: () => void;
  onQueryChange: (query: string) => void;
  onSearchKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onActiveIndex: (index: number) => void;
  onSelect: (issue: LinearIssueSnapshot) => void;
  onRetry: () => void;
  onClearSearch: (retry: boolean) => void;
}): React.JSX.Element {
  if (issue) {
    return (
      <LinearSelectedIssue
        issue={issue}
        locked={locked}
        onChange={onChangeIssue}
        onOpen={onOpenIssue}
      />
    );
  }

  return (
    <>
      <div className={styles.searchBox}>
        <Search size={14} aria-hidden="true" />
        <TextInput
          ref={searchRef}
          className={styles.searchInput}
          value={query}
          aria-label="Find Linear issue"
          placeholder="Search Linear issues by key or title…"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={onSearchKeyDown}
        />
        {searching && <LoaderCircle size={13} className={styles.spinner} aria-hidden="true" />}
        {query && !searching && (
          <button
            type="button"
            className={styles.clearSearch}
            title="Clear search"
            onClick={() => onClearSearch(false)}
          >
            <X size={13} aria-hidden="true" />
          </button>
        )}
      </div>
      <LinearIssueResults
        issues={issues}
        query={query}
        loading={searching}
        error={searchError}
        activeIndex={activeIndex}
        onActiveIndex={onActiveIndex}
        onSelect={onSelect}
        onRetry={onRetry}
        onClearSearch={() => onClearSearch(true)}
      />
    </>
  );
}

function LinearExecutionFooter({
  execution,
  stage,
  planningFailed,
  choice,
  pipeline,
  pipelines,
  hasIssue,
  mappingReady,
  mappingOpen,
  workflowLoading,
  currentBlocked,
  starting,
  onExecutionChange,
  onChoiceChange,
  onPipelineChange,
  onMappingToggle,
  onCancel,
  onSubmitPlan,
  onStartPipeline,
}: {
  execution: LinearExecution;
  stage: 'compose' | 'planning' | 'ready';
  planningFailed: boolean;
  choice: OrchestratorChoice;
  pipeline: PipelineDef | null;
  pipelines: PipelineDef[];
  hasIssue: boolean;
  mappingReady: boolean;
  mappingOpen: boolean;
  workflowLoading: boolean;
  currentBlocked: string | null;
  starting: boolean;
  onExecutionChange: (execution: LinearExecution) => void;
  onChoiceChange: (choice: OrchestratorChoice) => void;
  onPipelineChange: (pipelineId: string) => void;
  onMappingToggle: () => void;
  onCancel: () => void;
  onSubmitPlan: () => void;
  onStartPipeline: () => void;
}): React.JSX.Element {
  return (
    <div className={styles.startRow}>
      <div className={styles.execution} role="group" aria-label="Execution">
        <button
          type="button"
          className={execution === 'orchestrator' ? styles.executionActive : undefined}
          aria-pressed={execution === 'orchestrator'}
          disabled={stage !== 'compose'}
          onClick={() => onExecutionChange('orchestrator')}
          data-testid="linear-execution-orchestrator"
        >
          Orchestrator
        </button>
        <button
          type="button"
          className={execution === 'pipeline' ? styles.executionActive : undefined}
          aria-pressed={execution === 'pipeline'}
          disabled={stage !== 'compose'}
          title={
            stage !== 'compose' ? 'Discard the plan to run a stored pipeline instead' : undefined
          }
          onClick={() => onExecutionChange('pipeline')}
          data-testid="linear-execution-pipeline"
        >
          Pipeline
        </button>
      </div>

      {execution === 'orchestrator' ? (
        stage !== 'ready' && (
          <OrchestratorControls
            choice={choice}
            disabled={stage === 'planning'}
            onChange={onChoiceChange}
          />
        )
      ) : (
        <>
          <Dropdown
            className={styles.pipeline}
            value={pipeline?.id ?? ''}
            options={pipelines.map((candidate) => ({
              value: candidate.id,
              label: candidate.name,
              description: candidate.description || undefined,
            }))}
            onChange={onPipelineChange}
            aria-label="Pipeline"
          />
          {pipeline && <PipelineRibbon pipeline={pipeline} />}
        </>
      )}

      {hasIssue && (
        <button
          type="button"
          className={`${styles.mappingButton} ${mappingReady ? '' : styles.mappingButtonNeeded}`}
          aria-expanded={mappingOpen}
          onClick={onMappingToggle}
          data-testid="linear-mapping-chip"
        >
          {workflowLoading ? (
            <LoaderCircle size={11} className={styles.spinner} aria-hidden="true" />
          ) : mappingReady ? (
            <Check size={11} aria-hidden="true" />
          ) : (
            <AlertTriangle size={11} aria-hidden="true" />
          )}
          {workflowLoading
            ? 'Loading team workflow'
            : mappingReady
              ? 'Status mapping auto-set'
              : 'Status mapping needed'}
          <SlidersHorizontal size={11} className={styles.mappingSliders} aria-hidden="true" />
        </button>
      )}

      {stage === 'ready' ? (
        <span className={styles.planReady}>Plan ready · review and start below</span>
      ) : stage === 'planning' ? (
        <div className={styles.planningActions}>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!planningFailed}
            onClick={planningFailed ? onSubmitPlan : undefined}
          >
            {planningFailed ? 'Try again' : 'Planning…'}
          </Button>
        </div>
      ) : (
        <Button
          variant="primary"
          size="sm"
          className={styles.startButton}
          disabled={Boolean(currentBlocked) || starting}
          title={currentBlocked ?? undefined}
          onClick={execution === 'orchestrator' ? onSubmitPlan : onStartPipeline}
          data-testid="linear-primary"
        >
          {starting ? 'Starting…' : execution === 'orchestrator' ? 'Plan run' : 'Start from issue'}
          {!currentBlocked && !starting && <kbd>⌘↵</kbd>}
        </Button>
      )}
    </div>
  );
}

export default function LinearComposer({
  active,
  header,
  choice,
  onChoiceChange,
  onOpen,
  onOpenSettings,
  onConnectionChange,
  baseSyncing,
}: {
  active: boolean;
  header: ReactNode;
  choice: OrchestratorChoice;
  onChoiceChange: (choice: OrchestratorChoice) => void;
  onOpen: (runId: string) => void;
  onOpenSettings?: (pane: string) => void;
  onConnectionChange?: (connection: LinearConnectionState | null) => void;
  baseSyncing: boolean;
}): React.JSX.Element {
  const { settings, pipelines, project, projectId, patchSettings, refreshAll } = useApp();
  const orchestrator = useOrchestratorPlan(projectId, choice);
  const [connection, setConnection] = useState<LinearConnectionState | null>(null);
  const [execution, setExecution] = useState<LinearExecution>(loadExecution);
  const [query, setQuery] = useState('');
  const [issues, setIssues] = useState<LinearIssueSnapshot[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [issue, setIssue] = useState<LinearIssueSnapshot | null>(null);
  const [states, setStates] = useState<LinearWorkflowState[]>([]);
  const [mapping, setMapping] = useState<LinearStatusMapping>(EMPTY_MAPPING);
  const [mappingOpen, setMappingOpen] = useState(false);
  const [showMappingErrors, setShowMappingErrors] = useState(false);
  const [selectedPipeline, setSelectedPipeline] = useState('');
  const [searching, setSearching] = useState(false);
  const [workflowLoading, setWorkflowLoading] = useState(false);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [workflowError, setWorkflowError] = useState('');
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [startIssues, setStartIssues] = useState<ValidationIssue[]>([]);
  const [planStartIssues, setPlanStartIssues] = useState<ValidationIssue[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchGenerationRef = useRef(0);
  const issueRef = useRef<LinearIssueSnapshot | null>(null);
  const primaryActionRef = useRef<() => void>(() => undefined);
  issueRef.current = issue;

  const pipeline = useMemo(
    () => pipelines.find((candidate) => candidate.id === selectedPipeline) ?? pipelines[0] ?? null,
    [pipelines, selectedPipeline],
  );
  const mappingReady = mappingComplete(mapping) && !workflowError;
  const baseRef = project?.baseRef ?? 'base branch';
  const manualBlocked = blockedReason({
    hasProject: Boolean(project),
    hasIssue: Boolean(issue),
    hasPipeline: Boolean(pipeline),
    requirePipeline: true,
    baseSyncing,
    baseRef,
  });
  const planBlocked = blockedReason({
    hasProject: Boolean(project),
    hasIssue: Boolean(issue),
    hasPipeline: true,
    requirePipeline: false,
    baseSyncing,
    baseRef,
  });

  useEffect(() => {
    let cancelled = false;
    onConnectionChange?.(null);
    void api.linear.state().then((next) => {
      if (cancelled) return;
      setConnection(next);
      onConnectionChange?.(next);
    });
    return () => {
      cancelled = true;
    };
  }, [onConnectionChange]);

  useEffect(() => {
    if (!active || issue || !connection?.keySet) return;
    window.requestAnimationFrame(() => searchRef.current?.focus());
  }, [active, connection?.keySet, issue]);

  useEffect(() => {
    if (!connection?.keySet) return;
    const generation = ++searchGenerationRef.current;
    let cancelled = false;
    setSearching(true);
    setSearchError('');
    const timer = window.setTimeout(() => {
      void api.linear
        .issues(query)
        .then((next) => {
          if (cancelled || generation !== searchGenerationRef.current) return;
          setIssues(next);
          setActiveIndex(0);
        })
        .catch((error: Error) => {
          if (cancelled || generation !== searchGenerationRef.current) return;
          setIssues([]);
          setActiveIndex(0);
          setSearchError(error.message);
        })
        .finally(() => {
          if (!cancelled && generation === searchGenerationRef.current) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [connection?.keySet, query, retryGeneration]);

  useEffect(() => {
    if (!pipelines.some((candidate) => candidate.id === selectedPipeline)) {
      setSelectedPipeline(pipelines[0]?.id ?? '');
    }
  }, [pipelines, selectedPipeline]);

  useEffect(() => {
    if (!issue) {
      setStates([]);
      setMapping(EMPTY_MAPPING);
      setWorkflowError('');
      setWorkflowLoading(false);
      setShowMappingErrors(false);
      return;
    }
    let cancelled = false;
    setWorkflowLoading(true);
    setWorkflowError('');
    setStartIssues([]);
    setPlanStartIssues([]);
    void api.linear
      .workflowStates(issue.team.id)
      .then((next) => {
        if (cancelled) return;
        const nextMapping = suggestedMapping(settings?.linearStatusMapping ?? EMPTY_MAPPING, next);
        setStates(next);
        setMapping(nextMapping);
        setMappingOpen(!mappingComplete(nextMapping));
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setStates([]);
        setMapping(EMPTY_MAPPING);
        setMappingOpen(true);
        setWorkflowError(error.message);
      })
      .finally(() => {
        if (!cancelled) setWorkflowLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [issue, settings?.linearStatusMapping]);

  const selectIssue = (next: LinearIssueSnapshot): void => {
    orchestrator.discard();
    setIssue(next);
    setStartIssues([]);
    setPlanStartIssues([]);
    setShowMappingErrors(false);
  };

  const changeIssue = (): void => {
    orchestrator.discard();
    setIssue(null);
    setMappingOpen(false);
    setStartIssues([]);
    setPlanStartIssues([]);
    if (active) window.requestAnimationFrame(() => searchRef.current?.focus());
  };

  const changeExecution = (next: LinearExecution): void => {
    if (orchestrator.stage !== 'compose') return;
    setExecution(next);
    safeSetItem(EXECUTION_KEY, next);
    setStartIssues([]);
    setPlanStartIssues([]);
  };

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, Math.max(issues.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const next = issues[activeIndex];
      if (next) selectIssue(next);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (query) setQuery('');
      else event.currentTarget.blur();
    }
  };

  const mappingValidationIssues = (): ValidationIssue[] => [
    {
      level: 'error',
      where: 'linear',
      message: workflowError
        ? `Could not load ${issue?.team.name ?? 'the team'} workflow: ${workflowError}`
        : `Map all three lifecycle statuses for ${issue?.team.name ?? 'this team'} before starting.`,
    },
  ];

  const start = async (runPlan: GeneratedRunPlan | null): Promise<void> => {
    const selected = runPlan?.pipeline ?? pipeline;
    if (!project || !issue || !selected || starting || baseSyncing) return;
    const setErrors = runPlan ? setPlanStartIssues : setStartIssues;
    const clearOtherErrors = runPlan ? setStartIssues : setPlanStartIssues;
    clearOtherErrors([]);
    if (!mappingReady) {
      setShowMappingErrors(true);
      setMappingOpen(true);
      setErrors(mappingValidationIssues());
      return;
    }

    setStarting(true);
    setErrors([]);
    try {
      const errors = await patchSettings({ linearStatusMapping: mapping });
      if (errors.length) {
        setErrors(errors.map((message) => ({ level: 'error', where: 'linear', message })));
        return;
      }
      const result = await api.linear.startRun({
        projectId,
        pipelineId: selected.id,
        issueId: issue.id,
        ...(runPlan ? { plan: runPlan } : {}),
      });
      if (!result.ok) {
        setErrors(result.issues);
        await refreshAll();
        return;
      }
      orchestrator.discard();
      await refreshAll();
      if (result.runId) onOpen(result.runId);
    } catch (error) {
      setErrors([{ level: 'error', where: 'linear', message: (error as Error).message }]);
    } finally {
      setStarting(false);
    }
  };

  const submitPlan = async (): Promise<void> => {
    if (planBlocked || orchestrator.planningLive || evidenceLoading || !issue) return;
    setStartIssues([]);
    setPlanStartIssues([]);
    setEvidenceLoading(true);
    try {
      const detailedIssue = await api.linear.issue(issue.id);
      if (issueRef.current?.id !== issue.id) return;
      await orchestrator.submit(
        [linearIssueBrief(detailedIssue), linearIssueEvidence(detailedIssue)].join('\n\n'),
      );
    } catch (error) {
      if (issueRef.current?.id === issue.id) {
        setStartIssues([
          {
            level: 'error',
            where: 'linear.issue',
            message: (error as Error).message || 'Could not load Linear issue details.',
          },
        ]);
      }
    } finally {
      setEvidenceLoading(false);
    }
  };

  primaryActionRef.current = () => {
    if (orchestrator.stage === 'planning') return;
    if (orchestrator.stage === 'ready' && orchestrator.plan) {
      void start(orchestrator.plan);
    } else if (execution === 'orchestrator') {
      void submitPlan();
    } else {
      void start(null);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!active || !issue || !(event.metaKey || event.ctrlKey) || event.key !== 'Enter') return;
      event.preventDefault();
      primaryActionRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, issue]);

  const planningFailed = orchestrator.planning?.status === 'failed';
  const currentBlocked = evidenceLoading
    ? 'Loading Linear issue details'
    : execution === 'orchestrator'
      ? planBlocked
      : manualBlocked;
  const lifecycle = issue ? lifecycleSummary(issue, states, mapping, mappingReady) : '';

  return (
    <div className={styles.workspace}>
      <section className={`${styles.card} card`} data-testid={active ? 'run-composer' : undefined}>
        {header}
        {!connection ? (
          <div className={styles.connectionState} data-testid="linear-composer" aria-busy="true">
            Checking the Linear connection…
          </div>
        ) : !connection.keySet ? (
          <div className={styles.disconnected} data-testid="linear-composer">
            <PlugZap size={15} aria-hidden="true" />
            <div>
              <strong>Linear isn&apos;t connected.</strong>
              <span>Add a personal API key to browse issues and map workflow states.</span>
            </div>
            <Button size="sm" variant="primary" onClick={() => onOpenSettings?.('integrations')}>
              Open Integrations
            </Button>
          </div>
        ) : (
          <div className={styles.composer} data-testid="linear-composer">
            <LinearIssuePicker
              issue={issue}
              locked={orchestrator.stage !== 'compose'}
              query={query}
              issues={issues}
              searching={searching}
              searchError={searchError}
              activeIndex={activeIndex}
              searchRef={searchRef}
              onChangeIssue={changeIssue}
              onOpenIssue={() => {
                if (issue) void api.app.openExternal(issue.url);
              }}
              onQueryChange={setQuery}
              onSearchKeyDown={onSearchKeyDown}
              onActiveIndex={setActiveIndex}
              onSelect={selectIssue}
              onRetry={() => setRetryGeneration((generation) => generation + 1)}
              onClearSearch={(retry) => {
                setQuery('');
                if (retry) setRetryGeneration((generation) => generation + 1);
                searchRef.current?.focus();
              }}
            />

            {issue && mappingOpen && (
              <LinearStatusMappingPanel
                teamName={issue.team.name}
                states={states}
                mapping={mapping}
                loading={workflowLoading}
                error={workflowError}
                showErrors={showMappingErrors}
                onChange={(next) => {
                  setMapping(next);
                  if (mappingComplete(next)) {
                    setShowMappingErrors(false);
                    setStartIssues([]);
                    setPlanStartIssues([]);
                  }
                }}
              />
            )}

            <LinearExecutionFooter
              execution={execution}
              stage={orchestrator.stage}
              planningFailed={planningFailed}
              choice={choice}
              pipeline={pipeline}
              pipelines={pipelines}
              hasIssue={Boolean(issue)}
              mappingReady={mappingReady}
              mappingOpen={mappingOpen}
              workflowLoading={workflowLoading}
              currentBlocked={currentBlocked}
              starting={starting}
              onExecutionChange={changeExecution}
              onChoiceChange={onChoiceChange}
              onPipelineChange={setSelectedPipeline}
              onMappingToggle={() => setMappingOpen((open) => !open)}
              onCancel={orchestrator.cancel}
              onSubmitPlan={submitPlan}
              onStartPipeline={() => void start(null)}
            />

            {issue && execution === 'orchestrator' && orchestrator.stage === 'compose' && (
              <p className={styles.orchestratorHint}>
                The Orchestrator reads {issue.identifier}&apos;s title as the brief and the
                description, comments, labels, and parent as untrusted evidence, then composes the
                pipeline.
              </p>
            )}
            {currentBlocked && !starting && orchestrator.stage === 'compose' && (
              <p className={styles.startHint}>{currentBlocked}</p>
            )}
            {orchestrator.planError && (
              <p className={styles.planError} role="alert">
                {orchestrator.planError}
              </p>
            )}
            <ValidationIssues issues={startIssues} />
          </div>
        )}
      </section>

      {active && orchestrator.stage === 'planning' && (
        <section className={`${styles.planningPanel} card`} data-testid="planning-panel">
          <div className={styles.planningHead}>
            <span className={styles.planningTitle}>
              {planningFailed ? 'Planning failed' : 'The Orchestrator is planning'}
            </span>
            <span className={styles.planningDetail}>
              {orchestrator.planning?.detail ?? 'Opening the planning session…'}
            </span>
          </div>
          <PanelTranscript
            entries={orchestrator.planning?.entries ?? []}
            live={orchestrator.planningLive}
          />
        </section>
      )}

      {active &&
        orchestrator.stage === 'ready' &&
        orchestrator.plan &&
        orchestrator.original &&
        issue && (
          <PlanCard
            plan={orchestrator.plan}
            original={orchestrator.original}
            starting={starting}
            startBlocked={baseSyncing ? `Updating ${baseRef} first` : null}
            issues={planStartIssues}
            messages={orchestrator.messages}
            replying={orchestrator.replying}
            chatError={orchestrator.chatError}
            onSendMessage={(text) => void orchestrator.sendMessage(text)}
            sourceBadge={`Linear · ${issue.identifier}`}
            sourceDetail={lifecycle}
            onPhaseModelChange={orchestrator.setPhaseModel}
            onPhaseReasoningEffortChange={orchestrator.setPhaseReasoningEffort}
            onResetPhaseOverrides={orchestrator.resetPhaseOverrides}
            onStart={() => void start(orchestrator.plan)}
            onRegenerate={submitPlan}
            onDiscard={() => {
              orchestrator.discard();
              setPlanStartIssues([]);
            }}
          />
        )}
    </div>
  );
}
