import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ModelInfo,
  ReadinessAskAnswer,
  ReadinessCriterion,
  ReadinessEntry,
  ReadinessInspectResult,
  ReadinessPhase,
  ReadinessState,
  ReasoningEffort,
} from '@shared/types.js';
import { api } from '../api.js';
import { duration } from '../format.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';
import { isReadinessLive, readinessExitAction } from '../readiness-view.js';
import { useApp } from '../stores/app.js';
import ModelPicker from './ModelPicker.js';
import { Button } from './ui/Button.js';
import { Dropdown } from './ui/Dropdown.js';
import { Field, TextInput } from './ui/Field.js';
import { ModalShell } from './ui/ModalShell.js';
import styles from './ReadinessFlow.module.css';

const EFFORTS: { value: ReasoningEffort; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X-High' },
  { value: 'max', label: 'Max' },
];

const CRITERION_LABELS: Record<string, string> = {
  lint_format: 'Lint & format',
  typecheck: 'Typecheck',
  tests: 'Tests',
  build: 'Build',
  setup: 'Setup',
  agents_md: 'AGENTS.md',
  env_example: 'Env example',
  ci_parity: 'CI parity',
  templates: 'Templates',
  precommit: 'Pre-commit',
  coverage: 'Coverage',
};

const TOOL_ICON: Record<string, string> = {
  command: '⚙',
  read: '◇',
  edit: '✎',
  search: '⌕',
  todo: '☑',
  task: '▸',
  ask: '?',
  other: '·',
};

type StepId = 'check' | 'fix' | 'verify' | 'pr' | 'merge';
type StepTone = 'pending' | 'current' | 'done' | 'failed' | 'skipped';

const STEPS: { id: StepId; label: string }[] = [
  { id: 'check', label: 'Check' },
  { id: 'fix', label: 'Fix' },
  { id: 'verify', label: 'Verify' },
  { id: 'pr', label: 'PR' },
  { id: 'merge', label: 'Merge' },
];

function stepOf(phase: ReadinessPhase): StepId {
  switch (phase) {
    case 'remediating':
      return 'fix';
    case 'verifying':
      return 'verify';
    case 'pr_ready':
      return 'pr';
    case 'awaiting_merge':
    case 'confirming_merge':
    case 'finalizing':
    case 'complete':
      return 'merge';
    default:
      return 'check';
  }
}

function stepTone(id: StepId, phase: ReadinessPhase, failedAt?: StepId): StepTone {
  if (phase === 'skipped') return id === 'check' ? 'skipped' : 'pending';
  if (phase === 'failed') {
    const current = failedAt ?? 'check';
    if (id === current) return 'failed';
    return STEPS.findIndex((s) => s.id === id) < STEPS.findIndex((s) => s.id === current)
      ? 'done'
      : 'pending';
  }
  if (phase === 'complete') return 'done';
  if (phase === 'not_ready') {
    if (id === 'check') return 'done';
    if (id === 'fix') return 'current';
    return 'pending';
  }
  const current = stepOf(phase);
  const here = STEPS.findIndex((s) => s.id === id);
  const now = STEPS.findIndex((s) => s.id === current);
  if (here < now) return 'done';
  if (here === now) return 'current';
  return 'pending';
}

function statusClass(status: string): string {
  if (status === 'pass') return styles.pass;
  if (status === 'fail') return styles.fail;
  return styles.na;
}

function headlineFor(phase: ReadinessPhase, ready: boolean | undefined): string {
  switch (phase) {
    case 'complete':
      return 'This repository is agent-ready';
    case 'skipped':
      return 'Readiness skipped';
    case 'failed':
      return 'Readiness check failed';
    case 'awaiting_merge':
    case 'confirming_merge':
      return 'The PR is ready';
    case 'pr_ready':
      return 'Opening the pull request';
    case 'finalizing':
      return 'Finishing up';
    case 'remediating':
      return 'Making it ready';
    case 'verifying':
      return 'Verifying the fix';
    case 'evaluating':
    case 'inspecting':
      return 'Checking readiness';
    case 'not_ready':
      return ready ? 'Ready to write the marker' : 'This repository is not ready yet';
    default:
      return 'Agent Readiness Check';
  }
}

