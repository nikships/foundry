/** Inline approval card for entity saves and fixed privileged Smith actions. */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentDef,
  EnvelopeDef,
  PipelineDef,
  SmithEntityProposal,
  SmithPrivateDisplay,
  SmithProposal,
} from '@shared/types.js';
import { api } from '../../api.js';
import { compareEntities } from '../../view-models/smith-artifact-view.js';
import QrCode from '../media/QrCode.js';
import { Button } from '../ui/Button.js';
import { AgentDesign, EnvelopeDesign, PipelineDesign, ViewJson } from './SmithEntityDesign.js';
import styles from './SmithProposalCard.module.css';

export interface SmithNavTarget {
  kind: SmithEntityProposal['kind'];
  name: string;
}

const KIND_LABEL: Record<SmithEntityProposal['kind'], string> = {
  agent: 'agent',
  pipeline: 'pipeline',
  envelope: 'report',
};

export default function SmithProposalCard({
  projectId,
  onCompleted,
  onRequestChanges,
  compact,
}: {
  /** Conversation scope; absent means All projects. */
  projectId?: string;
  /** Refreshes app state; entity saves additionally provide a Design target. */
  onCompleted: (target?: SmithNavTarget) => void | Promise<void>;
  /**
   * Request changes: the proposal was rejected to unblock Smith's tool call,
   * and the operator should land in the composer to write the revision. The
   * host owns the composer, so it gets the prefill text to place there.
   */
  onRequestChanges?: (prefill: string) => void;
  /** Tighter design bodies for the titlebar bubble. */
  compact?: boolean;
}): React.JSX.Element | null {
  const [proposal, setProposal] = useState<SmithProposal | null>(null);
  const [privateDisplay, setPrivateDisplay] = useState<SmithPrivateDisplay | null>(null);
  const [secret, setSecret] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async (): Promise<void> => {
    const pending = (await api.smith.proposalsList())[0];
    setProposal(pending?.projectId === projectId ? pending : null);
  }, [projectId]);

  useEffect(() => {
    void refresh();
    return api.on('smith-proposals-changed', () => void refresh());
  }, [refresh]);

  // A different proposal, or a different scope, must not inherit the previous
  // card's in-flight state. A new proposal also supersedes a private display;
  // a scope change clears the display outright.
  const proposalId = proposal?.id ?? '';
  useEffect(() => {
    setError('');
    setSending(false);
    setSecret('');
    if (proposalId) setPrivateDisplay(null);
  }, [proposalId]);

  useEffect(() => {
    setError('');
    setSending(false);
    setSecret('');
    setPrivateDisplay(null);
  }, [projectId]);

  const answer = async (verdict: 'approve' | 'reject' | 'request-changes'): Promise<void> => {
    if (!proposal || sending) return;
    const approved = verdict === 'approve';
    setSending(true);
    setError('');
    try {
      const result = await api.smith.answerProposal(proposal.id, {
        approved,
        ...(approved && proposal.type === 'action' && proposal.secretRequest ? { secret } : {}),
      });
      setSecret('');
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.privateDisplay) setPrivateDisplay(result.privateDisplay);
      if (approved) {
        await onCompleted(
          proposal.type === 'entity' ? { kind: proposal.kind, name: proposal.name } : undefined,
        );
      }
      // Request changes is a reject that lands the operator in the composer:
      // Smith's tool call is already unblocked, and the next message is the
      // revision guidance — never a silent re-propose of the same spec.
      if (verdict === 'request-changes' && proposal.type === 'entity') {
        onRequestChanges?.(`Revise the ${KIND_LABEL[proposal.kind]} ${proposal.name}: `);
      }
      await refresh();
    } catch (caught) {
      setSecret('');
      setError(caught instanceof Error ? caught.message : 'Could not send that answer.');
    } finally {
      setSending(false);
    }
  };

  // A pending proposal outranks a display left over from the previous answer.
  if (!proposal) {
    return privateDisplay ? (
      <PrivateDisplayCard display={privateDisplay} onChange={setPrivateDisplay} />
    ) : null;
  }

  return proposal.type === 'entity' ? (
    <EntityCard
      proposal={proposal}
      sending={sending}
      error={error}
      compact={compact}
      requestChanges={!!onRequestChanges}
      onAnswer={(verdict) => void answer(verdict)}
    />
  ) : (
    <section
      className={styles.card}
      aria-labelledby="smith-proposal-title"
      data-testid="smith-proposal-card"
    >
      <header className={styles.header}>
        <span className={styles.kind}>action</span>
        <span className={`${styles.mode} ${styles.risk}`}>{proposal.risk}</span>
        <h2 className={styles.title} id="smith-proposal-title">
          {proposal.title}
        </h2>
      </header>
      <p className={styles.summary}>{proposal.summary}</p>
      <p className={styles.scopeNote}>
        Scope: {proposal.projectId ? `project ${proposal.projectId}` : 'All projects'} · Operation:{' '}
        <code>{proposal.operation}</code>
      </p>
      <pre className={`${styles.spec} selectable`}>{JSON.stringify(proposal.args, null, 2)}</pre>
      {proposal.secretRequest && (
        <label className={styles.secretField}>
          <span>{proposal.secretRequest.label}</span>
          <input
            type="password"
            autoComplete="off"
            value={secret}
            placeholder={proposal.secretRequest.placeholder}
            onChange={(event) => setSecret(event.currentTarget.value)}
            data-testid="smith-proposal-secret"
          />
        </label>
      )}
      <CardFooter
        sending={sending}
        error={error}
        approveDisabled={!!proposal.secretRequest && !secret.trim()}
        approveLabel={
          proposal.risk === 'destructive' ? 'Approve destructive action' : 'Approve action'
        }
        onAnswer={(verdict) => void answer(verdict)}
      />
    </section>
  );
}

