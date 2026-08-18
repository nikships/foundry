/**
 * The single writer of run state. Engine, agent sessions, and code phases all
 * report through here, so a run's status, its notification, and its banner can
 * never disagree: `finishRun` settles all three in one call.
 *
 * Every insert is one small transaction and lands as it happens — the renderer
 * polls `eventsAfter` with a change_id cursor, so live view and history are
 * the same query — and a row patched in place reflows instead of going stale.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Db } from './db.js';
import type {
  AgentSessionRow,
  EnvelopeRow,
  EventRow,
  EventType,
  GateCheck,
  GateResultRow,
  PhaseKind,
  PhaseRow,
  PhaseStatus,
  PipelineDef,
  RunMode,
  RunRow,
  RunStatus,
  UsageBreakdown,
} from '@shared/types.js';

export function newId(bytes = 6): string {
  return randomBytes(bytes).toString('hex');
}

export function nowIso(): string {
  return new Date().toISOString();
}

export interface EventInput {
  runId: string;
  phaseId?: string | null;
  parentId?: string | null;
  type: EventType;
  name: string;
  payload?: Record<string, unknown>;
  tokens?: number;
  startedAt?: string;
  endedAt?: string | null;
}

export interface PhaseInput {
  runId: string;
  seq: number;
  name: string;
  kind: PhaseKind;
  owner: string;
  description: string;
}

export class Tracer {
  /**
   * Hands out change_ids. In-memory because the db has a single writer (the
   * main process); seeded from the stored max so a reopened db continues the
   * sequence instead of restarting it.
   */
  private changeCounter: number;

  constructor(
    private readonly db: Db,
    /** Files stay the raw record: runs/{runId}/… under the project dir. */
    private readonly runsDir: string,
  ) {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(change_id), 0) AS max_change FROM events')
      .get() as { max_change: number };
    this.changeCounter = row.max_change;
  }

  private nextChangeId(): number {
    return ++this.changeCounter;
  }

  // ── runs ──────────────────────────────────────────────────────────────────

  startRun(input: {
    runId: string;
    projectId: string;
    pipeline: PipelineDef;
    request: string;
    engineer: string;
    worktreePath: string | null;
    branch: string | null;
    baseRef: string | null;
    branchPointSha?: string | null;
    mode: RunMode;
  }): void {
    this.db
      .prepare(
        `INSERT INTO runs (run_id, project_id, pipeline_id, pipeline_name, pipeline_snapshot_json,
           request, status, engineer, worktree_path, branch, base_ref, branch_point_sha, mode, started_at)
         VALUES (?,?,?,?,?,?,'running',?,?,?,?,?,?,?)`,
      )
      .run(
        input.runId,
        input.projectId,
        input.pipeline.id,
        input.pipeline.name,
        JSON.stringify(input.pipeline),
        input.request.slice(0, 4000),
        input.engineer,
        input.worktreePath,
        input.branch,
        input.baseRef,
        input.branchPointSha ?? null,
        input.mode,
        nowIso(),
      );
    mkdirSync(this.runDir(input.runId), { recursive: true });
    this.writeRunFile(input.runId, 'request.md', input.request);
    this.writeRunFile(input.runId, 'pipeline.json', JSON.stringify(input.pipeline, null, 2));
  }

  /**
   * Settles run status and tokens in one statement. Callers derive
   * `accepted` from the pipeline's own acceptance criterion; nothing else in
   * the app may write `runs.status` for a terminal state.
   */
  finishRun(runId: string, status: RunStatus, outcomeDetail?: string): RunRow | null {
    const totals = this.db
      .prepare(
        `SELECT COALESCE(SUM(tokens),0) AS tokens FROM events WHERE run_id = ? AND type = 'agent_end'`,
      )
      .get(runId) as { tokens: number };
    this.db
      .prepare(
        `UPDATE runs SET status = ?, ended_at = ?, total_tokens = ?,
           outcome_detail = COALESCE(?, outcome_detail) WHERE run_id = ?`,
      )
      .run(status, nowIso(), totals.tokens, outcomeDetail ?? null, runId);
    return this.run(runId);
  }

  setBranchPoint(runId: string, sha: string): void {
    this.db.prepare('UPDATE runs SET branch_point_sha = ? WHERE run_id = ?').run(sha, runId);
  }

  setRunMode(runId: string, mode: RunMode): void {
    this.db.prepare('UPDATE runs SET mode = ? WHERE run_id = ?').run(mode, runId);
  }

  setWorktree(runId: string, path: string | null, branch: string | null): void {
    this.db
      .prepare('UPDATE runs SET worktree_path = ?, branch = ? WHERE run_id = ?')
      .run(path, branch, runId);
  }

  setMerged(runId: string, merged: boolean): void {
    this.db.prepare('UPDATE runs SET merged = ? WHERE run_id = ?').run(merged ? 1 : 0, runId);
  }

  setPr(runId: string, prNumber: number, prUrl: string): void {
    this.db
      .prepare('UPDATE runs SET pr_number = ?, pr_url = ? WHERE run_id = ?')
      .run(prNumber, prUrl, runId);
  }

  setArchived(runId: string, archived: boolean): void {
    this.db.prepare('UPDATE runs SET archived = ? WHERE run_id = ?').run(archived ? 1 : 0, runId);
  }

  run(runId: string): RunRow | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as
      RawRun | undefined;
    return row ? mapRun(row) : null;
  }

  runs(opts: { projectId?: string; includeArchived?: boolean; limit?: number } = {}): RunRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.projectId) {
      where.push('project_id = ?');
      args.push(opts.projectId);
    }
    if (!opts.includeArchived) where.push('archived = 0');
    const sql =
      'SELECT * FROM runs' +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY started_at DESC LIMIT ?';
    args.push(opts.limit ?? 200);
    const rows = this.db.prepare(sql).all(...args) as RawRun[];
    const summary = this.db.prepare(
      'SELECT name, status, kind FROM phases WHERE run_id = ? ORDER BY seq',
    );
    return rows.map((r) => ({
      ...mapRun(r),
      phaseSummary: summary.all(r.run_id) as {
        name: string;
        status: PhaseStatus;
        kind: PhaseKind;
      }[],
    }));
  }

  activeRunIds(): string[] {
    const rows = this.db.prepare("SELECT run_id FROM runs WHERE status = 'running'").all() as {
      run_id: string;
    }[];
    return rows.map((r) => r.run_id);
  }

  // ── phases ────────────────────────────────────────────────────────────────

  /** A phase row is born `fail`: success has to be earned by a clean finish. */
  openPhase(input: PhaseInput): string {
    const phaseId = this.insertPhase(input, 'running', nowIso());
    this.emitPhaseStart(input.runId, phaseId, input);
    return phaseId;
  }

  queuePhase(input: PhaseInput): string {
    return this.insertPhase(input, 'queued', null);
  }

  beginQueuedPhase(phaseId: string): void {
    const row = this.rawPhase(phaseId);
    if (!row) return;
    this.db
      .prepare("UPDATE phases SET status = 'running', started_at = ? WHERE phase_id = ?")
      .run(nowIso(), phaseId);
    this.emitPhaseStart(row.run_id, phaseId, {
      name: row.name,
      kind: row.kind,
      owner: row.owner,
      description: row.description,
    });
  }

  setPhaseAttempt(phaseId: string, attempt: number): void {
    this.db.prepare('UPDATE phases SET attempt = ? WHERE phase_id = ?').run(attempt, phaseId);
  }

  closePhase(phaseId: string, status: PhaseStatus, error?: string | null): void {
    const row = this.rawPhase(phaseId);
    if (!row) return;
    this.db
      .prepare('UPDATE phases SET status = ?, error = ?, ended_at = ? WHERE phase_id = ?')
      .run(status, error ?? null, nowIso(), phaseId);
    this.event({
      runId: row.run_id,
      phaseId,
      type: 'phase_end',
      name: row.name,
      payload: { status, error: error ?? null },
    });
  }

  phases(runId: string): PhaseRow[] {
    const rows = this.db
      .prepare('SELECT * FROM phases WHERE run_id = ? ORDER BY seq')
      .all(runId) as RawPhase[];
    return rows.map(mapPhase);
  }

  phase(phaseId: string): PhaseRow | null {
    const row = this.rawPhase(phaseId);
    return row ? mapPhase(row) : null;
  }

  private rawPhase(phaseId: string): RawPhase | undefined {
    return this.db.prepare('SELECT * FROM phases WHERE phase_id = ?').get(phaseId) as
      RawPhase | undefined;
  }

  private insertPhase(
    input: PhaseInput,
    status: 'running' | 'queued',
    startedAt: string | null,
  ): string {
    const phaseId = `ph_${newId()}`;
    this.db
      .prepare(
        `INSERT INTO phases (phase_id, run_id, seq, name, kind, owner, description, status, attempt, started_at)
         VALUES (?,?,?,?,?,?,?,?,0,?)`,
      )
      .run(
        phaseId,
        input.runId,
        input.seq,
        input.name,
        input.kind,
        input.owner,
        input.description,
        status,
        startedAt,
      );
    return phaseId;
  }

  private emitPhaseStart(
    runId: string,
    phaseId: string,
    meta: { name: string; kind: string; owner: string; description: string },
  ): void {
    this.event({
      runId,
      phaseId,
      type: 'phase_start',
      name: meta.name,
      payload: { kind: meta.kind, owner: meta.owner, description: meta.description },
    });
  }

  // ── events ────────────────────────────────────────────────────────────────

  event(input: EventInput): string {
    const eventId = `evt_${newId()}`;
    const startedAt = input.startedAt ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO events (event_id, run_id, phase_id, parent_id, type, name, payload_json, tokens, started_at, ended_at, change_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        eventId,
        input.runId,
        input.phaseId ?? null,
        input.parentId ?? null,
        input.type,
        input.name,
        JSON.stringify(input.payload ?? {}),
        input.tokens ?? 0,
        startedAt,
        input.endedAt ?? null,
        this.nextChangeId(),
      );
    this.appendJsonl(input.runId, {
      event_id: eventId,
      ts: startedAt,
      type: input.type,
      name: input.name,
      phase_id: input.phaseId ?? null,
      payload: input.payload ?? {},
    });
    return eventId;
  }

  /**
   * Spanning events (tool calls) get their end time filled in on completion.
   * Tokens are left alone unless a caller passes them, so patching a payload
   * never silently erases a turn's token count.
   */
  endEvent(eventId: string, payloadPatch?: Record<string, unknown>, tokens?: number): void {
    const existing = this.db
      .prepare('SELECT payload_json, tokens FROM events WHERE event_id = ?')
      .get(eventId) as { payload_json: string; tokens: number } | undefined;
    if (!existing) return;
    this.db
      .prepare(
        'UPDATE events SET ended_at = ?, payload_json = ?, tokens = ?, change_id = ? WHERE event_id = ?',
      )
      .run(
        nowIso(),
        mergePayloadJson(existing.payload_json, payloadPatch),
        tokens ?? existing.tokens,
        this.nextChangeId(),
        eventId,
      );
  }

  /**
   * Sharpens a still-open event. A transport streams a tool call's arguments in
   * incrementally, so the first frame carries an empty input and only a later
   * one knows the command — the row has to be renamed in place without being
   * closed, or the span ends before the tool has even run.
   */
  renameEvent(eventId: string, name: string, payloadPatch?: Record<string, unknown>): void {
    const existing = this.db
      .prepare('SELECT payload_json FROM events WHERE event_id = ?')
      .get(eventId) as { payload_json: string } | undefined;
    if (!existing) return;
    this.db
      .prepare('UPDATE events SET name = ?, payload_json = ?, change_id = ? WHERE event_id = ?')
      .run(
        name,
        mergePayloadJson(existing.payload_json, payloadPatch),
        this.nextChangeId(),
        eventId,
      );
  }

  /**
   * Grows a still-open row's payload without renaming or closing it. Streaming
   * text (assistant replies, thinking) lands this way: one row per message
   * block, patched as deltas arrive, so the transcript is one continuous
   * paragraph rather than a confetti of delta rows.
   */
  patchEvent(eventId: string, payloadPatch: Record<string, unknown>): void {
    const existing = this.db
      .prepare('SELECT payload_json FROM events WHERE event_id = ?')
      .get(eventId) as { payload_json: string } | undefined;
    if (!existing) return;
    this.db
      .prepare('UPDATE events SET payload_json = ?, change_id = ? WHERE event_id = ?')
      .run(mergePayloadJson(existing.payload_json, payloadPatch), this.nextChangeId(), eventId);
  }

  /**
   * The cursor walks change_id, not rowid: an in-place update (a tool result
   * landing, a thinking block growing) re-serves the row, so live view and
   * history stay the same query. Rows still arrive in rowid (creation) order,
   * so a fresh read of a much-patched run matches the order the live view
   * built up; the caller's next cursor is the MAX change_id seen, not the
   * last row's. Callers replace rows by event_id.
   */
  eventsAfter(runId: string, afterChangeId: number, limit = 500): EventRow[] {
    const rows = this.db
      .prepare(
        'SELECT rowid, * FROM events WHERE run_id = ? AND change_id > ? ORDER BY rowid LIMIT ?',
      )
      .all(runId, afterChangeId, limit) as RawEvent[];
    return rows.map(mapEvent);
  }

  // ── envelopes ─────────────────────────────────────────────────────────────

  recordEnvelope(input: {
    runId: string;
    phaseId: string;
    agent: string;
    schemaKind: string;
    payload: unknown;
    valid: boolean;
    attempt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO envelopes (envelope_id, run_id, phase_id, agent, schema_kind, payload_json, valid, attempt, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        `env_${newId()}`,
        input.runId,
        input.phaseId,
        input.agent,
        input.schemaKind,
        JSON.stringify(input.payload ?? {}),
        input.valid ? 1 : 0,
        input.attempt,
        nowIso(),
      );
  }

  envelopes(runId: string): EnvelopeRow[] {
    const rows = this.db
      .prepare('SELECT * FROM envelopes WHERE run_id = ? ORDER BY created_at')
      .all(runId) as RawEnvelope[];
    return rows.map((r) => ({
      envelopeId: r.envelope_id,
      runId: r.run_id,
      phaseId: r.phase_id,
      agent: r.agent,
      schemaKind: r.schema_kind,
      payload: safeJson(r.payload_json),
      valid: !!r.valid,
      attempt: r.attempt,
      createdAt: r.created_at,
    }));
  }

  // ── gates ─────────────────────────────────────────────────────────────────

  recordGate(input: {
    runId: string;
    phaseId: string;
    attempt: number;
    gate: string;
    passed: boolean;
    checks: GateCheck[];
  }): void {
    this.db
      .prepare(
        `INSERT INTO gate_results (run_id, phase_id, attempt, gate, passed, checks_json, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        input.runId,
        input.phaseId,
        input.attempt,
        input.gate,
        input.passed ? 1 : 0,
        JSON.stringify(input.checks),
        nowIso(),
      );
    this.event({
      runId: input.runId,
      phaseId: input.phaseId,
      type: input.passed ? 'gate_pass' : 'gate_fail',
      name: input.gate,
      payload: { attempt: input.attempt, checks: input.checks },
    });
  }

  gateResults(runId: string): GateResultRow[] {
    const rows = this.db
      .prepare('SELECT * FROM gate_results WHERE run_id = ? ORDER BY id')
      .all(runId) as RawGate[];
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      phaseId: r.phase_id,
      attempt: r.attempt,
      gate: r.gate,
      passed: !!r.passed,
      checks: (safeJson(r.checks_json) as unknown as GateCheck[]) ?? [],
      createdAt: r.created_at,
    }));
  }

  // ── agent sessions ────────────────────────────────────────────────────────

  upsertAgentSession(input: {
    runId: string;
    agent: string;
    model: string;
    reasoningEffort: string;
    agentSessionId: string | null;
    mode: RunMode;
    color: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO agent_sessions (run_id, agent, model, reasoning_effort, agent_session_id, mode, color, created_at, last_used_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(run_id, agent) DO UPDATE SET
           model = excluded.model, reasoning_effort = excluded.reasoning_effort,
           agent_session_id = excluded.agent_session_id, mode = excluded.mode,
           last_used_at = excluded.last_used_at`,
      )
      .run(
        input.runId,
        input.agent,
        input.model,
        input.reasoningEffort,
        input.agentSessionId,
        input.mode,
        input.color,
        nowIso(),
        nowIso(),
      );
  }

  /**
   * Context occupancy after the agent's last turn, not a running sum: this is
   * what the lane's context bar measures against the window.
   */
  setAgentContext(
    runId: string,
    agent: string,
    contextTokens: number,
    contextWindow: number,
  ): void {
    this.db
      .prepare(
        'UPDATE agent_sessions SET context_tokens = ?, context_window = ?, last_used_at = ? WHERE run_id = ? AND agent = ?',
      )
      .run(contextTokens, contextWindow, nowIso(), runId, agent);
  }

  agentSessions(runId: string): AgentSessionRow[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_sessions WHERE run_id = ?')
      .all(runId) as RawAgentSession[];
    return rows.map((r) => ({
      runId: r.run_id,
      agent: r.agent,
      model: r.model,
      reasoningEffort: r.reasoning_effort,
      agentSessionId: r.agent_session_id,
      mode: (r.mode as RunMode) ?? 'pi',
      color: r.color,
      contextTokens: r.context_tokens ?? 0,
      contextWindow: r.context_window ?? 0,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    }));
  }

  // ── processes (kill path + relaunch sweep) ────────────────────────────────

  /**
   * `runId` is null for a child that belongs to the app rather than to a run —
   * the Bridge is one, started once and shared by every run. The column has a
   * foreign key to `runs`, so a synthetic id would be rejected; null satisfies
   * it, keeps the row out of every per-run query (`WHERE run_id = ?` never
   * matches null), and still reaches the relaunch sweep's unfiltered
   * `openProcesses()`.
   */
  recordProcess(input: {
    runId: string | null;
    kind: 'engine' | 'code' | 'bridge';
    name: string;
    pid: number;
    command: string;
  }): number {
    const info = this.db
      .prepare(
        'INSERT INTO processes (run_id, kind, name, pid, command, started_at) VALUES (?,?,?,?,?,?)',
      )
      .run(input.runId, input.kind, input.name, input.pid, input.command, nowIso());
    return Number(info.lastInsertRowid);
  }

  endProcess(id: number): void {
    this.db.prepare('UPDATE processes SET ended_at = ? WHERE id = ?').run(nowIso(), id);
  }

  openProcesses(runId?: string): {
    id: number;
    runId: string | null;
    kind: string;
    name: string;
    pid: number;
    command: string;
  }[] {
    const rows = (
      runId
        ? this.db
            .prepare('SELECT * FROM processes WHERE ended_at IS NULL AND run_id = ?')
            .all(runId)
        : this.db.prepare('SELECT * FROM processes WHERE ended_at IS NULL').all()
    ) as RawProcess[];
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      kind: r.kind,
      name: r.name,
      pid: r.pid,
      command: r.command,
    }));
  }

  /**
   * Tokens are counted per turn, so this is written whether or not the turn's
   * envelope parsed: the usage happened either way. The returned id lets the
   * caller patch in the envelope verdict once it knows it.
   */
  recordUsage(runId: string, phaseId: string, agent: string, usage: UsageBreakdown): string {
    const total =
      usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
    return this.event({
      runId,
      phaseId,
      type: 'agent_end',
      name: agent,
      payload: { usage },
      tokens: usage.reported ? total : 0,
      endedAt: nowIso(),
    });
  }

  // ── files: the raw record ─────────────────────────────────────────────────

  runDir(runId: string): string {
    return join(this.runsDir, runId);
  }

  writeRunFile(runId: string, relPath: string, content: string): string {
    const full = join(this.runDir(runId), relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    return full;
  }

  /**
   * The prompt for a phase attempt, as it was sent. Falls back to the newest
   * attempt on file, so the drawer still shows something after a correction
   * bumped the count past the file that exists.
   */
  readPrompt(runId: string, owner: string, phaseName: string, attempt = 1): string {
    const dir = join(this.runDir(runId), owner, 'prompts');
    for (let n = attempt; n >= 1; n--) {
      const file = join(dir, `${phaseName}-${n}.md`);
      if (existsSync(file)) return readFileSync(file, 'utf8');
    }
    return '';
  }

  /**
   * A JSON run file this run wrote earlier, or `null` when it is absent or no
   * longer parseable. Used for records a finished run can still be asked about
   * after the session that produced them is gone.
   */
  readRunJson<T>(runId: string, relPath: string): T | null {
    const full = join(this.runDir(runId), relPath);
    try {
      return JSON.parse(readFileSync(full, 'utf8')) as T;
    } catch {
      return null;
    }
  }

  appendRunFile(runId: string, relPath: string, content: string): string {
    const full = join(this.runDir(runId), relPath);
    mkdirSync(dirname(full), { recursive: true });
    appendFileSync(full, content);
    return full;
  }

  private appendJsonl(runId: string, line: Record<string, unknown>): void {
    try {
      this.appendRunFile(runId, 'events.jsonl', `${JSON.stringify(line)}\n`);
    } catch {
      // The db is the queryable mirror; a failed file append must not abort a run.
    }
  }

  // ── maintenance ───────────────────────────────────────────────────────────

  deleteRunsOlderThan(days: number): string[] {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = this.db
      .prepare("SELECT run_id FROM runs WHERE status != 'running' AND started_at < ?")
      .all(cutoff) as { run_id: string }[];
    const ids = rows.map((r) => r.run_id);
    const tx = this.db.transaction((runIds: string[]) => {
      for (const id of runIds) {
        this.db.prepare('DELETE FROM events WHERE run_id = ?').run(id);
        this.db.prepare('DELETE FROM envelopes WHERE run_id = ?').run(id);
        this.db.prepare('DELETE FROM gate_results WHERE run_id = ?').run(id);
        this.db.prepare('DELETE FROM agent_sessions WHERE run_id = ?').run(id);
        this.db.prepare('DELETE FROM processes WHERE run_id = ?').run(id);
        this.db.prepare('DELETE FROM phases WHERE run_id = ?').run(id);
        this.db.prepare('DELETE FROM runs WHERE run_id = ?').run(id);
      }
    });
    tx(ids);
    return ids;
  }

  compact(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    this.db.exec('VACUUM');
  }
}

