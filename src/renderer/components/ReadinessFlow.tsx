import { useEffect, useMemo, useState } from 'react';
import type {
  ModelInfo,
  ReadinessAskAnswer,
  ReadinessInspectResult,
  ReadinessState,
  ReasoningEffort,
} from '@shared/types.js';
import { api } from '../api.js';
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

function statusClass(status: string): string {
  if (status === 'pass') return styles.pass;
  if (status === 'fail') return styles.fail;
  return styles.na;
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

  // Readiness always runs on the default CLI (see readiness/sessions.ts), so the
  // picker must offer that CLI's catalog rather than a free-typed model id.
  const defaultCli = settings?.defaultCli;
  useEffect(() => {
    if (!defaultCli) return;
    let cancelled = false;
    void api.catalog.models(defaultCli).then((next) => {
      if (!cancelled) setModels(next);
    });
    return () => {
      cancelled = true;
    };
  }, [defaultCli]);

  const refreshModels = async (): Promise<void> => {
    if (!defaultCli) return;
    setModels(await api.catalog.models(defaultCli, true));
  };

  const phase = state?.phase ?? (inspect?.ready ? 'complete' : 'confirming');
  const evaluation = state?.evaluation;
  const marker = state?.marker ?? inspect?.marker ?? null;

  const headline = useMemo(() => {
    switch (phase) {
      case 'complete':
        return 'This repository is agent-ready';
      case 'skipped':
        return 'Readiness skipped';
      case 'failed':
        return 'Readiness check failed';
      case 'awaiting_merge':
      case 'confirming_merge':
      case 'pr_ready':
        return 'The PR is ready';
      case 'remediating':
      case 'verifying':
        return 'Making it ready';
      case 'evaluating':
      case 'inspecting':
        return 'Checking readiness';
      case 'not_ready':
        return evaluation?.ready ? 'Ready to write the marker' : 'This repository is not ready yet';
      default:
        return 'Agent Readiness Check';
    }
  }, [phase, evaluation?.ready]);

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

  const dismiss = async (): Promise<void> => {
    await api.readiness.dismiss(projectId);
    await refreshAll();
    onClose();
  };

  return (
    <ModalShell dismissible={false} ariaLabelledBy="readiness-title" className={styles.dialog}>
      <header className={styles.head}>
        <p className="eyebrow">
          <span className="index">00</span>Agent Readiness
        </p>
        <h2 id="readiness-title" className={styles.title}>
          {headline}
        </h2>
        <p className={styles.lead}>
          {state?.detail ||
            inspect?.markerDetail ||
            'Foundry checks whether this repository can support agent-driven pipelines before the first run.'}
        </p>
      </header>

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
                  emptyHint={`No models from ${defaultCli ?? 'the default CLI'}. Install and sign in under Settings → Agent CLIs, then refresh.`}
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

        {(evaluation || marker) && (
          <ul className={styles.criteria}>
            {(evaluation?.criteria ?? marker?.criteria ?? []).map((c) => (
              <li key={c.id} className={styles.criterion}>
                <span className={`badge ${statusClass(c.status)}`}>{c.status}</span>
                <div>
                  <strong className="mono">{c.id}</strong>
                  <p className={styles.notes}>{c.notes}</p>
                </div>
              </li>
            ))}
          </ul>
        )}

        {state?.entries.length ? (
          <ul className={styles.entries}>
            {state.entries.slice(-12).map((entry) => (
              <li key={entry.id}>{entry.text}</li>
            ))}
          </ul>
        ) : null}

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
          <p className={styles.link}>
            <button
              type="button"
              className="link"
              onClick={() => void api.app.openExternal(state.pr!.url)}
            >
              {state.pr.url}
            </button>
          </p>
        )}
        {state?.mergeDetail && <p className={styles.lead}>{state.mergeDetail}</p>}
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
        {phase === 'failed' && (
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        )}
      </footer>
    </ModalShell>
  );
}
