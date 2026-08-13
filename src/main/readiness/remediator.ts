/**
 * Production remediator: one agent turn in the readiness worktree.
 * Tests inject their own remediator and never reach this file's network path.
 */

import type { AppSettings, CliVendor, ReasoningEffort } from '@shared/types.js';
import { adapterFor } from '../cli/index.js';
import { OneShotClient } from '../droid/oneshot.js';
import { READINESS_SYSTEM_PROMPT, readinessRemediatePrompt } from './prompt.js';
import type { ReadinessRemediator } from './session.js';

export type { ReadinessRemediator };

const REMEDIATE_TIMEOUT_MS = 20 * 60_000;

export function createAgentRemediator(input: {
  settings: AppSettings;
  vendor: CliVendor;
}): ReadinessRemediator {
  return {
    async run(job) {
      const { settings, vendor } = input;
      const adapter = adapterFor(vendor);
      const cli = settings.clis[vendor];
      if (!cli) return { ok: false, detail: `no CLI configured for ${vendor}` };

      job.onEntry({
        kind: 'note',
        text: `Asking ${adapter.label} to make the repository agent-ready…`,
      });

      const client = new OneShotClient({
        vendor,
        cliPath: cli.path,
        extraArgs: cli.extraArgs,
        cwd: job.cwd,
        model: job.model,
        reasoningEffort: job.reasoningEffort,
        onStderr: (text) => {
          const trimmed = text.trim();
          if (trimmed) job.onEntry({ kind: 'note', text: trimmed.slice(0, 500) });
        },
      });

      const prompt = `${READINESS_SYSTEM_PROMPT}\n\n${readinessRemediatePrompt(job.evaluation)}`;
      try {
        const turn = await client.send(prompt, REMEDIATE_TIMEOUT_MS);
        if (job.signal.cancelled) return { ok: false, detail: 'cancelled' };
        if (turn.text.trim()) job.onEntry({ kind: 'text', text: turn.text.trim().slice(0, 4_000) });
        if (turn.interrupted) return { ok: false, detail: turn.reason || 'agent interrupted' };
        return { ok: true, detail: turn.reason || 'agent finished' };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      } finally {
        client.kill();
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
