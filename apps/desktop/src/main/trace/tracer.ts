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
import { z } from 'zod';
import type { Db } from './db.js';
import type {
  AgentSessionRow,
  EnvelopeRow,
  EventRow,
  EventType,
  GateCheck,
  GateResultRow,
  GeneratedRunPlan,
  PhaseCheckpointFile,
  PhaseCheckpointPayload,
  PhaseCheckpointRow,
  PhaseDef,
  PhaseKind,
  PhaseRow,
  PhaseStatus,
  PipelineDef,
  RunMode,
  RunRow,
  RunSource,
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

/**
 * Everything a checkpoint needs except its identity: the id, generation, and
 * timestamps are the Tracer's to assign, so a caller cannot mint a generation
 * that collides with one already on disk.
 */
export interface PhaseCheckpointInput {
  runId: string;
  phaseId: string;
  phaseName: string;
  phaseKind: PhaseKind;
  headSha: string;
  branch: string | null;
  worktreePath: string;
  model: string | null;
  agent: string | null;
  agentSessionId: string | null;
  leafMessageId: string | null;
  handoffFiles: string[];
  envelopePhases: string[];
  files: PhaseCheckpointFile[];
  truncated: boolean;
  omittedPaths: string[];
  bytesStored: number;
}

/** What a statement placeholder accepts; booleans are stored as 0/1 by callers. */
type SqlValue = string | number | null;

/**
 * Payload location under the run dir. The phase id is in the name because two
 * phases in one run may share a name after an amendment, and the generation
 * because a later attempt must never overwrite an earlier one's record.
 */
function checkpointPayloadPath(phaseName: string, phaseId: string, generation: number): string {
  // Dots are replaced along with everything else: a name like `../..` would
  // otherwise survive separator stripping and still climb out of the run dir.
  const safeName = phaseName.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'phase';
  return join('checkpoints', `${safeName}-${phaseId}-${generation}.json`);
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
    // Every table that stamps a change_id draws from this one counter, so the
    // seed is the max across all of them — seeding from `events` alone would
    // re-issue ids a reopened database has already given to a checkpoint.
    this.changeCounter =
      this.one<{ max_change: number }>(
        `SELECT MAX(max_change) AS max_change FROM (
           SELECT COALESCE(MAX(change_id), 0) AS max_change FROM events
           UNION ALL
           SELECT COALESCE(MAX(change_id), 0) AS max_change FROM phase_checkpoints
         )`,
      )?.max_change ?? 0;
  }

  private nextChangeId(): number {
    return ++this.changeCounter;
  }

  // ── statement helpers ─────────────────────────────────────────────────────

  private one<T>(sql: string, ...args: SqlValue[]): T | undefined {
    return this.db.prepare<SqlValue[], T>(sql).get(...args);
  }

  private many<T>(sql: string, ...args: SqlValue[]): T[] {
    return this.db.prepare<SqlValue[], T>(sql).all(...args);
  }

  private exec(
    sql: string,
    ...args: SqlValue[]
  ): { changes: number; lastInsertRowid: number | bigint } {
    return this.db.prepare<SqlValue[]>(sql).run(...args);
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
    /** The Orchestrator's confirmed plan, when this run was generated from one. */
    plan?: GeneratedRunPlan | null;
    /** Immutable external issue snapshot, when one triggered this run. */
    source?: RunSource | null;
  }): void {
    this.exec(
      `INSERT INTO runs (run_id, project_id, pipeline_id, pipeline_name, pipeline_snapshot_json,
         request, status, engineer, worktree_path, branch, base_ref, branch_point_sha, mode,
         plan_json, orchestrated, source_json, started_at)
       VALUES (?,?,?,?,?,?,'running',?,?,?,?,?,?,?,?,?,?)`,
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
      input.plan ? JSON.stringify(input.plan) : null,
      input.plan ? 1 : 0,
      input.source ? JSON.stringify(input.source) : null,
      nowIso(),
    );
    mkdirSync(this.runDir(input.runId), { recursive: true });
    this.writeRunFile(input.runId, 'request.md', input.request);
    this.writeRunFile(input.runId, 'pipeline.json', JSON.stringify(input.pipeline, null, 2));
    if (input.plan) {
      this.writeRunFile(input.runId, 'plan.json', JSON.stringify(input.plan, null, 2));
    }
    if (input.source) {
      this.writeRunFile(input.runId, 'source.json', JSON.stringify(input.source, null, 2));
    }
  }

  /**
   * The generated plan an orchestrated run started from, or null for a manual
   * run (and for a stored plan that no longer parses — the raw file under the
   * run dir remains the record).
   */
  runPlan(runId: string): GeneratedRunPlan | null {
    const row = this.one<{ plan_json: string | null }>(
      'SELECT plan_json FROM runs WHERE run_id = ?',
      runId,
    );
    if (!row?.plan_json) return null;
    try {
      return JSON.parse(row.plan_json) as GeneratedRunPlan;
    } catch {
      return null;
    }
  }

  /**
   * Settles run status and tokens in one statement. Callers derive
   * `accepted` from the pipeline's own acceptance criterion; nothing else in
   * the app may write `runs.status` for a terminal state.
   */
  finishRun(runId: string, status: RunStatus, outcomeDetail?: string): RunRow | null {
    const totals = this.one<{ tokens: number }>(
      `SELECT COALESCE(SUM(tokens),0) AS tokens FROM events WHERE run_id = ? AND type = 'agent_end'`,
      runId,
    );
    this.exec(
      `UPDATE runs SET status = ?, ended_at = ?, total_tokens = ?,
         outcome_detail = COALESCE(?, outcome_detail) WHERE run_id = ?`,
      status,
      nowIso(),
      totals?.tokens ?? 0,
      outcomeDetail ?? null,
      runId,
    );
    return this.run(runId);
  }

  /** Reopens a terminal run before its failed phase is attempted again. */
  reopenRun(runId: string): void {
    this.exec(
      "UPDATE runs SET status = 'running', ended_at = NULL, outcome_detail = NULL WHERE run_id = ?",
      runId,
    );
  }

  setBranchPoint(runId: string, sha: string): void {
    this.exec('UPDATE runs SET branch_point_sha = ? WHERE run_id = ?', sha, runId);
  }

  setRunMode(runId: string, mode: RunMode): void {
    this.exec('UPDATE runs SET mode = ? WHERE run_id = ?', mode, runId);
  }

  setWorktree(runId: string, path: string | null, branch: string | null): void {
    this.exec(
      'UPDATE runs SET worktree_path = ?, branch = ? WHERE run_id = ?',
      path,
      branch,
      runId,
    );
  }

  setMerged(runId: string, merged: boolean): void {
    this.exec('UPDATE runs SET merged = ? WHERE run_id = ?', merged ? 1 : 0, runId);
  }

  setPr(runId: string, prNumber: number, prUrl: string): void {
    this.exec('UPDATE runs SET pr_number = ?, pr_url = ? WHERE run_id = ?', prNumber, prUrl, runId);
  }

  setIssue(runId: string, issueNumber: number, issueUrl: string): void {
    this.exec(
      'UPDATE runs SET issue_number = ?, issue_url = ? WHERE run_id = ?',
      issueNumber,
      issueUrl,
      runId,
    );
  }

  setSourceSyncError(runId: string, message: string | null): void {
    this.exec('UPDATE runs SET source_sync_error = ? WHERE run_id = ?', message, runId);
  }

  setArchived(runId: string, archived: boolean): void {
    this.exec('UPDATE runs SET archived = ? WHERE run_id = ?', archived ? 1 : 0, runId);
  }

  run(runId: string): RunRow | null {
    const row = this.one<RawRun>('SELECT * FROM runs WHERE run_id = ?', runId);
    return row ? mapRun(row) : null;
  }

  runs(opts: { projectId?: string; includeArchived?: boolean; limit?: number } = {}): RunRow[] {
    const where: string[] = [];
    const args: SqlValue[] = [];
    if (opts.projectId) {
      where.push('project_id = ?');
      args.push(opts.projectId);
    }
    if (!opts.includeArchived) where.push('archived = 0');
    args.push(opts.limit ?? 200);
    const rows = this.many<RawRun>(
      'SELECT * FROM runs' +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
        ' ORDER BY started_at DESC LIMIT ?',
      ...args,
    );
    const summary = this.db.prepare<
      SqlValue[],
      { name: string; status: PhaseStatus; kind: PhaseKind }
    >('SELECT name, status, kind FROM phases WHERE run_id = ? ORDER BY seq');
    return rows.map((r) => ({ ...mapRun(r), phaseSummary: summary.all(r.run_id) }));
  }

  activeRunIds(): string[] {
    return this.many<{ run_id: string }>("SELECT run_id FROM runs WHERE status = 'running'").map(
      (r) => r.run_id,
    );
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
    this.exec(
      "UPDATE phases SET status = 'running', error = NULL, started_at = ?, ended_at = NULL WHERE phase_id = ?",
      nowIso(),
      phaseId,
    );
    this.emitPhaseStart(row.run_id, phaseId, row);
  }

  setPhaseAttempt(phaseId: string, attempt: number): void {
    this.exec('UPDATE phases SET attempt = ? WHERE phase_id = ?', attempt, phaseId);
  }

  closePhase(phaseId: string, status: PhaseStatus, error?: string | null): void {
    const row = this.rawPhase(phaseId);
    if (!row) return;
    this.exec(
      'UPDATE phases SET status = ?, error = ?, ended_at = ? WHERE phase_id = ?',
      status,
      error ?? null,
      nowIso(),
      phaseId,
    );
    this.event({
      runId: row.run_id,
      phaseId,
      type: 'phase_end',
      name: row.name,
      payload: { status, error: error ?? null },
    });
  }

  phases(runId: string): PhaseRow[] {
    return this.many<RawPhase>('SELECT * FROM phases WHERE run_id = ? ORDER BY seq', runId).map(
      mapPhase,
    );
  }

  phase(phaseId: string): PhaseRow | null {
    const row = this.rawPhase(phaseId);
    return row ? mapPhase(row) : null;
  }

  /**
   * Atomically replaces an orchestrated run's queued tail. The failed and
   * completed rows are history; only still-queued rows may be removed, and
   * every replacement receives a fresh identity after the historical rows.
   */
  amendRun(input: {
    runId: string;
    failedPhaseId: string;
    removeQueuedPhaseIds: string[];
    pipeline: PipelineDef;
    plan: GeneratedRunPlan;
    reason: string;
    attempt: number;
    evidence: string;
    before: string[];
    after: string[];
    newPhases: PhaseDef[];
    engineer: string;
  }): Map<string, string> {
    const apply = this.db.transaction(() => {
      for (const phaseId of input.removeQueuedPhaseIds) {
        const removed = this.exec(
          "DELETE FROM phases WHERE phase_id = ? AND run_id = ? AND status = 'queued'",
          phaseId,
          input.runId,
        );
        if (removed.changes !== 1) {
          throw new Error(`cannot replace phase ${phaseId}: it is no longer queued`);
        }
      }

      this.exec(
        `UPDATE runs SET pipeline_id = ?, pipeline_name = ?, pipeline_snapshot_json = ?,
           plan_json = ?, amendments = COALESCE(amendments, 0) + 1 WHERE run_id = ?`,
        input.pipeline.id,
        input.pipeline.name,
        JSON.stringify(input.pipeline),
        JSON.stringify(input.plan),
        input.runId,
      );
      const maxSeq =
        this.one<{ max_seq: number }>(
          'SELECT COALESCE(MAX(seq), -1) AS max_seq FROM phases WHERE run_id = ?',
          input.runId,
        )?.max_seq ?? -1;
      const ids = new Map<string, string>();
      input.newPhases.forEach((phase, index) => {
        ids.set(
          phase.name,
          this.insertPhase(
            {
              runId: input.runId,
              seq: maxSeq + index + 1,
              name: phase.name,
              kind: phase.kind,
              owner:
                phase.kind === 'agent'
                  ? (phase.agent ?? 'agent')
                  : phase.kind === 'code'
                    ? 'code'
                    : input.engineer,
              description: phase.description,
            },
            'queued',
            null,
          ),
        );
      });
      this.event({
        runId: input.runId,
        phaseId: input.failedPhaseId,
        type: 'replan',
        name: 'pipeline amended',
        payload: {
          attempt: input.attempt,
          reason: input.reason,
          evidence: input.evidence,
          before: input.before,
          after: input.after,
        },
      });
      return ids;
    });

    const ids = apply();
    this.writeRunFile(input.runId, 'pipeline.json', JSON.stringify(input.pipeline, null, 2));
    this.writeRunFile(input.runId, 'plan.json', JSON.stringify(input.plan, null, 2));
    return ids;
  }

  private rawPhase(phaseId: string): RawPhase | undefined {
    return this.one<RawPhase>('SELECT * FROM phases WHERE phase_id = ?', phaseId);
  }

  private insertPhase(
    input: PhaseInput,
    status: 'running' | 'queued',
    startedAt: string | null,
  ): string {
    const phaseId = `ph_${newId()}`;
    this.exec(
      `INSERT INTO phases (phase_id, run_id, seq, name, kind, owner, description, status, attempt, started_at)
       VALUES (?,?,?,?,?,?,?,?,0,?)`,
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
    this.exec(
      `INSERT INTO events (event_id, run_id, phase_id, parent_id, type, name, payload_json, tokens, started_at, ended_at, change_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
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
    const existing = this.storedEvent(eventId);
    if (!existing) return;
    this.updateEvent(eventId, {
      ended_at: nowIso(),
      payload_json: mergePayloadJson(existing.payload_json, payloadPatch),
      tokens: tokens ?? existing.tokens,
    });
  }

  /**
   * Sharpens a still-open event. A transport streams a tool call's arguments in
   * incrementally, so the first frame carries an empty input and only a later
   * one knows the command — the row has to be renamed in place without being
   * closed, or the span ends before the tool has even run.
   */
  renameEvent(eventId: string, name: string, payloadPatch?: Record<string, unknown>): void {
    const existing = this.storedEvent(eventId);
    if (!existing) return;
    this.updateEvent(eventId, {
      name,
      payload_json: mergePayloadJson(existing.payload_json, payloadPatch),
    });
  }

  /**
   * Grows a still-open row's payload without renaming or closing it. Streaming
   * text (assistant replies, thinking) lands this way: one row per message
   * block, patched as deltas arrive, so the transcript is one continuous
   * paragraph rather than a confetti of delta rows.
   */
  patchEvent(eventId: string, payloadPatch: Record<string, unknown>): void {
    const existing = this.storedEvent(eventId);
    if (!existing) return;
    this.updateEvent(eventId, {
      payload_json: mergePayloadJson(existing.payload_json, payloadPatch),
    });
  }

  private storedEvent(eventId: string): { payload_json: string; tokens: number } | undefined {
    return this.one('SELECT payload_json, tokens FROM events WHERE event_id = ?', eventId);
  }

  /**
   * The single in-place patch path. Every update stamps a fresh change_id, or
   * the renderer's cursor poll would never re-serve the row.
   */
  private updateEvent(eventId: string, columns: Record<string, SqlValue>): void {
    const assignments = Object.keys(columns).map((column) => `${column} = ?`);
    this.exec(
      `UPDATE events SET ${assignments.join(', ')}, change_id = ? WHERE event_id = ?`,
      ...Object.values(columns),
      this.nextChangeId(),
      eventId,
    );
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
    return this.many<RawEvent>(
      'SELECT rowid, * FROM events WHERE run_id = ? AND change_id > ? ORDER BY rowid LIMIT ?',
      runId,
      afterChangeId,
      limit,
    ).map(mapEvent);
  }

  /** Highest proposal attempt already spent, so a resume cannot reset the run budget. */
  replanAttempts(runId: string): number {
    const rows = this.many<{ payload_json: string }>(
      `SELECT payload_json FROM events
       WHERE run_id = ? AND (type = 'replan' OR name LIKE 'replan proposal%')`,
      runId,
    );
    return rows.reduce((highest, row) => {
      const attempt = safeJson(row.payload_json).attempt;
      return typeof attempt === 'number' ? Math.max(highest, attempt) : highest;
    }, 0);
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
    this.exec(
      `INSERT INTO envelopes (envelope_id, run_id, phase_id, agent, schema_kind, payload_json, valid, attempt, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
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
    const rows = this.many<RawEnvelope>(
      'SELECT * FROM envelopes WHERE run_id = ? ORDER BY created_at',
      runId,
    );
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
    this.exec(
      `INSERT INTO gate_results (run_id, phase_id, attempt, gate, passed, checks_json, created_at)
       VALUES (?,?,?,?,?,?,?)`,
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
    const rows = this.many<RawGate>(
      'SELECT * FROM gate_results WHERE run_id = ? ORDER BY id',
      runId,
    );
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      phaseId: r.phase_id,
      attempt: r.attempt,
      gate: r.gate,
      passed: !!r.passed,
      checks: safeJsonArray<GateCheck>(r.checks_json),
      createdAt: r.created_at,
    }));
  }

  // ── phase checkpoints ─────────────────────────────────────────────────────

  /**
   * Records where a phase began, durably, before it begins.
   *
   * Two stores rather than one: the bulk (phase-start file contents, path
   * lists) is JSON under the run directory, and SQLite keeps only the small
   * index a reader queries. The file is written first so a row never points at
   * a payload that is not there yet.
   *
   * A re-entry into the same phase is a new generation. Nothing here updates
   * or deletes an earlier row — an attempt's checkpoint is history the moment
   * it is written.
   */
  recordPhaseCheckpoint(input: PhaseCheckpointInput): PhaseCheckpointRow {
    const generation =
      (this.one<{ max_gen: number }>(
        'SELECT COALESCE(MAX(generation), 0) AS max_gen FROM phase_checkpoints WHERE phase_id = ?',
        input.phaseId,
      )?.max_gen ?? 0) + 1;
    const checkpointId = `cp_${newId()}`;
    const createdAt = nowIso();
    const payloadPath = checkpointPayloadPath(input.phaseName, input.phaseId, generation);

    const payload: PhaseCheckpointPayload = {
      checkpointId,
      runId: input.runId,
      phaseId: input.phaseId,
      phaseName: input.phaseName,
      generation,
      createdAt,
      headSha: input.headSha,
      branch: input.branch,
      worktreePath: input.worktreePath,
      model: input.model,
      agent: input.agent,
      agentSessionId: input.agentSessionId,
      leafMessageId: input.leafMessageId,
      handoffFiles: input.handoffFiles,
      envelopePhases: input.envelopePhases,
      files: input.files,
      truncated: input.truncated,
      omittedPaths: input.omittedPaths,
      bytesStored: input.bytesStored,
    };
    this.writeRunFile(input.runId, payloadPath, JSON.stringify(payload, null, 2));

    const changeId = this.nextChangeId();
    this.exec(
      `INSERT INTO phase_checkpoints (checkpoint_id, run_id, phase_id, phase_name, phase_kind,
         generation, head_sha, model, agent, agent_session_id, leaf_message_id, file_count,
         untracked_count, bytes_stored, truncated, payload_path, change_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      checkpointId,
      input.runId,
      input.phaseId,
      input.phaseName,
      input.phaseKind,
      generation,
      input.headSha,
      input.model,
      input.agent,
      input.agentSessionId,
      input.leafMessageId,
      input.files.length,
      input.files.filter((file) => file.state === 'untracked').length,
      input.bytesStored,
      input.truncated ? 1 : 0,
      payloadPath,
      changeId,
      createdAt,
    );
    const row = this.phaseCheckpointRow(checkpointId);
    if (!row) throw new Error(`checkpoint ${checkpointId} did not persist`);
    return row;
  }

  /**
   * Every checkpoint this run recorded, oldest first. A run that predates
   * checkpoints has none, which reads as an empty list rather than a fabricated
   * entry.
   */
  phaseCheckpoints(runId: string): PhaseCheckpointRow[] {
    return this.many<RawCheckpoint>(
      'SELECT * FROM phase_checkpoints WHERE run_id = ? ORDER BY rowid',
      runId,
    ).map(mapCheckpoint);
  }

  /**
   * One checkpoint's full phase-start record, or `null` when the id is unknown
   * or its payload file is gone. A caller that cannot read the payload must
   * not be handed the row alone and left to assume the contents are there.
   */
  phaseCheckpoint(
    checkpointId: string,
  ): { row: PhaseCheckpointRow; payload: PhaseCheckpointPayload } | null {
    const row = this.phaseCheckpointRow(checkpointId);
    if (!row) return null;
    const payload = this.readRunJson<PhaseCheckpointPayload>(row.runId, row.payloadPath);
    if (!payload) return null;
    return { row, payload };
  }

  private phaseCheckpointRow(checkpointId: string): PhaseCheckpointRow | null {
    const row = this.one<RawCheckpoint>(
      'SELECT * FROM phase_checkpoints WHERE checkpoint_id = ?',
      checkpointId,
    );
    return row ? mapCheckpoint(row) : null;
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
    const now = nowIso();
    this.exec(
      `INSERT INTO agent_sessions (run_id, agent, model, reasoning_effort, agent_session_id, mode, color, created_at, last_used_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(run_id, agent) DO UPDATE SET
         model = excluded.model, reasoning_effort = excluded.reasoning_effort,
         agent_session_id = excluded.agent_session_id, mode = excluded.mode,
         last_used_at = excluded.last_used_at`,
      input.runId,
      input.agent,
      input.model,
      input.reasoningEffort,
      input.agentSessionId,
      input.mode,
      input.color,
      now,
      now,
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
    this.exec(
      'UPDATE agent_sessions SET context_tokens = ?, context_window = ?, last_used_at = ? WHERE run_id = ? AND agent = ?',
      contextTokens,
      contextWindow,
      nowIso(),
      runId,
      agent,
    );
  }

  agentSessions(runId: string): AgentSessionRow[] {
    const rows = this.many<RawAgentSession>('SELECT * FROM agent_sessions WHERE run_id = ?', runId);
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
    const info = this.exec(
      'INSERT INTO processes (run_id, kind, name, pid, command, started_at) VALUES (?,?,?,?,?,?)',
      input.runId,
      input.kind,
      input.name,
      input.pid,
      input.command,
      nowIso(),
    );
    return Number(info.lastInsertRowid);
  }

  endProcess(id: number): void {
    this.exec('UPDATE processes SET ended_at = ? WHERE id = ?', nowIso(), id);
  }

  openProcesses(runId?: string): {
    id: number;
    runId: string | null;
    kind: string;
    name: string;
    pid: number;
    command: string;
  }[] {
    const rows = runId
      ? this.many<RawProcess>(
          'SELECT * FROM processes WHERE ended_at IS NULL AND run_id = ?',
          runId,
        )
      : this.many<RawProcess>('SELECT * FROM processes WHERE ended_at IS NULL');
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

  readRunFile(runId: string, relPath: string): string | null {
    try {
      return readFileSync(join(this.runDir(runId), relPath), 'utf8');
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
    const ids = this.many<{ run_id: string }>(
      "SELECT run_id FROM runs WHERE status != 'running' AND started_at < ?",
      cutoff,
    ).map((r) => r.run_id);
    // Children before parents: `runs` is the foreign-key target of the rest.
    const tables = [
      'events',
      'envelopes',
      'gate_results',
      'agent_sessions',
      'processes',
      'phase_checkpoints',
      'phases',
      'runs',
    ];
    this.db.transaction(() => {
      for (const id of ids) {
        for (const table of tables) this.exec(`DELETE FROM ${table} WHERE run_id = ?`, id);
      }
    })();
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
  issue_number: number | null;
  issue_url: string | null;
  source_json: string | null;
  source_sync_error: string | null;
  mode: string | null;
  merged: number;
  archived: number;
  orchestrated: number | null;
  amendments: number | null;
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

interface RawCheckpoint {
  checkpoint_id: string;
  run_id: string;
  phase_id: string;
  phase_name: string;
  phase_kind: string;
  generation: number;
  head_sha: string | null;
  model: string | null;
  agent: string | null;
  agent_session_id: string | null;
  leaf_message_id: string | null;
  file_count: number;
  untracked_count: number;
  bytes_stored: number;
  truncated: number;
  payload_path: string;
  change_id: number;
  created_at: string;
}

function mapCheckpoint(r: RawCheckpoint): PhaseCheckpointRow {
  const truncated = !!r.truncated;
  return {
    checkpointId: r.checkpoint_id,
    runId: r.run_id,
    phaseId: r.phase_id,
    phaseName: r.phase_name,
    phaseKind: r.phase_kind as PhaseKind,
    generation: r.generation,
    headSha: r.head_sha ?? '',
    model: r.model,
    agent: r.agent,
    agentSessionId: r.agent_session_id,
    leafMessageId: r.leaf_message_id,
    fileCount: r.file_count ?? 0,
    untrackedCount: r.untracked_count ?? 0,
    bytesStored: r.bytes_stored ?? 0,
    truncated,
    // A missing HEAD means the capture could not name the commit the phase
    // started from, so there is no baseline to restore the rest against.
    exactRestorePossible: !truncated && !!r.head_sha,
    payloadPath: r.payload_path,
    changeId: r.change_id,
    createdAt: r.created_at,
  };
}

function safeJson(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function safeJsonArray<T>(text: string | null): T[] {
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
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
    issueNumber: r.issue_number ?? null,
    issueUrl: r.issue_url ?? null,
    source: safeRunSource(r.source_json),
    sourceSyncError: r.source_sync_error,
    merged: !!r.merged,
    archived: !!r.archived,
    mode: (r.mode as RunMode) ?? 'pi',
    orchestrated: !!r.orchestrated,
    amendments: r.amendments ?? 0,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    totalTokens: r.total_tokens,
  };
}

const runSourceSchema = z.object({
  kind: z.literal('linear'),
  trigger: z.literal('manual'),
  issueId: z.string().min(1),
  url: z.string().min(1),
  revision: z.string().min(1),
  statusMapping: z.object({
    started: z.string().min(1),
    completed: z.string().min(1),
    failed: z.string().min(1),
  }),
  snapshot: z.object({
    id: z.string().min(1),
    identifier: z.string().min(1),
    title: z.string(),
    description: z.string(),
    url: z.string().min(1),
    updatedAt: z.string().min(1),
    team: z.object({ id: z.string().min(1), name: z.string().min(1) }),
    state: z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      type: z.string().min(1),
    }),
  }),
});

function safeRunSource(text: string | null): RunSource | null {
  if (!text) return null;
  try {
    const source: unknown = JSON.parse(text);
    const parsed = runSourceSchema.safeParse(source);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
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
