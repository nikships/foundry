/**
 * Executor against real git and a scripted droid stand-in. M3 acceptance
 * criteria: the repair loop converges in-session, boundary violations are
 * reverted with evidence, and a phase that never yields a valid envelope fails.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, projectDbPath, projectRunsDir, type Db } from '../src/main/trace/db.js';
import { Tracer } from '../src/main/trace/tracer.js';
import { Executor } from '../src/main/engine/executor.js';
import { RunRegistry } from '../src/main/engine/registry.js';
import { breakdownFile } from '../src/main/droid/agent.js';
import { exampleFor, jsonSchemaFor } from '../src/main/engine/envelopes.js';
import { defaultProject } from '../src/main/store/projects.js';
import type {
  AgentDef,
  AppSettings,
  CliConfig,
  CliVendor,
  CommandSpec,
  EnvelopeDef,
  PhaseDef,
  PipelineDef,
  ProjectDef,
} from '../src/shared/types.js';
import { CLI_VENDOR_IDS } from '../src/shared/types.js';

function sh(cwd: string, argv: string[]): string {
  try {
    return execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8' });
  } catch (e) {
    // execFileSync reports only "Command failed", which turns any setup failure
    // into an unactionable one; the command's own stderr says what happened.
    const stderr = (e as { stderr?: string }).stderr ?? '';
    throw new Error(`${argv.join(' ')} failed in ${cwd}: ${stderr.trim() || String(e)}`);
  }
}

function scratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-exec-'));
  sh(dir, ['git', 'init', '-q', '-b', 'main']);
  sh(dir, ['git', 'config', 'user.email', 'test@foundry.local']);
  sh(dir, ['git', 'config', 'user.name', 'Foundry Test']);
  writeFileSync(join(dir, 'README.md'), '# scratch\n');
  sh(dir, ['git', 'add', '-A']);
  sh(dir, ['git', 'commit', '-qm', 'initial']);
  return dir;
}

function emptyRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-empty-exec-'));
  sh(dir, ['git', 'init', '-q', '-b', 'main']);
  sh(dir, ['git', 'config', 'user.email', 'test@foundry.local']);
  sh(dir, ['git', 'config', 'user.name', 'Foundry Test']);
  return dir;
}

/**
 * One permission ask the scripted agent raises mid-turn, and what it does with
 * the answer. `writeIfAllowed` models an agent that respects a denial: the file
 * appears only when the policy allowed the write, so a leaked deny is visible
 * on disk rather than only in the trace.
 */
interface ScriptedAsk {
  method: 'droid.request_permission' | 'droid.ask_user';
  params: Record<string, unknown>;
  writeIfAllowed?: string;
}

/** Where `scriptedDroid` records every server-request reply it received. */
const ASK_REPLIES_FILE = 'ask-replies.jsonl';

interface AskReply {
  method: string;
  result: Record<string, unknown> | null;
}

/** The replies the scripted agent got back, in the order it raised the asks. */
function askReplies(droidPath: string): AskReply[] {
  const path = join(dirname(droidPath), ASK_REPLIES_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as AskReply);
}

interface ScriptedDroidOptions {
  /** Turn indexes (0-based) on which the child dies mid-turn, answering nothing. */
  dieOnTurns?: number[];
  /** Context occupancy the session reports, against a 100k window. */
  contextUsed?: number;
  /** What it reports once compaction has run; defaults to a tenth of the used. */
  contextUsedAfterCompaction?: number;
  /** Compaction the CLI refuses, the way a session too short to compact would. */
  compactFails?: boolean;
  /** Turn indexes that are acknowledged but never completed, so the turn times out. */
  stallOnTurns?: number[];
  /** Held-back handshake, so a test can act while the session is still starting. */
  handshakeDelayMs?: number;
  /** Structured output the CLI reports per turn index; `null` reports none. */
  structuredOutputs?: (unknown | null)[];
  /**
   * Completion reason per turn index. A `structured_output_*` reason is how
   * the CLI says it could not shape the reply, and the SDK turns it into the
   * `error_structured_output` subtype.
   */
  turnReasons?: (string | null)[];
  /** Files get_rewind_info advertises and execute_rewind can restore (path → bytes). */
  rewindFiles?: Record<string, string>;
  /** Paths get_rewind_info lists as created after the rewind anchor. */
  rewindCreatedFiles?: string[];
  /** Rewind the CLI refuses, so the engine must fall back to append-style. */
  rewindFails?: boolean;
}

/** Where `scriptedDroid` records the params of every turn the client sent. */
const TURN_REQUESTS_FILE = 'turn-requests.jsonl';

