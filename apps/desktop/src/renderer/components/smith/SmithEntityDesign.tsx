/**
 * Read-only design bodies for Smith's chat: a pipeline as ordered phase
 * cards, an agent as an identity card, an envelope as a typed field table.
 *
 * One semantic renderer per concept — `SmithArtifactCard` (conversational
 * previews) and `SmithProposalCard` (blocking approvals) both draw these, so a
 * design and its approval surface cannot drift apart. Deliberately small
 * primitives extracted from the design screens' visual vocabulary
 * (`PhaseGlyphs`, `AgentAvatar`, phase colors) rather than embedding the
 * editable canvas or roster wholesale.
 */

import { useState } from 'react';
import type { AgentDef, EnvelopeDef, PipelineDef, SmithRunSummaryArtifact } from '@shared/types.js';
import { useApp } from '../../stores/app.js';
import { duration, statusColor, tokens } from '../../utils/format.js';
import { phaseKindColor } from '../../utils/derive.js';
import {
  acceptanceLabel,
  commandLabel,
  gateLabel,
  isolationLabel,
  phaseWorkLabel,
  writesLabel,
} from '../../view-models/smith-artifact-view.js';
import AgentAvatar from '../media/AgentAvatar.js';
import StatusBadge from '../common/StatusBadge.js';
import { EnvelopeGlyph, PhaseGlyph } from '../pipeline/PhaseGlyphs.js';
import { Button } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import styles from './SmithEntityDesign.module.css';

/** The base fields every envelope already carries, shown for orientation. */
const ENVELOPE_BASE_FIELDS = ['status', 'summary', 'artifacts', 'notes_for_next_agent'];

function Detail({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className={styles.detail}>
      <dt className={styles.detailLabel}>{label}</dt>
      <dd className={styles.detailValue}>{value}</dd>
    </div>
  );
}

