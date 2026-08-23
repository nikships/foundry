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
import type { AgentDef, EnvelopeDef, PipelineDef } from '@shared/types.js';
import { useApp } from '../../stores/app.js';
import { phaseKindColor } from '../../utils/derive.js';
import {
  acceptanceLabel,
  commandLabel,
  gateLabel,
  phaseWorkLabel,
  writesLabel,
} from '../../view-models/smith-artifact-view.js';
import AgentAvatar from '../media/AgentAvatar.js';
import { EnvelopeGlyph, PhaseGlyph } from '../pipeline/PhaseGlyphs.js';
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
export { CheckpointDesign } from './SmithCheckpointDesign.js';
export { ReadinessJourneyDesign } from './SmithReadinessJourneyDesign.js';
export { ProviderStatusDesign } from './SmithProviderStatusDesign.js';
