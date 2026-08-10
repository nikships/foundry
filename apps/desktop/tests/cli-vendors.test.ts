/**
 * Each vendor's argv and parse, checked against the shapes their CLIs actually
 * print.
 */

import { describe, expect, it } from 'vitest';
import { adapterFor, allAdapters, type TurnRequest } from '../src/main/cli/index.js';
import { CLI_VENDOR_IDS } from '../src/shared/types.js';

const baseTurn: TurnRequest = {
  prompt: 'do the thing',
  cwd: '/tmp/wt',
  model: 'inherit',
  reasoningEffort: 'off',
  sessionId: null,
};

/** Reads better than an index chase when a flag's value is what is in question. */
function valueOf(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

describe('the vendor registry', () => {
  it('has an adapter for every vendor the contract names', () => {
    for (const id of CLI_VENDOR_IDS) expect(adapterFor(id).id).toBe(id);
  });

  it('falls back to droid rather than crashing on an unknown vendor', () => {
    expect(adapterFor('not-a-cli' as never).id).toBe('droid');
  });

  it('claims RPC for droid alone, because it is the only one with a client', () => {
    expect(
      allAdapters()
        .filter((a) => a.supportsRpc)
        .map((a) => a.id),
    ).toEqual(['droid']);
  });

  it('names caveats only for vendors with runtime constraints', () => {
    expect(adapterFor('droid').caveats).toEqual([]);
  });

  it('passes operator extra arguments through for every vendor', () => {
    for (const id of CLI_VENDOR_IDS) {
      const argv = adapterFor(id).turn({ ...baseTurn, extraArgs: ['--flag-we-do-not-model'] }).argv;
      expect(argv).toContain('--flag-we-do-not-model');
    }
  });

  it('carries the prompt for every vendor', () => {
    for (const id of CLI_VENDOR_IDS) {
      expect(adapterFor(id).turn(baseTurn).argv).toContain('do the thing');
    }
  });

  it('omits the model flag when the agent inherits, so the CLI picks its own', () => {
    for (const id of CLI_VENDOR_IDS) {
      const argv = adapterFor(id).turn(baseTurn).argv;
      expect(argv).not.toContain('inherit');
    }
  });

  it('returns null from parse when the CLI printed nothing parseable', () => {
    for (const id of CLI_VENDOR_IDS) {
      expect(
        adapterFor(id).parse({ stdout: 'command not found', stderr: '', code: 127 }),
      ).toBeNull();
    }
  });
});

describe('droid', () => {
  const droid = adapterFor('droid');

  it('hardcodes --auto high, so no input can lower what a run may do', () => {
    const configurations: TurnRequest[] = [
      baseTurn,
      {
        ...baseTurn,
        prompt: 'something else',
        cwd: '/elsewhere',
        model: 'claude-opus-5',
        reasoningEffort: 'high',
        sessionId: 'sess-9',
        restrictTools: ['Read'],
        disabledTools: ['Execute'],
        extraArgs: ['--flag-we-do-not-model'],
      },
    ];
    for (const turn of configurations) {
      expect(valueOf(droid.turn(turn).argv, '--auto')).toBe('high');
    }
  });

  it('resumes with --session-id', () => {
    expect(valueOf(droid.turn({ ...baseTurn, sessionId: 'sess-1' }).argv, '--session-id')).toBe(
      'sess-1',
    );
  });

  it('pairs reasoning effort with the model and drops both on inherit', () => {
    const withModel = droid.turn({
      ...baseTurn,
      model: 'claude-opus-5',
      reasoningEffort: 'high',
    }).argv;
    expect(valueOf(withModel, '-m')).toBe('claude-opus-5');
    expect(valueOf(withModel, '-r')).toBe('high');
    expect(droid.turn(baseTurn).argv).not.toContain('-r');
  });

  it('reads the result envelope droid prints last', () => {
    const stdout = [
      '{"type":"log","message":"starting"}',
      '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"sess-9","usage":{"inputTokens":10,"outputTokens":4}}',
    ].join('\n');
    const parsed = droid.parse({ stdout, stderr: '', code: 0 });
    expect(parsed).toMatchObject({ text: 'done', sessionId: 'sess-9', isError: false });
    expect(parsed?.usage?.inputTokens).toBe(10);
  });

  it('streams, so a detection or phase can be watched rather than awaited blind', () => {
    expect(valueOf(droid.turn(baseTurn).argv, '--output-format')).toBe('stream-json');
  });

  /**
   * Captured from `droid exec -o stream-json`. The terminal line is
   * `completion`/`finalText`, not the `result`/`result` that `-o json` prints:
   * parsing only the latter would leave every streamed turn with empty text.
   */
  it('reads the completion envelope stream-json ends with', () => {
    const stdout = [
      '{"type":"system","subtype":"init","session_id":"5457fcb9","model":"claude-opus-5"}',
      '{"type":"message","role":"assistant","id":"bf54","text":"DONE","session_id":"5457fcb9"}',
      '{"type":"completion","finalText":"DONE","numTurns":2,"durationMs":3264,"session_id":"5457fcb9","usage":{"input_tokens":21200,"output_tokens":145,"cache_read_input_tokens":7,"cache_creation_input_tokens":3}}',
    ].join('\n');
    const parsed = droid.parse({ stdout, stderr: '', code: 0 });
    expect(parsed).toMatchObject({ text: 'DONE', sessionId: '5457fcb9', isError: false });
    expect(parsed?.usage?.inputTokens).toBe(21200);
    expect(parsed?.usage?.outputTokens).toBe(145);
    expect(parsed?.usage?.cacheReadTokens).toBe(7);
    expect(parsed?.usage?.cacheCreationTokens).toBe(3);
  });

  it('folds an assistant message into one delta and its close', () => {
    const normalise = droid.stream!();
    expect(
      normalise({
        type: 'message',
        role: 'assistant',
        id: '1523',
        text: 'Listing files as requested.',
      }),
    ).toEqual([
      {
        type: 'assistant_text_delta',
        messageId: '1523',
        blockIndex: 0,
        textDelta: 'Listing files as requested.',
      },
      { type: 'assistant_text_complete', messageId: '1523', blockIndex: 0 },
    ]);
  });

  it('maps a tool call and its result onto the same id, so the row spans', () => {
    const normalise = droid.stream!();
    expect(
      normalise({
        type: 'tool_call',
        id: 'call_019f',
        toolId: 'LS',
        toolName: 'LS',
        parameters: { directory_path: '/tmp/probe' },
      }),
    ).toEqual([
      {
        type: 'tool_call',
        toolUse: {
          type: 'tool_use',
          id: 'call_019f',
          name: 'LS',
          input: { directory_path: '/tmp/probe' },
        },
      },
    ]);
    expect(
      normalise({
        type: 'tool_result',
        id: 'call_019f',
        toolId: 'LS',
        isError: false,
        value: 'total 8',
      }),
    ).toEqual([
      { type: 'tool_result', toolUseId: 'call_019f', content: 'total 8', isError: false },
    ]);
  });

  it('ignores the init and user lines, which carry no mid-turn event', () => {
    const normalise = droid.stream!();
    expect(normalise({ type: 'system', subtype: 'init', session_id: 'x' })).toEqual([]);
    expect(normalise({ type: 'message', role: 'user', id: 'u1', text: 'hi' })).toEqual([]);
    expect(normalise({ type: 'completion', finalText: 'done' })).toEqual([]);
  });
});

describe('stream normalisers', () => {
  it('every vendor exposes a stream factory', () => {
    for (const id of CLI_VENDOR_IDS) {
      expect(typeof adapterFor(id).stream).toBe('function');
    }
  });
});
