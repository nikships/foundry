import { useEffect, useMemo, useState } from 'react';
import type { GeneratedRunPlan, ValidationIssue } from '@shared/types.js';
import type { RunPlanExportSelection } from '@shared/ipc-contract.js';
import { api } from '../../api.js';
import {
  allPlanExportSelection,
  planExportItemIssues,
  planExportSelectionCount,
  planExportView,
  togglePlanExportSelection,
  type PlanExportItem,
} from '../../view-models/plan-view.js';
import { Button } from '../ui/Button.js';
import { SideSheet } from '../ui/SideSheet.js';
import styles from './ExportPlanSheet.module.css';

type BusyItem = PlanExportItem | 'selection' | null;

function IssueList({ issues }: { issues: ValidationIssue[] }): React.JSX.Element | null {
  if (!issues.length) return null;
  return (
    <ul
      className={styles.issues}
      role={issues.some((issue) => issue.level === 'error') ? 'alert' : undefined}
    >
      {issues.map((issue, index) => (
        <li key={`${issue.where}-${issue.message}-${index}`} data-level={issue.level}>
          {issue.message}
        </li>
      ))}
    </ul>
  );
}

export default function ExportPlanSheet({
  open,
  projectId,
  runId,
  plan,
  onClose,
}: {
  open: boolean;
  projectId: string;
  runId: string;
  plan: GeneratedRunPlan;
  onClose: () => void;
}): React.JSX.Element {
  const view = useMemo(() => planExportView(plan), [plan]);
  const all = useMemo(() => allPlanExportSelection(plan), [plan]);
  const [selection, setSelection] = useState<RunPlanExportSelection>(all);
  const [savedPipeline, setSavedPipeline] = useState(false);
  const [savedAgents, setSavedAgents] = useState<Set<string>>(new Set());
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [busy, setBusy] = useState<BusyItem>(null);

  useEffect(() => {
    if (!open) return;
    setSelection(all);
    setSavedPipeline(false);
    setSavedAgents(new Set());
    setIssues([]);
    setBusy(null);
  }, [all, open, plan.planId]);

  const save = async (target: RunPlanExportSelection, item: BusyItem): Promise<void> => {
    if (busy || planExportSelectionCount(target) === 0) return;
    setBusy(item);
    setIssues([]);
    try {
      const result = await api.runs.exportPlan(projectId, runId, target);
      setIssues(result.issues);
      if (!result.ok) return;
      if (target.pipeline) setSavedPipeline(true);
      if (target.agents.length) {
        setSavedAgents((current) => new Set([...current, ...target.agents]));
      }
      setSelection((current) => ({
        pipeline: target.pipeline ? false : current.pipeline,
        agents: current.agents.filter((name) => !target.agents.includes(name)),
      }));
    } catch (error) {
      setIssues([
        {
          level: 'error',
          where: item ?? 'selection',
          message: (error as Error).message || 'Could not export this plan.',
        },
      ]);
    } finally {
      setBusy(null);
    }
  };

  const unsavedAll: RunPlanExportSelection = {
    pipeline: !savedPipeline,
    agents: plan.agents.map((agent) => agent.name).filter((name) => !savedAgents.has(name)),
  };
  const globalIssues = issues.filter(
    (issue) => !issue.where.startsWith('pipeline') && !issue.where.startsWith('agent:'),
  );
  const selectedCount = planExportSelectionCount(selection);

  const setChecked = (item: PlanExportItem, checked: boolean): void => {
    setSelection((current) => togglePlanExportSelection(current, item, checked));
    setIssues([]);
  };

  return (
    <SideSheet
      open={open}
      onClose={onClose}
      label="Export generated plan"
      eyebrow="Run artifacts"
      title="Save to the Designer"
      footer={
        <>
          <span className={styles.selectionCount}>
            {selectedCount ? `${selectedCount} selected` : 'Nothing selected'}
          </span>
          <div className={styles.footerActions}>
            <Button
              size="sm"
              disabled={Boolean(busy) || planExportSelectionCount(unsavedAll) === 0}
              onClick={() => void save(unsavedAll, 'selection')}
            >
              Save all
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={Boolean(busy) || selectedCount === 0}
              onClick={() => void save(selection, 'selection')}
              data-testid="export-plan-selected"
            >
              {busy === 'selection' ? 'Saving…' : 'Save selected'}
            </Button>
          </div>
        </>
      }
    >
      <p className={styles.intro}>
        Generated definitions exist only on this run. Save the useful parts as ordinary, editable
        Designer entities.
      </p>
      <IssueList issues={globalIssues} />

      <section className={styles.group}>
        <h3>Pipeline</h3>
        <div className={styles.item} data-saved={savedPipeline || undefined}>
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={selection.pipeline}
              disabled={savedPipeline || Boolean(busy)}
              onChange={(event) => setChecked('pipeline', event.target.checked)}
            />
            <span>
              <strong>{view.pipeline.name}</strong>
              <small>
                saved as <span className="mono">{view.pipeline.id}</span>
              </small>
            </span>
          </label>
          <Button
            size="sm"
            disabled={savedPipeline || Boolean(busy)}
            onClick={() => void save({ pipeline: true, agents: [] }, 'pipeline')}
          >
            {savedPipeline ? 'Saved' : busy === 'pipeline' ? 'Saving…' : 'Save'}
          </Button>
          <p>{view.pipeline.description}</p>
          <IssueList issues={planExportItemIssues(issues, 'pipeline')} />
        </div>
      </section>

      {view.agents.length > 0 && (
        <section className={styles.group}>
          <h3>Synthesized agents</h3>
          <div className={styles.itemList}>
            {view.agents.map((agent) => {
              const item = `agent:${agent.name}` as const;
              const saved = savedAgents.has(agent.name);
              return (
                <div className={styles.item} data-saved={saved || undefined} key={agent.name}>
                  <label className={styles.checkRow}>
                    <input
                      type="checkbox"
                      checked={selection.agents.includes(agent.name)}
                      disabled={saved || Boolean(busy)}
                      onChange={(event) => setChecked(item, event.target.checked)}
                    />
                    <span>
                      <strong>{agent.name}</strong>
                      <small>ordinary roster agent</small>
                    </span>
                  </label>
                  <Button
                    size="sm"
                    disabled={saved || Boolean(busy)}
                    onClick={() => void save({ pipeline: false, agents: [agent.name] }, item)}
                  >
                    {saved ? 'Saved' : busy === item ? 'Saving…' : 'Save'}
                  </Button>
                  <p>{agent.purpose}</p>
                  <IssueList issues={planExportItemIssues(issues, item)} />
                </div>
              );
            })}
          </div>
        </section>
      )}
    </SideSheet>
  );
}
