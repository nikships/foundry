/**
 * Smith's one-slot approval queue. Public proposals are clone-safe data; the
 * pending entry may additionally retain one main-process executor closure.
 * Secrets flow from the card straight to that closure and are never copied
 * into the proposal, transcript, model result, or persisted chat state.
 */

import { randomUUID } from 'node:crypto';
import type {
  SmithActionProposal,
  SmithEntityProposal,
  SmithProposal,
  SmithProposalAnswer,
  SmithProposalAnswerResult,
  SmithProposalExecutionResult,
} from '@shared/types.js';
import type { ActionExecutionRecord } from './receipts.js';

export type EntityProposalInput = Omit<SmithEntityProposal, 'id' | 'createdAt'>;
export type ActionProposalInput = Omit<SmithActionProposal, 'id' | 'createdAt'>;
export type ProposalInput = EntityProposalInput | ActionProposalInput;

/** The outcome returned only to the blocked model tool call. */
export type ProposalOutcome =
  { approved: true; result: unknown } | { approved: false; note?: string };

/** Main-only executor retained beside a public action proposal. */
export type ProposalExecutor = (
  answer: SmithProposalAnswer,
) => Promise<SmithProposalExecutionResult> | SmithProposalExecutionResult;

/** Entity persistence remains the queue's default, retryable executor. */
export type SaveHandler = (
  proposal: SmithEntityProposal,
) => Promise<{ ok: true; entity: unknown } | { ok: false; error: string }>;

/**
 * Called once per settled action, with what the executor actually did. This is
 * the receipt seam: approval alone never reaches it, and a failure reaches it
 * exactly as a success does.
 */
export type ActionSettledHandler = (
  proposal: SmithActionProposal,
  execution: ActionExecutionRecord,
) => void;

interface PendingEntry {
  proposal: SmithProposal;
  executor: ProposalExecutor;
  resolve: (outcome: ProposalOutcome) => void;
  executing: boolean;
}

export class ProposalQueue {
  private pending: PendingEntry | null = null;

  constructor(
    private readonly onChanged: () => void,
    private readonly save: SaveHandler,
    /** Receives every settled action so main can record a receipt. */
    private readonly onActionSettled?: ActionSettledHandler,
  ) {}

  list(): SmithProposal[] {
    return this.pending ? [this.pending.proposal] : [];
  }

  propose(input: ProposalInput, executor?: ProposalExecutor): Promise<ProposalOutcome> {
    if (this.pending) return Promise.reject(new Error('proposal_pending'));

    const proposal = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    } as SmithProposal;
    const run = executor ?? this.entityExecutor(proposal);

    return new Promise<ProposalOutcome>((resolve) => {
      this.pending = { proposal, executor: run, resolve, executing: false };
      this.onChanged();
    });
  }

  async answer(id: string, answer: SmithProposalAnswer): Promise<SmithProposalAnswerResult> {
    const entry = this.pending;
    if (!entry || entry.proposal.id !== id) {
      return { ok: false, error: 'proposal not found' };
    }
    if (entry.executing) return { ok: false, error: 'proposal is already executing' };

    if (!answer.approved) {
      this.clear(entry);
      entry.resolve({ approved: false, note: answer.note });
      return { ok: true };
    }

    const secretRequest =
      entry.proposal.type === 'action' ? entry.proposal.secretRequest : undefined;
    if (answer.secret !== undefined && !secretRequest) {
      return { ok: false, error: 'this proposal does not accept a secret' };
    }
    if (secretRequest && !answer.secret?.trim()) {
      return { ok: false, error: `${secretRequest.label} is required` };
    }

    entry.executing = true;
    const startedAt = Date.now();
    let executed: SmithProposalExecutionResult;
    try {
      executed = await entry.executor(answer);
    } catch (error) {
      executed = {
        ok: false,
        error: errorMessage(error),
        retryable: entry.proposal.type === 'entity',
      };
    }
    const durationMs = Date.now() - startedAt;

    if (!executed.ok) {
      if (executed.retryable) {
        entry.executing = false;
        return { ok: false, error: executed.error };
      }
      this.settled(entry.proposal, {
        outcome: 'failed',
        durationMs,
        error: executed.error,
      });
      this.clear(entry);
      entry.resolve({ approved: true, result: { ok: false, error: executed.error } });
      return { ok: false, error: executed.error };
    }

    this.settled(entry.proposal, {
      outcome: 'succeeded',
      durationMs,
      result: executed.modelResult,
    });
    this.clear(entry);
    entry.resolve({ approved: true, result: executed.modelResult });
    return executed.privateDisplay
      ? { ok: true, privateDisplay: executed.privateDisplay }
      : { ok: true };
  }

  /**
   * Report a settled action. Entity saves are excluded: their evidence is the
   * stored definition, and the card already routes the operator to it.
   * A receipt must never take the answer down with it, so a throwing handler
   * is swallowed — the action itself already happened.
   */
  private settled(proposal: SmithProposal, execution: ActionExecutionRecord): void {
    if (proposal.type !== 'action' || !this.onActionSettled) return;
    try {
      this.onActionSettled(proposal, execution);
    } catch {
      // Losing a receipt is a lost record, never a lost action.
    }
  }

  cancelAll(): void {
    const entry = this.pending;
    if (!entry) return;
    this.clear(entry);
    entry.resolve({ approved: false, note: 'Foundry is shutting down' });
  }

  /** The default executor: an entity proposal saves, and may be retried. */
  private entityExecutor(proposal: SmithProposal): ProposalExecutor {
    if (proposal.type !== 'entity') throw new Error('action proposals require an executor');
    return async () => {
      const saved = await this.save(proposal);
      return saved.ok
        ? { ok: true, modelResult: { ok: true, entity: saved.entity } }
        : { ok: false, error: saved.error, retryable: true };
    };
  }

  private clear(entry: PendingEntry): void {
    if (this.pending !== entry) return;
    this.pending = null;
    this.onChanged();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