function progressOf(phase: ReadinessPhase, entries: number): number {
  switch (phase) {
    case 'idle':
    case 'confirming':
      return 0;
    case 'inspecting':
    case 'evaluating':
      return 0.12;
    case 'not_ready':
      return 0.28;
    case 'remediating':
      return Math.min(0.68, 0.34 + entries * 0.012);
    case 'verifying':
      return 0.74;
    case 'pr_ready':
    case 'awaiting_merge':
    case 'confirming_merge':
      return 0.86;
    case 'finalizing':
      return 0.94;
    case 'complete':
    case 'skipped':
    case 'failed':
      return 1;
    default:
      return 0;
  }
}

function currentWork(entries: ReadinessEntry[]): string {
  const open = [...entries].reverse().find((e) => e.kind === 'tool' && !e.done);
  if (open) return open.text;
  return entries[entries.length - 1]?.text ?? '';
}

function criterionCounts(criteria: ReadinessCriterion[]): {
  pass: number;
  fail: number;
  total: number;
} {
  return {
    pass: criteria.filter((c) => c.status === 'pass' || c.status === 'n/a').length,
    fail: criteria.filter((c) => c.status === 'fail').length,
    total: criteria.length,
  };
}

export default function ReadinessFlow({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}): React.JSX.Element {
  const { settings, refreshAll } = useApp();
  const [inspect, setInspect] = useState<ReadinessInspectResult | null>(null);
  const [state, setState] = useState<ReadinessState | null>(null);
  const [model, setModel] = useState(settings?.readinessModel ?? 'inherit');
  const [effort, setEffort] = useState<ReasoningEffort>(
    settings?.readinessReasoningEffort ?? 'high',
  );
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [saveDefault, setSaveDefault] = useState(false);
  const [skipWarn, setSkipWarn] = useState(false);
  const [askDrafts, setAskDrafts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const tailRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.readiness.inspect(projectId).then((next) => {
      if (!cancelled) setInspect(next);
    });
    void api.readiness.get(projectId).then((next) => {
      if (!cancelled && next) setState(next);
    });
    const off = api.on('readiness-progress', (data) => {
      const next = data as ReadinessState;
      if (next?.projectId === projectId) setState(next);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [projectId]);

  // The picker offers what a run can actually reach rather than a free-typed
  // model id, so a readiness evaluation cannot be started on a model whose
  // provider has no credential.
  useEffect(() => {
    let cancelled = false;
    void api.catalog.agentModels().then((next) => {
      if (!cancelled) setModels(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshModels = async (): Promise<void> => {
    setModels(await api.catalog.agentModels());
  };

  const phase = state?.phase ?? (inspect?.ready ? 'complete' : 'confirming');
  const evaluation = state?.evaluation;
  const marker = state?.marker ?? inspect?.marker ?? null;
  const criteria = evaluation?.criteria ?? marker?.criteria ?? [];
  const live = isReadinessLive(phase);
  const exit = readinessExitAction(phase);
  const headline = headlineFor(phase, evaluation?.ready);
  const counts = criterionCounts(criteria);
  const bar = progressOf(phase, state?.entries.length ?? 0);
  const activity = currentWork(state?.entries ?? []);

  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [live]);

  useEffect(() => {
    if (!live) return;
    tailRef.current?.scrollTo({ top: tailRef.current.scrollHeight });
  }, [state?.entries, live]);

  const elapsedMs = state?.startedAt ? Math.max(0, (state.endedAt ?? now) - state.startedAt) : 0;

  const startEval = async (): Promise<void> => {
    setBusy(true);
    setError('');
    const result = await api.readiness.evaluate(projectId, {
      model,
      reasoningEffort: effort,
      saveAsDefault: saveDefault,
    });
    setBusy(false);
    if ('error' in result) setError(result.error);
  };

  const makeReady = async (): Promise<void> => {
    setBusy(true);
    setError('');
    const result = await api.readiness.makeReady(projectId);
    setBusy(false);
    if ('error' in result) setError(result.error);
  };

  const skip = async (): Promise<void> => {
    if (!skipWarn) {
      setSkipWarn(true);
      return;
    }
    setBusy(true);
    await api.readiness.skip(projectId);
    setBusy(false);
    await refreshAll();
  };

  const retry = async (): Promise<void> => {
    setBusy(true);
    setError('');
    const result = await api.readiness.retry(projectId);
    setBusy(false);
    if ('error' in result) setError(result.error);
  };

  const confirmMerge = async (): Promise<void> => {
    setBusy(true);
    setError('');
    await api.readiness.confirmMerge(projectId);
    setBusy(false);
  };

  const dismiss = async (): Promise<void> => {
    await api.readiness.dismiss(projectId);
    await refreshAll();
    onClose();
  };

  const leave = useCallback(async (): Promise<void> => {
    if (exit.kind === 'cancel') await api.readiness.cancel(projectId);
    onClose();
  }, [exit.kind, onClose, projectId]);

  useEscapeToClose(() => void leave(), true);

  const answerAsk = async (): Promise<void> => {
    const questions = state?.pendingAsk?.questions ?? [];
    const answers: ReadinessAskAnswer[] = questions.map((q) => ({
      index: q.index,
      answer: askDrafts[q.index] ?? q.options[0] ?? '',
    }));
    if (answers.some((a) => !a.answer.trim())) return;
    await api.readiness.answerAsk(projectId, answers);
    setAskDrafts({});
  };

  return (
    <ModalShell dismissible={false} ariaLabelledBy="readiness-title" className={styles.dialog}>
      <header className={styles.head}>
        <div className="spread">
          <p className="eyebrow">
            <span className="index">00</span>Agent Readiness
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void leave()}
            data-testid="readiness-close"
            title={exit.kind === 'cancel' ? 'Cancel and close (Esc)' : 'Close (Esc)'}
          >
            Close
          </Button>
        </div>
        <h2 id="readiness-title" className={styles.title}>
          {headline}
        </h2>
        <p className={styles.lead}>
          {state?.detail ||
            inspect?.markerDetail ||
            'Foundry checks whether this repository can support agent-driven pipelines before the first run.'}
        </p>
        {(live || phase === 'awaiting_merge' || (state?.startedAt && phase !== 'confirming')) && (
          <p className={styles.meta} data-testid="readiness-meta">
            {live ? 'Working' : phase === 'awaiting_merge' ? 'Waiting on merge' : 'Elapsed'}
            {elapsedMs > 0 ? ` · ${duration(elapsedMs)}` : ''}
            {state?.model && state.model !== 'inherit' ? ` · ${state.model}` : ''}
            {live && activity ? ` · ${activity}` : ''}
          </p>
        )}
      </header>

      <ol className={styles.stepper} data-testid="readiness-stepper">
        {STEPS.map((step, i) => {
          const tone = stepTone(
            step.id,
            phase,
            state?.failedPhase ? stepOf(state.failedPhase) : undefined,
          );
          return (
            <li key={step.id} className={`${styles.step} ${styles[tone]}`} data-step={step.id}>
              {i > 0 && <span className={styles.stepRail} aria-hidden />}
              <span className={styles.stepDot} aria-hidden>
                {tone === 'done' ? '✓' : tone === 'failed' ? '✕' : i + 1}
              </span>
              <span className={styles.stepLabel}>{step.label}</span>
            </li>
          );
        })}
      </ol>

      <div
        className={styles.progress}
        data-testid="readiness-progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(bar * 100)}
        aria-label="Readiness progress"
      >
        <span
          className={`${styles.progressFill} ${live ? styles.progressLive : ''}`}
          style={{ width: `${Math.round(bar * 100)}%` }}
        />
      </div>

      <div className={styles.body}>
        {(phase === 'confirming' || phase === 'idle') && !inspect?.ready && (
          <>
            <p className={styles.lead}>
              No valid <span className="mono">.agents/agent-ready.json</span> was found. The
              readiness agent will inspect lint, types, tests, build, setup, AGENTS.md, CI,
              templates, hooks, and coverage — then offer a one-click fix PR if anything is missing.
            </p>
            <div className={styles.fields}>
              <Field label="Model">
                <ModelPicker
                  value={model}
                  models={models}
                  allowInherit
                  emptyHint="No models are reachable. Connect a provider under Settings → Providers, then refresh."
                  onChange={setModel}
                  onRefresh={() => void refreshModels()}
                />
              </Field>
              <Field label="Reasoning effort">
                <Dropdown
                  value={effort}
                  options={EFFORTS}
                  onChange={(next) => setEffort(next as ReasoningEffort)}
                />
              </Field>
            </div>
            <label className={styles.lead}>
              <input
                type="checkbox"
                checked={saveDefault}
                onChange={(e) => setSaveDefault(e.target.checked)}
              />{' '}
              Save as the app default for future readiness checks
            </label>
          </>
        )}

        {criteria.length > 0 && (
          <section className={styles.checklist} data-testid="readiness-criteria">
            <header className={styles.checklistHead}>
              <h3 className={styles.sectionTitle}>Checklist</h3>
              <p className={styles.counts}>
                {counts.fail
                  ? `${counts.fail} of ${counts.total} still need work`
                  : `${counts.pass} of ${counts.total} pass or N/A`}
              </p>
            </header>
            <ul className={styles.criteria}>
              {criteria.map((c) => (
                <li
                  key={c.id}
                  className={`${styles.criterion} ${statusClass(c.status)}`}
                  title={c.notes}
                >
                  <span className={styles.criterionMark} aria-hidden>
                    {c.status === 'pass' ? '✓' : c.status === 'fail' ? '✕' : '–'}
                  </span>
                  <div className={styles.criterionBody}>
                    <strong>{CRITERION_LABELS[c.id] ?? c.id}</strong>
                    <p className={styles.notes}>{c.notes}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {(state?.entries.length || live) && (
          <section className={styles.transcriptWrap}>
            <header className={styles.checklistHead}>
              <h3 className={styles.sectionTitle}>What it is doing</h3>
              {live && <span className={styles.liveTag}>live</span>}
            </header>
            <div
              className={`${styles.transcript} scroll`}
              ref={tailRef}
              data-testid="readiness-transcript"
            >
              {(state?.entries ?? []).map((entry) => (
                <div key={entry.id} className={`${styles.line} ${styles[entry.kind] ?? ''}`}>
                  {entry.kind === 'tool' && (
                    <span
                      className={`${styles.transcriptIcon} ${entry.done ? (entry.failed ? styles.failed : styles.ok) : styles.wait}`}
                    >
                      {TOOL_ICON[entry.toolKind ?? 'other'] ?? '·'}
                    </span>
                  )}
                  <span className={styles.transcriptText}>{entry.text}</span>
                </div>
              ))}
              {live && <div className={`${styles.line} ${styles.note} ${styles.pulse}`}>…</div>}
              {!state?.entries.length && !live && (
                <div className={`${styles.line} ${styles.note}`}>Nothing was reported.</div>
              )}
            </div>
          </section>
        )}

        {state?.pendingAsk && (
          <div className={styles.ask}>
            {state.pendingAsk.questions.map((q) => (
              <Field key={q.index} label={q.question || 'Question'}>
                {q.options.length ? (
                  <Dropdown
                    value={askDrafts[q.index] ?? ''}
                    options={[
                      { value: '', label: 'Choose…' },
                      ...q.options.map((opt) => ({ value: opt, label: opt })),
                    ]}
                    onChange={(next) => setAskDrafts((cur) => ({ ...cur, [q.index]: next }))}
                  />
                ) : (
                  <TextInput
                    value={askDrafts[q.index] ?? ''}
                    onChange={(e) => setAskDrafts((cur) => ({ ...cur, [q.index]: e.target.value }))}
                  />
                )}
              </Field>
            ))}
            <Button variant="primary" size="sm" onClick={() => void answerAsk()}>
              Answer
            </Button>
          </div>
        )}

        {state?.pr && (
          <section className={styles.pr} data-testid="readiness-pr">
            <div className={styles.prMain}>
              <div className={styles.prTitleRow}>
                <span className={styles.prNumber}>PR #{state.pr.number}</span>
                <span
                  className={`${styles.prState} ${state.pr.merged ? styles.prMerged : styles.prOpen}`}
                >
                  {state.pr.merged ? 'Merged' : 'Open'}
                </span>
              </div>
              <button
                type="button"
                className={styles.prUrl}
                title={state.pr.url}
                onClick={() => void api.app.openExternal(state.pr!.url)}
              >
                {state.pr.url}
              </button>
              {state.mergeDetail && <p className={styles.prNote}>{state.mergeDetail}</p>}
            </div>
            <Button size="sm" onClick={() => void api.app.openExternal(state.pr!.url)}>
              Open on GitHub
            </Button>
          </section>
        )}
        {!state?.pr && state?.mergeDetail && <p className={styles.lead}>{state.mergeDetail}</p>}
        {phase === 'skipped' && (
          <p className={styles.warn}>
            The Agent Readiness process can be run again anytime from project settings.
          </p>
        )}
        {error && <p className={styles.error}>{error}</p>}
        {skipWarn && phase !== 'skipped' && (
          <p className={styles.warn}>
            Skipping means the first pipeline run may fail mid-flight. Click Skip again to confirm.
            You can re-run this from project settings.
          </p>
        )}
      </div>

      <footer className={styles.actions}>
        <Button
          variant="ghost"
          className={styles.exit}
          onClick={() => void leave()}
          data-testid={exit.kind === 'cancel' ? 'readiness-cancel' : 'readiness-dismiss'}
        >
          {exit.label}
        </Button>
        {(phase === 'confirming' || phase === 'idle' || phase === 'not_ready') && (
          <Button variant="ghost" disabled={busy} onClick={() => void skip()}>
            {skipWarn ? 'Skip anyway' : 'Skip for now'}
          </Button>
        )}
        {(phase === 'confirming' || phase === 'idle') && !inspect?.ready && (
          <Button variant="primary" disabled={busy} onClick={() => void startEval()}>
            {busy ? 'Starting…' : 'Evaluate repository'}
          </Button>
        )}
        {phase === 'not_ready' && (
          <Button variant="primary" disabled={busy} onClick={() => void makeReady()}>
            {busy ? 'Working…' : 'Make it ready'}
          </Button>
        )}
        {(phase === 'awaiting_merge' || phase === 'confirming_merge') && (
          <Button variant="primary" disabled={busy} onClick={() => void confirmMerge()}>
            {busy ? 'Checking…' : 'I have merged the PR'}
          </Button>
        )}
        {(phase === 'failed' || phase === 'skipped') && (
          <Button disabled={busy} onClick={() => void retry()}>
            Retry
          </Button>
        )}
        {(phase === 'complete' || phase === 'skipped') && (
          <Button variant="primary" onClick={() => void dismiss()}>
            OK
          </Button>
        )}
      </footer>
    </ModalShell>
  );
}
