/**
 * Pure derivation for the voice layer: the settle detector, the settled-answer
 * text, the proposal summary, and the tool contract the live session declares.
 */

import { describe, expect, it } from 'vitest';
import type { SmithChatState, SmithTranscriptEntry } from '../../src/shared/ipc-contract.js';
import {
  EMPTY_SETTLE_WATCH,
  foldSettleWatch,
  friendlyVoiceError,
  proposalSummary,
  settledAnswerText,
  VOICE_TOOL_NAMES,
  voiceToolDeclarations,
} from '../../src/renderer/view-models/smith-voice-view.js';

function chat(over: Partial<SmithChatState>): SmithChatState {
  return {
    projectId: 'proj_1',
    model: 'inherit',
    activeModel: 'inherit',
    reasoningEffort: 'medium',
    activeReasoningEffort: 'medium',
    running: false,
    error: null,
    transcript: [],
    ...over,
  };
}

function text(
  id: string,
  source: SmithTranscriptEntry['source'],
  text: string,
): SmithTranscriptEntry {
  return { id, kind: 'text', source, text, at: 0 };
}

describe('foldSettleWatch', () => {
  it('ignores smith progress when nothing was delegated', () => {
    let folded = foldSettleWatch(EMPTY_SETTLE_WATCH, chat({ running: true }));
    expect(folded.settled).toBe(false);
    folded = foldSettleWatch(folded.next, chat({ running: false }));
    expect(folded.settled).toBe(false);
    expect(folded.next).toEqual(EMPTY_SETTLE_WATCH);
  });

  it('settles exactly once on the running→stopped edge of a delegated turn', () => {
    // The delegate path arms the watch directly; the fold then observes it.
    const armed = { delegated: true, running: true };
    const during = foldSettleWatch(armed, chat({ running: true }));
    expect(during.settled).toBe(false);
    expect(during.next).toEqual({ delegated: true, running: true });

    const settled = foldSettleWatch(during.next, chat({ running: false }));
    expect(settled.settled).toBe(true);
    expect(settled.next).toEqual(EMPTY_SETTLE_WATCH);

    // The push after the settle edge must not re-fire.
    const again = foldSettleWatch(settled.next, chat({ running: false }));
    expect(again.settled).toBe(false);
  });

  it('survives a null snapshot without changing the watch', () => {
    const folded = foldSettleWatch({ delegated: true, running: true }, null);
    expect(folded.settled).toBe(false);
    expect(folded.next).toEqual({ delegated: true, running: true });
  });
});

describe('settledAnswerText', () => {
  it('takes the last Smith text rows, not operator or tool rows', () => {
    const transcript = [
      text('a', 'operator', 'please fix it'),
      text('b', 'smith', 'first part'),
      text('c', 'operator', 'thanks'),
      text('d', 'smith', 'the answer'),
    ];
    expect(settledAnswerText(transcript)).toBe('first part\n\nthe answer');
  });

  it('caps long answers', () => {
    const transcript = [text('a', 'smith', 'x'.repeat(5000))];
    const out = settledAnswerText(transcript);
    expect(out.length).toBe(4001);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns empty when Smith said nothing', () => {
    expect(settledAnswerText([text('a', 'operator', 'hello')])).toBe('');
  });
});

describe('proposalSummary', () => {
  it('speaks an action proposal with its summary and risk', () => {
    const summary = proposalSummary([
      {
        id: 'p1',
        projectId: 'proj_1',
        createdAt: new Date().toISOString(),
        type: 'action',
        operation: 'runs.kill',
        title: 'Kill run run_1',
        summary: 'Stops run run_1 in its tracks.',
        args: { runId: 'run_1' },
        risk: 'destructive',
      },
    ]);
    expect(summary).toContain('Kill run run_1');
    expect(summary).toContain('destructive');
  });

  it('speaks an entity proposal with its kind and mode', () => {
    const summary = proposalSummary([
      {
        id: 'p2',
        createdAt: new Date().toISOString(),
        type: 'entity',
        kind: 'agent',
        mode: 'create',
        name: 'reviewer',
        spec: {},
        validation: [],
        overwrites: false,
      },
    ]);
    expect(summary).toContain('create the agent "reviewer"');
    expect(summary).not.toContain('undefined');
  });

  it('says when nothing is waiting', () => {
    expect(proposalSummary([])).toBe('No proposal is waiting.');
  });
});

describe('friendlyVoiceError', () => {
  it('maps an invalid-key blob to the Settings pointer, never the raw JSON', () => {
    const raw = new Error(
      'Could not mint a Live API token: {"error":{"code":400,"message":"API key not valid.",' +
        '"details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo",' +
        '"reason":"API_KEY_INVALID"}]}}',
    );
    expect(friendlyVoiceError(raw)).toBe(
      'Your Gemini API key was rejected. Replace it in Settings → Integrations.',
    );
  });

  it('passes ordinary errors through and truncates walls of text', () => {
    expect(friendlyVoiceError(new Error('The live connection dropped.'))).toBe(
      'The live connection dropped.',
    );
    const long = friendlyVoiceError(new Error(`x${'y'.repeat(500)}`));
    expect(long.length).toBeLessThan(300);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('voiceToolDeclarations', () => {
  it('declares exactly the four bounded tools with the pinned names', () => {
    const declarations = voiceToolDeclarations();
    expect(declarations.map((d) => d.name)).toEqual([
      VOICE_TOOL_NAMES.delegate,
      VOICE_TOOL_NAMES.cancel,
      VOICE_TOOL_NAMES.proposalRead,
      VOICE_TOOL_NAMES.proposalAnswer,
    ]);
    const delegate = declarations[0];
    expect(delegate.parameters?.required).toEqual(['text']);
  });
});
