/**
 * Production remediator: one agent turn in the readiness worktree.
 * Tests inject their own remediator and never reach this file's model path.
 */

import type { AppSettings, ReadinessEntry, ReasoningEffort } from '@shared/types.js';
import type { OneShotFactory } from '../pi/oneshot.js';
import { foldTranscript } from '../pi/transcript.js';
import { READINESS_SYSTEM_PROMPT, readinessRemediatePrompt } from './prompt.js';
import type { ReadinessRemediator } from './session.js';

export type { ReadinessRemediator };

const REMEDIATE_TIMEOUT_MS = 20 * 60_000;
const TEXT_CAP = 4_000;
/** How often cancellation is noticed; a stale cancel is a run left burning. */
const CANCEL_POLL_MS = 250;

export function createAgentRemediator(input: { oneShot: OneShotFactory }): ReadinessRemediator {
  return {
    async run(job) {
      job.onEntry({
        kind: 'note',
        text: job.continuation
          ? `Asking the agent${job.model === 'inherit' ? '' : ` (${job.model})`} to continue from the remaining failures…`
          : `Asking the agent${job.model === 'inherit' ? '' : ` (${job.model})`} to make the repository agent-ready…`,
      });

      // The remediator's whole job is to change the repository, so it runs
      // write-capable — but only inside the readiness worktree it was handed.
      // The isolated branch is what makes that safe: nothing it does reaches
      // the operator's checkout. A failed verify keeps that worktree so the
      // next turn can continue; only Start over / skip / cancel discards it.
      let last: ReadinessEntry | null = null;
      const absorb = foldTranscript<ReadinessEntry>({
        push: (row) => {
          last = job.onEntry(row);
          return last;
        },
        flush: () => job.flush(),
        last: () => last,
        textCap: TEXT_CAP,
      });

      const session = input.oneShot({
        cwd: job.cwd,
        access: 'write',
        model: job.model,
        reasoningEffort: job.reasoningEffort,
        onEvent: absorb,
        onWarning: (warning) => {
          last = job.onEntry({ kind: 'note', text: warning.slice(0, 500) });
        },
      });

      const prompt = `${READINESS_SYSTEM_PROMPT}\n\n${readinessRemediatePrompt(job.evaluation, {
        continuation: job.continuation,
        attempt: job.attempt,
        priorSummary: job.priorSummary,
      })}`;
      const watch = setInterval(() => {
        if (job.signal.cancelled) session.abort();
      }, CANCEL_POLL_MS);
      try {
        const turn = await session.send(prompt, REMEDIATE_TIMEOUT_MS);
        if (job.signal.cancelled) return { ok: false, detail: 'cancelled' };
        if (turn.interrupted) return { ok: false, detail: turn.reason || 'agent interrupted' };
        return { ok: true, detail: turn.reason || 'agent finished' };
      } catch (e) {
        if (job.signal.cancelled) return { ok: false, detail: 'cancelled' };
        return { ok: false, detail: (e as Error).message };
      } finally {
        clearInterval(watch);
        session.abort();
      }
    },
  };
}

export function resolveReadinessModel(
  settings: AppSettings,
  override?: { model?: string; reasoningEffort?: ReasoningEffort },
): { model: string; reasoningEffort: ReasoningEffort } {
  const model = override?.model || settings.readinessModel || settings.defaultModel || 'inherit';
  const reasoningEffort =
    override?.reasoningEffort ||
    settings.readinessReasoningEffort ||
    settings.defaultReasoningEffort;
  return { model, reasoningEffort };
}
