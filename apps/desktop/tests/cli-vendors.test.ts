/**
 * Each vendor's argv and parse, checked against the shapes their CLIs actually
 * print. These are the two halves of an adapter that can be wrong without
 * anything crashing: a missing flag turns into a phase that hangs on an approval
 * prompt, and a missed field turns into an agent that appears to have no memory
 * or to have cost nothing.
 *
 * The fixtures are the real output shapes from each CLI's documentation, not
 * shapes convenient to the parser.
 */

import { describe, expect, it } from 'vitest';
import { adapterFor, allAdapters, type TurnRequest } from '../src/main/cli/index.js';
import { CLI_VENDOR_IDS } from '../src/shared/types.js';

const baseTurn: TurnRequest = {
  prompt: 'do the thing',
  cwd: '/tmp/wt',
  autonomy: 'medium',
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

  it('falls back to droid rather than crashing on a vendor a stored roster invented', () => {
    expect(adapterFor('not-a-cli' as never).id).toBe('droid');
  });

  it('claims RPC for droid alone, because it is the only one with a client', () => {
    expect(
      allAdapters()
        .filter((a) => a.supportsRpc)
        .map((a) => a.id),
    ).toEqual(['droid']);
  });

  it('names a caveat for every vendor that cannot trace mid-turn tool calls', () => {
    for (const adapter of allAdapters()) {
      if (adapter.supportsRpc) continue;
      expect(adapter.caveats.length).toBeGreaterThan(0);
    }
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

  it('offers at least one selectable model per vendor, so an agent is never unconfigurable', async () => {
    for (const id of CLI_VENDOR_IDS) {
      if (id === 'droid') continue; // droid shells out to the real CLI
      const models = await adapterFor(id).models('unused');
      expect(models.length).toBeGreaterThan(0);
      expect(models.some((m) => m.id === 'inherit')).toBe(true);
    }
  });
});

describe('droid', () => {
  const droid = adapterFor('droid');

  it('sends autonomy as --auto, the one vendor that keeps a permission callback', () => {
    expect(valueOf(droid.turn({ ...baseTurn, autonomy: 'high' }).argv, '--auto')).toBe('high');
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
    // droid exec prints snake_case; the engine reads camelCase. Passing the
    // wire object through unmapped reported every one-shot turn as free.
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

describe('claude code', () => {
  const claude = adapterFor('claude');

  it('maps autonomy onto a permission mode rather than onto a prompt', () => {
    expect(valueOf(claude.turn({ ...baseTurn, autonomy: 'low' }).argv, '--permission-mode')).toBe(
      'default',
    );
    expect(
      valueOf(claude.turn({ ...baseTurn, autonomy: 'medium' }).argv, '--permission-mode'),
    ).toBe('acceptEdits');
    expect(valueOf(claude.turn({ ...baseTurn, autonomy: 'high' }).argv, '--permission-mode')).toBe(
      'bypassPermissions',
    );
  });

  it('asks for print mode and streaming json, the pair that makes a turn watchable', () => {
    const argv = claude.turn(baseTurn).argv;
    expect(argv).toContain('-p');
    expect(valueOf(argv, '--output-format')).toBe('stream-json');
    // stream-json in print mode emits nothing per message without it.
    expect(argv).toContain('--verbose');
  });

  it('starts a session with a uuid and resumes with --resume, never --session-id twice', () => {
    const first = claude.turn(baseTurn).argv;
    expect(valueOf(first, '--session-id')).toMatch(/^[0-9a-f-]{36}$/);
    const second = claude.turn({ ...baseTurn, sessionId: 'abc-123' }).argv;
    expect(valueOf(second, '--resume')).toBe('abc-123');
    expect(second).not.toContain('--session-id');
  });

  it('adds the worktree as a directory, since there is no --cwd to pass', () => {
    expect(valueOf(claude.turn(baseTurn).argv, '--add-dir')).toBe('/tmp/wt');
  });

  it('scopes tools with allow and deny lists', () => {
    const argv = claude.turn({
      ...baseTurn,
      restrictTools: ['Read', 'Edit'],
      disabledTools: ['WebFetch'],
    }).argv;
    expect(valueOf(argv, '--allowedTools')).toBe('Read,Edit');
    expect(valueOf(argv, '--disallowedTools')).toBe('WebFetch');
  });

  it('reads the result object, converting token names and dollars', () => {
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'shipped it',
      session_id: 'cc-1',
      total_cost_usd: 0.42,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 7,
      },
    });
    const parsed = claude.parse({ stdout, stderr: '', code: 0 });
    expect(parsed).toMatchObject({ text: 'shipped it', sessionId: 'cc-1', isError: false });
    expect(parsed?.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationTokens: 5,
      cacheReadTokens: 7,
      factoryCredits: 0.42,
    });
  });

  it('reports an errored turn as an error rather than as an empty answer', () => {
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      session_id: 'cc-2',
    });
    expect(claude.parse({ stdout, stderr: '', code: 1 })).toMatchObject({
      isError: true,
      reason: 'error_max_turns',
    });
  });
});