// ── row mapping ──────────────────────────────────────────────────────────────

interface RawRun {
  run_id: string;
  project_id: string;
  pipeline_id: string;
  pipeline_name: string | null;
  request: string | null;
  status: string;
  engineer: string | null;
  worktree_path: string | null;
  branch: string | null;
  base_ref: string | null;
  branch_point_sha: string | null;
  outcome_detail: string | null;
  pr_number: number | null;
  pr_url: string | null;
  mode: string | null;
  merged: number;
  archived: number;
  started_at: string;
  ended_at: string | null;
  total_tokens: number;
}

interface RawPhase {
  phase_id: string;
  run_id: string;
  seq: number;
  name: string;
  kind: string;
  owner: string;
  description: string;
  status: string;
  attempt: number;
  error: string | null;
  started_at: string | null;
  ended_at: string | null;
}

interface RawEvent {
  rowid: number;
  event_id: string;
  run_id: string;
  phase_id: string | null;
  parent_id: string | null;
  type: string;
  name: string;
  payload_json: string;
  tokens: number;
  started_at: string;
  ended_at: string | null;
  change_id: number;
}

interface RawEnvelope {
  envelope_id: string;
  run_id: string;
  phase_id: string;
  agent: string;
  schema_kind: string;
  payload_json: string;
  valid: number;
  attempt: number;
  created_at: string;
}