function PrivateDisplayCard({
  display,
  onChange,
}: {
  display: SmithPrivateDisplay;
  onChange: (next: SmithPrivateDisplay | null) => void;
}): React.JSX.Element {
  const encoded = JSON.stringify(display.payload);
  /** Transient acknowledgment that the pairing payload reached the clipboard. */
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    },
    [],
  );

  const copyPayload = (): void => {
    void navigator.clipboard.writeText(encoded).then(() => {
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <section className={styles.card} data-testid="smith-private-display">
      <header className={styles.header}>
        <span className={styles.kind}>private</span>
        <h2 className={styles.title}>Companion pairing</h2>
      </header>
      <p className={styles.summary}>Scan this QR on the device you want to pair.</p>
      <div className={styles.qr}>
        <QrCode value={encoded} size={200} title="Companion pairing QR code" />
      </div>
      <footer className={styles.footer}>
        <Button onClick={copyPayload}>{copied ? 'Copied ✓' : 'Copy pairing code'}</Button>
        <Button
          onClick={() => {
            void api.companion.pairingPayload({ refresh: true }).then((payload) => {
              if (payload) onChange({ kind: 'companion-pairing', payload });
            });
          }}
        >
          Refresh
        </Button>
        <span className={styles.spacer} />
        <Button onClick={() => onChange(null)}>Dismiss</Button>
      </footer>
    </section>
  );
}

/** The same read-only design bodies the artifact cards draw — one renderer per concept. */
function EntityDesignBody({
  proposal,
  compact,
}: {
  proposal: SmithEntityProposal;
  compact?: boolean;
}): React.JSX.Element {
  if (proposal.kind === 'pipeline') {
    return <PipelineDesign pipeline={proposal.spec as PipelineDef} compact={compact} />;
  }
  if (proposal.kind === 'agent') {
    return <AgentDesign agent={proposal.spec as AgentDef} compact={compact} />;
  }
  return <EnvelopeDesign envelope={proposal.spec as EnvelopeDef} compact={compact} />;
}

function EntityCard({
  proposal,
  sending,
  error,
  compact,
  requestChanges,
  onAnswer,
}: {
  proposal: SmithEntityProposal;
  sending: boolean;
  error: string;
  compact?: boolean;
  requestChanges: boolean;
  onAnswer: (verdict: 'approve' | 'reject' | 'request-changes') => void;
}): React.JSX.Element {
  const changes = proposal.overwrites
    ? compareEntities(proposal.kind, proposal.previous, proposal.spec)
    : [];
  return (
    <section className={styles.card} data-testid="smith-proposal-card">
      <header className={styles.header}>
        <span className={styles.kind}>{KIND_LABEL[proposal.kind]}</span>
        <span className={`${styles.mode} ${proposal.overwrites ? styles.modeOverwrite : ''}`}>
          {proposal.overwrites ? 'overwrite' : 'create'}
        </span>
        <h2 className={styles.title}>
          Smith wants to {proposal.overwrites ? 'overwrite' : 'create'}{' '}
          <span className={styles.name}>{proposal.name}</span>
        </h2>
      </header>
      <p className={styles.scopeNote}>
        Scope:{' '}
        {(proposal.targetProjectId ?? proposal.projectId)
          ? `project ${proposal.targetProjectId ?? proposal.projectId}`
          : 'global (all projects)'}
      </p>
      {proposal.overwrites && (
        <p className={styles.overwriteNote}>
          A {KIND_LABEL[proposal.kind]} named <strong>{proposal.name}</strong> already exists.
          Approving replaces its current definition.
        </p>
      )}
      <EntityDesignBody proposal={proposal} compact={compact} />
      {changes.length > 0 && (
        <div className={styles.changes} data-testid="smith-proposal-changes">
          <span className={styles.changesTitle}>What changes</span>
          {changes.map((change, index) => (
            <span key={`${change.where}-${index}`} className={styles.change}>
              <span className={styles.changeKind} data-change={change.kind}>
                {change.kind}
              </span>
              <span className={styles.changeWhere}>{change.where}</span>
              {change.kind === 'changed' || change.kind === 'reordered' ? (
                <span className={styles.changeValue}>
                  {change.before} → {change.after}
                </span>
              ) : (
                <span className={styles.changeValue}>{change.after ?? change.before}</span>
              )}
            </span>
          ))}
        </div>
      )}
      {proposal.validation.length > 0 && (
        <div className={styles.warnings}>
          {proposal.validation.map((issue, index) => (
            <span key={`${issue.where}-${index}`} className={styles.warning}>
              <span className={styles.warningWhere}>{issue.where}</span>
              {issue.message}
            </span>
          ))}
        </div>
      )}
      <ViewJson value={proposal.spec} />
      <CardFooter
        sending={sending}
        error={error}
        approveDisabled={false}
        approveLabel="Approve"
        requestChanges={requestChanges}
        onAnswer={onAnswer}
      />
    </section>
  );
}

function CardFooter({
  sending,
  error,
  approveDisabled,
  approveLabel,
  requestChanges,
  onAnswer,
}: {
  sending: boolean;
  error: string;
  approveDisabled: boolean;
  approveLabel: string;
  /** Shows the Request changes affordance (entity proposals in a chat host). */
  requestChanges?: boolean;
  onAnswer: (verdict: 'approve' | 'reject' | 'request-changes') => void;
}): React.JSX.Element {
  return (
    <>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <footer className={styles.footer}>
        {requestChanges && (
          <Button
            disabled={sending}
            onClick={() => onAnswer('request-changes')}
            data-testid="smith-proposal-request-changes"
          >
            {sending ? 'Sending…' : 'Request changes'}
          </Button>
        )}
        <Button
          disabled={sending}
          onClick={() => onAnswer('reject')}
          data-testid="smith-proposal-reject"
        >
          {sending ? 'Sending…' : 'Reject'}
        </Button>
        <span className={styles.spacer} />
        <Button
          variant="primary"
          disabled={sending || approveDisabled}
          onClick={() => onAnswer('approve')}
          data-testid="smith-proposal-approve"
        >
          {sending ? 'Running…' : approveLabel}
        </Button>
      </footer>
    </>
  );
}