describe('codex', () => {
  const codex = adapterFor('codex');

  it('maps autonomy onto a sandbox and never asks for approval', () => {
    expect(valueOf(codex.turn({ ...baseTurn, autonomy: 'low' }).argv, '--sandbox')).toBe(
      'read-only',
    );
    expect(valueOf(codex.turn({ ...baseTurn, autonomy: 'medium' }).argv, '--sandbox')).toBe(
      'workspace-write',
    );
    for (const autonomy of ['low', 'medium', 'high'] as const) {
      const argv = codex.turn({ ...baseTurn, autonomy }).argv;
      expect(valueOf(argv, '--ask-for-approval')).toBe('never');
      // Turning the sandbox off would remove the only guardrail the CLI has.
      expect(argv).not.toContain('danger-full-access');
      expect(argv).not.toContain('--yolo');
    }
  });

  it('opens the network only at high autonomy', () => {
    expect(codex.turn({ ...baseTurn, autonomy: 'high' }).argv).toContain(
      'sandbox_workspace_write.network_access=true',
    );
    expect(codex.turn({ ...baseTurn, autonomy: 'medium' }).argv).not.toContain(
      'sandbox_workspace_write.network_access=true',
    );
  });

  it('puts resume before the flags, because it is a subcommand and not a flag', () => {
    const argv = codex.turn({ ...baseTurn, sessionId: 'thread-7' }).argv;
    expect(argv.slice(0, 3)).toEqual(['exec', 'resume', 'thread-7']);
  });

  it('quotes reasoning effort, which is parsed as toml', () => {
    expect(codex.turn({ ...baseTurn, reasoningEffort: 'high' }).argv).toContain(
      'model_reasoning_effort="high"',
    );
  });

  it('folds the jsonl event stream into one turn', () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"01999ce5-f229-7661"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"i1","type":"reasoning","text":"thinking"}}',
      '{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"the answer"}}',
      '{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":9}}',
    ].join('\n');
    const parsed = codex.parse({ stdout, stderr: '', code: 0 });
    expect(parsed).toMatchObject({
      text: 'the answer',
      sessionId: '01999ce5-f229-7661',
      isError: false,
    });
    expect(parsed?.usage).toMatchObject({
      inputTokens: 24763,
      cacheReadTokens: 24448,
      outputTokens: 122,
      thinkingTokens: 9,
    });
  });

  it('accepts the older item_type discriminator and assistant_message name', () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"t-1"}',
      '{"type":"item.completed","item":{"id":"i1","item_type":"assistant_message","text":"legacy shape"}}',
    ].join('\n');
    expect(codex.parse({ stdout, stderr: '', code: 0 })?.text).toBe('legacy shape');
  });

  it('surfaces a failed turn', () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"t-2"}',
      '{"type":"turn.failed","error":{"message":"sandbox denied the write"}}',
    ].join('\n');
    expect(codex.parse({ stdout, stderr: '', code: 1 })).toMatchObject({
      isError: true,
      text: 'sandbox denied the write',
    });
  });
});