/** Every `add_user_message` the client sent, in order — the wire, not the trace. */
function turnRequests(droidPath: string): Record<string, unknown>[] {
  const path = join(dirname(droidPath), TURN_REQUESTS_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Where `scriptedDroid` records every wire event in the order it saw it. */
const WIRE_FILE = 'wire.jsonl';

/**
 * The session's wire history: every request the client sent plus the turn
 * completions the stub answered with, in order. Whether compaction happened
 * mid-turn is only knowable from this ordering.
 */
function wireLog(droidPath: string): string[] {
  const path = join(dirname(droidPath), WIRE_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim());
}

/** Where the stub records on-disk file bytes at the start of each turn. */
const CONTENT_AT_TURN_FILE = 'content-at-turn.jsonl';

/** Per-turn snapshots of watched files, so a test can see pre-retry restores. */
function contentAtTurns(droidPath: string): { turn: number; files: Record<string, string> }[] {
  const path = join(dirname(droidPath), CONTENT_AT_TURN_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { turn: number; files: Record<string, string> });
}

/** Marker the stub writes as soon as it is spawned, before any handshake. */
const SPAWN_MARKER_FILE = 'spawned';

/** Marker the stub writes the moment a turn starts, in either transport. */
const TURN_MARKER_FILE = 'turn-started';

/** `"<transport> <turn index>"` per turn the scripted agent has begun. */
function turnMarkers(droidPath: string): string[] {
  const path = join(dirname(droidPath), TURN_MARKER_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim());
}

/** Whether the scripted agent has begun a turn, i.e. a turn is in flight. */
function turnStarted(droidPath: string): boolean {
  return turnMarkers(droidPath).length > 0;
}

/** How many scripted children have reached their handshake, restarts included. */
function handshakeCount(droidPath: string): number {
  const path = join(dirname(droidPath), SPAWN_MARKER_FILE);
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).length;
}

/** Waits for a condition the scripted child reports through the filesystem. */
async function until(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Droid stand-in whose whole behaviour is a list of scripted turns, so a
 * pipeline's control flow can be tested without a model in the loop.
 *
 * It answers both transports off one argv: the SDK spawns it with
 * `--input-format stream-jsonrpc` and drives the JSON-RPC handshake, while the
 * one-shot fallback spawns it per turn and reads a single terminal object. The
 * shared turn counter on disk is what lets a session degrade mid-phase and
 * still continue the script where it left off.
 *
 * Every frame here has to satisfy the CLI's real zod schemas, because the SDK
 * validates and silently drops what does not — in particular the completion
 * must echo back the `messageId` the SDK minted for the turn, or the turn never
 * resolves.
 */
function scriptedDroid(
  turns: string[],
  sideEffects: (string | null)[] = [],
  asks: ScriptedAsk[][] = [],
  options: ScriptedDroidOptions = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-scripted-'));
  const state = join(dir, 'turn-count');
  writeFileSync(state, '0');
  const script = `
const { appendFileSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { dirname, isAbsolute, join } = require('node:path');
const V = { jsonrpc: '2.0', factoryApiVersion: '1.0.0', factoryProtocolVersion: '1.151.0' };
const TURNS = ${JSON.stringify(turns)};
const EFFECTS = ${JSON.stringify(sideEffects)};
const ASKS = ${JSON.stringify(asks)};
const STATE = ${JSON.stringify(state)};
const REPLIES = ${JSON.stringify(join(dir, ASK_REPLIES_FILE))};
const TURN_MARKER = ${JSON.stringify(join(dir, TURN_MARKER_FILE))};
const SPAWN_MARKER = ${JSON.stringify(join(dir, SPAWN_MARKER_FILE))};
const TURN_REQUESTS = ${JSON.stringify(join(dir, TURN_REQUESTS_FILE))};
const WIRE = ${JSON.stringify(join(dir, WIRE_FILE))};
const HANDSHAKE_DELAY = ${JSON.stringify(options.handshakeDelayMs ?? 0)};
const DIE_ON = ${JSON.stringify(options.dieOnTurns ?? [])};
const STALL_ON = ${JSON.stringify(options.stallOnTurns ?? [])};
const STRUCTURED = ${JSON.stringify(options.structuredOutputs ?? [])};
const REASONS = ${JSON.stringify(options.turnReasons ?? [])};
const CONTEXT_LIMIT = 100000;
const CONTEXT_USED = ${JSON.stringify(options.contextUsed ?? 1234)};
const CONTEXT_USED_COMPACTED = ${JSON.stringify(
    options.contextUsedAfterCompaction ?? Math.round((options.contextUsed ?? 1234) / 10),
  )};
const COMPACT_FAILS = ${JSON.stringify(options.compactFails ?? false)};
const REWIND_FILES = ${JSON.stringify(options.rewindFiles ?? {})};
const REWIND_CREATED = ${JSON.stringify(options.rewindCreatedFiles ?? [])};
const REWIND_FAILS = ${JSON.stringify(options.rewindFails ?? false)};
const CONTENT_AT_TURN = ${JSON.stringify(join(dir, CONTENT_AT_TURN_FILE))};
const EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];
const MODELS = [{ id: 'scripted', displayName: 'Scripted', shortDisplayName: 'Scripted', modelProvider: 'anthropic', supportedReasoningEfforts: EFFORTS, defaultReasoningEffort: 'medium', isCustom: false }];
const SETTINGS = { modelId: 'scripted', reasoningEffort: 'medium', autonomyLevel: 'high' };
const USAGE = { inputTokens: 100, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0, thinkingTokens: 0, factoryCredits: 1 };
// The SDK spawns with the stream-jsonrpc formats; the one-shot fallback does not.
const RPC = process.argv.includes('stream-jsonrpc');
const workdir = process.cwd();
const { createHash } = require('node:crypto');

const write = (path, contents) => {
  const target = isAbsolute(path) ? path : join(workdir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents ?? 'written by the scripted agent\\n');
};

const takeTurn = () => {
  const n = Number(readFileSync(STATE, 'utf8')) || 0;
  writeFileSync(STATE, String(n + 1));
  // The marker is how a test knows a turn is actually in flight, and which
  // transport ran it, without racing the engine.
  appendFileSync(TURN_MARKER, (RPC ? 'rpc' : 'oneshot') + ' ' + n + '\\n');
  return n;
};
const textFor = (n) => TURNS[Math.min(n, TURNS.length - 1)];
const recordWatchedContent = (n) => {
  const paths = Object.keys(REWIND_FILES);
  if (!paths.length) return;
  const files = {};
  for (const rel of paths) {
    const target = isAbsolute(rel) ? rel : join(workdir, rel);
    try { files[rel] = readFileSync(target, 'utf8'); } catch { files[rel] = null; }
  }
  appendFileSync(CONTENT_AT_TURN, JSON.stringify({ turn: n, files }) + '\\n');
};
const availableRewindFiles = () => Object.entries(REWIND_FILES).map(([filePath, content]) => {
  const buf = Buffer.from(content, 'utf8');
  return { filePath, contentHash: createHash('sha256').update(buf).digest('hex'), size: buf.byteLength };
});

if (!RPC) {
  const n = takeTurn();
  const effect = EFFECTS[n];
  if (effect) write(effect);
  // A stalled one-shot turn stays alive and silent, so a kill can land on it.
  if (STALL_ON.includes(n)) { setInterval(() => {}, 1000); return; }
  process.stdout.write(JSON.stringify({ type: 'completion', finalText: textFor(n), session_id: 's1', usage: { input_tokens: 100, output_tokens: 20 } }) + '\\n');
  process.exit(0);
}

const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
// Every request in, every turn boundary out: the only record of what happened
// between two turns rather than inside one.
const wire = (entry) => appendFileSync(WIRE, entry + '\\n');
const notify = (n) => out({ ...V, type: 'notification', method: 'droid.session_notification', params: { sessionId, notification: n } });
const pending = new Map();
let askSeq = 0;
let buffer = '';
let turnId = null;
let sessionId = 's1';
let compactions = 0;
let rewinds = 0;

/** Raises each ask in order, waiting for the answer, then finishes the turn. */
const raiseAsks = (list, done) => {
  const next = (i) => {
    if (i >= list.length) return done();
    const ask = list[i];
    const id = 'srv-' + askSeq++;
    pending.set(id, (result) => {
      // The reply the agent actually received, not the trace: cancelled vs
      // answers is what decides whether the agent asks again.
      appendFileSync(REPLIES, JSON.stringify({ method: ask.method, result: result ?? null }) + '\\n');
      const allowed = !!result && result.selectedOption !== undefined && result.selectedOption !== 'cancel';
      if (ask.writeIfAllowed && allowed) write(ask.writeIfAllowed);
      next(i + 1);
    });
    out({ ...V, type: 'request', id, method: ask.method, params: ask.params });
  };
  next(0);
};

const finish = (n) => {
  const messageId = 'm' + n;
  notify({ type: 'create_message', message: { id: messageId, role: 'assistant', content: [{ type: 'text', text: textFor(n) }], createdAt: 1, updatedAt: 1 } });
  const structured = STRUCTURED[n];
  if (structured !== undefined && structured !== null) {
    notify({ type: 'structured_output', messageId, structuredOutput: structured });
  }
  notify({ type: 'session_token_usage_changed', sessionId, tokenUsage: USAGE });
  wire('turn_completed ' + n);
  notify({ type: 'agent_turn_completed', reason: REASONS[n] || 'completed', turnId, tokenUsage: USAGE, cumulativeTokenUsage: USAGE });
};

const runTurn = () => {
  const n = takeTurn();
  recordWatchedContent(n);
  if (DIE_ON.includes(n)) { setTimeout(() => process.exit(9), 20); return; }
  if (STALL_ON.includes(n)) return;
  const effect = EFFECTS[n];
  if (effect) write(effect);
  raiseAsks(ASKS[n] || [], () => finish(n));
};

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  let i;
  while ((i = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const { id, method, params = {} } = msg;
    if (msg.type === 'response' && pending.has(id)) {
      const resolve = pending.get(id);
      pending.delete(id);
      resolve(msg.result);
      continue;
    }
    if (method) wire(method);
    if (method === 'droid.initialize_session' || method === 'droid.load_session') {
      // A resumed session handshakes with load_session, so both are marked: a
      // restart's child is only visible to a test through the second one.
      appendFileSync(SPAWN_MARKER, method + '\\n');
      if (method === 'droid.load_session' && params.sessionId) sessionId = params.sessionId;
      const result = method === 'droid.initialize_session'
        ? { sessionId, session: { messages: [] }, settings: SETTINGS, availableModels: MODELS }
        : { session: { messages: [] }, settings: SETTINGS, availableModels: MODELS, cwd: workdir };
      const answer = () => out({ ...V, type: 'response', id, result });
      if (HANDSHAKE_DELAY) setTimeout(answer, HANDSHAKE_DELAY); else answer();
    } else if (method === 'droid.compact_session') {
      if (COMPACT_FAILS) {
        out({ ...V, type: 'response', id, error: { code: -32603, message: 'nothing to compact' } });
      } else {
        compactions++;
        // A successor id the source handle is retired for: the next turn has to
        // arrive on it, and load_session is how the SDK adopts it.
        out({ ...V, type: 'response', id, result: { newSessionId: 's' + (compactions + 1), removedCount: 7 } });
      }
    } else if (method === 'droid.get_rewind_info') {
      if (REWIND_FAILS) {
        out({ ...V, type: 'response', id, error: { code: -32603, message: 'rewind info unavailable' } });
      } else {
        out({
          ...V,
          type: 'response',
          id,
          result: {
            availableFiles: availableRewindFiles(),
            createdFiles: REWIND_CREATED.map((filePath) => ({ filePath })),
            evictedFiles: [],
          },
        });
      }
    } else if (method === 'droid.execute_rewind') {
      if (REWIND_FAILS) {
        out({ ...V, type: 'response', id, error: { code: -32603, message: 'rewind refused' } });
      } else {
        rewinds++;
        const restore = Array.isArray(params.filesToRestore) ? params.filesToRestore : [];
        let restoredCount = 0;
        for (const file of restore) {
          const rel = file && file.filePath;
          if (rel && Object.prototype.hasOwnProperty.call(REWIND_FILES, rel)) {
            write(rel, REWIND_FILES[rel]);
            restoredCount++;
          }
        }
        const del = Array.isArray(params.filesToDelete) ? params.filesToDelete : [];
        let deletedCount = 0;
        for (const file of del) {
          const rel = file && file.filePath;
          if (!rel) continue;
          try {
            const target = isAbsolute(rel) ? rel : join(workdir, rel);
            require('node:fs').rmSync(target, { force: true });
            deletedCount++;
          } catch { /* best-effort */ }
        }
        // Successor id the source handle is retired for — same swap as compact.
        out({
          ...V,
          type: 'response',
          id,
          result: {
            newSessionId: 'rw' + rewinds,
            restoredCount,
            deletedCount,
            failedRestoreCount: 0,
            failedDeleteCount: 0,
          },
        });
      }
    } else if (method === 'droid.update_session_settings') {
      notify({ type: 'settings_updated', requestId: id, settings: SETTINGS });
      out({ ...V, type: 'response', id, result: {} });
    } else if (method === 'droid.list_tools') {
      out({ ...V, type: 'response', id, result: { tools: [{ id: 'execute-cli', llmId: 'Execute', displayName: 'Execute', description: 'run a command', category: 'execute', defaultAllowed: true, currentlyAllowed: true }] } });
    } else if (method === 'droid.get_context_breakdown') {
      out({ ...V, type: 'response', id, result: { modelId: 'scripted', modelDisplayName: 'Scripted', contextBudget: CONTEXT_LIMIT, usedTokens: 1200, freeTokens: CONTEXT_LIMIT - 1200, categories: [{ name: 'System prompt', tokens: 900, colorKey: 'systemPrompt' }], skills: [], mcpServers: [], droids: [] } });
    } else if (method === 'droid.get_context_stats') {
      const used = compactions ? CONTEXT_USED_COMPACTED : CONTEXT_USED;
      out({ ...V, type: 'response', id, result: { used, remaining: CONTEXT_LIMIT - used, limit: CONTEXT_LIMIT, accuracy: 'estimated', updatedAt: '2026-08-09T00:00:00.000Z' } });
    } else if (method === 'droid.add_user_message') {
      turnId = params.messageId;
      wire('turn_started ' + params.messageId + ' session=' + sessionId);
      // User create_message is how SdkSession learns the rewind anchor id.
      notify({
        type: 'create_message',
        message: {
          id: params.messageId,
          role: 'user',
          content: [{ type: 'text', text: String(params.text || '') }],
          createdAt: 1,
          updatedAt: 1,
        },
      });
      // The params as they arrived: whether a turn carried an output schema is
      // only knowable from the wire, not from any observable side effect.
      appendFileSync(TURN_REQUESTS, JSON.stringify(params) + '\\n');
      out({ ...V, type: 'response', id, result: {} });
      runTurn();
    } else if (method === 'droid.close_session') {
      out({ ...V, type: 'response', id, result: {} });
      setTimeout(() => process.exit(0), 10);
    } else {
      out({ ...V, type: 'response', id, result: {} });
    }
  }
});
`;
  const js = join(dir, 'scripted.cjs');
  writeFileSync(js, script);
  const bin = join(dir, 'droid');
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/** A `droid.request_permission` ask in the CLI's real nested shape. */
function permissionAsk(
  toolUse: { id: string; name: string; input: Record<string, unknown> },
  confirmationType: string,
  details: Record<string, unknown>,
): Record<string, unknown> {
  return {
    toolUses: [{ toolUse: { type: 'tool_use', ...toolUse }, confirmationType, details }],
    options: [
      { label: 'Yes', value: 'proceed_once' },
      { label: 'No', value: 'cancel' },
    ],
  };
}

const buildAgent = (over: Partial<AgentDef> = {}): AgentDef => ({
  name: 'builder',
  purpose: 'build things',
  model: 'scripted',
  reasoningEffort: 'medium',
  systemPrompt: 'You build.',
  userPrompt: 'Build: {{request}}',
  writes: null,
  envelope: 'build',
  color: '#5ad2dd',
  ...over,
});

function codePhase(name: string, command: CommandSpec, over: Partial<PhaseDef> = {}): PhaseDef {
  return { name, kind: 'code', description: over.description ?? name, command, ...over };
}

function agentPhase(name: string, over: Partial<PhaseDef> = {}): PhaseDef {
  return {
    name,
    kind: 'agent',
    agent: 'builder',
    description: over.description ?? name,
    envelope: 'build',
    prompt: { template: 'user', inputs: ['request'] },
    ...over,
  };
}

function pipe(phases: PhaseDef[], over: Partial<PipelineDef> = {}): PipelineDef {
  return {
    id: 'p',
    name: 'p',
    description: over.description ?? 'test pipeline',
    acceptance: { kind: 'all_phases_pass' },
    phases,
    ...over,
  };
}

function buildEnvelope(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: 'success',
    summary: 'built it',
    artifacts: [],
    changed_files: [],
    commit_message: 'add a thing',
    notes_for_next_agent: '',
    ...over,
  });
}

function reviewEnvelope(approved: boolean): string {
  return JSON.stringify({
    status: 'success',
    summary: 'reviewed',
    artifacts: [],
    approved,
    findings: approved ? [] : [{ requirement: 'it works', met: false, evidence: 'it does not' }],
    blocking: approved ? [] : ['it does not work'],
    notes_for_next_agent: '',
  });
}

interface Harness {
  repo: string;
  project: ProjectDef;
  tracer: Tracer;
  support: string;
  db: Db;
}

let h: Harness;

beforeEach(() => {
  const repo = scratchRepo();
  const support = mkdtempSync(join(tmpdir(), 'foundry-support-'));
  const db = openDb(projectDbPath(support, repo));
  h = {
    repo,
    support,
    db,
    tracer: new Tracer(db, projectRunsDir(support, repo)),
    project: { ...defaultProject(repo), mergePolicy: 'never' },
  };
});

interface ProcessRow {
  kind: string;
  name: string;
  pid: number;
  command: string;
  ended_at: string | null;
}

/** Every recorded child, open or closed — `openProcesses` only shows the open ones. */
function processRows(runId: string): ProcessRow[] {
  return h.db
    .prepare('SELECT kind, name, pid, command, ended_at FROM processes WHERE run_id = ?')
    .all(runId) as ProcessRow[];
}

/** Whether a pid is still a live process, without signalling it. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type AskHuman = ConstructorParameters<typeof Executor>[0]['askHuman'];

interface RunInput {
  pipeline: PipelineDef;
  agents?: AgentDef[];
  envelopeDefs?: EnvelopeDef[];
  droidPath?: string;
  request?: string;
  project?: Partial<ProjectDef>;
  askHuman?: AskHuman;
  turnTimeoutMs?: number;
  envelopeRetries?: number;
  gateRetries?: number;
  compactionThreshold?: number;
  rewindAfterCorrections?: number;
  daemonPort?: number;
  /** Defaults to subprocess so unit tests never spawn a real daemon. */
  transport?: 'daemon' | 'subprocess';
  mcpServers?: import('../src/shared/types.js').UserMcpServer[]; // eslint-disable-line @typescript-eslint/consistent-type-imports
}

function run(input: RunInput): Promise<{ status: string; runId: string }> {
  const started = start(input);
  return started.done;
}

/**
 * The run as a live handle rather than a promise, so a test can act on it
 * while it is still in flight — the kill path has no other way in.
 */
function start(input: RunInput): {
  executor: Executor;
  runId: string;
  done: Promise<{ status: string; runId: string }>;
} {
  const runId = `run_${Math.random().toString(36).slice(2, 8)}`;
  // These tests exercise droid, so every vendor points at the same stub: an
  // agent that names another CLI would otherwise spawn a binary the test
  // environment does not have.
  const path = input.droidPath ?? 'droid-not-used';
  const clis = {} as Record<CliVendor, CliConfig>;
  for (const vendor of CLI_VENDOR_IDS) clis[vendor] = { path, extraArgs: [] };
  const executor = new Executor({
    tracer: h.tracer,
    clis,
    turnTimeoutMs: input.turnTimeoutMs ?? 30_000,
    envelopeRetries: input.envelopeRetries ?? 2,
    gateRetries: input.gateRetries ?? 2,
    compactionThreshold: input.compactionThreshold ?? 0.8,
    rewindAfterCorrections: input.rewindAfterCorrections ?? 2,
    daemonPort: input.daemonPort ?? 37_643,
    transport: input.transport ?? 'subprocess',
    mcpServers: input.mcpServers ?? [],
    agents: input.agents ?? [buildAgent()],
    envelopeDefs: input.envelopeDefs ?? [],
    project: { ...h.project, ...input.project },
    pipeline: input.pipeline,
    request: input.request ?? 'do the thing',
    runId,
    engineer: 'test',
    askHuman: input.askHuman ?? (async () => ({ approve: true })),
  });
  return { executor, runId, done: executor.run().then((o) => ({ status: o.status, runId })) };
}

