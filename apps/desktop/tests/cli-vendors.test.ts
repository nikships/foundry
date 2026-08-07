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
    expect(allAdapters().filter((a) => a.supportsRpc).map((a) => a.id)).toEqual(['droid']);
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
      expect(adapterFor(id).parse({ stdout: 'command not found', stderr: '', code: 127 })).toBeNull();
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
    expect(valueOf(droid.turn({ ...baseTurn, sessionId: 'sess-1' }).argv, '--session-id')).toBe('sess-1');
  });

  it('pairs reasoning effort with the model and drops both on inherit', () => {
    const withModel = droid.turn({ ...baseTurn, model: 'claude-opus-5', reasoningEffort: 'high' }).argv;
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
});

describe('claude code', () => {
  const claude = adapterFor('claude');

  it('maps autonomy onto a permission mode rather than onto a prompt', () => {
    expect(valueOf(claude.turn({ ...baseTurn, autonomy: 'low' }).argv, '--permission-mode')).toBe('default');
    expect(valueOf(claude.turn({ ...baseTurn, autonomy: 'medium' }).argv, '--permission-mode')).toBe('acceptEdits');
    expect(valueOf(claude.turn({ ...baseTurn, autonomy: 'high' }).argv, '--permission-mode')).toBe('bypassPermissions');
  });

  it('asks for print mode and json, the pair that makes a turn scriptable', () => {
    const argv = claude.turn(baseTurn).argv;
    expect(argv).toContain('-p');
    expect(valueOf(argv, '--output-format')).toBe('json');
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
    const argv = claude.turn({ ...baseTurn, restrictTools: ['Read', 'Edit'], disabledTools: ['WebFetch'] }).argv;
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
    const stdout = JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 'cc-2' });
    expect(claude.parse({ stdout, stderr: '', code: 1 })).toMatchObject({
      isError: true,
      reason: 'error_max_turns',
    });
  });
});

describe('codex', () => {
  const codex = adapterFor('codex');

  it('maps autonomy onto a sandbox and never asks for approval', () => {
    expect(valueOf(codex.turn({ ...baseTurn, autonomy: 'low' }).argv, '--sandbox')).toBe('read-only');
    expect(valueOf(codex.turn({ ...baseTurn, autonomy: 'medium' }).argv, '--sandbox')).toBe('workspace-write');
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
    expect(parsed).toMatchObject({ text: 'the answer', sessionId: '01999ce5-f229-7661', isError: false });
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
    expect(valueOf(argv, '--output-format')).toBe('json');
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
    const stdout = JSON.stringify({
      sessionId: 'session-260408-000616-51s5',
      taskName: 'Fix the tests',
      result: 'fixed',
      changes: [],
      llmUsage: [
        { model: 'a', calls: 1, cost: 0.003, inputTokens: 5476, cacheInputTokens: 2, cacheCreateTokens: 3, outputTokens: 126 },
        { model: 'b', calls: 1, cost: 0.001, inputTokens: 554, cacheInputTokens: 4, cacheCreateTokens: 5, outputTokens: 84 },
      ],
    });
    const parsed = junie.parse({ stdout, stderr: '', code: 0 });
    expect(parsed).toMatchObject({ text: 'fixed', sessionId: 'session-260408-000616-51s5' });
    expect(parsed?.usage).toMatchObject({
      inputTokens: 6030,
      outputTokens: 210,
      cacheReadTokens: 6,
      cacheCreationTokens: 8,
    });
    expect(parsed?.usage?.factoryCredits).toBeCloseTo(0.004);
  });

  it('reports usage as absent rather than as zero when Junie sent none', () => {
    const stdout = JSON.stringify({ sessionId: 's', result: 'ok' });
    expect(junie.parse({ stdout, stderr: '', code: 0 })?.usage).toBeNull();
  });
});

describe('grok', () => {
  const grok = adapterFor('grok');

  it('maps autonomy onto a sandbox profile and stops it asking', () => {
    expect(valueOf(grok.turn({ ...baseTurn, autonomy: 'low' }).argv, '--sandbox')).toBe('read-only');
    expect(valueOf(grok.turn({ ...baseTurn, autonomy: 'medium' }).argv, '--sandbox')).toBe('workspace');
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
    expect(valueOf(grok.turn({ ...baseTurn, sessionId: 'grok-sess' }).argv, '-r')).toBe('grok-sess');
  });

  it('writes one allow or deny flag per tool', () => {
    const argv = grok.turn({ ...baseTurn, restrictTools: ['read', 'bash'], disabledTools: ['webfetch'] }).argv;
    expect(argv.filter((a) => a === '--allow')).toHaveLength(2);
    expect(valueOf(argv, '--deny')).toBe('webfetch');
  });

  it('reads the result object', () => {
    const stdout = JSON.stringify({
      text: 'grok did it',
      stopReason: 'end_turn',
      sessionId: '0199a213-81c0-7800',
      usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 1, cost: 0.01 },
    });
    const parsed = grok.parse({ stdout, stderr: '', code: 0 });
    expect(parsed).toMatchObject({ text: 'grok did it', sessionId: '0199a213-81c0-7800', isError: false });
    expect(parsed?.usage).toMatchObject({ inputTokens: 12, outputTokens: 3, cacheReadTokens: 1 });
  });

  it('accepts snake_case token names too, since the schema is unpublished', () => {
    const stdout = JSON.stringify({ text: 'ok', usage: { input_tokens: 5, output_tokens: 1 } });
    expect(grok.parse({ stdout, stderr: '', code: 0 })?.usage).toMatchObject({
      inputTokens: 5,
      outputTokens: 1,
    });
  });

  it('reports usage as absent when the block carries no token names it knows', () => {
    const stdout = JSON.stringify({ text: 'ok', usage: { somethingElse: 3 } });
    expect(grok.parse({ stdout, stderr: '', code: 0 })?.usage).toBeNull();
  });

  it('treats the stderr line it prints on success as noise, not as an error', () => {
    expect(grok.noisyStderr?.test('ERROR worker quit: UnexpectedContentType')).toBe(true);
    expect(grok.noisyStderr?.test('fatal: could not read config')).toBe(false);
  });
});
