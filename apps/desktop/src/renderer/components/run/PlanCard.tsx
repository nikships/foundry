import { useCallback, useMemo, useRef, useState } from 'react';
import type { GeneratedRunPlan, ReasoningEffort, ValidationIssue } from '@shared/types.js';
import type { PlanChatMessage } from '@shared/ipc-contract.js';
import { useApp } from '../../stores/app.js';
import { overriddenPhases, planCardView } from '../../view-models/plan-view.js';
import {
  isMissingProjectCommandWarning,
  missingProjectCommandRefs,
} from '../../view-models/project-commands-view.js';
import ProjectCommandsModal from '../project/ProjectCommandsModal.js';
import { Button } from '../ui/Button.js';
import { ModalShell } from '../ui/ModalShell.js';
import PlanCanvas from './PlanCanvas.js';
import PlanChat from './PlanChat.js';
import PlanPhaseSheet from './PlanPhaseSheet.js';
import styles from './PlanCard.module.css';

/**
 * The Orchestrator's proposal, laid out for confirmation: the refined brief,
 * the proposed pipeline as an inspectable board, the agents it synthesized,
 * the acceptance rule, and why the pipeline has this shape. Nothing here
 * starts anything — the operator disposes, and may re-cast any agent phase,
 * or talk the proposal over with the Orchestrator, before doing so.
 */
export default function PlanCard({
  plan,
  original,
  starting,
  startBlocked,
  issues,
  messages,
  replying,
  chatError,
  onSendMessage,
  onPhaseModelChange,
  onPhaseReasoningEffortChange,
  onResetPhaseOverrides,
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
  /** The back-and-forth about this proposal, in order. */
  messages: PlanChatMessage[];
  /** True while the Orchestrator is considering a follow-up message. */
  replying: boolean;
  /** Why the last message was refused, or empty. */
  chatError: string;
  onSendMessage: (text: string) => void;
  onPhaseModelChange: (phaseName: string, model: string) => void;
  onPhaseReasoningEffortChange: (phaseName: string, effort: ReasoningEffort) => void;
  onResetPhaseOverrides: () => void;
  onStart: () => void;
  onRegenerate: () => void;
  onDiscard: () => void;
  /** Optional immutable request-source linkage, such as a Linear issue. */
  sourceBadge?: string;
  /** Read-only lifecycle summary for that source. */
  sourceDetail?: string;
}): React.JSX.Element {
  const { agentColor, project, refreshAll } = useApp();
  const [configuringCommands, setConfiguringCommands] = useState(false);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
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
  const synthColor = useCallback(
    (name: string | null): string => {
      if (!name) return 'var(--text-faint)';
      return plan.agents.find((a) => a.name === name)?.color ?? agentColor(name);
    },
    [plan.agents, agentColor],
  );

  const inspectedPhase = useMemo(
    () => view.phases.find((phase) => phase.name === inspecting) ?? null,
    [view.phases, inspecting],
  );

  /** Escape or Done returns focus to the node the operator was inspecting. */
  const closeInspector = useCallback((): void => {
    const name = inspecting;
    setInspecting(null);
    if (!name) return;
    requestAnimationFrame(() => {
      cardRef.current
        ?.querySelector<HTMLElement>(`[data-plan-node="${CSS.escape(name)}"]`)
        ?.focus();
    });
  }, [inspecting]);

  const commandPronoun = missingCommandRefs.length === 1 ? 'it' : 'them';

  return (
    <section ref={cardRef} className={`${styles.card} card`} data-testid="plan-card">
      <header className={styles.head}>
        <div className={styles.headText}>
          <h2 className={styles.title}>{view.title}</h2>
          {sourceBadge && <span className={styles.sourceBadge}>{sourceBadge}</span>}
          <p className={`faint ${styles.summary}`} data-testid="plan-orchestrator">
            {view.summary} · composed by {view.orchestratorCredit}
          </p>
        </div>
        <p className={styles.description}>{view.description}</p>
      </header>

      <div className={styles.section}>
        <p className={styles.label}>The brief</p>
        <p className={styles.brief} data-testid="plan-refined-request">
          {view.refinedRequest}
        </p>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <p className={styles.label}>The pipeline</p>
          {overridden.size > 0 && (
            <button
              type="button"
              className={styles.resetModels}
              disabled={starting}
              onClick={onResetPhaseOverrides}
              data-testid="plan-reset-phase-overrides"
            >
              Restore proposed settings
            </button>
          )}
        </div>
        <PlanCanvas
          phases={view.phases}
          overridden={overridden}
          selectedPhase={inspecting}
          onInspect={setInspecting}
          agentColor={synthColor}
          onToggleExpand={() => setFullscreen(true)}
        />
        <p className={`faint ${styles.acceptanceUnderCanvas}`} data-testid="plan-acceptance">
          {view.acceptance}
        </p>
      </div>

      <div className={styles.section}>
        <p className={styles.label}>Discuss with the Orchestrator</p>
        <PlanChat
          messages={messages}
          replying={replying}
          error={chatError}
          disabled={starting}
          onSend={onSendMessage}
        />
      </div>

      {view.agents.length > 0 && (
        <div className={styles.section}>
          <p className={styles.label}>Synthesized for this run</p>
          <div className={styles.agents}>
            {view.agents.map((agent) => (
              <div
                key={agent.name}
                className={styles.agent}
                data-testid={`plan-agent-${agent.name}`}
              >
                <span className={styles.agentDot} style={{ background: agent.color }} />
                <span className={styles.agentName}>{agent.name}</span>
                <span className={styles.agentPurpose}>{agent.purpose}</span>
                <span className={`faint ${styles.agentMeta}`}>{agent.model}</span>
                <span
                  className={`faint ${styles.agentMeta}`}
                  data-testid={`plan-agent-${agent.name}-writes`}
                >
                  {agent.boundary}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

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
                selected project does not provide {commandPronoun} yet. Configure {commandPronoun}{' '}
                here without leaving or losing this plan.
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

      {!fullscreen && (
        <PlanPhaseSheet
          phase={inspectedPhase}
          overridden={inspectedPhase ? overridden.has(inspectedPhase.name) : false}
          starting={starting}
          onPhaseModelChange={onPhaseModelChange}
          onPhaseReasoningEffortChange={onPhaseReasoningEffortChange}
          onClose={closeInspector}
        />
      )}

      {fullscreen && (
        // The phase sheet renders inside the modal because the backdrop's
        // stacking context would otherwise sit above it.
        <ModalShell
          onClose={() => {
            if (!inspecting) setFullscreen(false);
          }}
          className={styles.fullscreenModal}
          data-testid="plan-canvas-fullscreen"
        >
          <header className={styles.fullscreenHead}>
            <p className={styles.label}>The pipeline · {view.title}</p>
          </header>
          <div className={styles.fullscreenBody}>
            <PlanCanvas
              phases={view.phases}
              overridden={overridden}
              selectedPhase={inspecting}
              onInspect={setInspecting}
              agentColor={synthColor}
              expanded
              onToggleExpand={() => setFullscreen(false)}
            />
            <PlanPhaseSheet
              phase={inspectedPhase}
              overridden={inspectedPhase ? overridden.has(inspectedPhase.name) : false}
              starting={starting}
              onPhaseModelChange={onPhaseModelChange}
              onPhaseReasoningEffortChange={onPhaseReasoningEffortChange}
              onClose={closeInspector}
            />
          </div>
        </ModalShell>
      )}

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
