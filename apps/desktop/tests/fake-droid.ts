/**
 * Stand-in for `droid exec --input-format stream-jsonrpc`. Frames match the
 * real CLI (type discriminator, string ids, flat settings params) so the
 * adapter can be tested against protocol quirks that broke a naive client.
 *
 * The SDK validates every frame with the CLI's own zod schemas and drops
 * whatever fails, so this stub has to be schema-complete rather than merely
 * plausible: a `create_message` without timestamps or an `agent_turn_completed`
 * missing a token count is silently discarded and the turn hangs instead of
 * failing. The turn id is the sharpest edge — the SDK generates it, sends it as
 * `add_user_message.messageId`, and raises a ProtocolError if the completion
 * comes back without it.
 */

import { writeFileSync, chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type FakeScenario =
  | 'happy'
  | 'tool-calls'
  | 'bad-envelope-then-good'
  | 'die-on-first-turn'
  | 'reject-model'
  | 'ask-permission'
  | 'ask-user';

const SCRIPT = String.raw`
import { appendFileSync } from 'node:fs';

const V = { jsonrpc: '2.0', factoryApiVersion: '1.0.0', factoryProtocolVersion: '1.151.0' };
const scenario = process.env.FAKE_SCENARIO || 'happy';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const notify = (n, sessionId) =>
  out({ ...V, type: 'notification', method: 'droid.session_notification', params: { sessionId, notification: n } });
const reply = (id, result) => out({ ...V, type: 'response', id, result });
const fail = (id, code, message) => out({ ...V, type: 'response', id, error: { code, message } });

let sessionId = 'fake-session-1';
let settings = { modelId: 'gpt-fake-default', reasoningEffort: 'high', autonomyLevel: 'high' };
let turns = 0;
let buffer = '';
// The turn id the SDK minted for the in-flight turn; agent_turn_completed must
// echo it or the SDK raises a protocol error / ignores the completion.
let turnId = null;

// Every frame the client sends, appended for tests that assert on the wire
// rather than on an observable side effect.
const framesPath = process.env.FAKE_FRAMES || '';
const record = (msg) => {
  if (!framesPath) return;
  appendFileSync(framesPath, JSON.stringify(msg) + '\n');
};

/** Server requests awaiting the client's response, by frame id. */
const serverRequests = new Map();

/** A permission ask in the CLI's real shape: nested tool use + offered options. */
const execPermission = (command) => ({
  toolUses: [{
    toolUse: { type: 'tool_use', id: 'call-perm-1', name: 'Execute', input: { command } },
    confirmationType: 'exec',
    details: { type: 'exec', fullCommand: command, command },
  }],
  options: [
    { label: 'Yes', value: 'proceed_once' },
    { label: 'No', value: 'cancel' },
  ],
});

const EFFORTS = ['off', 'low', 'medium', 'high'];
const MODELS = [
  { id: 'gpt-fake-default', modelId: 'gpt-fake-default', modelProvider: 'openai', displayName: 'Fake Default', shortDisplayName: 'Default', supportedReasoningEfforts: EFFORTS, defaultReasoningEffort: 'high', isCustom: false },
  { id: 'fake-allowed', modelId: 'fake-allowed', modelProvider: 'anthropic', displayName: 'Fake Allowed', shortDisplayName: 'Allowed', supportedReasoningEfforts: EFFORTS, defaultReasoningEffort: 'medium', isCustom: false },
];
const USAGE = () => ({ inputTokens: 1000 + turns, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 900, thinkingTokens: 10, factoryCredits: 42 });

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    record(msg);
    // The client answers a server request with a response frame; only those two
    // shapes are legal, and the real CLI rejects anything else.
    if (msg.type === 'response' && typeof msg.id === 'string') {
      const pending = serverRequests.get(msg.id);
      if (pending) {
        serverRequests.delete(msg.id);
        pending(msg.result);
      }
      continue;
    }
    if (msg.type !== 'request' || typeof msg.id !== 'string') {
      out({ ...V, type: 'response', id: null, error: { code: -32700, message: 'Invalid JSON-RPC message' } });
      continue;
    }
    handle(msg);
  }
});

function handle(msg) {
  const { id, method, params = {} } = msg;
  if (method === 'droid.initialize_session' || method === 'droid.load_session') {
    if (params.sessionId) sessionId = params.sessionId;
    notify({ type: 'settings_updated', settings }, sessionId);
    reply(id, { sessionId, session: { messages: [] }, settings, availableModels: MODELS });
    return;
  }
  if (method === 'droid.update_session_settings') {
    if (params.modelId) settings = { ...settings, modelId: params.modelId };
    if (params.reasoningEffort) settings = { ...settings, reasoningEffort: params.reasoningEffort };
    notify({ type: 'settings_updated', requestId: id, settings }, sessionId);
    reply(id, {});
    return;
  }
  if (method === 'droid.get_context_stats') {
    reply(id, { used: 1234, remaining: 98766, limit: 100000, accuracy: 'estimated', updatedAt: '2026-08-09T00:00:00.000Z' });
    return;
  }
  if (method === 'droid.list_tools') {
    reply(id, { tools: [{ id: 'execute-cli', llmId: 'Execute', displayName: 'Execute', description: 'run a command', category: 'execute', defaultAllowed: true, currentlyAllowed: true }] });
    return;
  }
  if (method === 'droid.close_session') {
    reply(id, {});
    setTimeout(() => process.exit(0), 20);
    return;
  }
  if (method === 'droid.interrupt_session') {
    reply(id, {});
    return;
  }
  if (method === 'droid.add_user_message') {
    turnId = params.messageId;
    reply(id, {});
    runTurn(params.text || '');
    return;
  }
  reply(id, {});
}

function finalText(text) {
  const messageId = 'msg-' + Math.random().toString(36).slice(2, 8);
  for (const piece of text.match(/.{1,12}/gs) || []) {
    notify({ type: 'assistant_text_delta', messageId, blockIndex: 0, textDelta: piece }, sessionId);
  }
  notify({ type: 'assistant_text_complete', messageId, blockIndex: 0 }, sessionId);
  notify({ type: 'create_message', message: { id: messageId, role: 'assistant', content: [{ type: 'text', text }], createdAt: 1, updatedAt: 1 } }, sessionId);
}

function completeTurn() {
  const usage = USAGE();
  notify({ type: 'session_token_usage_changed', sessionId, tokenUsage: usage }, sessionId);
  notify({ type: 'droid_working_state_changed', newState: 'idle' }, sessionId);
  notify({ type: 'agent_turn_completed', reason: 'completed', turnId, tokenUsage: usage, cumulativeTokenUsage: usage }, sessionId);
}

function runTurn(_prompt) {
  turns++;
  notify({ type: 'droid_working_state_changed', newState: 'streaming_assistant_message' }, sessionId);

  if (scenario === 'die-on-first-turn' && turns === 1) {
    setTimeout(() => process.exit(7), 30);
    return;
  }

  // A model the org forbids is accepted by update_session_settings and only
  // fails once a turn runs on it, as an error notification rather than a throw.
  if (scenario === 'reject-model' && settings.modelId !== 'gpt-fake-default') {
    notify({ type: 'error', message: '400 {"detail":"Invalid model ID in request body","status":400,"title":"Bad Request"}', errorType: 'Error', timestamp: '2026-08-09T00:00:00.000Z' }, sessionId);
    notify({ type: 'agent_turn_completed', reason: 'error', turnId, tokenUsage: USAGE(), cumulativeTokenUsage: USAGE() }, sessionId);
    return;
  }

  if (scenario === 'tool-calls') {
    const callId = 'call_fake_' + turns;
    // First frame has empty input: arguments stream in on later frames.
    notify({ type: 'tool_call', toolUse: { type: 'tool_use', id: callId, name: 'Execute', input: {} } }, sessionId);
    notify({ type: 'tool_call', toolUse: { type: 'tool_use', id: callId, name: 'Execute', input: { command: 'bun test', summary: 'run tests' } } }, sessionId);
    notify({ type: 'tool_execution_phase_changed', toolUseId: callId, toolName: 'Execute', phase: 'executing' }, sessionId);
    notify({ type: 'tool_result', toolUseId: callId, messageId: 'm', content: 'ok\n[Process exited with code 0]', isError: false }, sessionId);
  }

  if (scenario === 'ask-permission' && turns === 1) {
    out({ ...V, type: 'request', id: 'srv-1', method: 'droid.request_permission', params: execPermission('rm -rf build') });
  }

  // The agent blocks on its own question, exactly like the real CLI: the turn
  // only completes once an answer comes back.
  if (scenario === 'ask-user' && turns === 1) {
    const id = 'srv-ask-1';
    serverRequests.set(id, (result) => {
      finalText(JSON.stringify({ status: 'success', summary: 'fake did the work', artifacts: [], notes_for_next_agent: JSON.stringify(result) }));
      completeTurn();
    });
    out({ ...V, type: 'request', id, method: 'droid.ask_user', params: { toolCallId: 'call-1', questions: [{ index: 0, topic: 'db', question: 'which database?', options: ['postgres', 'mysql'] }] } });
    return;
  }

  const bad = scenario === 'bad-envelope-then-good' && turns === 1;
  const text = bad
    ? 'I finished the work but I am going to explain it in prose instead of JSON.'
    : JSON.stringify({ status: 'success', summary: 'fake did the work', artifacts: [], notes_for_next_agent: 'nothing' });
  finalText(text);
  completeTurn();
}
`;

/** Writes an executable stand-in and returns its path. */
export function writeFakeDroid(): string {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-fake-droid-'));
  const js = join(dir, 'fake-droid.mjs');
  writeFileSync(js, SCRIPT);
  const bin = join(dir, 'droid');
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}