/** Raw JSON as a collapsed audit fallback — never the default body. */
export function ViewJson({ value }: { value: unknown }): React.JSX.Element {
  return (
    <details className={styles.viewJson}>
      <summary className={styles.viewJsonSummary}>View JSON</summary>
      <pre className={`${styles.json} selectable`}>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

function PhaseCard({
  phase,
  index,
  compact,
}: {
  phase: PipelineDef['phases'][number];
  index: number;
  compact?: boolean;
}): React.JSX.Element {
  const { agentColor } = useApp();
  const color = phaseKindColor(phase.kind, agentColor(phase.agent ?? null));
  const [open, setOpen] = useState(false);
  const gates = phase.gates ?? [];
  const work = phaseWorkLabel(phase);
  return (
    <li className={styles.phase} style={{ borderLeftColor: color }}>
      <button
        type="button"
        className={styles.phaseHead}
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        data-testid={`smith-design-phase-${phase.name}`}
      >
        <span className={styles.phaseIndex}>{index + 1}</span>
        <span className={styles.phaseGlyph} style={{ color }} aria-hidden>
          <PhaseGlyph kind={phase.kind} />
        </span>
        {phase.kind === 'agent' && phase.agent && !compact && (
          <AgentAvatar name={phase.agent} size={18} />
        )}
        <span className={styles.phaseName}>{phase.name}</span>
        <span className={styles.phaseKind}>{phase.kind}</span>
        {work && <span className={styles.phaseWork}>{work}</span>}
        {phase.feedbackTo && (
          <span className={styles.phaseLoop} title={`sends failures back to ${phase.feedbackTo}`}>
            ↩ {phase.feedbackTo}
          </span>
        )}
        <span className={styles.disclosure} aria-hidden>
          {open ? '−' : '+'}
        </span>
      </button>
      {open && (
        <dl className={styles.phaseDetails}>
          <Detail label="Description" value={phase.description} />
          {phase.kind === 'agent' && phase.agent && <Detail label="Agent" value={phase.agent} />}
          {phase.model && <Detail label="Model" value={phase.model} />}
          {phase.envelope && (
            <Detail
              label="Envelope"
              value={
                <span className={styles.withGlyph}>
                  <EnvelopeGlyph /> {phase.envelope}
                </span>
              }
            />
          )}
          {phase.kind === 'code' && (
            <Detail label="Command" value={<code>{commandLabel(phase.command)}</code>} />
          )}
          {phase.kind === 'engineer' && phase.question && (
            <Detail label="Checkpoint question" value={phase.question} />
          )}
          {gates.length > 0 && (
            <Detail label="Gates" value={gates.map((gate) => gateLabel(gate)).join(', ')} />
          )}
          {phase.retries !== undefined && <Detail label="Retries" value={phase.retries} />}
          {phase.feedbackTo && (
            <Detail
              label="Feedback loop"
              value={`failures return to ${phase.feedbackTo}${
                phase.feedbackRetries !== undefined ? ` (up to ${phase.feedbackRetries}×)` : ''
              }`}
            />
          )}
          {phase.prompt && <Detail label="Prompt inputs" value={phase.prompt.inputs.join(', ')} />}
          {phase.optional && <Detail label="Optional" value="a failure does not fail the run" />}
        </dl>
      )}
    </li>
  );
}

export function PipelineDesign({
  pipeline,
  compact,
}: {
  pipeline: PipelineDef;
  compact?: boolean;
}): React.JSX.Element {
  return (
    <div className={cx(styles.design, compact && styles.compact)}>
      {pipeline.description && <p className={styles.blurb}>{pipeline.description}</p>}
      <ol className={styles.phases} aria-label="Phases in execution order">
        {pipeline.phases.map((phase, index) => (
          <PhaseCard key={phase.name} phase={phase} index={index} compact={compact} />
        ))}
      </ol>
      <dl className={styles.footRow}>
        <Detail label="Acceptance" value={acceptanceLabel(pipeline.acceptance)} />
        <Detail
          label="Isolation"
          value={
            pipeline.isolation === false
              ? 'runs in the project checkout (no worktree)'
              : 'each run gets its own git worktree'
          }
        />
      </dl>
    </div>
  );
}

export function AgentDesign({
  agent,
  compact,
}: {
  agent: AgentDef;
  compact?: boolean;
}): React.JSX.Element {
  return (
    <div className={cx(styles.design, compact && styles.compact)}>
      <div className={styles.agentIdentity}>
        <AgentAvatar
          name={agent.name}
          size={compact ? 24 : 32}
          emblem={agent.emblem}
          color={agent.color}
        />
        <div className={styles.agentIdentityText}>
          <span className={styles.agentName} style={{ color: agent.color }}>
            {agent.name}
          </span>
          <span className={styles.blurb}>{agent.purpose}</span>
        </div>
      </div>
      <dl className={styles.grid}>
        <Detail
          label="Model"
          value={agent.inheritDefaults ? 'inherits the app defaults' : agent.model}
        />
        <Detail
          label="Reasoning"
          value={agent.inheritDefaults ? 'inherits the app defaults' : agent.reasoningEffort}
        />
        <Detail label="Tools" value={agent.toolProfile ?? 'full'} />
        <Detail label="Write boundary" value={writesLabel(agent.writes)} />
        <Detail
          label="Envelope"
          value={
            <span className={styles.withGlyph}>
              <EnvelopeGlyph /> {agent.envelope}
            </span>
          }
        />
        {agent.customFields && agent.customFields.length > 0 && (
          <Detail
            label="Custom output"
            value={agent.customFields.map((field) => field.name).join(', ')}
          />
        )}
      </dl>
      <details className={styles.prompts}>
        <summary className={styles.viewJsonSummary}>Prompts</summary>
        <dl className={styles.grid}>
          <Detail
            label="System prompt"
            value={<span className={styles.promptText}>{agent.systemPrompt}</span>}
          />
          <Detail
            label="User prompt"
            value={<span className={styles.promptText}>{agent.userPrompt}</span>}
          />
        </dl>
      </details>
    </div>
  );
}

export function EnvelopeDesign({
  envelope,
  compact,
}: {
  envelope: EnvelopeDef;
  compact?: boolean;
}): React.JSX.Element {
  return (
    <div className={cx(styles.design, compact && styles.compact)}>
      {envelope.description && <p className={styles.blurb}>{envelope.description}</p>}
      <table className={styles.fields}>
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Type</th>
            <th scope="col">Required</th>
            <th scope="col">Description</th>
          </tr>
        </thead>
        <tbody>
          {envelope.fields.map((field) => (
            <tr key={field.name}>
              <td className={styles.fieldName}>{field.name}</td>
              <td>{field.type}</td>
              <td>{field.required ? 'yes' : 'no'}</td>
              <td>{field.description ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={styles.baseNote}>
        Plus the base fields every envelope carries: {ENVELOPE_BASE_FIELDS.join(', ')}.
      </p>
    </div>
  );
}

export { ChecklistDesign } from './SmithChecklistDesign.js';
export { EntityComparisonDesign } from './SmithEntityComparisonDesign.js';
export { ChangeReceiptDesign } from './SmithChangeReceiptDesign.js';
export { ProjectCardDesign } from './SmithProjectCardDesign.js';
export { PrCardDesign } from './SmithPrCardDesign.js';

export function RunSummaryDesign({
  artifact,
  compact,
  onOpenInspector,
}: {
  artifact: SmithRunSummaryArtifact;
  compact?: boolean;
  onOpenInspector?: (runId: string) => void;
}): React.JSX.Element {
  const { agentColor } = useApp();
  const [openPhase, setOpenPhase] = useState<string | null>(null);

  const durationStr = artifact.durationMs ? duration(artifact.durationMs) : null;
  const tokenStr = artifact.totalTokens ? tokens(artifact.totalTokens) : null;

  return (
    <div className={cx(styles.design, compact && styles.compact)}>
      <div className={styles.runMetaHeader}>
        <div className={styles.statusRow}>
          <StatusBadge status={artifact.status} />
          {artifact.live && <span className={styles.liveChip}>live</span>}
          <span className={styles.runIdChip}>{artifact.runId}</span>
        </div>
        {durationStr && <span className={styles.durationChip}>{durationStr}</span>}
      </div>

      {artifact.request && <p className={styles.requestText}>&ldquo;{artifact.request}&rdquo;</p>}

      {artifact.outcomeDetail && (
        <div className={styles.outcomeCallout}>
          <span className={styles.outcomeLabel}>Outcome</span>
          <p className={styles.outcomeText}>{artifact.outcomeDetail}</p>
        </div>
      )}

      {artifact.phases && artifact.phases.length > 0 && (
        <div className={styles.waterfallSection}>
          <span className={styles.sectionLabel}>Phases</span>
          <ol className={styles.miniWaterfall} aria-label="Run phases">
            {artifact.phases.map((phase, index) => {
              const color = phaseKindColor(phase.kind, agentColor(phase.owner ?? null));
              const isOpen = openPhase === phase.name;
              const statusCol = statusColor(phase.status);
              const phaseDur = phase.durationMs ? duration(phase.durationMs) : null;

              return (
                <li
                  key={`${phase.name}-${index}`}
                  className={cx(styles.miniPhase)}
                  style={{ borderLeftColor: statusCol }}
                >
                  <button
                    type="button"
                    className={styles.miniPhaseHead}
                    onClick={() => setOpenPhase(isOpen ? null : phase.name)}
                    aria-expanded={isOpen}
                    data-testid={`smith-summary-phase-${phase.name}`}
                  >
                    <span className={styles.phaseIndex}>{index + 1}</span>
                    <span className={styles.phaseGlyph} style={{ color }} aria-hidden>
                      <PhaseGlyph kind={phase.kind} />
                    </span>
                    {phase.kind === 'agent' && phase.owner && !compact && (
                      <AgentAvatar name={phase.owner} size={16} />
                    )}
                    <span className={styles.phaseName}>{phase.name}</span>
                    <span className={styles.phaseKind}>{phase.kind}</span>
                    <span
                      className={styles.phaseStatusDot}
                      style={{ color: statusCol }}
                      title={phase.status}
                    >
                      ● {phase.status}
                    </span>
                    {phaseDur && <span className={styles.phaseDur}>{phaseDur}</span>}
                    <span className={styles.disclosure} aria-hidden>
                      {isOpen ? '−' : '+'}
                    </span>
                  </button>
                  {isOpen && (
                    <dl className={styles.phaseDetails}>
                      {phase.owner && <Detail label="Agent" value={phase.owner} />}
                      <Detail label="Status" value={phase.status} />
                      {phaseDur && <Detail label="Duration" value={phaseDur} />}
                      {phase.error && (
                        <Detail
                          label="Error"
                          value={<span className={styles.phaseError}>{phase.error}</span>}
                        />
                      )}
                      {phase.envelopeSummary && (
                        <Detail label="Report summary" value={phase.envelopeSummary} />
                      )}
                    </dl>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}

      <dl className={styles.footRow}>
        <Detail label="Isolation" value={isolationLabel(artifact.isolation, artifact.branch)} />
        {tokenStr && <Detail label="Tokens" value={tokenStr} />}
        {artifact.prNumber && artifact.prUrl && (
          <Detail
            label="Pull request"
            value={
              <a href={artifact.prUrl} target="_blank" rel="noreferrer" className={styles.link}>
                #{artifact.prNumber}
              </a>
            }
          />
        )}
        {artifact.issueNumber && artifact.issueUrl && (
          <Detail
            label="Issue"
            value={
              <a href={artifact.issueUrl} target="_blank" rel="noreferrer" className={styles.link}>
                #{artifact.issueNumber}
              </a>
            }
          />
        )}
      </dl>

      {onOpenInspector && (
        <div className={styles.actionRow}>
          <Button
            size="sm"
            onClick={() => onOpenInspector(artifact.runId)}
            data-testid="smith-open-inspector"
          >
            Open in Inspector
          </Button>
        </div>
      )}
    </div>
  );
}
