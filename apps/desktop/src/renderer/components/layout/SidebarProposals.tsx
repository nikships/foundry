/**
 * Proposal rows for Sidebar Activity. Split from `Sidebar.tsx` so the
 * sidebar's live-ring CSS contract (pinned by `sidebar-activity.test.ts` to
 * one `runDotLive` reference in that file) stays untouched: this module owns
 * the second live reference while reusing the exact same dot/ring classes.
 */
import type { ProposalSnapshot } from '@shared/types.js';
import { since, statusColor } from '../../utils/format.js';
import { proposalTitle } from '../../view-models/proposals-view.js';
import { cx } from '../ui/cx.js';
import styles from './Sidebar.module.css';

function proposalColor(status: ProposalSnapshot['status']): string {
  if (status === 'generating') return 'var(--accent)';
  if (status === 'ready') return 'var(--green)';
  return 'var(--red)';
}

function proposalWord(status: ProposalSnapshot['status']): string {
  if (status === 'generating') return 'planning';
  if (status === 'ready') return 'plan ready';
  return 'planning failed';
}

export default function SidebarProposals({
  proposals,
  onOpenProposal,
}: {
  proposals: ProposalSnapshot[];
  onOpenProposal?: (planId: string) => void;
}): React.JSX.Element {
  return (
    <>
      {proposals.map((proposal) => {
        const generating = proposal.status === 'generating';
        return (
          <button
            key={proposal.planId}
            type="button"
            className={styles.runItem}
            title={`${proposal.prompt}\n${proposalWord(proposal.status)}`}
            data-testid={`sidebar-proposal-${proposal.planId}`}
            data-proposal-status={proposal.status}
            onClick={() => onOpenProposal?.(proposal.planId)}
          >
            <span
              className={cx(styles.runDot, generating && styles.runDotLive)}
              style={{
                color: generating ? proposalColor(proposal.status) : statusColor('accepted'),
                ...(generating ? undefined : { background: proposalColor(proposal.status) }),
              }}
            />
            <span className={styles.runBody}>
              <span className={styles.runName}>{proposalTitle(proposal)}</span>
              <span className={`${styles.runMeta} faint`}>
                proposal ·{' '}
                {generating
                  ? proposal.detail || proposalWord(proposal.status)
                  : `${proposalWord(proposal.status)} · ${since(
                      new Date(proposal.updatedAt).toISOString(),
                    )}`}
              </span>
            </span>
          </button>
        );
      })}
    </>
  );
}
