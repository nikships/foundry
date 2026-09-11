/**
 * Shared test harness and helpers for Executor test suites.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../helpers/tmp.js';
import { openDb, projectDbPath, projectRunsDir, type Db } from '../../../src/main/trace/db.js';
import { Tracer } from '../../../src/main/trace/tracer.js';
import { Executor, type ExecutorDeps } from '../../../src/main/engine/executor.js';
import { defaultProject } from '../../../src/main/store/projects.js';
import type {
  AgentDef,
  CommandSpec,
  EnvelopeDef,
  LinearRunSource,
  PhaseDef,
  PipelineDef,
  ProjectDef,
} from '../../../src/shared/types.js';
import type { RunSourceLifecycle } from '../../../src/main/engine/source-lifecycle.js';
import type { GhOptions } from '../../../src/main/system/gh.js';
import {
  ScriptedAgent,
  type AskReply,
  type ScriptedAgentOptions,
  type ScriptedAsk,
} from '../../helpers/scripted-transport.js';

export function sh(cwd: string, argv: string[]): string {
  try {
    return execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8' });
  } catch (e) {
    // execFileSync reports only "Command failed", which turns any setup failure
    // into an unactionable one; the command's own stderr says what happened.
    const stderr = (e as { stderr?: string }).stderr ?? '';
    throw new Error(`${argv.join(' ')} failed in ${cwd}: ${stderr.trim() || String(e)}`);
  }
}

export function scratchRepo(): string {
  const dir = tempDir('foundry-exec-');
  sh(dir, ['git', 'init', '-q', '-b', 'main']);
  sh(dir, ['git', 'config', 'user.email', 'test@foundry.local']);
  sh(dir, ['git', 'config', 'user.name', 'Foundry Test']);
  writeFileSync(join(dir, 'README.md'), '# scratch\n');
  sh(dir, ['git', 'add', '-A']);
  sh(dir, ['git', 'commit', '-qm', 'initial']);
  return dir;
}

export function emptyRepo(): string {
  const dir = tempDir('foundry-empty-exec-');
  sh(dir, ['git', 'init', '-q', '-b', 'main']);
  sh(dir, ['git', 'config', 'user.email', 'test@foundry.local']);
  sh(dir, ['git', 'config', 'user.name', 'Foundry Test']);
  return dir;
}

/**
 * The scripted agent for the run currently under construction.
 *
 * Agent phases run in process, so a test scripts the transport rather than a
 * child: `run({ scripted })` hands this to the executor's `transport` seam and
 * the engine drives the production `AgentSession`, policy, and event folding on
 * top of it.
 */
export function scriptedAgent(
  turns: string[],
  sideEffects: (string | null)[] = [],
  asks: ScriptedAsk[][] = [],
  options: ScriptedAgentOptions = {},
): ScriptedAgent {
  return new ScriptedAgent(turns, sideEffects, asks, options);
}

/** The replies the scripted agent got back, in the order it raised the asks. */
export function askReplies(agent: ScriptedAgent): AskReply[] {
  return agent.askReplies;
}

/** Every turn the engine sent, in order — the wire, not the trace. */
export function turnRequests(agent: ScriptedAgent): {
  text: string;
  outputFormat?: unknown;
  systemPrompt?: string;
  sessionId: string;
}[] {
  return agent.turnRequests;
}

/**
 * The session's wire history: every request the engine made plus the turn
 * boundaries the agent answered with, in order. Whether compaction happened
 * mid-turn is only knowable from this ordering.
 */
export function wireLog(agent: ScriptedAgent): string[] {
  return agent.wire;
}

/** `"turn <index>"` per turn the scripted agent has begun. */
export function turnMarkers(agent: ScriptedAgent): string[] {
  return agent.turnMarkers;
}

/** Whether the scripted agent has begun a turn, i.e. a turn is in flight. */
export function turnStarted(agent: ScriptedAgent): boolean {
  return agent.turnStarted;
}

/** How many sessions the run has opened, resumes included. */
export function handshakeCount(agent: ScriptedAgent): number {
  return agent.sessionOpens;
}

