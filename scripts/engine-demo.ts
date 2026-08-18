/**
 * M1 harness: drives the engine with no UI at all, so the run loop, the tracer,
 * and the WAL polling contract can be proven before Electron is in the picture.
 *
 *   bun run engine:demo              two code phases in a scratch repo
 *   bun run engine:demo --sweep      simulate a crash, then sweep
 *   bun run engine:demo --agent      real pi agent phase (needs a provider)
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, projectDbPath, projectRunsDir } from '../src/main/trace/db.js';
import { Tracer } from '../src/main/trace/tracer.js';
import { Executor } from '../src/main/engine/executor.js';
import { RunRegistry } from '../src/main/engine/registry.js';
import { BUILTIN_AGENTS } from '../src/main/store/builtin-agents.js';
import { defaultProject } from '../src/main/store/projects.js';
import { defaultSettings } from '../src/main/store/settings.js';
import type { PipelineDef, ProjectDef } from '../src/shared/types.js';

const args = new Set(process.argv.slice(2));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function sh(cwd: string, argv: string[]): string {
  return execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8' });
}

function scratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-demo-'));
  sh(dir, ['git', 'init', '-q', '-b', 'main']);
  sh(dir, ['git', 'config', 'user.email', 'demo@foundry.local']);
  sh(dir, ['git', 'config', 'user.name', 'Foundry Demo']);
  writeFileSync(join(dir, 'README.md'), '# demo\n');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'add.js'), 'export const add = (a, b) => a + b;\n');
  writeFileSync(
    join(dir, 'test.sh'),
    '#!/bin/sh\nnode -e "import(\'./src/add.js\').then(m => process.exit(m.add(2,2) === 4 ? 0 : 1))"\n',
  );
  sh(dir, ['chmod', '+x', 'test.sh']);
  sh(dir, ['git', 'add', '-A']);
  sh(dir, ['git', 'commit', '-qm', 'initial']);
  return dir;
}

const CODE_PIPELINE: PipelineDef = {
  id: 'demo-code',
  name: 'Demo: code phases only',
  description: 'Runs the project test command, then commits, with no agent involved.',
  acceptance: { kind: 'all_phases_pass' },
  phases: [
    {
      name: 'test',
      kind: 'code',
      description: "Run the scratch repo's test script and capture its exit status as evidence.",
      command: { ref: 'test' },
    },
    {
      name: 'touch_file',
      kind: 'code',
      description: 'Write a file so the commit phase has something real to record.',
      command: { argv: ['sh', '-c', 'echo "engine was here" > engine-demo.txt'] },
    },
    {
      name: 'commit',
      kind: 'code',
      description: 'Commit the worktree so the run leaves a reviewable history entry.',
      command: { builtin: 'git_commit' },
    },
  ],
};

const AGENT_PIPELINE: PipelineDef = {
  id: 'demo-agent',
  name: 'Demo: one agent phase',
  description: 'A single read-only scout turn against the scratch repo, with gates.',
  acceptance: { kind: 'envelope_status', phase: 'scout' },
  isolation: false,
  phases: [
    {
      name: 'scout',
      kind: 'agent',
      agent: 'scout',
      description: 'Report what the scratch repo contains, without changing anything.',
      envelope: 'scout',
      gates: ['artifacts_exist'],
      prompt: { template: 'user', inputs: ['request'] },
    },
  ],
};

async function main(): Promise<void> {
  const repo = scratchRepo();
  const appSupport = mkdtempSync(join(tmpdir(), 'foundry-support-'));
  const project: ProjectDef = {
    ...defaultProject(repo),
    commands: [{ name: 'test', argv: ['./test.sh'] }],
  };
  const settings = defaultSettings();

  console.log(`repo:        ${repo}`);
  console.log(`app support: ${appSupport}`);

  const db = openDb(projectDbPath(appSupport, repo));
  const tracer = new Tracer(db, projectRunsDir(appSupport, repo));

  if (args.has('--sweep')) {
    await sweepDemo(tracer, appSupport, project);
    return;
  }

  // Honour FOUNDRY_DEMO_MODEL so the demo is not bound to the caller's policy.
  const modelOverride = process.env.FOUNDRY_DEMO_MODEL;
  const agents = BUILTIN_AGENTS.map((a) => ({
    ...a,
    ...(modelOverride ? { model: modelOverride } : {}),
  }));

  const useAgent = args.has('--agent');
  const pipeline = useAgent ? AGENT_PIPELINE : CODE_PIPELINE;
  const request = useAgent
    ? 'What does this repository contain, and what does test.sh verify?'
    : 'Prove the engine sequences code phases and commits the result.';

  const runId = `run_demo_${Date.now().toString(36)}`;
  const executor = new Executor({
    tracer,
    turnTimeoutMs: 10 * 60_000,
    envelopeRetries: 2,
    gateRetries: 1,
    compactionThreshold: settings.compactionThreshold,
    rewindAfterCorrections: settings.rewindAfterCorrections,
    supportDir: appSupport,
    agents,
    envelopeDefs: [],
    project,
    pipeline,
    request,
    runId,
    engineer: 'demo',
    askHuman: async () => {
      console.log('  [interrupt] auto-approved by the demo harness');
      return { approve: true };
    },
    onLiveText: () => undefined,
  });

  // Poll with a change_id cursor the same way the renderer will.
  let cursor = 0;
  const poll = setInterval(() => {
    for (const e of tracer.eventsAfter(runId, cursor)) {
      cursor = Math.max(cursor, e.changeId);
      const label = e.name ? `${e.type} ${e.name}` : e.type;
      console.log(`  [${String(e.changeId).padStart(3)}] ${label}`);
    }
  }, 250);

  const outcome = await executor.run();
  await sleep(600);
  clearInterval(poll);

  const run = tracer.run(runId);
  console.log('');
  console.log(`status:  ${outcome.status} (db says ${run?.status})`);
  console.log(`detail:  ${outcome.detail}`);
  console.log(`branch:  ${outcome.branch ?? '(no isolation)'}`);
  console.log('phases:');
  for (const p of tracer.phases(runId)) {
    console.log(`  ${p.seq} ${p.name.padEnd(12)} ${p.status.padEnd(8)} ${p.error ?? ''}`);
  }
  const gates = tracer.gateResults(runId);
  if (gates.length > 0) {
    console.log('gates:');
    for (const g of gates) {
      console.log(`  ${g.gate} ${g.passed ? 'pass' : 'FAIL'}`);
      for (const c of g.checks) console.log(`    ${c.ok ? '+' : '-'} ${c.item}: ${c.note}`);
    }
  }
  const envelopes = tracer.envelopes(runId);
  if (envelopes.length > 0) {
    console.log('envelopes:');
    for (const e of envelopes) {
      console.log(`  ${e.schemaKind} attempt ${e.attempt} valid=${e.valid}`);
      console.log(`    ${JSON.stringify(e.payload).slice(0, 300)}`);
    }
  }
  console.log(`events:  ${tracer.eventsAfter(runId, 0, 10_000).length}`);
  const head = sh(outcome.worktreePath ?? repo, ['git', 'log', '--oneline'])
    .trim()
    .split('\n')[0];
  console.log(`git log: ${head}`);
  process.exit(outcome.status === 'accepted' ? 0 : 1);
}

/** Crash mid-flight, then prove sweep does not leave the run as `running`. */
async function sweepDemo(tracer: Tracer, appSupport: string, project: ProjectDef): Promise<void> {
  const runId = 'run_crashed_demo';
  tracer.startRun({
    runId,
    projectId: project.id,
    pipeline: CODE_PIPELINE,
    request: 'simulate a crash',
    engineer: 'demo',
    worktreePath: null,
    branch: null,
    baseRef: 'main',
    mode: 'pi',
  });
  const victim = spawn('sleep', ['300']);
  const rowId = tracer.recordProcess({
    runId,
    kind: 'engine',
    name: 'demo',
    pid: victim.pid!,
    command: 'sleep 300',
  });
  console.log(
    `recorded pid ${victim.pid} (row ${rowId}), run status = ${tracer.run(runId)?.status}`,
  );
  victim.kill('SIGKILL');
  await sleep(400);

  const registry = new RunRegistry({
    appSupportDir: appSupport,
    settings: () => defaultSettings(),
    engineerName: 'demo',
    onRunFinished: () => undefined,
    onInterruptsChanged: () => undefined,
    onRunsChanged: () => undefined,
  });
  const result = registry.sweep([project]);
  const after = tracer.run(runId);
  console.log(`sweep finalised: ${JSON.stringify(result.runsFinalised)}`);
  console.log(`run status now:  ${after?.status}`);
  process.exit(after?.status === 'failed' ? 0 : 1);
}

void main();
