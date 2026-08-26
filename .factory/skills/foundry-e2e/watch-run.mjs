#!/usr/bin/env node
/**
 * Read-only observer for a Foundry run, for the foundry-e2e skill.
 *
 * Opens the per-project trace.db (WAL) readonly — the same reads the renderer
 * does — and never writes, never signals a process. Two commands:
 *
 *   node watch-run.mjs tail <project> [--run <runId>] [--stall-min 10] [--interval 2]
 *     Follows a run, printing one NDJSON line per meaningful transition
 *     (phase status/attempt, gate result, envelope, run status). Exits 0 on a
 *     terminal run status, 3 when nothing has changed for --stall-min minutes
 *     while the run still claims to be running. Without --run it picks the
 *     newest 'running' run (falling back to the newest run) and says which.
 *
 *   node watch-run.mjs report <project> --run <runId> [--out <file>]
 *     Writes a Markdown grading dossier: run metadata, phase table, gates,
 *     envelopes, tokens, outcome, and the worktree diff when it still exists.
 *     Default output: /tmp/foundry-e2e/<runId>.md
 *
 * <project> is a project path (e.g. /Users/nik/repos/foundry), a project id,
 * or a project name as listed in projects.json.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

// Resolved from the repo's node_modules (this file lives under .factory/skills/).
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const SUPPORT_DIR =
  process.env.FOUNDRY_SUPPORT_DIR ?? join(homedir(), 'Library/Application Support/foundry/foundry');

const TERMINAL = new Set(['accepted', 'rejected', 'failed', 'killed']);

function fail(msg) {
  process.stderr.write(`watch-run: ${msg}\n`);
  process.exit(2);
}

function loadProjects() {
  const file = join(SUPPORT_DIR, 'projects.json');
  if (!existsSync(file)) fail(`no projects.json at ${file}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

function projectHash(projectPath) {
  return createHash('sha256').update(projectPath).digest('hex').slice(0, 16);
}

function resolveProject(ref) {
  const projects = loadProjects();
  const project = projects.find((p) => p.path === ref || p.id === ref || p.name === ref);
  if (!project) {
    fail(
      `project '${ref}' not found; known: ${projects.map((p) => `${p.name} (${p.path})`).join(', ')}`,
    );
  }
  const dbPath = join(SUPPORT_DIR, 'projects', projectHash(project.path), 'trace.db');
  if (!existsSync(dbPath)) fail(`no trace.db for ${project.name} at ${dbPath}`);
  return { project, dbPath };
}

function openReadonly(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  return db;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
    else args._.push(a);
  }
  return args;
}

function pickRun(db, runId) {
  if (runId) {
    const run = db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId);
    if (!run) fail(`run ${runId} not found`);
    return run;
  }
  const running = db
    .prepare("SELECT * FROM runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1")
    .get();
  if (running) return running;
  const newest = db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 1').get();
  if (!newest) fail('no runs in this project');
  return newest;
}

function snapshotRun(db, runId) {
  return {
    run: db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId),
    phases: db.prepare('SELECT * FROM phases WHERE run_id = ? ORDER BY seq').all(runId),
    gates: db
      .prepare('SELECT * FROM gate_results WHERE run_id = ? ORDER BY id')
      .all(runId),
    envelopes: db
      .prepare('SELECT * FROM envelopes WHERE run_id = ? ORDER BY created_at')
      .all(runId),
    maxChange: db
      .prepare('SELECT COALESCE(MAX(change_id), 0) AS c FROM events WHERE run_id = ?')
      .get(runId).c,
  };
}

function emit(obj) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function tail(args) {
  const { project, dbPath } = resolveProject(args._[0] ?? fail('tail needs a project'));
  const db = openReadonly(dbPath);
  const run = pickRun(db, args.run);
  const stallMs = Number(args['stall-min'] ?? 10) * 60_000;
  const intervalMs = Number(args.interval ?? 2) * 1000;

  emit({
    kind: 'watching',
    project: project.name,
    runId: run.run_id,
    pipeline: run.pipeline_name,
    status: run.status,
    worktree: run.worktree_path,
    branch: run.branch,
  });

  let prev = snapshotRun(db, run.run_id);
  for (const p of prev.phases) {
    emit({ kind: 'phase', name: p.name, phaseKind: p.kind, status: p.status, attempt: p.attempt });
  }
  let lastActivity = Date.now();

  while (true) {
    if (TERMINAL.has(prev.run.status)) {
      emit({
        kind: 'terminal',
        runId: run.run_id,
        status: prev.run.status,
        outcomeDetail: prev.run.outcome_detail,
        totalTokens: prev.run.total_tokens,
        worktree: prev.run.worktree_path,
        branch: prev.run.branch,
      });
      process.exit(0);
    }
    await sleep(intervalMs);
    const next = snapshotRun(db, run.run_id);
    let changed = next.maxChange !== prev.maxChange;

    const prevPhases = new Map(prev.phases.map((p) => [p.phase_id, p]));
    for (const p of next.phases) {
      const old = prevPhases.get(p.phase_id);
      if (!old || old.status !== p.status || old.attempt !== p.attempt) {
        changed = true;
        emit({
          kind: 'phase',
          name: p.name,
          phaseKind: p.kind,
          status: p.status,
          attempt: p.attempt,
          error: p.error ?? undefined,
        });
      }
    }
    for (const g of next.gates.slice(prev.gates.length)) {
      changed = true;
      emit({ kind: 'gate', gate: g.gate, passed: !!g.passed, attempt: g.attempt });
    }
    for (const e of next.envelopes.slice(prev.envelopes.length)) {
      changed = true;
      emit({ kind: 'envelope', agent: e.agent, schema: e.schema_kind, valid: !!e.valid });
    }
    if (next.run.status !== prev.run.status) {
      changed = true;
      emit({ kind: 'status', status: next.run.status });
    }

    if (changed) lastActivity = Date.now();
    else if (Date.now() - lastActivity > stallMs) {
      emit({
        kind: 'stall',
        runId: run.run_id,
        idleMinutes: Math.round((Date.now() - lastActivity) / 60_000),
        note: 'no trace activity; decide whether the run is legitimately slow or wedged',
      });
      process.exit(3);
    }
    prev = next;
  }
}

const DIFF_LINE_CAP = 4000;

function worktreeDiff(run) {
  const wt = run.worktree_path;
  if (!wt || !existsSync(wt)) return null;
  const base = run.branch_point_sha || run.base_ref || 'main';
  const git = (...argv) =>
    execFileSync('git', ['-C', wt, ...argv], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  try {
    const stat = git('diff', '--stat', base, 'HEAD');
    let diff = git('diff', base, 'HEAD');
    const lines = diff.split('\n');
    let truncated = false;
    if (lines.length > DIFF_LINE_CAP) {
      diff = lines.slice(0, DIFF_LINE_CAP).join('\n');
      truncated = true;
    }
    return { base, stat, diff, truncated };
  } catch (err) {
    return { base, error: String(err.message ?? err) };
  }
}

function mdEscape(text) {
  return String(text ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function report(args) {
  const { project, dbPath } = resolveProject(args._[0] ?? fail('report needs a project'));
  const db = openReadonly(dbPath);
  if (!args.run) fail('report needs --run <runId>');
  const { run, phases, gates, envelopes } = snapshotRun(db, args.run);
  if (!run) fail(`run ${args.run} not found`);
  const sessions = db
    .prepare('SELECT * FROM agent_sessions WHERE run_id = ?')
    .all(run.run_id);
  const modelByAgent = new Map(sessions.map((s) => [s.agent, s.model]));

  const lines = [];
  lines.push(`# Foundry E2E run dossier — ${run.run_id}`);
  lines.push('');
  lines.push(`- **Project:** ${project.name} (${project.path})`);
  lines.push(`- **Pipeline:** ${run.pipeline_name ?? run.pipeline_id}${run.orchestrated ? ' (orchestrated)' : ''}`);
  lines.push(`- **Status:** ${run.status}${run.merged ? ' (merged)' : ''}`);
  lines.push(`- **Outcome detail:** ${run.outcome_detail ?? '—'}`);
  lines.push(`- **Started:** ${run.started_at}  **Ended:** ${run.ended_at ?? '—'}`);
  lines.push(`- **Total tokens:** ${run.total_tokens ?? 0}`);
  lines.push(`- **Worktree:** ${run.worktree_path ?? '—'}  **Branch:** ${run.branch ?? '—'}  **Base:** ${run.base_ref ?? '—'}`);
  lines.push('');
  lines.push('## Request');
  lines.push('');
  lines.push('```');
  lines.push(run.request ?? '(none recorded)');
  lines.push('```');

  if (run.plan_json) {
    try {
      const plan = JSON.parse(run.plan_json);
      if (plan.refinedRequest) {
        lines.push('', '## Refined request (orchestrator)', '', '```', plan.refinedRequest, '```');
      }
      if (plan.rationale) {
        lines.push('', '**Plan rationale:** ' + plan.rationale);
      }
    } catch {
      /* plan_json unreadable; the raw column stays inspectable in the db */
    }
  }

  lines.push('', '## Phases', '');
  lines.push('| # | Phase | Kind | Owner | Model | Status | Attempts | Duration | Error |');
  lines.push('|---|-------|------|-------|-------|--------|----------|----------|-------|');
  for (const p of phases) {
    const dur =
      p.started_at && p.ended_at
        ? `${Math.round((new Date(p.ended_at) - new Date(p.started_at)) / 1000)}s`
        : '—';
    lines.push(
      `| ${p.seq} | ${mdEscape(p.name)} | ${p.kind} | ${mdEscape(p.owner ?? '—')} | ${mdEscape(
        modelByAgent.get(p.owner) ?? '—',
      )} | ${p.status} | ${p.attempt} | ${dur} | ${mdEscape(p.error ?? '')} |`,
    );
  }

  if (gates.length) {
    const phaseName = new Map(phases.map((p) => [p.phase_id, p.name]));
    lines.push('', '## Gate results', '');
    lines.push('| Phase | Gate | Attempt | Passed | Checks |');
    lines.push('|-------|------|---------|--------|--------|');
    for (const g of gates) {
      lines.push(
        `| ${mdEscape(phaseName.get(g.phase_id) ?? g.phase_id)} | ${mdEscape(g.gate)} | ${
          g.attempt ?? '—'
        } | ${g.passed ? 'yes' : 'NO'} | ${mdEscape(g.checks_json ?? '')} |`,
      );
    }
  }

  if (envelopes.length) {
    const phaseName = new Map(phases.map((p) => [p.phase_id, p.name]));
    lines.push('', '## Envelopes', '');
    for (const e of envelopes) {
      lines.push(
        `### ${e.agent ?? '?'} — ${e.schema_kind ?? '?'} (phase ${phaseName.get(e.phase_id) ?? '?'}, attempt ${e.attempt ?? '?'}, ${e.valid ? 'valid' : 'INVALID'})`,
        '',
        '```json',
      );
      try {
        lines.push(JSON.stringify(JSON.parse(e.payload_json), null, 2));
      } catch {
        lines.push(String(e.payload_json).slice(0, 4000));
      }
      lines.push('```', '');
    }
  }

  const diff = worktreeDiff(run);
  lines.push('', '## Worktree diff');
  if (!diff) {
    lines.push('', 'Worktree no longer exists; diff unavailable.');
  } else if (diff.error) {
    lines.push('', `git diff against ${diff.base} failed: ${diff.error}`);
  } else {
    lines.push('', `Against \`${diff.base}\`:`, '', '```', diff.stat.trimEnd(), '```', '');
    lines.push('```diff');
    lines.push(diff.diff.trimEnd());
    lines.push('```');
    if (diff.truncated) lines.push('', `_Diff truncated at ${DIFF_LINE_CAP} lines; full diff in the worktree._`);
  }

  const out = args.out ?? join('/tmp/foundry-e2e', `${run.run_id}.md`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, lines.join('\n') + '\n');
  process.stdout.write(out + '\n');
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._.shift();
if (cmd === 'tail') await tail(args);
else if (cmd === 'report') report(args);
else fail('usage: watch-run.mjs <tail|report> <project> [--run id] [--stall-min n] [--out file]');
