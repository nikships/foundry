/**
 * Production remediator: one agent turn in the readiness worktree.
 * Tests inject their own remediator and never reach this file's network path.
 */

import type { AppSettings, CliVendor, ReadinessEntry, ReasoningEffort } from '@shared/types.js';
import { adapterFor } from '../cli/index.js';
import { OneShotClient } from '../droid/oneshot.js';
import { labelToolCall, toolKind } from '../droid/events.js';
import type { DroidNotification, ToolUse } from '../droid/protocol.js';
import { READINESS_SYSTEM_PROMPT, readinessRemediatePrompt } from './prompt.js';
import type { ReadinessRemediator } from './session.js';

export type { ReadinessRemediator };

const REMEDIATE_TIMEOUT_MS = 20 * 60_000;
const TEXT_CAP = 4_000;

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
        text: `Asking ${adapter.label}${job.model === 'inherit' ? '' : ` (${job.model})`} to make the repository agent-ready…`,
      });

      const normalise = adapter.stream?.();
      const openTools = new Map<string, ReadinessEntry>();
      let last: ReadinessEntry | null = null;

      const absorb = (notifications: DroidNotification[]): void => {
        for (const n of notifications) {
          switch (n.type) {
            case 'assistant_text_delta': {
              const delta = (n as { textDelta?: string }).textDelta ?? '';
              if (!delta.trim()) break;
              if (last?.kind === 'text') {
                last.text = `${last.text}${delta}`.slice(0, TEXT_CAP);
                job.flush();
              } else {
                last = job.onEntry({ kind: 'text', text: delta.slice(0, TEXT_CAP) });
              }
              break;
            }
            case 'tool_call': {
              const tool = (n as { toolUse?: ToolUse }).toolUse;
              if (!tool?.id || openTools.has(tool.id)) break;
              last = job.onEntry({
                kind: 'tool',
                text: labelToolCall(tool),
                toolKind: toolKind(tool.name),
              });
              openTools.set(tool.id, last);
              break;
            }
            case 'tool_result': {
              const r = n as { toolUseId?: string; isError?: boolean };
              const open = r.toolUseId ? openTools.get(r.toolUseId) : undefined;
              if (!open || !r.toolUseId) break;
              open.done = true;
              open.failed = !!r.isError;
              openTools.delete(r.toolUseId);
              last = open;
              job.flush();
              break;
            }
            default:
              break;
          }
        }
      };

      const client = new OneShotClient({
        vendor,
        cliPath: cli.path,
        extraArgs: cli.extraArgs,
        cwd: job.cwd,
        model: job.model,
        reasoningEffort: job.reasoningEffort,
        onStderr: (text) => {
          const trimmed = text.trim();
          if (trimmed) {
            last = job.onEntry({ kind: 'note', text: trimmed.slice(0, 500) });
          }
        },
      });

      const prompt = `${READINESS_SYSTEM_PROMPT}\n\n${readinessRemediatePrompt(job.evaluation)}`;
      const watch = setInterval(() => {
        if (job.signal.cancelled) client.kill();
      }, 250);
      try {
        const turn = await client.send(
          prompt,
          REMEDIATE_TIMEOUT_MS,
          normalise ? (line) => absorb(normalise(line)) : undefined,
        );
        if (job.signal.cancelled) return { ok: false, detail: 'cancelled' };
        // Stream already carried the live answer. Only dump the final text when
        // the vendor had no stream, so the operator still sees what happened.
        if (!normalise && turn.text.trim()) {
          job.onEntry({ kind: 'text', text: turn.text.trim().slice(0, TEXT_CAP) });
        }
        if (turn.interrupted) return { ok: false, detail: turn.reason || 'agent interrupted' };
        return { ok: true, detail: turn.reason || 'agent finished' };
      } catch (e) {
        if (job.signal.cancelled) return { ok: false, detail: 'cancelled' };
        return { ok: false, detail: (e as Error).message };
      } finally {
        clearInterval(watch);
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