/** Waits for a condition the scripted agent reports. */
export async function until(
  predicate: () => boolean,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export const buildAgent = (over: Partial<AgentDef> = {}): AgentDef => ({
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

export function codePhase(
  name: string,
  command: CommandSpec,
  over: Partial<PhaseDef> = {},
): PhaseDef {
  return { name, kind: 'code', description: over.description ?? name, command, ...over };
}

export function agentPhase(name: string, over: Partial<PhaseDef> = {}): PhaseDef {
  return {
    name,
    kind: 'agent',
    agent: 'builder',
    description: over.description ?? name,
    envelope: 'build',
    prompt: { inputs: ['request'] },
    ...over,
  };
}

export function pipe(phases: PhaseDef[], over: Partial<PipelineDef> = {}): PipelineDef {
  return {
    id: 'p',
    name: 'p',
    description: over.description ?? 'test pipeline',
    acceptance: { kind: 'all_phases_pass' },
    phases,
    ...over,
  };
}

export const linearSource: LinearRunSource = {
  kind: 'linear',
  trigger: 'manual',
  issueId: 'issue-uuid',
  url: 'https://linear.app/foundry/issue/FOU-190',
  revision: '2026-08-25T19:09:16.054Z',
  statusMapping: { started: 'started', completed: 'completed', failed: 'failed' },
  snapshot: {
    id: 'issue-uuid',
    identifier: 'FOU-190',
    title: 'Add Linear integration',
    description: 'Start this pipeline from Linear.',
    url: 'https://linear.app/foundry/issue/FOU-190',
    updatedAt: '2026-08-25T19:09:16.054Z',
    team: { id: 'team-uuid', name: 'Foundry' },
    state: { id: 'todo', name: 'Todo', type: 'unstarted' },
  },
};

export function buildEnvelope(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: 'success',
    summary: 'built it',
    artifacts: [],
    commit_message: 'add a thing',
    notes_for_next_agent: '',
    ...over,
  });
}

export function reviewEnvelope(approved: boolean): string {
  return JSON.stringify({
    status: 'success',
    summary: 'reviewed',
    artifacts: [],
    approved,
    findings: [
      {
        requirement: 'it works',
        met: approved,
        evidence: approved ? 'it does' : 'it does not',
      },
    ],
    blocking: approved ? [] : ['it does not work'],
    notes_for_next_agent: '',
  });
}

export function prEnvelope(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: 'success',
    summary: 'drafted the pull request',
    artifacts: [],
    notes_for_next_agent: '',
    title: 'Add the thing',
    body: '## Summary\n\nIt works.\n',
    ...over,
  });
}

/** Point the scratch checkout at a local bare origin so push works offline. */
export function addOrigin(repo: string): string {
  const dir = tempDir('foundry-exec-origin-');
  const bare = join(dir, 'origin.git');
  sh(dir, ['git', 'init', '-q', '--bare', '-b', 'main', 'origin.git']);
  sh(repo, ['git', 'remote', 'add', 'origin', bare]);
  sh(repo, ['git', 'push', '-qu', 'origin', 'main']);
  return bare;
}

export function prWriter(): AgentDef {
  return buildAgent({
    name: 'pr_writer',
    purpose: 'draft a pr',
    envelope: 'pr',
    writes: [],
    userPrompt: 'Draft a PR for {{request}} on {{branch}} against {{base_ref}}.',
  });
}

export function issueWriter(): AgentDef {
  return buildAgent({
    name: 'issue_writer',
    purpose: 'draft an issue',
    envelope: 'issue',
    writes: [],
    userPrompt: 'Draft an issue for {{request}}.',
  });
}

export function issueEnvelope(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: 'success',
    summary: 'drafted the issue',
    artifacts: [],
    notes_for_next_agent: '',
    title: 'Fix the thing',
    body: '## Problem\n\nIt is broken.\n',
    labels: [],
    ...over,
  });
}

export function fileIssuePhase(over: Partial<PhaseDef> = {}): PhaseDef {
  return agentPhase('file_issue', {
    agent: 'issue_writer',
    envelope: 'issue',
    description: 'File the GitHub issue that tracks the diagnosed problem.',
    prompt: { inputs: ['request'] },
    ...over,
  });
}

