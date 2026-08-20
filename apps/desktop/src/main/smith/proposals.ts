/**
 * The proposal queue. A `foundry-cli create|edit` blocks the calling agent
 * until a human decides, so exactly one proposal may be pending at a time:
 * concurrent writes fail fast rather than stacking a queue the user cannot see.
 *
 * The queue owns the blocking promise. The socket server enqueues and awaits;
 * the renderer's Approve/Reject answers through `answer`, which resolves that
 * promise and lets the CLI exit. This mirrors the engineer-interrupt pattern in
 * `engine/registry.ts`, kept separate because a proposal is not a run event.
 */

import { randomUUID } from 'node:crypto';
import type { SmithProposal, ValidationIssue } from '@shared/types.js';

/** What the socket server hands the queue; the queue assigns id and timestamp. */
export interface ProposalInput {
  kind: SmithProposal['kind'];
  mode: SmithProposal['mode'];
  name: string;
  spec: unknown;
  validation: ValidationIssue[];
  overwrites: boolean;
  projectId: string;
}

/**
 * The outcome the CLI receives. `approve` carries the saved entity so the CLI
 * can print it; `reject` carries the human's note so the agent can revise.
 */
export type ProposalOutcome =
  { approved: true; entity: unknown } | { approved: false; note?: string };

/**
 * How a proposal is settled once a human answers. The queue does not know how
 * to save — the caller (the smith IPC router) does the store write and reports
 * back the persisted entity or an error, and the queue relays it to the CLI.
 */
export type SaveHandler = (
  proposal: SmithProposal,
) => Promise<{ ok: true; entity: unknown } | { ok: false; error: string }>;

interface PendingEntry {
  proposal: SmithProposal;
  resolve: (outcome: ProposalOutcome) => void;
}

export class ProposalQueue {
  private pending: PendingEntry | null = null;

  constructor(
    /** Called whenever the pending set changes, so the renderer can refresh. */
    private readonly onChanged: () => void,
    /** Persists an approved proposal. Supplied by the IPC router. */
    private readonly save: SaveHandler,
  ) {}

  /** The one pending proposal as a list, matching the polled-list convention. */
  list(): SmithProposal[] {
    return this.pending ? [this.pending.proposal] : [];
  }

  /**
   * Stages a proposal and blocks until it is answered. Rejects immediately with
   * `proposal_pending` when one is already outstanding — the CLI turns that into
   * a JSON error the agent can wait on and retry.
   */
  propose(input: ProposalInput): Promise<ProposalOutcome> {
    if (this.pending) return Promise.reject(new Error('proposal_pending'));
    const proposal: SmithProposal = {
      id: randomUUID(),
      kind: input.kind,
      mode: input.mode,
      name: input.name,
      spec: input.spec,
      validation: input.validation,
      overwrites: input.overwrites,
      projectId: input.projectId,
      createdAt: new Date().toISOString(),
    };
    return new Promise<ProposalOutcome>((resolve) => {
      this.pending = { proposal, resolve };
      this.onChanged();
    });
  }

  /**
   * Settles the pending proposal. On approve, the save handler runs first; a
   * failed save leaves the proposal pending and returns false so the card can
   * show the error rather than silently dismissing. On reject, the note travels
   * back to the CLI.
   */
  async answer(id: string, decision: { approved: boolean; note?: string }): Promise<boolean> {
    const entry = this.pending;
    if (!entry || entry.proposal.id !== id) return false;

    if (!decision.approved) {
      this.pending = null;
      entry.resolve({ approved: false, note: decision.note });
      this.onChanged();
      return true;
    }

    const saved = await this.save(entry.proposal);
    if (!saved.ok) {
      // A refused save is not a rejection: the proposal stays pending so the
      // human can retry once the underlying problem is fixed.
      return false;
    }
    this.pending = null;
    entry.resolve({ approved: true, entity: saved.entity });
    this.onChanged();
    return true;
  }

  /**
   * Fails any pending proposal so a waiting CLI unblocks on shutdown rather than
   * hanging until its socket dies.
   */
  cancelAll(): void {
    if (!this.pending) return;
    const entry = this.pending;
    this.pending = null;
    entry.resolve({ approved: false, note: 'Foundry is shutting down' });
    this.onChanged();
  }
}