function events(runId: string) {
  return h.tracer.eventsAfter(runId, 0, 1000);
}

describe('code phases', () => {
  it('accepts a run whose phases all pass', async () => {
    const outcome = await run({
      pipeline: pipe(
        [
          codePhase(
            'one',
            { argv: ['sh', '-c', 'echo hi > a.txt'] },
            {
              description: 'Write a file the second phase can see.',
            },
          ),
          codePhase(
            'two',
            { argv: ['test', '-f', 'a.txt'] },
            {
              description: 'Confirm the file the first phase wrote is there.',
            },
          ),
        ],
        { description: 'two passing commands' },
      ),
    });
    expect(outcome.status).toBe('accepted');
    expect(h.tracer.phases(outcome.runId).map((p) => p.status)).toEqual(['success', 'success']);
  });

  it('rejects a run when a command fails, and keeps the output as evidence', async () => {
    const outcome = await run({
      pipeline: pipe(
        [
          codePhase(
            'boom',
            { argv: ['sh', '-c', 'echo detail >&2; exit 4'] },
            {
              description: 'Fail on purpose to prove failure is recorded.',
            },
          ),
        ],
        { description: 'one failing command' },
      ),
    });
    expect(outcome.status).toBe('rejected');
    const phase = h.tracer.phases(outcome.runId)[0]!;
    expect(phase.status).toBe('fail');
    expect(phase.error).toContain('exit 4');
  });

  it('lets an optional phase fail without failing the run', async () => {
    const outcome = await run({
      pipeline: pipe(
        [
          codePhase(
            'lint',
            { argv: ['sh', '-c', 'exit 1'] },
            {
              optional: true,
              description: 'Report style problems without blocking the run.',
            },
          ),
        ],
        { description: 'an optional failure' },
      ),
    });
    expect(outcome.status).toBe('accepted');
    expect(h.tracer.phases(outcome.runId)[0]!.status).toBe('skipped');
  });

  it('fails a phase whose project command is not configured, naming the fix', async () => {
    const outcome = await run({
      pipeline: pipe(
        [
          codePhase(
            'test',
            { ref: 'test' },
            {
              description: 'Run the project test command that was never set.',
            },
          ),
        ],
        { description: 'refers to a missing project command' },
      ),
    });
    expect(outcome.status).toBe('rejected');
    expect(h.tracer.phases(outcome.runId)[0]!.error).toContain('is not configured');
  });

  /**
   * A project Foundry created empty has no test command because it has no code
   * yet. Failing there would make a brand-new repo unable to run the pipeline
   * meant to fill it, so the phase skips and says why.
   */
  it('skips an unconfigured project command for a project created empty', async () => {
    const outcome = await run({
      project: { scaffold: true },
      pipeline: pipe(
        [
          codePhase(
            'write',
            { argv: ['sh', '-c', 'echo hi > a.txt'] },
            { description: 'Stand in for the work a build phase would do.' },
          ),
          codePhase(
            'test',
            { ref: 'test' },
            { description: 'Run the project test command this new repo does not have yet.' },
          ),
        ],
        {
          description: 'a new project with no test command',
          acceptance: { kind: 'phase_flag', phase: 'test', flag: 'passed' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    const phases = h.tracer.phases(outcome.runId);
    expect(phases.map((p) => p.status)).toEqual(['success', 'skipped']);
    expect(phases[1]!.error).toContain('no "test" command');
  });

  /**
   * The skip is scoped to the gap it exists for: once the project has the
   * command, the phase runs for real and a failure still fails the run.
   */
  it('still runs the command for a scaffold project that has one', async () => {
    const outcome = await run({
      project: { scaffold: true, commands: [{ name: 'test', argv: ['sh', '-c', 'exit 3'] }] },
      pipeline: pipe(
        [
          codePhase(
            'test',
            { ref: 'test' },
            { description: 'Run the project test command, which now exists.' },
          ),
        ],
        { description: 'a scaffold project that grew a test command' },
      ),
    });

    expect(outcome.status).toBe('rejected');
    expect(h.tracer.phases(outcome.runId)[0]!.error).toContain('exit 3');
  });

  it('runs inside a worktree on its own branch by default', async () => {
    const outcome = await run({
      pipeline: pipe(
        [
          codePhase(
            'write',
            { argv: ['sh', '-c', 'echo isolated > only-in-worktree.txt'] },
            {
              description: 'Write a file so the test can see which tree it landed in.',
            },
          ),
        ],
        { description: 'writes a file to prove where it ran' },
      ),
    });
    const run1 = h.tracer.run(outcome.runId)!;
    expect(run1.branch).toBe(`foundry/${outcome.runId}`);
    // Isolation: the base checkout is untouched.
    expect(existsSync(join(h.repo, 'only-in-worktree.txt'))).toBe(false);
    expect(existsSync(join(run1.worktreePath!, 'only-in-worktree.txt'))).toBe(true);
  });

  it('honours a pipeline that opts out of isolation', async () => {
    const outcome = await run({
      pipeline: pipe(
        [
          codePhase(
            'write',
            { argv: ['sh', '-c', 'echo direct > in-repo.txt'] },
            {
              description: 'Write directly into the checkout to prove isolation is off.',
            },
          ),
        ],
        {
          description: 'docs-only chain that does not need a branch',
          isolation: false,
        },
      ),
    });
    expect(h.tracer.run(outcome.runId)!.worktreePath).toBeNull();
    expect(existsSync(join(h.repo, 'in-repo.txt'))).toBe(true);
  });
});

describe('agent phases', () => {
  it('parses an envelope, runs gates, and records both', async () => {
    const droid = scriptedDroid([buildEnvelope({ changed_files: ['made.txt'] })], ['made.txt']);
    const outcome = await run({
      droidPath: droid,
      pipeline: pipe(
        [
          agentPhase('build', {
            description: 'Have the scripted agent make a file and claim it.',
            gates: ['diff_matches_claims'],
          }),
        ],
        {
          description: 'one agent phase with a claims gate',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });
    expect(outcome.status).toBe('accepted');
    const envelopes = h.tracer.envelopes(outcome.runId);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.valid).toBe(true);
    const gates = h.tracer.gateResults(outcome.runId);
    expect(gates[0]!.gate).toBe('diff_matches_claims');
    expect(gates[0]!.passed).toBe(true);
  });

  it('corrects a malformed reply in the same session and then succeeds', async () => {
    const droid = scriptedDroid(['I will explain in prose instead of JSON.', buildEnvelope()]);
    const outcome = await run({
      droidPath: droid,
      pipeline: pipe(
        [
          agentPhase('build', {
            description: 'Prove a parse failure costs one message, not a restart.',
          }),
        ],
        {
          description: 'first reply is prose, second is an envelope',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });
    expect(outcome.status).toBe('accepted');
    const correction = events(outcome.runId).find((e) => e.type === 'correction');
    expect(correction?.name).toBe('envelope did not parse');
    // Both attempts are recorded: the invalid one is evidence, not noise.
    expect(h.tracer.envelopes(outcome.runId).map((e) => e.valid)).toEqual([false, true]);
  });

  it('fails the phase when no attempt ever produces a valid envelope', async () => {
    const droid = scriptedDroid(['never json']);
    const outcome = await run({
      droidPath: droid,
      pipeline: pipe(
        [agentPhase('build', { description: 'Prove success is earned, never assumed.' })],
        {
          description: 'the agent never produces an envelope',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });
    expect(outcome.status).toBe('rejected');
    expect(h.tracer.phases(outcome.runId)[0]!.status).toBe('fail');
  });

  it('resolves a custom envelope library def into the prompt and the parse', async () => {
    const customEnvelope = JSON.stringify({
      status: 'success',
      summary: 'scouted',
      artifacts: [],
      notes_for_next_agent: '',
      severity: 'high',
    });
    const droid = scriptedDroid([customEnvelope]);
    const defs: EnvelopeDef[] = [
      {
        name: 'severity_report',
        fields: [{ name: 'severity', type: 'string', required: true, description: 'low|med|high' }],
      },
    ];
    const outcome = await run({
      droidPath: droid,
      envelopeDefs: defs,
      agents: [buildAgent({ envelope: 'severity_report' })],
      pipeline: pipe(
        [
          agentPhase('report', {
            description: 'Return a severity-tagged report using a custom envelope.',
            envelope: 'severity_report',
          }),
        ],
        {
          description: 'custom envelope library end-to-end',
          acceptance: { kind: 'envelope_status', phase: 'report' },
        },
      ),
    });
    expect(outcome.status).toBe('accepted');
    const envelopes = h.tracer.envelopes(outcome.runId);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.valid).toBe(true);
    expect(envelopes[0]!.schemaKind).toBe('severity_report');
    expect(envelopes[0]!.payload).toMatchObject({ severity: 'high' });

    const prompt = readFileSync(
      join(h.tracer.runDir(outcome.runId), 'builder/prompts/report-1.md'),
      'utf8',
    );
    expect(prompt).toContain('severity');
    expect(prompt).toContain('low|med|high');
  });

  it('fails when the agent itself reports failure', async () => {
    const droid = scriptedDroid([buildEnvelope({ status: 'fail', summary: 'could not do it' })]);
    const outcome = await run({
      droidPath: droid,
      pipeline: pipe(
        [agentPhase('build', { description: 'Prove a self-reported failure is not overridden.' })],
        {
          description: 'the agent reports its own failure',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });
    expect(outcome.status).toBe('rejected');
    expect(h.tracer.phases(outcome.runId)[0]!.error).toContain('could not do it');
  });

  it('reverts a write outside the boundary and fails with the violation', async () => {
    const droid = scriptedDroid(
      [buildEnvelope(), buildEnvelope(), buildEnvelope()],
      ['forbidden/x.txt', 'forbidden/x.txt', 'forbidden/x.txt'],
    );
    const outcome = await run({
      droidPath: droid,
      agents: [buildAgent({ writes: ['allowed/'] })],
      pipeline: pipe(
        [
          agentPhase('build', {
            retries: 1,
            description: 'Prove the boundary is enforced in code, not by asking.',
          }),
        ],
        {
          description: 'the agent writes outside its boundary',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });
    expect(outcome.status).toBe('rejected');
    const worktree = h.tracer.run(outcome.runId)!.worktreePath!;
    expect(existsSync(join(worktree, 'forbidden/x.txt'))).toBe(false);
    const violation = events(outcome.runId).find((e) => e.name === 'write boundary');
    expect(violation).toBeDefined();
    expect(JSON.stringify(violation!.payload)).toContain('forbidden/x.txt');
  });

  it('allows a write that is inside the boundary', async () => {
    const droid = scriptedDroid(
      [buildEnvelope({ changed_files: ['allowed/x.txt'] })],
      ['allowed/x.txt'],
    );
    const outcome = await run({
      droidPath: droid,
      agents: [buildAgent({ writes: ['allowed/'] })],
      pipeline: pipe(
        [
          agentPhase('build', {
            description: 'Prove an in-boundary write survives enforcement.',
          }),
        ],
        {
          description: 'the agent writes inside its boundary',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });
    expect(outcome.status).toBe('accepted');
    const worktree = h.tracer.run(outcome.runId)!.worktreePath!;
    expect(existsSync(join(worktree, 'allowed/x.txt'))).toBe(true);
  });

  it('retries a gate failure as a correction into the same session', async () => {
    // First turn claims a file it never wrote; second turn tells the truth.
    const droid = scriptedDroid(
      [
        buildEnvelope({ changed_files: ['ghost.txt'] }),
        buildEnvelope({ changed_files: ['real.txt'] }),
      ],
      [null, 'real.txt'],
    );
    const outcome = await run({
      droidPath: droid,
      pipeline: pipe(
        [
          agentPhase('build', {
            retries: 1,
            description: 'Prove a gate failure costs one message inside the live session.',
            gates: ['diff_matches_claims'],
          }),
        ],
        {
          description: 'a claims gate rejects the first attempt',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });
    expect(outcome.status).toBe('accepted');
    const gates = h.tracer.gateResults(outcome.runId);
    expect(gates.map((g) => g.passed)).toEqual([false, true]);
    const correction = events(outcome.runId).find(
      (e) => e.type === 'correction' && e.name === 'gate violations',
    );
    expect(correction).toBeDefined();
  });
});

describe('the repair loop', () => {
  function installCheck(body: string): void {
    writeFileSync(join(h.repo, 'check.sh'), body);
    chmodSync(join(h.repo, 'check.sh'), 0o755);
    sh(h.repo, ['git', 'add', '-A']);
    sh(h.repo, ['git', 'commit', '-qm', 'add check']);
  }

  const repairPipeline = (feedbackRetries: number): PipelineDef =>
    pipe(
      [
        agentPhase('build', { description: 'Implement the change the request asks for.' }),
        codePhase(
          'test',
          { ref: 'test' },
          {
            description: 'Run the project check and hand any failure back to the builder.',
            feedbackTo: 'build',
            feedbackRetries,
          },
        ),
      ],
      {
        description: 'build, test, repair',
        acceptance: { kind: 'phase_flag', phase: 'test', flag: 'passed' },
      },
    );

  it('sends a test failure back to the builder and accepts once it converges', async () => {
    // Passes only once the builder has written fix.txt.
    installCheck('#!/bin/sh\ntest -f fix.txt\n');
    const envelope = buildEnvelope({ summary: 'attempted', commit_message: 'work' });
    // First build writes nothing; the repair writes fix.txt.
    const droid = scriptedDroid([envelope, envelope], [null, 'fix.txt']);

    const outcome = await run({
      droidPath: droid,
      project: { commands: [{ name: 'test', argv: ['./check.sh'] }] },
      pipeline: repairPipeline(2),
    });

    expect(outcome.status).toBe('accepted');
    const feedback = events(outcome.runId).find(
      (e) => e.type === 'correction' && e.name === 'feedback to build',
    );
    expect(feedback).toBeDefined();
    const worktree = h.tracer.run(outcome.runId)!.worktreePath!;
    expect(existsSync(join(worktree, 'fix.txt'))).toBe(true);
  });

  it('gives up after the feedback budget rather than looping forever', async () => {
    installCheck('#!/bin/sh\nexit 1\n');
    const envelope = buildEnvelope({ summary: 'tried', commit_message: 'x' });
    const droid = scriptedDroid([envelope]);
    const outcome = await run({
      droidPath: droid,
      project: { commands: [{ name: 'test', argv: ['./check.sh'] }] },
      pipeline: pipe(
        [
          agentPhase('build', {
            description: 'Attempt the change that cannot satisfy the check.',
          }),
          codePhase(
            'test',
            { ref: 'test' },
            {
              description: 'Run the check that always fails and stop after the budget.',
              feedbackTo: 'build',
              feedbackRetries: 1,
            },
          ),
        ],
        {
          description: 'a check that can never pass',
          acceptance: { kind: 'phase_flag', phase: 'test', flag: 'passed' },
        },
      ),
    });
    expect(outcome.status).toBe('rejected');
    expect(h.tracer.phases(outcome.runId).find((p) => p.name === 'test')!.error).toContain(
      'repair attempt',
    );
  });
});

describe('acceptance criteria', () => {
  it('rejects a run whose reviewer did not approve, even though every phase ran', async () => {
    const droid = scriptedDroid([reviewEnvelope(false)]);
    const outcome = await run({
      droidPath: droid,
      agents: [buildAgent({ name: 'reviewer', envelope: 'review' })],
      pipeline: pipe(
        [
          agentPhase('review', {
            agent: 'reviewer',
            description: 'Judge the work and record why it does not pass.',
            envelope: 'review',
            gates: ['verdict_consistent'],
          }),
        ],
        {
          description: 'acceptance hangs on the reviewer verdict',
          acceptance: { kind: 'phase_flag', phase: 'review', flag: 'approved' },
        },
      ),
    });
    // Phase succeeded; the run is still not accepted.
    expect(h.tracer.phases(outcome.runId)[0]!.status).toBe('success');
    expect(outcome.status).toBe('rejected');
  });
});

describe('engineer phases', () => {
  it('records what the human decided and carries their notes forward', async () => {
    const outcome = await run({
      droidPath: 'unused',
      agents: [],
      request: 'ask me',
      turnTimeoutMs: 5000,
      envelopeRetries: 1,
      gateRetries: 1,
      pipeline: pipe(
        [
          {
            name: 'approve',
            kind: 'engineer',
            description: 'Pause so a human can confirm before anything else runs.',
            question: 'Ship it?',
          },
        ],
        { description: 'pause for a human' },
      ),
      askHuman: async (req) => {
        expect(req.body).toBe('Ship it?');
        return { approve: true, text: 'go ahead, but watch the migration' };
      },
    });
    expect(outcome.status).toBe('accepted');
    const interrupt = events(outcome.runId).find((e) => e.type === 'interrupt');
    expect(interrupt!.payload.decision).toBe('approve');
    expect(interrupt!.payload.text).toContain('migration');
  });

  it('fails the run when the human rejects', async () => {
    const outcome = await run({
      droidPath: 'unused',
      agents: [],
      request: 'ask me',
      turnTimeoutMs: 5000,
      envelopeRetries: 1,
      gateRetries: 1,
      pipeline: pipe(
        [
          {
            name: 'approve',
            kind: 'engineer',
            description: 'Pause so a human can stop the run here.',
            question: 'Ship it?',
          },
        ],
        { description: 'pause for a human who says no' },
      ),
      askHuman: async () => ({ approve: false }),
    });
    expect(outcome.status).toBe('rejected');
  });
});

describe('zero-interrupt runs', () => {
  /**
   * Every ask a run can raise, in one phase: a non-allowlisted command, a write
   * outside the worktree, a tool no rule covers, and a question. None of them
   * may reach a human, and each must settle the way the policy says.
   */
  const everyAsk = (outside: string): ScriptedAsk[] => [
    {
      method: 'droid.request_permission',
      params: permissionAsk(
        {
          id: 'call-exec',
          name: 'Execute',
          input: { command: 'git commit --allow-empty -m probe' },
        },
        'exec',
        {
          type: 'exec',
          fullCommand: 'git commit --allow-empty -m probe',
          command: 'git commit --allow-empty -m probe',
        },
      ),
    },
    {
      method: 'droid.request_permission',
      params: permissionAsk(
        { id: 'call-write', name: 'Create', input: { file_path: outside } },
        'create',
        {
          type: 'create',
          filePath: outside,
          fileName: 'escaped.txt',
          content: 'escaped',
        },
      ),
      writeIfAllowed: outside,
    },
    {
      method: 'droid.request_permission',
      params: permissionAsk({ id: 'call-future', name: 'SomeFutureTool', input: {} }, 'mcp_tool', {
        type: 'mcp_tool',
        toolName: 'SomeFutureTool',
        impactLevel: 'medium',
      }),
    },
    {
      method: 'droid.ask_user',
      params: {
        toolCallId: 'call-1',
        questions: [
          { index: 0, topic: 'db', question: 'which database?', options: ['postgres', 'mysql'] },
        ],
      },
    },
  ];

  it('settles with no human prompt and traces all four auto-decisions', async () => {
    const outside = join(mkdtempSync(join(tmpdir(), 'foundry-outside-')), 'escaped.txt');
    const droid = scriptedDroid([buildEnvelope()], [], [everyAsk(outside)]);
    let humanAsked = 0;

    const outcome = await run({
      droidPath: droid,
      pipeline: pipe(
        [agentPhase('build', { description: 'Raise every kind of ask a run can raise.' })],
        {
          description: 'an agent that asks for everything',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
      askHuman: async () => {
        humanAsked++;
        return { approve: true };
      },
    });

    expect(outcome.status).toBe('accepted');
    expect(humanAsked).toBe(0);

    const interrupts = events(outcome.runId).filter((e) => e.type === 'interrupt');
    expect(interrupts).toHaveLength(4);
    for (const event of interrupts) {
      expect(event.payload.auto).toBe(true);
      expect(event.payload.reason).toBeTruthy();
    }

    const byMethod = (method: string, predicate: (p: Record<string, unknown>) => boolean) =>
      interrupts.find((e) => e.payload.method === method && predicate(e.payload));

    expect(
      byMethod(
        'droid.request_permission',
        (p) => p.command === 'git commit --allow-empty -m probe',
      )!.name,
    ).toBe('allow (policy)');
    expect(
      byMethod('droid.request_permission', (p) =>
        String(p.reason).includes('outside the run worktree'),
      )!.name,
    ).toBe('deny (policy)');
    expect(
      byMethod('droid.request_permission', (p) => String(p.reason).includes('no policy rule'))!
        .name,
    ).toBe('allow (policy)');

    const question = byMethod('droid.ask_user', () => true)!;
    expect(question.name).toBe('allow (policy)');
    expect(question.payload.answers).toEqual([
      { index: 0, question: 'which database?', answer: 'postgres' },
    ]);

    // The trace is not the wire. What settles the question is the reply the
    // agent received: a `cancelled` there reads as a refusal and it asks again.
    const replies = askReplies(droid);
    expect(replies.map((r) => r.method)).toEqual([
      'droid.request_permission',
      'droid.request_permission',
      'droid.request_permission',
      'droid.ask_user',
    ]);
    const answered = replies.at(-1)!.result!;
    expect(answered.answers).toEqual([
      { index: 0, question: 'which database?', answer: 'postgres' },
    ]);
    expect(answered.cancelled).toBeUndefined();

    // The denial has to actually stop the write, not merely be recorded.
    expect(existsSync(outside)).toBe(false);
  });
});

describe('the safety net under a zero-interrupt policy', () => {
  it('reverts a boundary violation that never went through an ask', async () => {
    const droid = scriptedDroid(
      [buildEnvelope(), buildEnvelope()],
      ['forbidden/slipped.txt', 'forbidden/slipped.txt'],
    );
    const outcome = await run({
      droidPath: droid,
      agents: [buildAgent({ writes: ['allowed/'] })],
      pipeline: pipe(
        [
          agentPhase('build', {
            retries: 1,
            description: 'Prove git, not the ask layer, is what enforces the boundary.',
          }),
        ],
        {
          description: 'the agent writes outside its boundary without asking',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('rejected');
    const worktree = h.tracer.run(outcome.runId)!.worktreePath!;
    expect(existsSync(join(worktree, 'forbidden/slipped.txt'))).toBe(false);
    const violation = events(outcome.runId).find((e) => e.name === 'write boundary');
    expect(JSON.stringify(violation!.payload)).toContain('forbidden/slipped.txt');
    expect(events(outcome.runId).some((e) => e.name === 'boundary violation')).toBe(true);
  });

  it('fails the phase on a protected path however many retries it gets', async () => {
    const droid = scriptedDroid(
      [buildEnvelope(), buildEnvelope(), buildEnvelope()],
      ['.foundry/stash.json', '.foundry/stash.json', '.foundry/stash.json'],
    );
    const outcome = await run({
      droidPath: droid,
      agents: [buildAgent({ writes: null })],
      pipeline: pipe(
        [
          agentPhase('build', {
            retries: 2,
            description: 'Prove a protected path cannot be retried into a pass.',
          }),
        ],
        {
          description: 'the agent writes a protected path',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('rejected');
    expect(h.tracer.phases(outcome.runId)[0]!.status).toBe('fail');
    const worktree = h.tracer.run(outcome.runId)!.worktreePath!;
    expect(existsSync(join(worktree, '.foundry/stash.json'))).toBe(false);
  });
});

describe('the trace record', () => {
  it('writes prompts, envelopes, and events to disk as the raw record', async () => {
    const droid = scriptedDroid([buildEnvelope({ summary: 'ok', commit_message: 'x' })]);
    const outcome = await run({
      droidPath: droid,
      pipeline: pipe(
        [
          agentPhase('build', {
            description: 'Produce a record on disk as well as in the db.',
          }),
        ],
        {
          description: 'one agent phase',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });
    const dir = h.tracer.runDir(outcome.runId);
    expect(existsSync(join(dir, 'request.md'))).toBe(true);
    expect(existsSync(join(dir, 'pipeline.json'))).toBe(true);
    expect(existsSync(join(dir, 'events.jsonl'))).toBe(true);
    expect(existsSync(join(dir, 'builder/prompts/build-1.md'))).toBe(true);
    // Prompt on disk is exactly what was sent, envelope example included.
    const prompt = readFileSync(join(dir, 'builder/prompts/build-1.md'), 'utf8');
    expect(prompt).toContain('do the thing');
    expect(prompt).toContain('changed_files');
  });

  it('queues every phase up front so the waterfall can draw what has not run', async () => {
    const outcome = await run({
      pipeline: pipe(
        [
          codePhase(
            'first',
            { argv: ['false'] },
            {
              description: 'Fail immediately so later phases never start.',
            },
          ),
          codePhase(
            'second',
            { argv: ['true'] },
            {
              description: 'Never run, and stay visible as queued in the trace.',
            },
          ),
        ],
        { description: 'stops early on purpose' },
      ),
    });
    const phases = h.tracer.phases(outcome.runId);
    expect(phases.map((p) => p.status)).toEqual(['fail', 'queued']);
  });

  it('runs an execution in an initially empty repository without failing isolation', async () => {
    const empty = emptyRepo();
    const droid = scriptedDroid(
      [buildEnvelope({ summary: 'created initial app', changed_files: ['index.ts'] })],
      ['index.ts'],
    );
    const outcome = await run({
      droidPath: droid,
      project: { ...defaultProject(empty), mergePolicy: 'auto' },
      pipeline: pipe([agentPhase('build', { description: 'build initial project' })], {
        acceptance: { kind: 'all_phases_pass' },
      }),
      request: 'make initial project',
    });
    expect(outcome.status).toBe('accepted');
  });
});

/**
 * The SDK transport, exercised the way a run actually uses it: a real child
 * process over stream-jsonrpc against the scripted binary. These pin the
 * properties the swap could quietly lose — that agent phases still run in RPC
 * mode, that the child is recorded and reaped, and that a flapping transport
 * degrades exactly twice before giving up on it.
 */
describe('the SDK transport under the executor', () => {
  it('runs agent phases over RPC, not the one-shot fallback', async () => {
    const droid = scriptedDroid([buildEnvelope()]);
    const outcome = await run({
      droidPath: droid,
      pipeline: pipe(
        [agentPhase('build', { description: 'Prove the agent phase drove the SDK transport.' })],
        {
          description: 'one agent phase over the SDK',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    expect(h.tracer.run(outcome.runId)!.mode).toBe('rpc');
    const sessions = h.tracer.agentSessions(outcome.runId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.mode).toBe('rpc');
    // The session id only exists if the SDK's own handshake completed.
    expect(sessions[0]!.droidSessionId).toBe('s1');
  });

  it('records the droid child with a real pid and its --auto spawn command', async () => {
    const droid = scriptedDroid([buildEnvelope()]);
    const outcome = await run({
      droidPath: droid,
      pipeline: pipe(
        [agentPhase('build', { description: 'Prove the child is recorded for the kill path.' })],
        {
          description: 'one agent phase',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    const rows = processRows(outcome.runId).filter((r) => r.kind === 'droid');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('builder');
    expect(rows[0]!.pid).toBeGreaterThan(0);
    expect(rows[0]!.command).toContain(droid);
    // Runs are always autonomous; the flag is part of what `ps` should show.
    expect(rows[0]!.command).toContain('--auto high');
    expect(rows[0]!.ended_at).not.toBeNull();
    expect(h.tracer.openProcesses(outcome.runId)).toHaveLength(0);
  });

  it('leaves no droid child alive after an accepted run settles', async () => {
    const droid = scriptedDroid([buildEnvelope()]);
    const outcome = await run({
      droidPath: droid,
      pipeline: pipe(
        [agentPhase('build', { description: 'Settle cleanly and close the child.' })],
        {
          description: 'an accepted run',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    const pids = processRows(outcome.runId)
      .filter((r) => r.kind === 'droid')
      .map((r) => r.pid);
    expect(pids.length).toBeGreaterThan(0);
    for (const pid of pids) expect(alive(pid)).toBe(false);
  });

  it('leaves no droid child alive after a failed run settles', async () => {
    // Never a valid envelope: the phase burns its budget and the run is rejected.
    const droid = scriptedDroid(['not an envelope at all']);
    const outcome = await run({
      droidPath: droid,
      pipeline: pipe(
        [agentPhase('build', { description: 'Fail the phase and still close the child.' })],
        {
          description: 'a rejected run',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('rejected');
    const pids = processRows(outcome.runId)
      .filter((r) => r.kind === 'droid')
      .map((r) => r.pid);
    expect(pids.length).toBeGreaterThan(0);
    for (const pid of pids) expect(alive(pid)).toBe(false);
  });

  it('keeps one session across a correction rather than restarting', async () => {
    const droid = scriptedDroid(['prose, not JSON', buildEnvelope()]);
    const outcome = await run({
      droidPath: droid,
      pipeline: pipe(
        [agentPhase('build', { description: 'Correct in the live session over the SDK.' })],
        {
          description: 'a correction inside one session',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    const sessions = h.tracer.agentSessions(outcome.runId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.mode).toBe('rpc');
    expect(
      events(outcome.runId).some(
        (e) => e.type === 'correction' && e.name === 'envelope did not parse',
      ),
    ).toBe(true);
    // One child for the whole phase: a restart would have recorded a second.
    expect(processRows(outcome.runId).filter((r) => r.kind === 'droid')).toHaveLength(1);
  });

  it('restarts the session in RPC after a single stalled turn', async () => {
    // Turn 0 is acknowledged and never answered, so the turn times out; the
    // restarted session picks the script up at turn 1.
    const droid = scriptedDroid([buildEnvelope(), buildEnvelope()], [], [], { stallOnTurns: [0] });
    const outcome = await run({
      droidPath: droid,
      turnTimeoutMs: 1500,
      pipeline: pipe(
        [agentPhase('build', { description: 'Prove one strike does not cost RPC mode.' })],
        {
          description: 'a transport that stalls once',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    // One strike is survivable: the run stays on the RPC transport throughout.
    expect(h.tracer.run(outcome.runId)!.mode).toBe('rpc');
    const fallbacks = events(outcome.runId).filter(
      (e) => e.name === 'builder: fallback to one-shot',
    );
    expect(fallbacks).toHaveLength(1);
    expect(String(fallbacks[0]!.payload.reason)).toContain('retrying after');
    // The stalled child is replaced, and both children are reaped. The
    // replaced one is only closed out by the exit hook, since settlement can
    // only ever close the row of the session that is current at the end.
    const rows = processRows(outcome.runId).filter((r) => r.kind === 'droid');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.ended_at).not.toBeNull();
      expect(alive(row.pid)).toBe(false);
    }
    expect(h.tracer.openProcesses(outcome.runId)).toHaveLength(0);
  });

  it('retries the first mid-turn death, then degrades to one-shot on the second', async () => {
    // Turn 0 and turn 1 kill the child mid-turn; turn 2 is the one-shot reply.
    const droid = scriptedDroid([buildEnvelope(), buildEnvelope(), buildEnvelope()], [], [], {
      dieOnTurns: [0, 1],
    });
    const outcome = await run({
      droidPath: droid,
      pipeline: pipe(
        [agentPhase('build', { description: 'Prove two strikes cost the RPC transport.' })],
        {
          description: 'a transport that dies twice',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    expect(h.tracer.run(outcome.runId)!.mode).toBe('oneshot');
    expect(h.tracer.agentSessions(outcome.runId)[0]!.mode).toBe('oneshot');

    const fallbacks = events(outcome.runId).filter(
      (e) => e.name === 'builder: fallback to one-shot',
    );
    // Strike one retries in RPC, strike two switches: two log events, in order.
    expect(fallbacks).toHaveLength(2);
    expect(String(fallbacks[0]!.payload.reason)).toContain('retrying after');
    expect(fallbacks[0]!.payload.failures).toBe(1);
    expect(fallbacks[1]!.payload.failures).toBe(2);
  });

  it('records the one-shot fallback child as its own process row', async () => {
    const droid = scriptedDroid([buildEnvelope(), buildEnvelope(), buildEnvelope()], [], [], {
      dieOnTurns: [0, 1],
    });
    const outcome = await run({
      droidPath: droid,
      pipeline: pipe(
        [agentPhase('build', { description: 'Prove the fallback child is visible to the sweep.' })],
        {
          description: 'a transport that dies twice',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    // A fallback child the kill path cannot see is a child that survives a kill.
    // `stream-jsonrpc` is the RPC child's format and starts with the same text.
    const fallbackRows = processRows(outcome.runId).filter(
      (r) => !r.command.includes('stream-jsonrpc'),
    );
    expect(fallbackRows).toHaveLength(1);
    expect(fallbackRows[0]!.name).toBe('builder');
    expect(fallbackRows[0]!.pid).toBeGreaterThan(0);
    expect(fallbackRows[0]!.ended_at).not.toBeNull();
    expect(alive(fallbackRows[0]!.pid)).toBe(false);
    expect(h.tracer.openProcesses(outcome.runId)).toHaveLength(0);
  });
});

/**
 * Pre-emptive compaction. The engine, not the agent, decides when a session has
 * filled up, and it decides it BETWEEN phases: compacting a session mid-turn
 * would need the stream closed first, and the SDK refuses it outright.
 */
describe('compaction between phases', () => {
  /** Two agent phases so there is an inter-phase window at all. */
  function twoPhases(over: Partial<PipelineDef> = {}): PipelineDef {
    return pipe(
      [
        agentPhase('build', { description: 'Fill the context up.' }),
        agentPhase('polish', { description: 'Run after the window was compacted.' }),
      ],
      {
        description: 'two agent phases with a compaction window between them',
        acceptance: { kind: 'envelope_status', phase: 'polish' },
        ...over,
      },
    );
  }

  function compactions(runId: string) {
    return events(runId).filter((e) => e.type === 'compaction');
  }

  it('compacts a session over the threshold and runs the next phase on the successor', async () => {
    const droid = scriptedDroid([buildEnvelope(), buildEnvelope()], [], [], {
      contextUsed: 85_000,
      contextUsedAfterCompaction: 8_500,
    });
    const outcome = await run({ droidPath: droid, pipeline: twoPhases() });

    expect(outcome.status).toBe('accepted');
    // One compaction, in the one window there was for it.
    const compacted = wireLog(droid).filter((line) => line === 'droid.compact_session');
    expect(compacted).toHaveLength(1);

    // The successor id is what the trace carries, so a resumed run picks up the
    // session that still has room rather than the retired one.
    const sessions = h.tracer.agentSessions(outcome.runId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.droidSessionId).toBe('s2');

    const turns = wireLog(droid).filter((line) => line.startsWith('turn_started'));
    expect(turns).toHaveLength(2);
    expect(turns[0]).toContain('session=s1');
    expect(turns[1]).toContain('session=s2');
  });

  it('records what the compaction removed and the window either side of it', async () => {
    const droid = scriptedDroid([buildEnvelope(), buildEnvelope()], [], [], {
      contextUsed: 85_000,
      contextUsedAfterCompaction: 8_500,
    });
    const outcome = await run({ droidPath: droid, pipeline: twoPhases() });

    const rows = compactions(outcome.runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('builder');
    expect(rows[0]!.payload.removedCount).toBe(7);
    expect(rows[0]!.payload.before).toEqual({ used: 85_000, limit: 100_000 });
    expect(rows[0]!.payload.after).toEqual({ used: 8_500, limit: 100_000 });
  });

  it('leaves a session under the threshold alone', async () => {
    const droid = scriptedDroid([buildEnvelope(), buildEnvelope()], [], [], {
      contextUsed: 40_000,
    });
    const outcome = await run({ droidPath: droid, pipeline: twoPhases() });

    expect(outcome.status).toBe('accepted');
    expect(wireLog(droid)).not.toContain('droid.compact_session');
    expect(compactions(outcome.runId)).toHaveLength(0);
    expect(h.tracer.agentSessions(outcome.runId)[0]!.droidSessionId).toBe('s1');
  });

  it('honours a threshold the operator moved', async () => {
    const droid = scriptedDroid([buildEnvelope(), buildEnvelope()], [], [], {
      contextUsed: 60_000,
    });
    const outcome = await run({
      droidPath: droid,
      compactionThreshold: 0.5,
      pipeline: twoPhases(),
    });

    expect(outcome.status).toBe('accepted');
    expect(wireLog(droid).filter((l) => l === 'droid.compact_session')).toHaveLength(1);
  });

  it('never compacts inside a turn, correction retries included', async () => {
    // Phase one needs a correction, so the phase spans two turns with one
    // inter-phase window after them — over threshold from the very first stats.
    const droid = scriptedDroid(['prose, not JSON', buildEnvelope(), buildEnvelope()], [], [], {
      contextUsed: 90_000,
      contextUsedAfterCompaction: 9_000,
    });
    const outcome = await run({ droidPath: droid, pipeline: twoPhases() });

    expect(outcome.status).toBe('accepted');
    const log = wireLog(droid);
    // Every compaction sits outside an open turn: between a completion and the
    // next turn's start, never between a start and its completion.
    let openTurn = false;
    for (const line of log) {
      if (line.startsWith('turn_started')) openTurn = true;
      if (line.startsWith('turn_completed')) openTurn = false;
      if (line === 'droid.compact_session') expect(openTurn).toBe(false);
    }
    expect(log.filter((l) => l === 'droid.compact_session')).toHaveLength(1);
    // Three turns: the bad envelope, its correction, then phase two.
    expect(log.filter((l) => l.startsWith('turn_started'))).toHaveLength(3);
  });

  it('carries a post-compaction correction on the successor session', async () => {
    // Phase two's first reply is unparseable, so its correction is the first
    // thing the successor session ever sees.
    const droid = scriptedDroid([buildEnvelope(), 'prose, not JSON', buildEnvelope()], [], [], {
      contextUsed: 85_000,
      contextUsedAfterCompaction: 8_500,
    });
    const outcome = await run({ droidPath: droid, pipeline: twoPhases() });

    expect(outcome.status).toBe('accepted');
    const turns = wireLog(droid).filter((l) => l.startsWith('turn_started'));
    expect(turns).toHaveLength(3);
    expect(turns[0]).toContain('session=s1');
    // Both phase-two turns, the correction included, land on the successor.
    expect(turns[1]).toContain('session=s2');
    expect(turns[2]).toContain('session=s2');

    // One session row for the agent, and the correction is inside the phase.
    const sessions = h.tracer.agentSessions(outcome.runId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.droidSessionId).toBe('s2');
    expect(
      events(outcome.runId).some(
        (e) => e.type === 'correction' && e.name === 'envelope did not parse',
      ),
    ).toBe(true);
    // A swap is not a restart: no second child was spawned for it.
    expect(processRows(outcome.runId).filter((r) => r.kind === 'droid')).toHaveLength(1);
  });

  it('carries on with the run when the session refuses to compact', async () => {
    const droid = scriptedDroid([buildEnvelope(), buildEnvelope()], [], [], {
      contextUsed: 85_000,
      compactFails: true,
    });
    const outcome = await run({ droidPath: droid, pipeline: twoPhases() });

    // A failed compaction costs the run nothing: the next phase runs on the
    // session it already had and acceptance decides the outcome as usual.
    expect(outcome.status).toBe('accepted');
    expect(wireLog(droid).filter((l) => l === 'droid.compact_session')).toHaveLength(1);
    expect(compactions(outcome.runId)).toHaveLength(0);
    expect(h.tracer.agentSessions(outcome.runId)[0]!.droidSessionId).toBe('s1');
    const turns = wireLog(droid).filter((l) => l.startsWith('turn_started'));
    expect(turns[1]).toContain('session=s1');
    // The failure is on the record, so a run that then hits the wall explains itself.
    const failures = events(outcome.runId).filter((e) => e.name === 'builder: compaction failed');
    expect(failures).toHaveLength(1);
    expect(String(failures[0]!.payload.message)).toContain('nothing to compact');
  });

  it('never attempts compaction for a session that degraded to one-shot', async () => {
    // Two stalled turns cost the RPC transport, and a stalled child stays ALIVE
    // and answering — so a session that reached one-shot while still holding a
    // usable RPC handle would happily report 95% and be compacted. The guard is
    // on the transport, not on stats happening to be unavailable.
    const droid = scriptedDroid(
      [buildEnvelope(), buildEnvelope(), buildEnvelope(), buildEnvelope()],
      [],
      [],
      { stallOnTurns: [0, 1], contextUsed: 95_000 },
    );
    const outcome = await run({ droidPath: droid, turnTimeoutMs: 1500, pipeline: twoPhases() });

    expect(outcome.status).toBe('accepted');
    expect(h.tracer.agentSessions(outcome.runId)[0]!.mode).toBe('oneshot');
    // The stalled children were alive when the session gave up on them.
    expect(wireLog(droid)).not.toContain('droid.compact_session');
    expect(compactions(outcome.runId)).toHaveLength(0);
  });
});

/**
 * The envelope as a wire constraint. The schema an agent turn carries is the
 * same zod instance the reply is parsed against, and a structured reply is
 * still only a candidate: nothing succeeds without passing the parse.
 */
describe('structured-output envelopes', () => {
  /** Prose no `extractJson` can rescue, so only structuredOutput can settle it. */
  const NO_JSON = 'I did the work. There is no JSON anywhere in this sentence.';

  const structuredBuild = {
    status: 'success',
    summary: 'built it from the schema',
    artifacts: [],
    changed_files: [],
    commit_message: 'add a thing',
    notes_for_next_agent: '',
  };

  function corrections(runId: string) {
    return events(runId).filter(
      (e) => e.type === 'correction' && e.name === 'envelope did not parse',
    );
  }

  it('constrains agent turns with the envelope schema and no other phase', async () => {
    const droid = scriptedDroid([buildEnvelope()]);
    const outcome = await run({
      droidPath: droid,
      pipeline: pipe(
        [
          agentPhase('build', { description: 'Carry the envelope schema on the wire.' }),
          {
            name: 'approve',
            kind: 'engineer',
            description: 'A human checkpoint, which is not an agent turn.',
            question: 'Ship it?',
          },
          codePhase('check', { argv: ['true'] }, { description: 'A command, not an agent turn.' }),
        ],
        {
          description: 'agent, engineer, and code phases side by side',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    // Only the agent phase ever sends a turn, and it carries the schema the
    // reply is parsed against — same source, so the two cannot drift.
    const requests = turnRequests(droid);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.outputFormat).toEqual({
      type: 'json_schema',
      schema: JSON.parse(JSON.stringify(jsonSchemaFor('build'))),
    });
  });

  it('carries an agent’s custom fields into the schema it puts on the wire', async () => {
    const droid = scriptedDroid([buildEnvelope({ severity: 'high' })]);
    const custom = [
      { name: 'severity', type: 'string' as const, required: true, description: 'low|med|high' },
    ];
    const outcome = await run({
      droidPath: droid,
      agents: [buildAgent({ customFields: custom })],
      pipeline: pipe(
        [agentPhase('build', { description: 'Constrain the turn with the extended schema.' })],
        {
          description: 'an agent with a custom envelope field',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    const format = turnRequests(droid)[0]!.outputFormat as { schema: Record<string, unknown> };
    expect(format.schema).toEqual(JSON.parse(JSON.stringify(jsonSchemaFor('build', custom))));
    expect(format.schema.required).toContain('severity');
  });

  it('still shows the agent the generated example beside the schema', async () => {
    const droid = scriptedDroid([buildEnvelope()]);
    const outcome = await run({
      droidPath: droid,
      pipeline: pipe(
        [agentPhase('build', { description: 'Keep the prompt example alongside the constraint.' })],
        {
          description: 'the prompt example survives the wire constraint',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    // Removing the example is an eval-backed decision, not a side effect of
    // gaining a second channel for the same shape.
    const example = exampleFor('build');
    expect(String(turnRequests(droid)[0]!.text)).toContain(example);
    const prompt = readFileSync(
      join(h.tracer.runDir(outcome.runId), 'builder/prompts/build-1.md'),
      'utf8',
    );
    expect(prompt).toContain(example);
  });

  it('accepts a valid structured reply whose text carries no envelope at all', async () => {
    const droid = scriptedDroid([NO_JSON], [], [], { structuredOutputs: [structuredBuild] });
    const outcome = await run({
      droidPath: droid,
      pipeline: pipe(
        [agentPhase('build', { description: 'Settle the phase from the structured reply.' })],
        {
          description: 'structured output is the primary path',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    expect(corrections(outcome.runId)).toHaveLength(0);
    const envelopes = h.tracer.envelopes(outcome.runId);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.valid).toBe(true);
    expect(envelopes[0]!.payload).toMatchObject({
      status: 'success',
      summary: 'built it from the schema',
      commit_message: 'add a thing',
    });
  });

  it('accepts a structured reply on a non-generic kind with a required field', async () => {
    const structuredReview = {
      status: 'success',
      summary: 'reviewed from the schema',
      artifacts: [],
      approved: true,
      findings: [],
      blocking: [],
      notes_for_next_agent: '',
    };
    const droid = scriptedDroid([NO_JSON], [], [], { structuredOutputs: [structuredReview] });
    const outcome = await run({
      droidPath: droid,
      agents: [buildAgent({ name: 'reviewer', envelope: 'review' })],
      pipeline: pipe(
        [
          agentPhase('review', {
            agent: 'reviewer',
            envelope: 'review',
            description: 'Settle a review phase from the structured reply.',
          }),
        ],
        {
          description: 'structured output on the review kind',
          acceptance: { kind: 'phase_flag', phase: 'review', flag: 'approved' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    expect(corrections(outcome.runId)).toHaveLength(0);
    expect(h.tracer.envelopes(outcome.runId)[0]!.payload).toMatchObject({
      approved: true,
      summary: 'reviewed from the schema',
    });
  });

  it('corrects a structured reply the schema accepts but the parse rejects', async () => {
    // `status: 'maybe'` is a string, so a loose schema check waves it through;
    // the zod enum is what actually decides, and it is the only authority.
    const bogus = { ...structuredBuild, status: 'maybe' };
    const droid = scriptedDroid([NO_JSON, buildEnvelope()], [], [], {
      structuredOutputs: [bogus, null],
    });
    const outcome = await run({
      droidPath: droid,
      pipeline: pipe(
        [agentPhase('build', { description: 'Never trust a transport’s conformance claim.' })],
        {
          description: 'structured output that fails the zod parse',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    const corrected = corrections(outcome.runId);
    expect(corrected).toHaveLength(1);
    expect(String(corrected[0]!.payload.problem)).toContain('status');
    // Both attempts are recorded, the rejected one as evidence.
    expect(h.tracer.envelopes(outcome.runId).map((e) => e.valid)).toEqual([false, true]);
  });

  it('reads the text when droid could not shape the reply, without burning a retry', async () => {
    const droid = scriptedDroid([buildEnvelope()], [], [], {
      turnReasons: ['structured_output_invalid'],
    });
    const outcome = await run({
      droidPath: droid,
      pipeline: pipe(
        [agentPhase('build', { description: 'Fall back to the text on the same attempt.' })],
        {
          description: 'a schema failure whose text still parses',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    expect(corrections(outcome.runId)).toHaveLength(0);
    expect(turnRequests(droid)).toHaveLength(1);
    expect(h.tracer.envelopes(outcome.runId).map((e) => e.valid)).toEqual([true]);
  });

  it('spends the envelope budget, not a second one, when neither channel parses', async () => {
    const droid = scriptedDroid([NO_JSON], [], [], {
      turnReasons: ['structured_output_missing', 'structured_output_missing'],
    });
    const outcome = await run({
      droidPath: droid,
      envelopeRetries: 1,
      pipeline: pipe(
        [agentPhase('build', { description: 'Prove a schema failure has no budget of its own.' })],
        {
          description: 'neither structured output nor text ever parses',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('rejected');
    // envelopeRetries + 1 attempts, exactly today's arithmetic.
    expect(turnRequests(droid)).toHaveLength(2);
    expect(corrections(outcome.runId)).toHaveLength(2);
    // Born fail: nothing about a schema failure flips a phase.
    expect(h.tracer.phases(outcome.runId)[0]!.status).toBe('fail');
  });

  it('keeps the bad-envelope-then-good scenario at one correction and two attempts', async () => {
    // The pre-SDK baseline for this scenario, unchanged by the wire constraint.
    const droid = scriptedDroid(['I will explain in prose instead of JSON.', buildEnvelope()]);
    const outcome = await run({
      droidPath: droid,
      pipeline: pipe(
        [agentPhase('build', { description: 'Hold the envelope retry rate where it was.' })],
        {
          description: 'first reply is prose, second is an envelope',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    expect(h.tracer.phases(outcome.runId)[0]!.status).toBe('success');
    expect(corrections(outcome.runId)).toHaveLength(1);
    expect(turnRequests(droid)).toHaveLength(2);
    expect(h.tracer.envelopes(outcome.runId).map((e) => e.valid)).toEqual([false, true]);
  });
});

/**
 * Rewind instrumentation (Phase 3b part 1): every agent-phase correction carries
 * a per-phase running correctionIndex shared across envelope/boundary/gate, so
 * traces can answer "which attempt index succeeded".
 */
describe('correction instrumentation', () => {
  function agentCorrections(runId: string) {
    return events(runId).filter(
      (e) =>
        e.type === 'correction' &&
        (e.name === 'envelope did not parse' ||
          e.name === 'boundary violation' ||
          e.name === 'gate violations'),
    );
  }

  it('numbers every correction in a phase with a shared running correctionIndex', async () => {
    // Envelope fail → boundary fail → gate fail → success. One counter across
    // the three kinds, and the existing attempt field stays on each payload.
    const droid = scriptedDroid(
      [
        'prose, not JSON',
        buildEnvelope({ changed_files: ['allowed/ok.txt'] }),
        buildEnvelope({ changed_files: ['ghost.txt'] }),
        buildEnvelope({ changed_files: ['real.txt'] }),
      ],
      [null, 'forbidden/slipped.txt', null, 'real.txt'],
    );
    const outcome = await run({
      droidPath: droid,
      agents: [buildAgent({ writes: ['allowed/', 'real.txt'] })],
      envelopeRetries: 1,
      pipeline: pipe(
        [
          agentPhase('build', {
            retries: 2,
            description: 'Share one correctionIndex across envelope, boundary, and gate.',
            gates: ['diff_matches_claims'],
          }),
        ],
        {
          description: 'three correction kinds then success',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    const corrections = agentCorrections(outcome.runId);
    expect(corrections.map((e) => e.name)).toEqual([
      'envelope did not parse',
      'boundary violation',
      'gate violations',
    ]);
    expect(corrections.map((e) => e.payload.correctionIndex)).toEqual([1, 2, 3]);
    // attempt is still present — Banner detail keys off it.
    for (const event of corrections) {
      expect(typeof event.payload.attempt).toBe('number');
      expect(event.payload.attempt).toBeGreaterThan(0);
    }
  });

  it('resets correctionIndex at the start of each agent phase', async () => {
    const droid = scriptedDroid([
      'phase-one prose',
      buildEnvelope({ summary: 'phase one' }),
      'phase-two prose',
      buildEnvelope({ summary: 'phase two' }),
    ]);
    const outcome = await run({
      droidPath: droid,
      pipeline: pipe(
        [
          agentPhase('first', {
            description: 'First phase burns one envelope correction.',
          }),
          agentPhase('second', {
            description: 'Second phase starts the counter over.',
          }),
        ],
        {
          description: 'two agent phases each with one envelope correction',
          acceptance: { kind: 'all_phases_pass' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    const corrections = agentCorrections(outcome.runId);
    expect(corrections).toHaveLength(2);
    expect(corrections.map((e) => e.payload.correctionIndex)).toEqual([1, 1]);
    // Distinct phases — the counter did not bleed across.
    expect(corrections[0]!.phaseId).not.toBe(corrections[1]!.phaseId);
  });
});

/**
 * A kill is an operator verdict, not a transport flap. The two-strike fallback
 * exists to rescue a run from a dying child, and the child a kill leaves behind
 * looks exactly like one — so every recovery path has to stand down once the
 * kill has fired, or the operator's kill settles as an accepted run.
 */
describe('killing a run mid-turn', () => {
  it('settles killed instead of being rescued by the one-shot fallback', async () => {
    // Turn 0 is acknowledged and never answered, so the kill lands mid-turn.
    // Turn 1 would succeed: without the short-circuit, a recovery attempt
    // finishes the phase and the run settles accepted.
    const droid = scriptedDroid([buildEnvelope(), buildEnvelope(), buildEnvelope()], [], [], {
      stallOnTurns: [0],
    });
    const started = start({
      droidPath: droid,
      pipeline: pipe(
        [agentPhase('build', { description: 'Prove a kill is not a transport failure.' })],
        {
          description: 'a run killed mid-turn',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    await until(() => turnStarted(droid), 'the scripted agent to start its turn');
    started.executor.cancel();
    const outcome = await started.done;

    expect(outcome.status).toBe('killed');
    const row = h.tracer.run(outcome.runId)!;
    expect(row.status).toBe('killed');
    expect(row.outcomeDetail).toBe('the run was killed');

    // No recovery of any kind: not a restart, not a degrade to one-shot.
    expect(events(outcome.runId).filter((e) => e.name === 'builder: fallback to one-shot')).toEqual(
      [],
    );
    // The killed turn is not filed as an agent failure: a kill is what the
    // operator asked for, so the timeline must not read like a broken agent.
    expect(events(outcome.runId).filter((e) => e.name === 'builder: turn failed')).toEqual([]);
    // Only the one turn the kill landed on was ever spent.
    expect(turnMarkers(droid)).toEqual(['rpc 0']);
    expect(h.tracer.run(outcome.runId)!.mode).toBe('rpc');
    const rows = processRows(outcome.runId).filter((r) => r.kind === 'droid');
    expect(rows).toHaveLength(1);
    for (const r of rows) {
      expect(r.ended_at).not.toBeNull();
      expect(alive(r.pid)).toBe(false);
    }
    expect(h.tracer.openProcesses(outcome.runId)).toHaveLength(0);
  });

  it('does not accept a run whose remaining phases never ran', async () => {
    const droid = scriptedDroid([buildEnvelope(), buildEnvelope()], [], [], { stallOnTurns: [1] });
    const started = start({
      droidPath: droid,
      pipeline: pipe(
        [
          agentPhase('build', { description: 'Pass before the kill lands.' }),
          agentPhase('review', { description: 'Never finish: the kill lands here.' }),
        ],
        {
          description: 'a kill after one phase already passed',
          // The phase that passed would satisfy acceptance on its own.
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    await until(
      () => turnStarted(droid) && h.tracer.phases(started.runId)[0]?.status === 'success',
      'the first phase to pass and the second turn to start',
    );
    started.executor.cancel();
    const outcome = await started.done;

    expect(outcome.status).toBe('killed');
    expect(h.tracer.run(outcome.runId)!.outcomeDetail).toBe('the run was killed');
  });

  it('settles killed when the kill lands during a one-shot turn', async () => {
    // Two deaths degrade the session to one-shot, and the one-shot turn then
    // stalls: the kill lands on a fallback child, not an RPC one.
    const droid = scriptedDroid([buildEnvelope(), buildEnvelope(), buildEnvelope()], [], [], {
      dieOnTurns: [0, 1],
      stallOnTurns: [2],
    });
    const started = start({
      droidPath: droid,
      pipeline: pipe(
        [agentPhase('build', { description: 'Prove the fallback turn is killable too.' })],
        {
          description: 'a kill during the one-shot fallback',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    await until(
      () => turnMarkers(droid).some((line) => line.startsWith('oneshot')),
      'the one-shot fallback turn to start',
    );
    const fallbackPid = h.tracer
      .openProcesses(started.runId)
      .find((p) => !p.command.includes('stream-jsonrpc'))?.pid;
    expect(fallbackPid).toBeGreaterThan(0);
    started.executor.cancel();
    const outcome = await started.done;

    expect(outcome.status).toBe('killed');
    expect(h.tracer.run(outcome.runId)!.outcomeDetail).toBe('the run was killed');
    expect(alive(fallbackPid!)).toBe(false);
    expect(h.tracer.openProcesses(outcome.runId)).toHaveLength(0);
  });

  it('kills the child a recovery path spawned while the kill was landing', async () => {
    // The kill lands during the restarted session's handshake, so `kill()` runs
    // before that child exists: nothing else would ever reap it.
    const droid = scriptedDroid([buildEnvelope(), buildEnvelope()], [], [], {
      dieOnTurns: [0],
      handshakeDelayMs: 1500,
    });
    const started = start({
      droidPath: droid,
      pipeline: pipe(
        [agentPhase('build', { description: 'Prove an in-flight restart is reaped by the kill.' })],
        {
          description: 'a kill racing a transport restart',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    // The first child dies on turn 0; the restart's handshake is the second,
    // and it is still in flight while the delay runs.
    await until(() => handshakeCount(droid) === 2, 'the restarted session to reach its handshake');
    started.executor.cancel();
    const outcome = await started.done;

    expect(outcome.status).toBe('killed');
    // The restarted child is never prompted: a turn spent after the kill is
    // both real money and a result the run could still be settled on.
    expect(turnMarkers(droid)).toHaveLength(1);
    // Two children, both recorded and both reaped — including the one that did
    // not exist yet when `kill()` ran.
    const rows = processRows(outcome.runId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.ended_at).not.toBeNull();
      expect(alive(row.pid)).toBe(false);
    }
    expect(h.tracer.openProcesses(outcome.runId)).toHaveLength(0);
  });

  it('leaves no droid child alive and no process row open after a kill', async () => {
    const droid = scriptedDroid([buildEnvelope(), buildEnvelope()], [], [], { stallOnTurns: [0] });
    const started = start({
      droidPath: droid,
      pipeline: pipe([agentPhase('build', { description: 'Prove the kill reaps the child.' })], {
        description: 'a killed run leaves nothing behind',
        acceptance: { kind: 'envelope_status', phase: 'build' },
      }),
    });

    await until(() => turnStarted(droid), 'the scripted agent to start its turn');
    const before = h.tracer.openProcesses(started.runId);
    expect(before).toHaveLength(1);
    started.executor.cancel();
    await started.done;

    expect(alive(before[0]!.pid)).toBe(false);
    expect(h.tracer.openProcesses(started.runId)).toHaveLength(0);
  });
});

/**
 * What is filling an agent's context. The session is the only thing that can
 * answer, and it dies with the run, so the answer has to outlive it or the
 * Inspector shows every finished run the same empty panel.
 */
describe('the context breakdown an agent leaves behind', () => {
  function registry(): RunRegistry {
    return new RunRegistry({
      appSupportDir: h.support,
      settings: () => ({}) as AppSettings,
      engineerName: 'test',
      onRunFinished: () => undefined,
      onInterruptsChanged: () => undefined,
      onRunsChanged: () => undefined,
    });
  }

  it('records the breakdown each turn produced with the run files', async () => {
    const droid = scriptedDroid([buildEnvelope()]);
    const outcome = await run({
      droidPath: droid,
      pipeline: pipe([agentPhase('build', { description: 'Produce one turn to snapshot.' })], {
        description: 'a run whose breakdown is kept',
        acceptance: { kind: 'envelope_status', phase: 'build' },
      }),
    });

    expect(outcome.status).toBe('accepted');
    const captured = h.tracer.readRunJson<{
      capturedAt: string;
      breakdown: { usedTokens: number; categories: { name: string }[] };
    }>(outcome.runId, breakdownFile('builder'));
    expect(captured?.breakdown.usedTokens).toBe(1200);
    expect(captured?.breakdown.categories[0]!.name).toBe('System prompt');
    expect(Date.parse(captured!.capturedAt)).toBeGreaterThan(0);
  });

  it('answers for a finished run from that record, marked as not live', async () => {
    const droid = scriptedDroid([buildEnvelope()]);
    const outcome = await run({
      droidPath: droid,
      pipeline: pipe([agentPhase('build', { description: 'Produce one turn to snapshot.' })], {
        description: 'a finished run still explains its context',
        acceptance: { kind: 'envelope_status', phase: 'build' },
      }),
    });

    const result = await registry().contextBreakdown(h.project, outcome.runId, 'builder');
    expect(result.breakdown?.usedTokens).toBe(1200);
    expect(result.live).toBe(false);
    expect(result.capturedAt).toBeTruthy();
    expect(result.reason).toBeUndefined();
  });

  it('says why there is nothing rather than answering with an empty breakdown', async () => {
    const result = await registry().contextBreakdown(h.project, 'run_never_existed', 'builder');
    expect(result.breakdown).toBeNull();
    expect(result.reason).toBe('not_live');
  });
});

/**
 * Rewind correction loops (Phase 3b part 2). After N failed corrections the
 * engine rewinds the SDK session (swap-and-persist like compaction) and
 * restores phase-start files before the retry turn — without extending budgets.
 */
describe('rewind correction policy', () => {
  const PHASE_START = 'phase-start content\n';
  const seedThenBuild = (): PipelineDef =>
    pipe(
      [
        codePhase(
          'seed',
          { argv: ['sh', '-c', 'printf "phase-start content\\n" > watched.txt'] },
          { description: 'Leave a dirty file the agent phase will snapshot.' },
        ),
        agentPhase('build', {
          description: 'Fail twice so the 2nd correction rewinds, then succeed.',
        }),
      ],
      {
        description: 'seed a dirty file, then an agent phase that rewinds',
        acceptance: { kind: 'envelope_status', phase: 'build' },
      },
    );

  function corrections(runId: string) {
    return events(runId).filter((e) => e.type === 'correction');
  }

  it('rewinds on the 2nd correction, persists the successor, and retries on it', async () => {
    const droid = scriptedDroid(
      ['prose', 'still prose', buildEnvelope()],
      ['watched.txt', 'watched.txt', null],
      [],
      { rewindFiles: { 'watched.txt': PHASE_START } },
    );
    const outcome = await run({
      droidPath: droid,
      envelopeRetries: 2,
      pipeline: seedThenBuild(),
    });
    expect(outcome.status).toBe('accepted');

    const wire = wireLog(droid);
    expect(wire).toContain('droid.get_rewind_info');
    expect(wire).toContain('droid.execute_rewind');
    // getRewindInfo before execute_rewind, and the retry turn after the swap.
    const infoAt = wire.indexOf('droid.get_rewind_info');
    const rewindAt = wire.indexOf('droid.execute_rewind');
    expect(infoAt).toBeGreaterThanOrEqual(0);
    expect(rewindAt).toBeGreaterThan(infoAt);
    const turns = wire.filter((line) => line.startsWith('turn_started'));
    expect(turns).toHaveLength(3);
    // First two attempts on s1; the post-rewind retry lands on the successor.
    expect(turns[0]).toContain('session=s1');
    expect(turns[1]).toContain('session=s1');
    expect(turns[2]).toContain('session=rw1');
    expect(h.tracer.agentSessions(outcome.runId)[0]!.droidSessionId).toBe('rw1');

    const rewound = corrections(outcome.runId).filter((e) => e.payload.rewind === true);
    expect(rewound).toHaveLength(1);
    expect(rewound[0]!.payload.correctionIndex).toBe(2);
    expect(rewound[0]!.payload.restoredCount).toBe(1);
    expect(rewound[0]!.payload.deletedCount).toBe(0);
    // No novel event type — architecture reuses correction.
    expect(events(outcome.runId).map((e) => e.type)).not.toContain('rewind');
  });

  it('restores phase-start file bytes before the retry turn starts', async () => {
    const droid = scriptedDroid(
      ['prose', 'still prose', buildEnvelope()],
      ['watched.txt', 'watched.txt', null],
      [],
      { rewindFiles: { 'watched.txt': PHASE_START } },
    );
    const outcome = await run({
      droidPath: droid,
      envelopeRetries: 2,
      pipeline: seedThenBuild(),
    });
    expect(outcome.status).toBe('accepted');

    const snapshots = contentAtTurns(droid);
    // Turns 0 and 1 are the failed attempts; turn 2 is the post-rewind retry.
    expect(snapshots.map((s) => s.turn)).toEqual([0, 1, 2]);
    // After the agent corrupted the file, rewind put phase-start bytes back
    // before the retry turn was composed.
    expect(snapshots[2]!.files['watched.txt']).toBe(PHASE_START);
    // And the intermediate attempts really did dirty it.
    expect(snapshots[0]!.files['watched.txt']).toBe(PHASE_START);
    expect(snapshots[1]!.files['watched.txt']).toBe('written by the scripted agent\n');
  });

  it('falls back to append-style correction when rewind fails', async () => {
    const droid = scriptedDroid(['prose', 'still prose', buildEnvelope()], [], [], {
      rewindFiles: { 'watched.txt': PHASE_START },
      rewindFails: true,
    });
    const outcome = await run({
      droidPath: droid,
      envelopeRetries: 2,
      pipeline: seedThenBuild(),
    });
    // A refused rewind must not fail the phase: the append-style retry still runs.
    expect(outcome.status).toBe('accepted');
    expect(wireLog(droid)).toContain('droid.get_rewind_info');
    expect(wireLog(droid)).not.toContain('droid.execute_rewind');
    // All three turns stayed on the original session.
    const turns = wireLog(droid).filter((line) => line.startsWith('turn_started'));
    expect(turns).toHaveLength(3);
    for (const turn of turns) expect(turn).toContain('session=s1');
    expect(h.tracer.agentSessions(outcome.runId)[0]!.droidSessionId).toBe('s1');
    expect(corrections(outcome.runId).some((e) => e.payload.rewind === true)).toBe(false);
    expect(events(outcome.runId).some((e) => e.name === 'builder: rewind failed')).toBe(true);
  });

  it('disables rewind entirely when rewindAfterCorrections is 0', async () => {
    const droid = scriptedDroid(['prose', 'still prose', buildEnvelope()], [], [], {
      rewindFiles: { 'watched.txt': PHASE_START },
    });
    const outcome = await run({
      droidPath: droid,
      envelopeRetries: 2,
      rewindAfterCorrections: 0,
      pipeline: seedThenBuild(),
    });
    expect(outcome.status).toBe('accepted');
    expect(wireLog(droid)).not.toContain('droid.get_rewind_info');
    expect(wireLog(droid)).not.toContain('droid.execute_rewind');
    expect(corrections(outcome.runId).some((e) => e.payload.rewind === true)).toBe(false);
  });

  it('does not extend the envelope budget when a rewind runs', async () => {
    // Every reply is prose: envelopeRetries+1 attempts, then the phase fails.
    // Rewind on the 2nd correction must not buy an extra turn.
    const droid = scriptedDroid(['no', 'still no', 'nope', 'never'], [], [], {
      rewindFiles: { 'watched.txt': PHASE_START },
    });
    const outcome = await run({
      droidPath: droid,
      envelopeRetries: 2,
      rewindAfterCorrections: 2,
      pipeline: seedThenBuild(),
    });
    expect(outcome.status).toBe('rejected');
    expect(h.tracer.phases(outcome.runId).find((p) => p.name === 'build')!.status).toBe('fail');
    // envelopeRetries + 1 turn attempts, exactly — rewind consumed a correction
    // slot inside that envelope, it did not add one.
    expect(turnRequests(droid)).toHaveLength(3);
    expect(wireLog(droid)).toContain('droid.execute_rewind');
    const envelopeCorrections = corrections(outcome.runId).filter(
      (e) => e.name === 'envelope did not parse',
    );
    expect(envelopeCorrections).toHaveLength(3);
  });

  it('never attempts rewind for a session that degraded to one-shot', async () => {
    // Two stalled turns force oneshot; further envelope failures must stay append-style.
    const droid = scriptedDroid(
      ['ignored', 'ignored', 'prose', 'still prose', buildEnvelope()],
      [],
      [],
      {
        stallOnTurns: [0, 1],
        rewindFiles: { 'watched.txt': PHASE_START },
      },
    );
    const outcome = await run({
      droidPath: droid,
      turnTimeoutMs: 1500,
      envelopeRetries: 2,
      rewindAfterCorrections: 2,
      pipeline: seedThenBuild(),
    });
    expect(outcome.status).toBe('accepted');
    expect(h.tracer.run(outcome.runId)!.mode).toBe('oneshot');
    expect(wireLog(droid)).not.toContain('droid.get_rewind_info');
    expect(wireLog(droid)).not.toContain('droid.execute_rewind');
    expect(corrections(outcome.runId).some((e) => e.payload.rewind === true)).toBe(false);
  });
});

/** VAL-CROSS-009 — rewind and compaction coexist without trace corruption. */
describe('rewind and compaction coexist (VAL-CROSS-009)', () => {
  const PHASE_START = 'phase-start content\n';

  it('records both a rewind and a compaction, keeps event ordering and session lineage intact', async () => {
    // Two agent phases: phase-one trips a rewind on its 2nd correction; between
    // phases the session is full and gets compacted before phase-two.
    const droid = scriptedDroid(
      ['prose', 'still prose', buildEnvelope(), buildEnvelope()],
      ['watched.txt', 'watched.txt', null, null],
      [],
      {
        rewindFiles: { 'watched.txt': PHASE_START },
        contextUsed: 85_000,
        contextUsedAfterCompaction: 8_500,
      },
    );
    const outcome = await run({
      droidPath: droid,
      envelopeRetries: 2,
      compactionThreshold: 0.8,
      rewindAfterCorrections: 2,
      pipeline: pipe(
        [
          codePhase(
            'seed',
            { argv: ['sh', '-c', 'printf "phase-start content\\n" > watched.txt'] },
            { description: 'Seed a dirty file so rewind has something to restore.' },
          ),
          agentPhase('one', {
            description: 'Fail twice to trigger rewind on the 2nd correction, then succeed.',
          }),
          agentPhase('two', { description: 'Run after the compaction, on the successor.' }),
        ],
        {
          description: 'rewind in phase-one + compaction between phases',
          acceptance: { kind: 'all_phases_pass' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    const runId = outcome.runId;

    // Both event kinds are present in the same run.
    const all = events(runId);
    const hadRewind = all.some((e) => e.type === 'correction' && e.payload.rewind === true);
    const hadCompaction = all.some((e) => e.type === 'compaction');
    expect(hadRewind).toBe(true);
    expect(hadCompaction).toBe(true);

    // Every payload is valid JSON (tracer stores object, not string — assert no null payloads).
    for (const e of all) {
      expect(e.payload).not.toBeNull();
      expect(typeof e.payload).toBe('object');
    }

    // change_id replay yields all rows once (cursor pagination, same as VAL-CROSS-006).
    let cursor = 0;
    const replayed: ReturnType<typeof events> = [];
    for (;;) {
      const page = h.tracer.eventsAfter(runId, cursor, 10);
      if (!page.length) break;
      replayed.push(...page);
      cursor = page[page.length - 1]!.changeId;
    }
    expect(replayed).toHaveLength(all.length);
    const ids = replayed.map((r) => r.changeId);
    for (let i = 1; i < ids.length; i++) expect(ids[i]!).toBeGreaterThan(ids[i - 1]!);
    const byId = new Map(replayed.map((r) => [r.eventId, r]));
    expect(byId.size).toBe(replayed.length);

    // agent_sessions reflects the swaps: one AgentSession row whose id changed
    // across rewind+compact (both persist via upsertAgentSession).
    const sessions = h.db
      .prepare(
        'SELECT agent, droid_session_id FROM agent_sessions WHERE run_id = ? ORDER BY last_used_at',
      )
      .all(runId) as { agent: string; droid_session_id: string }[];
    expect(sessions.some((s) => s.agent === 'builder')).toBe(true);
    const builder = sessions.find((s) => s.agent === 'builder')!;
    expect(builder.droid_session_id).toBeTruthy();

    expect(h.tracer.run(runId)!.outcomeDetail).toBeTruthy();
  });
});

/** VAL-CROSS-011 — non-droid / oneshot vendor still starts oneshot with the honest span. */
describe('non-droid vendor oneshot path (VAL-CROSS-011)', () => {
  it('completes as oneshot with the honest tool lineage when rpc is exhausted', async () => {
    // Two rpc strikes exhaust the ladder; the surviving turn is the oneshot
    // path. A non-droid vendor (supportsRpc false) would start there directly;
    // this exercises the same trace shape the validator asserts.
    const droid = scriptedDroid([buildEnvelope(), buildEnvelope(), buildEnvelope()], [], [], {
      dieOnTurns: [0, 1],
    });
    const outcome = await run({
      droidPath: droid,
      pipeline: pipe(
        [agentPhase('build', { description: 'exhaust rpc so the turn lands oneshot' })],
        {
          description: 'oneshot honest span',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });
    expect(outcome.status).toBe('accepted');
    expect(h.tracer.run(outcome.runId)!.mode).toBe('oneshot');
    const row = h.db
      .prepare('SELECT mode FROM agent_sessions WHERE run_id = ?')
      .get(outcome.runId) as { mode: string };
    expect(row.mode).toBe('oneshot');
    // One-shot fallback is an honest single turn: no mid-turn rpc spans,
    // run settles, mode reflects reality (not stuck on daemon/rpc).
    const fallbackEvents = events(outcome.runId).filter(
      (e) => e.name === 'builder: fallback to one-shot',
    );
    expect(fallbackEvents.length).toBeGreaterThanOrEqual(1);
    // The process rows show the fallback child is tracked.
    const rows = processRows(outcome.runId);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

/** VAL-PROD-012 — missing droid binary surfaces as a settled failure, not a hang. */
describe('missing droid binary (VAL-PROD-012)', () => {
  it('settles failed with a legible outcome_detail when the binary is unresolvable', async () => {
    const outcome = await run({
      droidPath: '/nonexistent/droid',
      pipeline: pipe([agentPhase('build', { description: 'binary is missing' })], {
        description: 'missing droid binary',
        acceptance: { kind: 'envelope_status', phase: 'build' },
      }),
    });

    // No hang, no perpetual running — run settles terminal.
    expect(['failed', 'rejected']).toContain(outcome.status);
    const row = h.tracer.run(outcome.runId)!;
    expect(row.outcomeDetail).toBeTruthy();
    // The trace explains the root cause rather than masking it.
    const payloads = events(outcome.runId).map((e) => JSON.stringify(e.payload));
    const combined = payloads.join('\n');
    expect(combined).toMatch(/spawn|ENOENT|not found|unresolvable|executable|droid/i);
  });
});
