/**
 * Pure derivation for Smith's live voice layer, kept free of React and the
 * network so the tool contract and the settle detector are testable in Node.
 *
 * The live session's tools are declared here rather than in the hook because
 * they are the contract between the voice model and the dispatch table: one
 * change to a tool's name or parameters must touch this file only, and the
 * hook reads both from it.
 */

import type { SmithChatState } from '@shared/ipc-contract.js';
import type { SmithProposal } from '@shared/types.js';

import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';

/** The tools the live session declares; names match main's `VOICE_TOOLS`. */
export const VOICE_TOOL_NAMES = {
  delegate: 'smith_delegate',
  cancel: 'smith_cancel',
  proposalRead: 'smith_proposal_read',
  proposalAnswer: 'smith_proposal_answer',
} as const;

/**
 * JSON-schema function declarations for the live session, in the shape
 * `@google/genai`'s `tools` config expects. The SDK import is type-only, so
 * this module still runs in Node tests without the SDK loaded.
 */
export function voiceToolDeclarations(): FunctionDeclaration[] {
  return [
    {
      name: VOICE_TOOL_NAMES.delegate,
      description:
        'Delegate a task to the real Smith agent on the model the operator chose in the app. Use for anything that reads or changes Foundry: runs, pipelines, agents, projects, files, settings, questions about app state. Returns immediately with "started"; the result arrives as a later user message.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          text: {
            type: Type.STRING,
            description:
              'A faithful, self-contained statement of what the operator wants, in their words.',
          },
        },
        required: ['text'],
      },
    },
    {
      name: VOICE_TOOL_NAMES.cancel,
      description: 'Stop the Smith turn that is currently running, if any.',
      parameters: {
        type: Type.OBJECT,
        properties: {},
      },
    },
    {
      name: VOICE_TOOL_NAMES.proposalRead,
      description:
        'Read the one proposal card waiting for the operator, if any. Call when the operator asks what is pending or wants to decide by voice.',
      parameters: {
        type: Type.OBJECT,
        properties: {},
      },
    },
    {
      name: VOICE_TOOL_NAMES.proposalAnswer,
      description:
        'Approve or reject the pending proposal card. Only call when the operator clearly asked you to decide.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          approved: {
            type: Type.BOOLEAN,
            description: 'True to approve, false to reject.',
          },
        },
        required: ['approved'],
      },
    },
  ];
}

/**
 * Maps a voice-session failure to the one line the overlay shows. Mint
 * failures from main are already friendly, but the live socket can also hand
 * the hook a raw Google JSON-RPC blob (an invalid key carries
 * `API_KEY_INVALID` inside `{"error":{"code":400,...}}`); that must never
 * render verbatim, so an invalid key always resolves to the Settings →
 * Integrations pointer and anything else keeps its short detail.
 */
export function friendlyVoiceError(raw: unknown): string {
  const message = raw instanceof Error ? raw.message : String(raw);
  if (/API_KEY_INVALID|API key not valid|invalid API key|API key expired/i.test(message)) {
    return 'Your Gemini API key was rejected. Replace it in Settings → Integrations.';
  }
  const oneLine = message.replace(/\s+/g, ' ').trim();
  if (oneLine.length > 240) return `${oneLine.slice(0, 240)}…`;
  return oneLine || 'The live session failed. Try connecting again.';
}

/** What the live session should show for one delegated turn's progress. */
export interface VoiceSettleWatch {
  /** True once a delegate call marked a turn live. */
  delegated: boolean;
  /** The running flag observed on the last smith-progress push. */
  running: boolean;
}

export const EMPTY_SETTLE_WATCH: VoiceSettleWatch = { delegated: false, running: false };

/**
 * Folds one smith chat snapshot into the settle watch. A delegated turn is
 * the one this layer started with `smith_delegate`; the watch arms when it
 * sees the turn running and reports `settled` exactly once when it stops —
 * the push that carries the finished answer.
 */
export function foldSettleWatch(
  watch: VoiceSettleWatch,
  state: SmithChatState | null,
): { next: VoiceSettleWatch; settled: boolean } {
  if (!state) return { next: watch, settled: false };
  if (!watch.delegated) {
    // Nothing was delegated through voice; nothing to announce.
    return { next: { delegated: false, running: state.running }, settled: false };
  }
  if (state.running) return { next: { delegated: true, running: true }, settled: false };
  return { next: { delegated: false, running: false }, settled: watch.running };
}

/**
 * The text to inject into the live session when a delegated turn settles.
 * Smith's own text rows from this turn, newest last, capped so a long answer
 * does not eat the live session's context window.
 */
export function settledAnswerText(
  transcript: SmithChatState['transcript'],
  maxEntries = 3,
  maxChars = 4000,
): string {
  const smithText = transcript
    .filter((entry) => entry.kind === 'text' && entry.source === 'smith')
    .slice(-maxEntries);
  const text = smithText.map((entry) => (entry as { text: string }).text).join('\n\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/** A bounded, spoken summary of the one pending proposal for the voice model. */
export function proposalSummary(proposals: SmithProposal[]): string {
  if (proposals.length === 0) return 'No proposal is waiting.';
  const p = proposals[0];
  if (p.type === 'action') {
    return `One action proposal is waiting: ${p.title}. Summary: ${p.summary}. Risk level: ${p.risk}.`;
  }
  return `One proposal is waiting: it would ${p.mode} the ${p.kind} "${p.name}"${
    p.overwrites ? ', overwriting the existing definition' : ''
  }. Its full details are on the card in the app.`;
}
