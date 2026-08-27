import { useMemo, useState } from 'react';
import type { GeneratedRunPlan, ValidationIssue } from '@shared/types.js';
import { useApp } from '../../stores/app.js';
import { useAgentModels } from '../../hooks/useAgentModels.js';
import { phaseKindColor } from '../../utils/derive.js';
import { overriddenPhases, planCardView } from '../../view-models/plan-view.js';
import {
  isMissingProjectCommandWarning,
  missingProjectCommandRefs,
} from '../../view-models/project-commands-view.js';
import ModelPicker from '../common/ModelPicker.js';
import PipelineRibbon from '../pipeline/PipelineRibbon.js';
import { PhaseGlyph } from '../pipeline/PhaseGlyphs.js';
import ProjectCommandsModal from '../project/ProjectCommandsModal.js';
import { Button } from '../ui/Button.js';
import styles from './PlanCard.module.css';

/**
 * The Orchestrator's proposal, laid out for confirmation: the refined brief,
 * the ordered phases with the model each is appointed to, the agents it
 * synthesized, the acceptance rule, and why the pipeline has this shape.
 * Nothing here starts anything — the operator disposes, and may re-cast any
 * agent phase onto a different model before doing so.
 */
export default function PlanCard({
  plan,
  original,
  starting,
  startBlocked,
  issues,
  onPhaseModelChange,
  onResetModels,
  onStart,
  onRegenerate,
  onDiscard,
  sourceBadge,
  sourceDetail,
}: {
  plan: GeneratedRunPlan;
  /** The plan as the Orchestrator proposed it, before any operator override. */
  original: GeneratedRunPlan;
  starting: boolean;
  /** Why starting is refused right now, or null when it may proceed. */
  startBlocked: string | null;
  /** Start-time validation failures, shown on the card rather than lost. */
  issues: ValidationIssue[];
  onPhaseModelChange: (phaseName: string, model: string) => void;
  onResetModels: () => void;
  onStart: () => void;
  onRegenerate: () => void;
  onDiscard: () => void;
  /** Optional immutable request-source linkage, such as a Linear issue. */
  sourceBadge?: string;
  /** Read-only lifecycle summary for that source. */
  sourceDetail?: string;
}): React.JSX.Element {
  const { agentColor, project, refreshAll } = useApp();
  const { models, refresh } = useAgentModels();
  const [configuringCommands, setConfiguringCommands] = useState(false);
  const planProject = project?.id === plan.projectId ? project : null;
  const missingCommandRefs = useMemo(
    () => (planProject ? missingProjectCommandRefs(plan.pipeline, planProject.commands) : []),
    [plan.pipeline, planProject],
  );
  const visiblePlan = useMemo(
    () => ({
      ...plan,
      warnings: planProject
        ? plan.warnings.filter((warning) => !isMissingProjectCommandWarning(warning))
        : plan.warnings,
    }),
    [plan, planProject],
  );
  const view = useMemo(() => planCardView(visiblePlan), [visiblePlan]);
  const overridden = useMemo(() => overriddenPhases(original, plan), [original, plan]);
  const synthColor = (name: string | null): string => {
    if (!name) return 'var(--text-faint)';
    return plan.agents.find((a) => a.name === name)?.color ?? agentColor(name);
  };

  return (
    <section className={`${styles.card} card`} data-testid="plan-card">
      <header className={styles.head}>
        <div className={styles.headText}>
          <h2 className={styles.title}>{view.title}</h2>
          {sourceBadge && <span className={styles.sourceBadge}>{sourceBadge}</span>}
          <p className={`faint ${styles.summary}`}>
            {view.summary} · composed by {view.orchestratorModel}
          </p>
        </div>
        <p className={styles.description}>{view.description}</p>
        <PipelineRibbon pipeline={plan.pipeline} />
      </header>

      <div className={styles.section}>
        <p className={styles.label}>The brief</p>
        <p className={styles.brief} data-testid="plan-refined-request">
          {view.refinedRequest}
        </p>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <p className={styles.label}>Phases</p>
          {overridden.size > 0 && (
            <button
              type="button"
              className={styles.resetModels}
              disabled={starting}
              onClick={onResetModels}
              data-testid="plan-reset-models"
            >
              Restore proposed models
            </button>
          )}
        </div>
        <ol className={styles.phases}>
          {view.phases.map((phase) => {
            const color = phaseKindColor(phase.kind, synthColor(phase.agent));
            return (
              <li key={phase.name} className={styles.phase}>
                <span className={styles.phaseIcon} style={{ color }}>
                  <PhaseGlyph kind={phase.kind} />
                </span>
                <div className={styles.phaseBody}>
                  <div className={styles.phaseTop}>
                    <span className={styles.phaseName} style={{ color }}>
                      {phase.name}
                    </span>
                    {phase.agent && (
                      <span className={`faint ${styles.phaseAgent}`}>
                        {phase.agent}
                        {phase.synthesized && (
                          <span className={styles.synthBadge}>synthesized</span>
                        )}
                      </span>
                    )}
                    {phase.decides && <span className={styles.decides}>decides</span>}
                  </div>
                  <p className={styles.phaseDesc}>{phase.description}</p>
                  {phase.note && <p className={`faint ${styles.phaseNote}`}>{phase.note}</p>}
                  {phase.model !== null && (
                    <div className={styles.phaseModel} data-testid={`plan-model-${phase.name}`}>
                      <span className={styles.phaseModelLabel}>Model</span>
                      <ModelPicker
                        value={phase.model}
                        models={models}
                        showNotes={false}
                        disabled={starting}
                        onChange={(model) => onPhaseModelChange(phase.name, model)}
                        onRefresh={() => void refresh()}
                      />
                      {overridden.has(phase.name) && (
                        <span className={styles.overridden}>overridden</span>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      {view.agents.length > 0 && (
        <div className={styles.section}>
          <p className={styles.label}>Synthesized for this run</p>
          <div className={styles.agents}>
            {view.agents.map((agent) => (
              <div key={agent.name} className={styles.agent}>
                <span className={styles.agentDot} style={{ background: agent.color }} />
                <span className={styles.agentName}>{agent.name}</span>
                <span className={styles.agentPurpose}>{agent.purpose}</span>
                <span className={`faint ${styles.agentMeta}`}>
                  {agent.model} · {agent.reasoningEffort} · {agent.boundary}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className={styles.section}>
        <p className={styles.label}>Acceptance</p>
        <p className={styles.acceptance}>{view.acceptance}</p>
      </div>

      <div className={styles.section}>
        <p className={styles.label}>Why this shape</p>
        <p className={styles.rationale}>{view.rationale}</p>
      </div>

      {(view.warnings.length > 0 || missingCommandRefs.length > 0) && (
        <div className={styles.warnings} data-testid="plan-warnings">
          {view.warnings.map((group) => (
            <div key={group.where} className={styles.warningGroup}>
              <strong>{group.where}</strong>
              <ul>
                {group.messages.map((message, i) => (
                  <li key={i}>{message}</li>
                ))}
              </ul>
            </div>
          ))}
          {missingCommandRefs.length > 0 && (
            <div className={styles.warningGroup}>
              <strong>Project commands</strong>
              <p className={styles.warningMessage}>
                This plan needs {missingCommandRefs.map((ref) => `“${ref}”`).join(', ')}, but the
                selected project does not provide {missingCommandRefs.length === 1 ? 'it' : 'them'}
                yet. Configure {missingCommandRefs.length === 1 ? 'it' : 'them'} here without
                leaving or losing this plan.
              </p>
              <Button
                size="sm"
                onClick={() => setConfiguringCommands(true)}
                data-testid="plan-configure-commands"
              >
                Configure commands
              </Button>
            </div>
          )}
        </div>
      )}

      {issues.length > 0 && (
        <ul className={styles.issues}>
          {issues.map((issue, i) => (
            <li key={i}>
              <strong>{issue.where}</strong> {issue.message}
            </li>
          ))}
        </ul>
      )}

      <div className={styles.actions}>
        <Button
          variant="primary"
          disabled={starting || Boolean(startBlocked)}
          title={startBlocked ?? undefined}
          onClick={onStart}
          data-testid="plan-start"
        >
          {starting ? 'Starting…' : 'Start run'}
        </Button>
        <Button disabled={starting} onClick={onRegenerate} data-testid="plan-regenerate">
          Regenerate
        </Button>
        <Button variant="ghost" disabled={starting} onClick={onDiscard} data-testid="plan-discard">
          Discard
        </Button>
        {sourceDetail && <span className={styles.sourceDetail}>{sourceDetail}</span>}
        {startBlocked && <span className={`faint ${styles.blocked}`}>{startBlocked}</span>}
      </div>
      {planProject && configuringCommands && (
        <ProjectCommandsModal
          project={planProject}
          commandNames={missingCommandRefs}
          onClose={() => setConfiguringCommands(false)}
          onSaved={async () => refreshAll()}
        />
      )}
    </section>
  );
}