describe('junie', () => {
  const junie = adapterFor('junie');

  it('scopes the run with --project and skips the update check', () => {
    const argv = junie.turn(baseTurn).argv;
    expect(valueOf(argv, '--project')).toBe('/tmp/wt');
    expect(valueOf(argv, '--output-format')).toBe('json-stream');
    expect(argv).toContain('--skip-update-check');
  });

  it('emits no autonomy flag, because Junie publishes none for headless use', () => {
    // Guessing a flag here would fail on builds that do not have it, so autonomy
    // is left to the allowlist and the doctor says so.
    const argv = junie.turn({ ...baseTurn, autonomy: 'high' }).argv;
    expect(argv).not.toContain('--brave');
    expect(argv.join(' ')).not.toContain('autonomy');
  });

  it('sums the per-model usage rows, since a turn can bill two models', () => {
    // Real json-stream output: the id is on the opening session line, and the
    // usage rows ride the result line under the misnamed errorCode key.
    const stdout = [
      JSON.stringify({
        type: 'session',
        timestamp: 1786076788625,
        sessionId: 'session-260807-002628-i9s8',
      }),
      JSON.stringify({
        type: 'step',
        timestamp: 1786076796849,
        name: 'Found "**/*" ',
        details: 'a.txt\n',
      }),
      JSON.stringify({
        type: 'result',
        timestamp: 1786076805204,
        result: 'fixed',
        changes: [],
        errorCode: [
          {
            model: 'a',
            calls: 1,
            cost: 0.003,
            inputTokens: 5476,
            cacheInputTokens: 2,
            cacheCreateTokens: 3,
            outputTokens: 126,
          },
          {
            model: 'b',
            calls: 1,
            cost: 0.001,
            inputTokens: 554,
            cacheInputTokens: 4,
            cacheCreateTokens: 5,
            outputTokens: 84,
          },
        ],
      }),
    ].join('\n');
    const parsed = junie.parse({ stdout, stderr: '', code: 0 });
    expect(parsed).toMatchObject({ text: 'fixed', sessionId: 'session-260807-002628-i9s8' });
    expect(parsed?.usage).toMatchObject({
      inputTokens: 6030,
      outputTokens: 210,
      cacheReadTokens: 6,
      cacheCreationTokens: 8,
    });
    expect(parsed?.usage?.factoryCredits).toBeCloseTo(0.004);
  });

  it('still reads the plain json format, which names the usage rows llmUsage', () => {
    const stdout = JSON.stringify({
      sessionId: 'session-260408-000616-51s5',
      taskName: 'Fix the tests',
      result: 'fixed',
      changes: [],
      llmUsage: [{ model: 'a', calls: 1, cost: 0.003, inputTokens: 10, outputTokens: 2 }],
    });
    const parsed = junie.parse({ stdout, stderr: '', code: 0 });
    expect(parsed).toMatchObject({ text: 'fixed', sessionId: 'session-260408-000616-51s5' });
    expect(parsed?.usage?.inputTokens).toBe(10);
  });

  it('reports usage as absent rather than as zero when Junie sent none', () => {
    const stdout = [
      JSON.stringify({ type: 'session', sessionId: 's' }),
      JSON.stringify({ type: 'result', result: 'ok', changes: [] }),
    ].join('\n');
    expect(junie.parse({ stdout, stderr: '', code: 0 })?.usage).toBeNull();
  });
});

