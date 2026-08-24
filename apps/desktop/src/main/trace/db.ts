/**
 * One SQLite db per project. WAL so the renderer's polling reads never block
 * the engine's writes, and losing the db loses nothing unbuildable: the files
 * under runs/ are the raw record, this is the queryable mirror.
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id                 TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL,
  pipeline_id            TEXT NOT NULL,
  pipeline_name          TEXT,
  pipeline_snapshot_json TEXT,
  request                TEXT,
  status                 TEXT NOT NULL DEFAULT 'running',
  engineer               TEXT,
  worktree_path          TEXT,
  branch                 TEXT,
  base_ref               TEXT,
  mode                   TEXT DEFAULT 'pi',
  merged                 INTEGER DEFAULT 0,
  archived               INTEGER DEFAULT 0,
  branch_point_sha       TEXT,
  outcome_detail         TEXT,
  pr_number              INTEGER,
  pr_url                 TEXT,
  issue_number           INTEGER,
  issue_url              TEXT,
  started_at             TEXT,
  ended_at               TEXT,
  total_tokens           INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS phases (
  phase_id    TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(run_id),
  seq         INTEGER NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  owner       TEXT,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'fail',
  attempt     INTEGER DEFAULT 0,
  error       TEXT,
  started_at  TEXT,
  ended_at    TEXT
);
CREATE TABLE IF NOT EXISTS events (
  event_id     TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(run_id),
  phase_id     TEXT REFERENCES phases(phase_id),
  parent_id    TEXT,
  type         TEXT NOT NULL,
  name         TEXT,
  payload_json TEXT,
  tokens       INTEGER DEFAULT 0,
  started_at   TEXT,
  ended_at     TEXT,
  change_id    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS envelopes (
  envelope_id  TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(run_id),
  phase_id     TEXT REFERENCES phases(phase_id),
  agent        TEXT,
  schema_kind  TEXT,
  payload_json TEXT,
  valid        INTEGER,
  attempt      INTEGER,
  created_at   TEXT
);
CREATE TABLE IF NOT EXISTS gate_results (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL REFERENCES runs(run_id),
  phase_id    TEXT REFERENCES phases(phase_id),
  attempt     INTEGER,
  gate        TEXT,
  passed      INTEGER,
  checks_json TEXT,
  created_at  TEXT
);
CREATE TABLE IF NOT EXISTS agent_sessions (
  run_id           TEXT NOT NULL REFERENCES runs(run_id),
  agent            TEXT NOT NULL,
  model            TEXT,
  reasoning_effort TEXT,
  agent_session_id TEXT,
  mode             TEXT DEFAULT 'pi',
  color            TEXT,
  context_tokens   INTEGER DEFAULT 0,
  context_window   INTEGER DEFAULT 0,
  created_at       TEXT,
  last_used_at     TEXT,
  PRIMARY KEY (run_id, agent)
);
CREATE TABLE IF NOT EXISTS processes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT REFERENCES runs(run_id),
  kind       TEXT,
  name       TEXT,
  pid        INTEGER,
  command    TEXT,
  started_at TEXT,
  ended_at   TEXT
);
-- rowid cannot be indexed, but rows within one run_id are already rowid-ordered,
-- which is exactly what the renderer's cursor query walks.
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id);
CREATE INDEX IF NOT EXISTS idx_events_change ON events(run_id, change_id);
CREATE INDEX IF NOT EXISTS idx_phases_run_seq ON phases(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_envelopes_phase ON envelopes(phase_id);
CREATE INDEX IF NOT EXISTS idx_gates_phase ON gate_results(phase_id);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_processes_open ON processes(ended_at) WHERE ended_at IS NULL;
`;

export function projectHash(projectPath: string): string {
  return createHash('sha256').update(projectPath).digest('hex').slice(0, 16);
}

/**
 * Columns added after a database was first created. `CREATE TABLE IF NOT
 * EXISTS` never revisits an existing table, so additive columns are applied
 * here — additive only, because a WAL database with runs in it is user data.
 */
const ADDED_COLUMNS: { table: string; column: string; ddl: string }[] = [
  {
    table: 'runs',
    column: 'issue_number',
    ddl: 'ALTER TABLE runs ADD COLUMN issue_number INTEGER',
  },
  { table: 'runs', column: 'issue_url', ddl: 'ALTER TABLE runs ADD COLUMN issue_url TEXT' },
  // Orchestrated runs: the generated plan travels with the run so retroactive
  // export and the Inspector's pipeline view never depend on the pipeline store.
  { table: 'runs', column: 'plan_json', ddl: 'ALTER TABLE runs ADD COLUMN plan_json TEXT' },
  {
    table: 'runs',
    column: 'orchestrated',
    ddl: 'ALTER TABLE runs ADD COLUMN orchestrated INTEGER DEFAULT 0',
  },
  {
    table: 'runs',
    column: 'amendments',
    ddl: 'ALTER TABLE runs ADD COLUMN amendments INTEGER DEFAULT 0',
  },
];

function addMissingColumns(db: Db): void {
  for (const { table, column, ddl } of ADDED_COLUMNS) {
    const columns = db.pragma(`table_info(${table})`) as { name: string }[];
    if (!columns.some((c) => c.name === column)) db.exec(ddl);
  }
}

export function openDb(dbPath: string): Db {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  addMissingColumns(db);
  return db;
}

export function projectDbPath(appSupportDir: string, projectPath: string): string {
  return join(projectDir(appSupportDir, projectPath), 'trace.db');
}

export function projectRunsDir(appSupportDir: string, projectPath: string): string {
  return join(projectDir(appSupportDir, projectPath), 'runs');
}

function projectDir(appSupportDir: string, projectPath: string): string {
  return join(appSupportDir, 'projects', projectHash(projectPath));
}

/**
 * The app's own trace, for children that outlive every run and belong to no
 * project — today that is the Bridge and nothing else.
 *
 * It is the same schema deliberately: the relaunch sweep, `openProcesses()`,
 * and the pid-recycle check are the machinery that reclaims an orphan, and a
 * second shape would mean a second implementation of all three. `runs` simply
 * stays empty here, which is what makes a null `run_id` satisfy its foreign key.
 */
export function appDbPath(appSupportDir: string): string {
  return join(appSupportDir, 'app', 'trace.db');
}

export function appRunsDir(appSupportDir: string): string {
  return join(appSupportDir, 'app', 'runs');
}