export function openPrPhase(over: Partial<PhaseDef> = {}): PhaseDef {
  return agentPhase('open_pr', {
    agent: 'pr_writer',
    envelope: 'pr',
    description: 'Open a pull request with a human-readable title and body.',
    prompt: { inputs: ['request', 'envelope:plan', 'envelope:build'] },
    ...over,
  });
}

export interface Harness {
  repo: string;
  project: ProjectDef;
  tracer: Tracer;
  support: string;
  db: Db;
}

export function createHarness(): Harness {
  const repo = scratchRepo();
  const support = tempDir('foundry-support-');
  const db = openDb(projectDbPath(support, repo));
  return {
    repo,
    support,
    db,
    tracer: new Tracer(db, projectRunsDir(support, repo)),
    project: { ...defaultProject(repo), mergePolicy: 'never' },
  };
}

export interface ProcessRow {
  kind: string;
  name: string;
  pid: number;
  command: string;
  ended_at: string | null;
}

/** Every recorded child, open or closed — `openProcesses` only shows the open ones. */
export function processRowsForHarness(h: Harness, runId: string): ProcessRow[] {
  return h.db
    .prepare('SELECT kind, name, pid, command, ended_at FROM processes WHERE run_id = ?')
    .all(runId) as ProcessRow[];
}

export interface RunInput {
  pipeline: PipelineDef;
  agents?: AgentDef[];
  envelopeDefs?: EnvelopeDef[];
  scripted?: ScriptedAgent;
  /** Reason the session could not be opened, when the run must fail to open one. */
  sessionUnavailable?: string;
  request?: string;
  project?: Partial<ProjectDef>;
  /** The install default an `inherit` roster model resolves against. */
  defaultModel?: string;
  envelopeRetries?: number;
  gateRetries?: number;
  compactionThreshold?: number;
  rewindAfterCorrections?: number;
  /** Omitted means no healing, which is what a run with no model configured gets. */
  healing?: ExecutorDeps['healing'];
  gh?: GhOptions;
  landing?: ExecutorDeps['landing'];
  source?: ExecutorDeps['source'];
  sourceLifecycle?: RunSourceLifecycle;
}

export function transportSeam(input: RunInput): ExecutorDeps['transport'] {
  const agent =
    input.scripted ??
    new ScriptedAgent(
      [],
      [],
      [],
      input.sessionUnavailable ? { unavailable: input.sessionUnavailable } : {},
    );
  return (req) => agent.transport(req);
}

export function startForHarness(
  h: Harness,
  input: RunInput,
): {
  executor: Executor;
  runId: string;
  done: Promise<{ status: string; runId: string }>;
} {
  const runId = `run_${Math.random().toString(36).slice(2, 8)}`;
  const executor = new Executor({
    tracer: h.tracer,
    defaultModel: input.defaultModel,
    envelopeRetries: input.envelopeRetries ?? 2,
    gateRetries: input.gateRetries ?? 2,
    compactionThreshold: input.compactionThreshold ?? 0.8,
    rewindAfterCorrections: input.rewindAfterCorrections ?? 2,
    healing: input.healing ?? null,
    supportDir: h.support,
    transport: transportSeam(input),
    agents: input.agents ?? [buildAgent()],
    envelopeDefs: input.envelopeDefs ?? [],
    project: { ...h.project, ...input.project },
    pipeline: input.pipeline,
    request: input.request ?? 'do the thing',
    source: input.source,
    sourceLifecycle: input.sourceLifecycle,
    runId,
    engineer: 'test',
    gh: input.gh,
    landing: input.landing,
  });
  return { executor, runId, done: executor.run().then((o) => ({ status: o.status, runId })) };
}

export function runForHarness(
  h: Harness,
  input: RunInput,
): Promise<{ status: string; runId: string }> {
  const started = startForHarness(h, input);
  return started.done;
}

export function eventsForHarness(h: Harness, runId: string) {
  return h.tracer.eventsAfter(runId, 0, 1000);
}