interface RawGate {
  id: number;
  run_id: string;
  phase_id: string;
  attempt: number;
  gate: string;
  passed: number;
  checks_json: string;
  created_at: string;
}

interface RawAgentSession {
  run_id: string;
  agent: string;
  model: string;
  reasoning_effort: string;
  agent_session_id: string | null;
  mode: string | null;
  color: string;
  context_tokens: number;
  context_window: number;
  created_at: string;
  last_used_at: string;
}

interface RawProcess {
  id: number;
  run_id: string | null;
  kind: string;
  name: string;
  pid: number;
  command: string;
}

function safeJson(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function mergePayloadJson(existing: string, patch?: Record<string, unknown>): string {
  return JSON.stringify({
    ...(JSON.parse(existing) as Record<string, unknown>),
    ...(patch ?? {}),
  });
}

function mapRun(r: RawRun): RunRow {
  return {
    runId: r.run_id,
    projectId: r.project_id,
    pipelineId: r.pipeline_id,
    pipelineName: r.pipeline_name ?? r.pipeline_id,
    request: r.request ?? '',
    status: r.status as RunStatus,
    engineer: r.engineer ?? '',
    worktreePath: r.worktree_path,
    branch: r.branch,
    baseRef: r.base_ref,
    branchPointSha: r.branch_point_sha,
    outcomeDetail: r.outcome_detail,
    prNumber: r.pr_number ?? null,
    prUrl: r.pr_url ?? null,
    merged: !!r.merged,
    archived: !!r.archived,
    mode: (r.mode as RunMode) ?? 'pi',
    startedAt: r.started_at,
    endedAt: r.ended_at,
    totalTokens: r.total_tokens,
  };
}

function mapPhase(r: RawPhase): PhaseRow {
  return {
    phaseId: r.phase_id,
    runId: r.run_id,
    seq: r.seq,
    name: r.name,
    kind: r.kind as PhaseKind,
    owner: r.owner,
    description: r.description,
    status: r.status as PhaseStatus,
    attempt: r.attempt,
    error: r.error,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

function mapEvent(r: RawEvent): EventRow {
  return {
    rowid: r.rowid,
    changeId: r.change_id,
    eventId: r.event_id,
    runId: r.run_id,
    phaseId: r.phase_id,
    parentId: r.parent_id,
    type: r.type as EventType,
    name: r.name,
    payload: safeJson(r.payload_json),
    tokens: r.tokens,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}