describe('grok', () => {
  const grok = adapterFor('grok');

  it('maps autonomy onto a sandbox profile and stops it asking', () => {
    expect(valueOf(grok.turn({ ...baseTurn, autonomy: 'low' }).argv, '--sandbox')).toBe(
      'read-only',
    );
    expect(valueOf(grok.turn({ ...baseTurn, autonomy: 'medium' }).argv, '--sandbox')).toBe(
      'workspace',
    );
    expect(valueOf(grok.turn({ ...baseTurn, autonomy: 'high' }).argv, '--sandbox')).toBe('off');
    expect(grok.turn(baseTurn).argv).toContain('--always-approve');
  });

  it('carries the prompt as the value of -p', () => {
    const argv = grok.turn(baseTurn).argv;
    expect(valueOf(argv, '-p')).toBe('do the thing');
  });

  it('suppresses the update check and the fullscreen takeover, neither of which survives a pipe', () => {
    const argv = grok.turn(baseTurn).argv;
    expect(argv).toContain('--no-auto-update');
    expect(argv).toContain('--no-alt-screen');
  });

  it('resumes with -r', () => {
    expect(valueOf(grok.turn({ ...baseTurn, sessionId: 'grok-sess' }).argv, '-r')).toBe(
      'grok-sess',
    );
  });

  it('writes one allow or deny flag per tool', () => {
    const argv = grok.turn({
      ...baseTurn,
      restrictTools: ['read', 'bash'],
      disabledTools: ['webfetch'],
    }).argv;
    expect(argv.filter((a) => a === '--allow')).toHaveLength(2);
    expect(valueOf(argv, '--deny')).toBe('webfetch');
  });

  it('asks for the streaming format, which is where the transcript lives', () => {
    expect(valueOf(grok.turn(baseTurn).argv, '--output-format')).toBe('streaming-json');
  });

  it('folds the answer out of the text deltas and reads the end object', () => {
    // Real streaming-json output, captured from the CLI: thought and text are
    // per-token deltas, and one end object carries session, usage, and cost.
    const stdout = [
      JSON.stringify({ type: 'available_commands', tools: [], commands: [] }),
      JSON.stringify({ type: 'thought', data: 'The' }),
      JSON.stringify({ type: 'thought', data: ' user' }),
      JSON.stringify({ type: 'text', data: 'grok' }),
      JSON.stringify({ type: 'text', data: ' did it' }),
      JSON.stringify({
        type: 'end',
        stopReason: 'end_turn',
        sessionId: '0199a213-81c0-7800',
        usage: {
          input_tokens: 12,
          output_tokens: 3,
          cache_read_input_tokens: 1,
          reasoning_tokens: 2,
        },
        total_cost_usd: 0.01,
      }),
    ].join('\n');
    const parsed = grok.parse({ stdout, stderr: '', code: 0 });
    expect(parsed).toMatchObject({
      text: 'grok did it',
      sessionId: '0199a213-81c0-7800',
      isError: false,
    });
    expect(parsed?.usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 1,
      thinkingTokens: 2,
      factoryCredits: 0.01,
    });
  });

  it('reports usage as absent when the end object carries no token counts', () => {
    const stdout = [
      JSON.stringify({ type: 'text', data: 'ok' }),
      JSON.stringify({ type: 'end', stopReason: 'end_turn', sessionId: 's', usage: {} }),
    ].join('\n');
    expect(grok.parse({ stdout, stderr: '', code: 0 })?.usage).toBeNull();
  });

  it('treats the stderr line it prints on success as noise, not as an error', () => {
    expect(grok.noisyStderr?.test('ERROR worker quit: UnexpectedContentType')).toBe(true);
    expect(grok.noisyStderr?.test('fatal: could not read config')).toBe(false);
  });
});

/**
 * The stream normalisers, fed line by line exactly as the one-shot harness
 * feeds them. Every fixture is a line the real CLI printed (captured during
 * development), because a normaliser tested against a convenient shape parses
 * nothing at all.
 */
