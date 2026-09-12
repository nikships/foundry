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
  settledWorkPrompt,
  SMITH_VOICE_CAPABILITY_PROMPTS,
  voiceCapabilityWorkText,
  VOICE_SECRET_REDIRECT,
  voiceSecretRefusal,
  VOICE_TOOL_NAMES,
  voiceToolDeclarations,
  workStartedResult,
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
  it('takes only Smith text from the current operator turn', () => {
    const transcript = [
      text('a', 'operator', 'please fix it'),
      text('b', 'smith', 'first part'),
      text('c', 'operator', 'thanks'),
      text('d', 'smith', 'the answer'),
    ];
    expect(settledAnswerText(transcript)).toBe('the answer');
  });

  it('caps long answers', () => {
    const transcript = [text('a', 'smith', 'x'.repeat(5000))];
    const out = settledAnswerText(transcript);
    expect(out.length).toBe(4001);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns empty when Smith said nothing', () => {
    expect(settledAnswerText([text('a', 'operator', 'hello')])).toBe('');
    expect(
      settledAnswerText([text('a', 'smith', 'old success'), text('b', 'operator', 'new task')]),
    ).toBe('');
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
  it('gives actionable microphone permission and device recovery instructions', () => {
    expect(friendlyVoiceError(new DOMException('Permission denied', 'NotAllowedError'))).toContain(
      'Privacy & Security → Microphone',
    );
    expect(friendlyVoiceError(new DOMException('Device missing', 'NotFoundError'))).toContain(
      'microphone is unavailable',
    );
  });

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
      VOICE_TOOL_NAMES.work,
      VOICE_TOOL_NAMES.cancel,
      VOICE_TOOL_NAMES.proposalRead,
      VOICE_TOOL_NAMES.proposalAnswer,
    ]);
    const delegate = declarations[0];
    expect(delegate.parameters?.required).toEqual(['text']);
  });

  it('describes work as Smith without exposing a separate agent', () => {
    const work = voiceToolDeclarations()[0];
    expect(work.description).toContain('Continue your work as Smith');
    expect(work.description).not.toMatch(/delegat|real Smith|backend|handoff|ask Smith/i);
  });
});

describe('voice work handoff language', () => {
  it('keeps the waiting status in first person without exposing the handoff', () => {
    const result = workStartedResult();
    expect(result.detail).toBe('I am working on it. I will answer when I have the result.');
    expect(JSON.stringify(result)).not.toMatch(/delegat|backend|handoff|ask Smith|separate agent/i);
  });

  it('instructs settled answers to remain first-person Smith responses', () => {
    const prompt = settledWorkPrompt('Changed the setting successfully.');
    expect(prompt).toContain('Continue the conversation as Smith');
    expect(prompt).toContain('Answer the operator in first person');
    expect(prompt).toContain('Changed the setting successfully.');
  });
});

describe('voice user-level capability routing', () => {
  it('advertises orchestrator, assigned Linear work, pipelines, and key state via smith_work', () => {
    const work = voiceToolDeclarations()[0];
    expect(work.description).toContain('orchestrator');
    expect(work.description).toMatch(/assigned Linear/i);
    expect(work.description).toMatch(/saved pipeline/i);
    expect(work.description).toMatch(/Voice key/i);
    expect(work.description).not.toMatch(/delegat|real Smith|backend|handoff|ask Smith/i);
  });

  it('covers the spoken entry points with self-contained work text', () => {
    const ids = SMITH_VOICE_CAPABILITY_PROMPTS.map((item) => item.id);
    for (const id of [
      'assigned-work',
      'ticket-status',
      'orchestrator-plan',
      'pipeline-run',
    ] as const) {
      expect(ids).toContain(id);
    }
    expect(voiceCapabilityWorkText('assigned-work')).toMatch(/assigned to me/i);
    expect(voiceCapabilityWorkText('assigned-work', 'FOU')).toContain('FOU');
    expect(voiceCapabilityWorkText('ticket-status', 'FOU-123')).toContain('FOU-123');
    expect(voiceCapabilityWorkText('orchestrator-plan', 'fix login')).toContain('fix login');
    expect(voiceCapabilityWorkText('pipeline-run', 'ship-it')).toContain('ship-it');
  });

  it('narrates a settled orchestrator plan id instead of claiming an outcome', () => {
    const prompt = settledWorkPrompt('Your plan plan-a1b2c3d4e5f6 is ready for review.');
    expect(prompt).toContain('plan-a1b2c3d4e5f6');
    expect(prompt).toContain('Continue the conversation as Smith');
  });
});

describe('voice secret handling', () => {
  it('redirects key proposals to the masked desktop card, never spoken aloud', () => {
    expect(VOICE_SECRET_REDIRECT).toMatch(/masked card/i);
    expect(VOICE_SECRET_REDIRECT).toMatch(/do not speak/i);
    expect(voiceSecretRefusal()).toContain(VOICE_SECRET_REDIRECT);
  });

  it('reads a key proposal aloud as a desktop-card redirect', () => {
    const summary = proposalSummary([
      {
        id: 'p9',
        projectId: 'proj_1',
        createdAt: new Date().toISOString(),
        type: 'action',
        operation: 'gemini_live_set_api_key',
        title: 'gemini live set api key',
        summary: 'gemini live set api key.',
        args: {},
        risk: 'credential',
        secretRequest: { kind: 'api-key', label: 'Gemini API key for Live Voice' },
      },
    ]);
    expect(summary).toContain('gemini live set api key');
    expect(summary).toContain(VOICE_SECRET_REDIRECT);
  });

  it('leaves ordinary action proposals without the redirect', () => {
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
    expect(summary).not.toContain(VOICE_SECRET_REDIRECT);
  });
});