describe('stream normalisers', () => {
  it('every vendor exposes a stream factory', () => {
    for (const id of CLI_VENDOR_IDS) {
      expect(typeof adapterFor(id).stream).toBe('function');
    }
  });

  it('codex folds a command execution into a spanning bash row', () => {
    const normalise = adapterFor('codex').stream!();
    const started = normalise({
      type: 'item.started',
      item: { id: 'cmd-1', type: 'command_execution', command: 'bun test' },
    });
    expect(started).toEqual([
      {
        type: 'tool_call',
        toolUse: { type: 'tool_use', id: 'cmd-1', name: 'Execute', input: { command: 'bun test' } },
      },
    ]);
    const completed = normalise({
      type: 'item.completed',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: 'bun test',
        aggregated_output: '3 pass',
        exit_code: 0,
      },
    });
    // The completed side re-announces the call, so a build that only emits
    // completions still produces the span.
    expect(completed[0]).toMatchObject({ type: 'tool_call' });
    expect(completed[1]).toEqual({
      type: 'tool_result',
      toolUseId: 'cmd-1',
      content: '3 pass',
      isError: false,
    });
  });

  it('codex marks a non-zero exit as an errored result', () => {
    const normalise = adapterFor('codex').stream!();
    const completed = normalise({
      type: 'item.completed',
      item: {
        id: 'cmd-2',
        type: 'command_execution',
        command: 'bun test',
        aggregated_output: '1 fail',
        exit_code: 1,
      },
    });
    expect(completed[1]).toMatchObject({ isError: true });
  });

  it('codex folds reasoning and the answer into thinking and text', () => {
    const normalise = adapterFor('codex').stream!();
    expect(
      normalise({ type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'hmm' } }),
    ).toEqual([
      { type: 'thinking_text_delta', messageId: 'codex-r1', textDelta: 'hmm' },
      { type: 'thinking_text_complete', messageId: 'codex-r1' },
    ]);
    expect(
      normalise({
        type: 'item.completed',
        item: { id: 'm1', type: 'agent_message', text: 'done' },
      }),
    ).toEqual([
      { type: 'assistant_text_delta', messageId: 'codex-m1', blockIndex: 0, textDelta: 'done' },
      { type: 'assistant_text_complete', messageId: 'codex-m1', blockIndex: 0 },
    ]);
  });

  it('codex folds a file change into an edit span naming the touched paths', () => {
    const normalise = adapterFor('codex').stream!();
    const out = normalise({
      type: 'item.completed',
      item: { id: 'f1', type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }] },
    });
    expect(out[0]).toMatchObject({
      type: 'tool_call',
      toolUse: { name: 'Edit', input: { file_path: 'src/a.ts' } },
    });
    expect(out[1]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'f1',
      content: 'update src/a.ts',
    });
  });

  it('claude folds an assistant message block by block', () => {
    const normalise = adapterFor('claude').stream!();
    const out = normalise({
      type: 'assistant',
      message: {
        id: 'msg_1',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'let me think' },
          { type: 'text', text: 'the answer' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    });
    expect(out).toEqual([
      { type: 'thinking_text_delta', messageId: 'msg_1:0', textDelta: 'let me think' },
      { type: 'thinking_text_complete', messageId: 'msg_1:0' },
      { type: 'assistant_text_delta', messageId: 'msg_1', blockIndex: 1, textDelta: 'the answer' },
      { type: 'assistant_text_complete', messageId: 'msg_1', blockIndex: 1 },
      // Bash is renamed at the boundary so the shared folder labels it a command.
      {
        type: 'tool_call',
        toolUse: { type: 'tool_use', id: 'toolu_1', name: 'Execute', input: { command: 'ls' } },
      },
    ]);
  });

  it('claude folds tool results from user messages, string or block content', () => {
    const normalise = adapterFor('claude').stream!();
    expect(
      normalise({
        type: 'user',
        message: {
          id: 'u1',
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file list', is_error: false },
          ],
        },
      }),
    ).toEqual([
      { type: 'tool_result', toolUseId: 'toolu_1', content: 'file list', isError: false },
    ]);
    expect(
      normalise({
        type: 'user',
        message: {
          id: 'u2',
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_2',
              content: [{ type: 'text', text: 'boom' }],
              is_error: true,
            },
          ],
        },
      }),
    ).toEqual([{ type: 'tool_result', toolUseId: 'toolu_2', content: 'boom', isError: true }]);
  });

  it('claude ignores lines that are not conversation, like system and result', () => {
    const normalise = adapterFor('claude').stream!();
    expect(normalise({ type: 'system', subtype: 'init', session_id: 's' })).toEqual([]);
    expect(normalise({ type: 'result', subtype: 'success', result: 'x' })).toEqual([]);
  });

  it('grok segments thoughts and text around a tool call', () => {
    const normalise = adapterFor('grok').stream!();
    expect(normalise({ type: 'thought', data: 'The' })).toEqual([
      { type: 'thinking_text_delta', messageId: 'grok-thought-1', textDelta: 'The' },
    ]);
    // A text line closes the open thought block before opening the text block.
    expect(normalise({ type: 'text', data: 'ok' })).toEqual([
      { type: 'thinking_text_complete', messageId: 'grok-thought-1' },
      { type: 'assistant_text_delta', messageId: 'grok-text-2', blockIndex: 0, textDelta: 'ok' },
    ]);
    // A second thought segment is a new block, not a continuation of the first.
    const second = normalise({ type: 'thought', data: 'again' });
    expect(second[0]).toEqual({
      type: 'assistant_text_complete',
      messageId: 'grok-text-2',
      blockIndex: 0,
    });
    expect(second[1]).toEqual({
      type: 'thinking_text_delta',
      messageId: 'grok-thought-3',
      textDelta: 'again',
    });
  });

  it('grok folds a tool call and its terminal update into a span', () => {
    const normalise = adapterFor('grok').stream!();
    const call = normalise({
      type: 'tool_call',
      toolCallId: 'call-1',
      title: 'list_dir',
      status: 'pending',
      toolName: 'list_dir',
      rawInput: { target_directory: '.' },
    });
    expect(call).toEqual([
      {
        type: 'tool_call',
        toolUse: { type: 'tool_use', id: 'call-1', name: 'LS', input: { target_directory: '.' } },
      },
    ]);
    // A null status is a progress ping, not a result.
    expect(
      normalise({ type: 'tool_call_update', toolCallId: 'call-1', status: null, rawOutput: null }),
    ).toEqual([]);
    const done = normalise({
      type: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'completed',
      rawOutput: { type: 'ListDir', Content: { content: '- a.txt' } },
    });
    expect(done).toEqual([
      { type: 'tool_result', toolUseId: 'call-1', content: '- a.txt', isError: false },
    ]);
  });

  it('grok keeps two turns on one adapter independent', () => {
    const adapter = adapterFor('grok');
    const first = adapter.stream!();
    const second = adapter.stream!();
    first({ type: 'thought', data: 'turn one' });
    // The second turn's normaliser starts its own segment count.
    expect(second({ type: 'thought', data: 'turn two' })).toEqual([
      { type: 'thinking_text_delta', messageId: 'grok-thought-1', textDelta: 'turn two' },
    ]);
  });

  it('junie folds a step into a completed span and skips the TASK RESULT echo', () => {
    const normalise = adapterFor('junie').stream!();
    const out = normalise({
      type: 'step',
      timestamp: 1786076796849,
      name: 'Found "**/*" ',
      details: 'a.txt\nsrc/b.txt\n',
    });
    expect(out).toEqual([
      {
        type: 'tool_call',
        toolUse: {
          type: 'tool_use',
          id: 'junie-step-1786076796849',
          name: 'step',
          input: { summary: 'Found "**/*"' },
        },
      },
      {
        type: 'tool_result',
        toolUseId: 'junie-step-1786076796849',
        content: 'a.txt\nsrc/b.txt\n',
        isError: false,
      },
    ]);
    expect(
      normalise({ type: 'step', timestamp: 1, name: 'TASK RESULT', details: 'the answer' }),
    ).toEqual([]);
  });

  it('junie lands the result line as the assistant text', () => {
    const normalise = adapterFor('junie').stream!();
    expect(normalise({ type: 'result', result: 'all done' })).toEqual([
      {
        type: 'assistant_text_delta',
        messageId: 'junie-result',
        blockIndex: 0,
        textDelta: 'all done',
      },
      { type: 'assistant_text_complete', messageId: 'junie-result', blockIndex: 0 },
    ]);
    expect(normalise({ type: 'session', sessionId: 's' })).toEqual([]);
  });
});
