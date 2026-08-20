/**
 * The companion host against a real temp project and the scripted transport.
 * Every request is a real HTTP round trip on a loopback bind: pairing spends a
 * short-lived secret, the token gates every route fail-closed, and the run
 * routes drive the production executor — no network beyond the loopback, no
 * model, no mocked git.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../helpers/tmp.js';
import { openDb, projectDbPath, projectRunsDir } from '../../../src/main/trace/db.js';
import { Tracer } from '../../../src/main/trace/tracer.js';
import { Executor } from '../../../src/main/engine/executor.js';
import { CompanionHost, lanAddress, lanInterface } from '../../../src/main/companion/host.js';
import { PairingSecrets, PAIRING_SECRET_TTL_MS } from '../../../src/main/companion/pairing.js';
import { DeviceStore, LAST_SEEN_DEBOUNCE_MS } from '../../../src/main/companion/devices.js';
import { defaultProject } from '../../../src/main/store/projects.js';
import { COMPANION_PROTOCOL_VERSION } from '../../../src/shared/companion.js';
import type {
  CompanionError,
  CompanionPairingPayload,
  CompanionPairResult,
} from '../../../src/shared/companion.js';
import type { EventPage, RunDetail } from '../../../src/shared/ipc-contract.js';
import type {
  AgentDef,
  AppSettings,
  InterruptAnswer,
  PendingInterrupt,
  PipelineDef,
  ProjectDef,
  RunRow,
} from '../../../src/shared/types.js';
import { makeFakeGh, type FakeGh } from '../../helpers/fake-gh.js';
import { ScriptedAgent, type ScriptedAgentOptions } from '../../helpers/scripted-transport.js';

function sh(cwd: string, argv: string[]): string {
  try {
    return execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8' });
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr ?? '';
    throw new Error(`${argv.join(' ')} failed in ${cwd}: ${stderr.trim() || String(e)}`);
  }
}

function scratchRepo(): string {
  const dir = tempDir('foundry-companion-');
  sh(dir, ['git', 'init', '-q', '-b', 'main']);
  sh(dir, ['git', 'config', 'user.email', 'test@foundry.local']);
  sh(dir, ['git', 'config', 'user.name', 'Foundry Test']);
  writeFileSync(join(dir, 'README.md'), '# scratch\n');
  sh(dir, ['git', 'add', '-A']);
  sh(dir, ['git', 'commit', '-qm', 'initial']);
  return dir;
}

/** Point the scratch checkout at a local bare origin so push works offline. */
function addOrigin(repo: string): void {
  const dir = tempDir('foundry-companion-origin-');
  sh(dir, ['git', 'init', '-q', '--bare', '-b', 'main', 'origin.git']);
  sh(repo, ['git', 'remote', 'add', 'origin', join(dir, 'origin.git')]);
  sh(repo, ['git', 'push', '-qu', 'origin', 'main']);
}

const buildAgent = (): AgentDef => ({
  name: 'builder',
  purpose: 'build things',
  model: 'scripted',
  reasoningEffort: 'medium',
  systemPrompt: 'You build.',
  userPrompt: 'Build: {{request}}',
  writes: null,
  envelope: 'build',
  color: '#5ad2dd',
});

const pipeline = (): PipelineDef => ({
  id: 'p',
  name: 'p',
  description: 'test pipeline',
  acceptance: { kind: 'all_phases_pass' },
  phases: [
    {
      name: 'build',
      kind: 'agent',
      agent: 'builder',
      description: 'build it',
      envelope: 'build',
      prompt: { inputs: ['request'] },
    },
  ],
});

const buildEnvelope = (): string =>
  JSON.stringify({
    status: 'success',
    summary: 'built it',
    artifacts: [],
    commit_message: 'add a thing',
    notes_for_next_agent: '',
  });

/**
 * A registry-lite over the production `Executor` with the scripted transport:
 * the host's registry seam, driven exactly the way `RunRegistry` drives it but
 * without `PiTransport` (a unit test has no model to run one on).
 */
class TestRegistry {
  private readonly live = new Map<string, Executor>();
  readonly settled = new Map<string, Promise<string>>();
  private seq = 0;
  pendingInterrupts: PendingInterrupt[] = [];
  answered: InterruptAnswer[] = [];
  continued: string[] = [];

  constructor(
    private readonly tracer: Tracer,
    private readonly support: string,
    private readonly scripted: () => ScriptedAgent,
  ) {}

  start(input: { project: ProjectDef; pipeline: PipelineDef; request: string }): string {
    const runId = `run_companion_${++this.seq}`;
    const agent = this.scripted();
    const executor = new Executor({
      tracer: this.tracer,
      turnTimeoutMs: 30_000,
      envelopeRetries: 2,
      gateRetries: 2,
      compactionThreshold: 0.8,
      rewindAfterCorrections: 2,
      supportDir: this.support,
      transport: (req) => agent.transport(req),
      agents: [buildAgent()],
      envelopeDefs: [],
      project: input.project,
      pipeline: input.pipeline,
      request: input.request,
      runId,
      engineer: 'test',
      askHuman: async () => ({ approve: true }),
    });
    this.live.set(runId, executor);
    this.settled.set(
      runId,
      executor.run().then((o) => {
        this.live.delete(runId);
        return o.status;
      }),
    );
    return runId;
  }

  tracerFor(): Tracer {
    return this.tracer;
  }

  isLive(runId: string): boolean {
    return this.live.has(runId);
  }

  kill(_project: ProjectDef, runId: string): boolean {
    const executor = this.live.get(runId);
    if (!executor) return false;
    executor.cancel();
    return true;
  }

  resume(input: { runId: string }): { ok: boolean; detail: string } {
    this.continued.push(input.runId);
    return { ok: true, detail: 'Continuing run' };
  }

  interrupts(): PendingInterrupt[] {
    return this.pendingInterrupts;
  }

  answer(answer: InterruptAnswer): boolean {
    this.answered.push(answer);
    const idx = this.pendingInterrupts.findIndex((i) => i.interruptId === answer.interruptId);
    if (idx !== -1) {
      this.pendingInterrupts.splice(idx, 1);
      return true;
    }
    return false;
  }
}

interface Harness {
  host: CompanionHost;
  registry: TestRegistry;
  tracer: Tracer;
  project: ProjectDef;
  repo: string;
  support: string;
  gh: FakeGh;
  origin: () => string;
  changes: string[];
  /** A second host over the same support dir: what a relaunch looks like. */
  relaunch: () => CompanionHost;
}

let h: Harness;
let scriptedOptions: ScriptedAgentOptions = {};

beforeEach(async () => {
  scriptedOptions = {};
  const repo = scratchRepo();
  const support = tempDir('foundry-companion-support-');
  const project = { ...defaultProject(repo), mergePolicy: 'never' as const };
  const tracer = new Tracer(openDb(projectDbPath(support, repo)), projectRunsDir(support, repo));
  const registry = new TestRegistry(tracer, support, () => {
    return new ScriptedAgent([buildEnvelope()], [], [], scriptedOptions);
  });
  const gh = makeFakeGh({ createUrl: 'https://github.com/acme/widgets/pull/7' });
  const changes: string[] = [];
  const makeHost = (): CompanionHost =>
    new CompanionHost({
      supportDir: support,
      projects: () => [project],
      projectById: (id) => (id === project.id ? project : null),
      pipelinesFor: () => [pipeline()],
      rosterFor: () => [buildAgent()],
      envelopeDefs: () => [],
      settings: () => ({}) as AppSettings,
      saveProject: (next) => next,
      oneShot: () => {
        throw new Error('the companion suite never opens a one-shot');
      },
      registry,
      appVersion: () => '0.0.0-test',
      notifyRuns: () => undefined,
      onStateChanged: () => changes.push('changed'),
      bindHost: '127.0.0.1',
      gh: { bin: gh.bin },
    });
  const host = makeHost();
  const state = await host.start();
  if (!state.running || !state.origin) throw new Error(`host did not start: ${state.detail}`);
  h = {
    host,
    registry,
    tracer,
    project,
    repo,
    support,
    gh,
    origin: () => host.state().origin!,
    changes,
    relaunch: makeHost,
  };
});

afterEach(async () => {
  await h.host.stop();
});

async function pairPhone(name = 'Test Phone'): Promise<CompanionPairResult> {
  const payload = h.host.pairingPayload();
  if (!payload) throw new Error('no pairing payload while running');
  const res = await fetch(`${h.origin()}/pair`, {
    method: 'POST',
    body: JSON.stringify({
      protocolVersion: payload.protocolVersion,
      secret: payload.secret,
      deviceName: name,
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as CompanionPairResult;
}

function authed(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${h.origin()}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

async function until(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('pairing', () => {
  it('puts the origin, desktop identity, and protocol version in the QR payload', () => {
    const payload = h.host.pairingPayload() as CompanionPairingPayload;
    expect(payload.origin).toBe(h.origin());
    expect(payload.protocolVersion).toBe(COMPANION_PROTOCOL_VERSION);
    expect(payload.desktopId).toMatch(/^desk_/);
    expect(payload.secret.length).toBeGreaterThan(20);
    expect(new Date(payload.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('exchanges the pairing secret for a device token exactly once', async () => {
    const payload = h.host.pairingPayload() as CompanionPairingPayload;
    const first = await fetch(`${h.origin()}/pair`, {
      method: 'POST',
      body: JSON.stringify({
        protocolVersion: COMPANION_PROTOCOL_VERSION,
        secret: payload.secret,
        deviceName: 'Pixel',
      }),
    });
    expect(first.status).toBe(200);
    const paired = (await first.json()) as CompanionPairResult;
    expect(paired.token.length).toBeGreaterThan(20);
    expect(paired.deviceId).toMatch(/^dev_/);

    // A replayed exchange finds the secret already spent.
    const replay = await fetch(`${h.origin()}/pair`, {
      method: 'POST',
      body: JSON.stringify({
        protocolVersion: COMPANION_PROTOCOL_VERSION,
        secret: payload.secret,
        deviceName: 'Impostor',
      }),
    });
    expect(replay.status).toBe(401);
    const error = (await replay.json()) as CompanionError;
    expect(error.error.code).toBe('pairing_invalid');
  });

  it('refuses an older phone with a readable protocol error', async () => {
    const payload = h.host.pairingPayload() as CompanionPairingPayload;
    const res = await fetch(`${h.origin()}/pair`, {
      method: 'POST',
      body: JSON.stringify({
        protocolVersion: COMPANION_PROTOCOL_VERSION - 1,
        secret: payload.secret,
        deviceName: 'Old Phone',
      }),
    });
    expect(res.status).toBe(409);
    const error = (await res.json()) as CompanionError;
    expect(error.error.code).toBe('protocol_mismatch');
    expect(error.error.message).toContain('update the older app');
  });

  it('expires a secret on the clock, without anyone spending it', () => {
    let now = 1_000_000;
    const secrets = new PairingSecrets(() => now);
    const { secret } = secrets.issue();
    now += PAIRING_SECRET_TTL_MS + 1;
    expect(secrets.redeem(secret)).toBe(false);
    expect(secrets.current()).toBeNull();
  });

  it('re-reading pairingPayload does not rotate the in-flight secret', () => {
    const first = h.host.pairingPayload() as CompanionPairingPayload;
    const second = h.host.pairingPayload() as CompanionPairingPayload;
    expect(second.secret).toBe(first.secret);
    expect(second.expiresAt).toBe(first.expiresAt);
    expect(second.origin).toBe(first.origin);
  });

  it('explicit refresh mints a new secret; later reads keep that one', () => {
    const first = h.host.pairingPayload() as CompanionPairingPayload;
    const refreshed = h.host.pairingPayload({ refresh: true }) as CompanionPairingPayload;
    expect(refreshed.secret).not.toBe(first.secret);
    const reread = h.host.pairingPayload() as CompanionPairingPayload;
    expect(reread.secret).toBe(refreshed.secret);
    expect(reread.expiresAt).toBe(refreshed.expiresAt);
  });

  it('issues a new payload after the displayed secret is spent', async () => {
    const first = h.host.pairingPayload() as CompanionPairingPayload;
    const res = await fetch(`${h.origin()}/pair`, {
      method: 'POST',
      body: JSON.stringify({
        protocolVersion: COMPANION_PROTOCOL_VERSION,
        secret: first.secret,
        deviceName: 'Pixel',
      }),
    });
    expect(res.status).toBe(200);
    const next = h.host.pairingPayload() as CompanionPairingPayload;
    expect(next.secret).not.toBe(first.secret);
  });

  it('announces pair and unpair on the state-changed seam', async () => {
    const before = h.changes.length;
    const paired = await pairPhone();
    expect(h.changes.length).toBeGreaterThan(before);
    h.host.unpair(paired.deviceId);
    expect(h.host.state().devices).toEqual([]);
  });
});

describe('token auth, fail closed', () => {
  it.each([
    ['GET', '/v1/session'],
    ['GET', '/v1/projects'],
    ['GET', '/v1/interrupts'],
    ['POST', '/v1/runs'],
    ['GET', '/v1/projects/x/runs'],
    ['GET', '/v1/projects/x/runs/y'],
    ['GET', '/v1/projects/x/runs/y/events'],
    ['POST', '/v1/projects/x/runs/y/kill'],
    ['POST', '/v1/projects/x/runs/y/continue'],
    ['POST', '/v1/projects/x/runs/y/pr'],
    ['GET', '/v1/projects/x/runs/y/pr-draft'],
    ['GET', '/v1/projects/x/pr-status'],
    ['POST', '/v1/interrupts/answer'],
  ])('rejects a missing token on %s %s', async (method, path) => {
    const res = await fetch(`${h.origin()}${path}`, { method });
    expect(res.status).toBe(401);
    const error = (await res.json()) as CompanionError;
    expect(error.error.code).toBe('unauthorized');
  });

  it('rejects a token it never issued', async () => {
    const res = await authed('a'.repeat(43), '/v1/projects');
    expect(res.status).toBe(401);
  });

  it('answers 401 before 404, so an unpaired caller cannot map the surface', async () => {
    const res = await fetch(`${h.origin()}/v1/definitely-not-a-route`);
    expect(res.status).toBe(401);
  });

  it('invalidates the device token on unpair', async () => {
    const paired = await pairPhone();
    expect((await authed(paired.token, '/v1/session')).status).toBe(200);

    expect(h.host.unpair(paired.deviceId)).toBe(true);
    const after = await authed(paired.token, '/v1/session');
    expect(after.status).toBe(401);
  });

  it('keeps other devices paired when one is revoked', async () => {
    const first = await pairPhone('First');
    const second = await pairPhone('Second');
    h.host.unpair(first.deviceId);
    expect((await authed(second.token, '/v1/session')).status).toBe(200);
    expect((await authed(first.token, '/v1/session')).status).toBe(401);
  });
});

describe('run routes', () => {
  it('lists projects with their pipelines and phase ribbons', async () => {
    const paired = await pairPhone();
    const res = await authed(paired.token, '/v1/projects');
    expect(res.status).toBe(200);
    const projects = (await res.json()) as {
      id: string;
      pipelines: {
        id: string;
        name: string;
        description: string;
        phases?: { name: string; kind: string }[];
      }[];
    }[];
    expect(projects).toHaveLength(1);
    expect(projects[0]!.id).toBe(h.project.id);
    expect(projects[0]!.pipelines.map((p) => p.id)).toEqual(['p']);
    expect(projects[0]!.pipelines[0]!.phases).toEqual([
      { id: 'build', name: 'build', kind: 'agent', isFeedbackTarget: false },
    ]);
  });

  it('starts a run, lists it, pages its events, and reads its detail', async () => {
    const paired = await pairPhone();
    const started = await authed(paired.token, '/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ projectId: h.project.id, pipelineId: 'p', request: 'build a thing' }),
    });
    expect(started.status).toBe(200);
    const outcome = (await started.json()) as { ok: boolean; runId?: string };
    expect(outcome.ok).toBe(true);
    const runId = outcome.runId!;
    expect(await h.registry.settled.get(runId)).toBe('accepted');

    const list = await authed(paired.token, `/v1/projects/${h.project.id}/runs`);
    const rows = (await list.json()) as RunRow[];
    expect(rows.map((r) => r.runId)).toContain(runId);
    expect(rows.find((r) => r.runId === runId)!.status).toBe('accepted');

    const detail = await authed(paired.token, `/v1/projects/${h.project.id}/runs/${runId}`);
    const body = (await detail.json()) as RunDetail;
    expect(body.run?.runId).toBe(runId);
    expect(body.live).toBe(false);
    expect(body.phases.map((p) => p.status)).toEqual(['success']);

    // The cursor walks change_id exactly like the renderer's poll.
    const first = await authed(
      paired.token,
      `/v1/projects/${h.project.id}/runs/${runId}/events?after=0`,
    );
    const page = (await first.json()) as EventPage;
    expect(page.events.length).toBeGreaterThan(0);
    expect(page.cursor).toBeGreaterThan(0);
    const second = await authed(
      paired.token,
      `/v1/projects/${h.project.id}/runs/${runId}/events?after=${page.cursor}`,
    );
    const nextPage = (await second.json()) as EventPage;
    expect(nextPage.events).toEqual([]);
    expect(nextPage.cursor).toBe(page.cursor);
  });

  it('refuses to start a run for an unknown pipeline, with issues', async () => {
    const paired = await pairPhone();
    const res = await authed(paired.token, '/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ projectId: h.project.id, pipelineId: 'nope', request: 'x' }),
    });
    const outcome = (await res.json()) as { ok: boolean; issues: { message: string }[] };
    expect(outcome.ok).toBe(false);
    expect(outcome.issues[0]!.message).toContain('pipeline not found');
  });

  it('rejects a start body missing its fields as a bad request', async () => {
    const paired = await pairPhone();
    const res = await authed(paired.token, '/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ projectId: h.project.id }),
    });
    expect(res.status).toBe(400);
  });

  it('kills a live run through the host', async () => {
    scriptedOptions = { stallOnTurns: [0] };
    const paired = await pairPhone();
    const started = await authed(paired.token, '/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ projectId: h.project.id, pipelineId: 'p', request: 'never ends' }),
    });
    const { runId } = (await started.json()) as { runId: string };
    await until(() => h.registry.isLive(runId), 'the run to go live');

    const killed = await authed(paired.token, `/v1/projects/${h.project.id}/runs/${runId}/kill`, {
      method: 'POST',
    });
    expect(((await killed.json()) as { ok: boolean }).ok).toBe(true);
    expect(await h.registry.settled.get(runId)).toBe('killed');
  });

  it('continues a failed run through the host', async () => {
    const paired = await pairPhone();
    const res = await authed(
      paired.token,
      `/v1/projects/${h.project.id}/runs/run_failed/continue`,
      { method: 'POST' },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, detail: 'Continuing run' });
    expect(h.registry.continued).toEqual(['run_failed']);
  });

  it('lists historical runs across statuses and hides archived runs by default', async () => {
    const paired = await pairPhone();

    // Create runs with accepted, rejected, failed, killed statuses and one archived
    h.tracer.startRun({
      runId: 'run_acc',
      projectId: h.project.id,
      pipeline: pipeline(),
      request: 'accepted change',
      engineer: 'test',
      worktreePath: null,
      branch: 'foundry/run_acc',
      baseRef: 'main',
      mode: 'pi',
    });
    h.tracer.finishRun('run_acc', 'accepted', 'all passed');

    h.tracer.startRun({
      runId: 'run_rej',
      projectId: h.project.id,
      pipeline: pipeline(),
      request: 'rejected change',
      engineer: 'test',
      worktreePath: null,
      branch: 'foundry/run_rej',
      baseRef: 'main',
      mode: 'pi',
    });
    h.tracer.finishRun('run_rej', 'rejected', 'boundary violation');

    h.tracer.startRun({
      runId: 'run_archived',
      projectId: h.project.id,
      pipeline: pipeline(),
      request: 'archived run',
      engineer: 'test',
      worktreePath: null,
      branch: 'foundry/run_archived',
      baseRef: 'main',
      mode: 'pi',
    });
    h.tracer.finishRun('run_archived', 'accepted');
    h.tracer.setArchived('run_archived', true);

    const res = await authed(paired.token, `/v1/projects/${h.project.id}/runs`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as RunRow[];

    const runIds = rows.map((r) => r.runId);
    expect(runIds).toContain('run_acc');
    expect(runIds).toContain('run_rej');
    expect(runIds).not.toContain('run_archived');

    const accRow = rows.find((r) => r.runId === 'run_acc');
    expect(accRow?.status).toBe('accepted');
    expect(accRow?.outcomeDetail).toBe('all passed');
    expect(accRow?.phaseSummary).toBeDefined();

    const rejRow = rows.find((r) => r.runId === 'run_rej');
    expect(rejRow?.status).toBe('rejected');
    expect(rejRow?.outcomeDetail).toBe('boundary violation');
  });

  it('404s an unknown project for a paired caller', async () => {
    const paired = await pairPhone();
    const res = await authed(paired.token, '/v1/projects/unknown/runs');
    expect(res.status).toBe(404);
  });
});

describe('interrupt routes', () => {
  it('lists pending interrupts and answers one through the host', async () => {
    const paired = await pairPhone();
    h.registry.pendingInterrupts = [
      {
        interruptId: 'int_1',
        runId: 'run_1',
        phaseId: 'ph_1',
        kind: 'engineer',
        title: 'Review required',
        body: 'Please approve the plan',
        options: [
          { id: 'approve', label: 'Approve', kind: 'approve' },
          { id: 'reject', label: 'Reject', kind: 'reject' },
        ],
        createdAt: new Date().toISOString(),
      },
    ];

    const listRes = await authed(paired.token, '/v1/interrupts');
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as PendingInterrupt[];
    expect(list).toHaveLength(1);
    expect(list[0]!.interruptId).toBe('int_1');

    const answerRes = await authed(paired.token, '/v1/interrupts/answer', {
      method: 'POST',
      body: JSON.stringify({ interruptId: 'int_1', decision: 'approve', text: 'looks good' }),
    });
    expect(answerRes.status).toBe(200);
    const answerResult = (await answerRes.json()) as { ok: boolean };
    expect(answerResult.ok).toBe(true);
    expect(h.registry.answered).toEqual([
      { interruptId: 'int_1', decision: 'approve', text: 'looks good' },
    ]);
    expect(h.registry.pendingInterrupts).toEqual([]);
  });

  it('rejects an invalid answer payload as a bad request', async () => {
    const paired = await pairPhone();
    const res = await authed(paired.token, '/v1/interrupts/answer', {
      method: 'POST',
      body: JSON.stringify({ interruptId: 'int_1' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('PR routes', () => {
  it('drafts the same title and body create would send to GitHub', async () => {
    addOrigin(h.repo);
    sh(h.repo, ['git', 'branch', 'foundry/run_pr_draft']);
    const request = `${'Please land the companion confirm sheet and Custom Tab helper. '.repeat(3)}end.`;
    h.tracer.startRun({
      runId: 'run_pr_draft',
      projectId: h.project.id,
      pipeline: pipeline(),
      request,
      engineer: 'test',
      worktreePath: null,
      branch: 'foundry/run_pr_draft',
      baseRef: 'main',
      mode: 'pi',
    });
    h.tracer.finishRun('run_pr_draft', 'accepted', 'all passed');

    const paired = await pairPhone();
    const draftRes = await authed(
      paired.token,
      `/v1/projects/${h.project.id}/runs/run_pr_draft/pr-draft`,
    );
    expect(draftRes.status).toBe(200);
    const draft = (await draftRes.json()) as { title: string; body: string; source: string };
    expect(draft.source).toBe('run');
    expect(draft.title).toBe(`p: ${request.slice(0, 63)}…`);
    expect(draft.body).toContain(request);
    expect(draft.body).toContain('Opened by Foundry from run run_pr_draft');

    const created = await authed(
      paired.token,
      `/v1/projects/${h.project.id}/runs/run_pr_draft/pr`,
      {
        method: 'POST',
        body: JSON.stringify({ title: '', body: '' }),
      },
    );
    expect(created.status).toBe(200);
    expect(((await created.json()) as { ok: boolean }).ok).toBe(true);

    const createCall = h.gh.calls().find((args) => args[0] === 'pr' && args[1] === 'create');
    expect(createCall).toBeDefined();
    const titleIdx = createCall!.indexOf('--title');
    const bodyIdx = createCall!.indexOf('--body');
    expect(createCall![titleIdx + 1]).toBe(draft.title);
    expect(createCall![bodyIdx + 1]).toBe(draft.body);
  });

  it('creates a PR for a settled run and records its coordinates', async () => {
    addOrigin(h.repo);
    sh(h.repo, ['git', 'branch', 'foundry/run_pr_1']);
    h.tracer.startRun({
      runId: 'run_pr_1',
      projectId: h.project.id,
      pipeline: pipeline(),
      request: 'make a change',
      engineer: 'test',
      worktreePath: null,
      branch: 'foundry/run_pr_1',
      baseRef: 'main',
      mode: 'pi',
    });
    h.tracer.finishRun('run_pr_1', 'accepted');

    const paired = await pairPhone();
    const res = await authed(paired.token, `/v1/projects/${h.project.id}/runs/run_pr_1/pr`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Add the thing', body: 'It works.' }),
    });
    expect(res.status).toBe(200);
    const action = (await res.json()) as { ok: boolean; url?: string; number?: number };
    expect(action.ok).toBe(true);
    expect(action.url).toBe('https://github.com/acme/widgets/pull/7');

    // The phone reads prUrl off the same run row the desktop shows.
    const detail = await authed(paired.token, `/v1/projects/${h.project.id}/runs/run_pr_1`);
    const body = (await detail.json()) as RunDetail;
    expect(body.run?.prUrl).toBe('https://github.com/acme/widgets/pull/7');
    expect(body.run?.prNumber).toBe(7);
  });

  it('reports gh status through the host', async () => {
    const paired = await pairPhone();
    const res = await authed(paired.token, `/v1/projects/${h.project.id}/pr-status`);
    expect(res.status).toBe(200);
    const status = (await res.json()) as { available: boolean };
    expect(status.available).toBe(true);
  });
});

describe('host lifecycle', () => {
  it('stops cleanly and refuses new pairing payloads while stopped', async () => {
    await h.host.stop();
    expect(h.host.state().running).toBe(false);
    expect(h.host.pairingPayload()).toBeNull();
    // Restart so afterEach's stop stays a no-op rather than an error.
    await h.host.start();
  });

  it('never exposes a token or secret through state()', async () => {
    await pairPhone();
    const state = JSON.stringify(h.host.state());
    expect(state).not.toContain('secret');
    expect(state).not.toContain('token');
  });

  it('reports a LAN address on this machine or none, never 0.0.0.0', () => {
    const address = lanAddress();
    if (address !== null) expect(address).not.toBe('0.0.0.0');
  });

  it('unpairs via POST /v1/unpair and immediately revokes the device token', async () => {
    const paired = await pairPhone();
    const sessionBefore = await authed(paired.token, '/v1/session');
    expect(sessionBefore.status).toBe(200);

    const unpairRes = await authed(paired.token, '/v1/unpair', { method: 'POST' });
    expect(unpairRes.status).toBe(200);
    expect(((await unpairRes.json()) as { ok: boolean }).ok).toBe(true);

    expect(h.host.state().devices.find((d) => d.deviceId === paired.deviceId)).toBeUndefined();

    // Any subsequent requests with this revoked token must fail fail-closed (401)
    const sessionAfter = await authed(paired.token, '/v1/session');
    expect(sessionAfter.status).toBe(401);
    const err = (await sessionAfter.json()) as CompanionError;
    expect(err.error.code).toBe('unauthorized');

    const runsAfter = await authed(paired.token, `/v1/projects/${h.project.id}/runs`);
    expect(runsAfter.status).toBe(401);
  });

  it('unpairs via host.unpair() and revokes the token', async () => {
    const paired = await pairPhone();
    const sessionBefore = await authed(paired.token, '/v1/session');
    expect(sessionBefore.status).toBe(200);

    const removed = h.host.unpair(paired.deviceId);
    expect(removed).toBe(true);
    expect(h.host.state().devices).toHaveLength(0);

    const sessionAfter = await authed(paired.token, '/v1/session');
    expect(sessionAfter.status).toBe(401);
  });

  it('reconnects with a valid stored token across host restart', async () => {
    const paired = await pairPhone();
    const session1 = await authed(paired.token, '/v1/session');
    expect(session1.status).toBe(200);

    // Stop and restart host
    await h.host.stop();
    await new Promise((r) => setTimeout(r, 20));
    await h.host.start();

    // Stored token is still valid
    const session2 = await authed(paired.token, '/v1/session');
    expect(session2.status).toBe(200);
  });

  it('produces a single-use pairing payload that cannot be replayed', async () => {
    const payload = h.host.pairingPayload();
    expect(payload).not.toBeNull();
    expect(payload!.protocolVersion).toBe(COMPANION_PROTOCOL_VERSION);
    expect(payload!.origin).toBe(h.origin());
    expect(payload!.secret).toBeTruthy();
    expect(payload!.desktopId).toBeTruthy();
    expect(payload!.desktopName).toBeTruthy();

    // First pair succeeds
    const res1 = await fetch(`${h.origin()}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: COMPANION_PROTOCOL_VERSION,
        secret: payload!.secret,
        deviceName: 'Pixel 9',
      }),
    });
    expect(res1.status).toBe(200);

    // Replay of same secret fails
    const res2 = await fetch(`${h.origin()}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: COMPANION_PROTOCOL_VERSION,
        secret: payload!.secret,
        deviceName: 'Attacker Phone',
      }),
    });
    expect(res2.status).toBe(401);
    const err = (await res2.json()) as CompanionError;
    expect(err.error.code).toBe('pairing_invalid');
  });
});

describe('a stable address across restarts', () => {
  const portOf = (origin: string): number => Number(new URL(origin).port);

  it('rebinds the same port after stop and start', async () => {
    const first = portOf(h.origin());
    await h.host.stop();
    const state = await h.host.start();
    expect(state.running).toBe(true);
    expect(portOf(state.origin!)).toBe(first);
    expect(state.detail).toBeUndefined();
  });

  it('persists the bound port so a relaunched host serves the same origin', async () => {
    const before = h.host.state().origin!;
    await h.host.stop({ preserveEnabled: true });

    // A fresh CompanionHost over the same support dir is what a relaunch is:
    // nothing in memory survives, only companion.json.
    const relaunched = h.relaunch();
    const state = await relaunched.restore();
    try {
      expect(state.origin).toBe(before);
    } finally {
      await relaunched.stop();
    }
  });

  it('keeps an already-paired phone reachable at its stored origin after a relaunch', async () => {
    const paired = await pairPhone();
    const stored = h.origin();
    await h.host.stop({ preserveEnabled: true });

    const relaunched = h.relaunch();
    await relaunched.restore();
    try {
      expect(relaunched.state().origin).toBe(stored);
      const res = await fetch(`${stored}/v1/session`, {
        headers: { authorization: `Bearer ${paired.token}` },
      });
      expect(res.status).toBe(200);
    } finally {
      await relaunched.stop();
    }
  });

  it('records the port it bound in companion.json', () => {
    const file = JSON.parse(readFileSync(join(h.support, 'companion.json'), 'utf8')) as {
      lastPort: number;
    };
    expect(file.lastPort).toBe(portOf(h.origin()));
  });

  it('restores the enabled host after an app restart', async () => {
    const before = h.host.state().origin!;
    await h.host.stop({ preserveEnabled: true });

    const relaunched = h.relaunch();
    const state = await relaunched.restore();
    try {
      expect(state.running).toBe(true);
      expect(state.origin).toBe(before);
    } finally {
      await relaunched.stop();
    }
  });

  it('does not restore a host the operator turned off', async () => {
    await h.host.stop();

    const relaunched = h.relaunch();
    const state = await relaunched.restore();
    expect(state.running).toBe(false);
  });

  it('falls back to an ephemeral port when the remembered one is taken, and says so', async () => {
    const taken = portOf(h.origin());

    // Leave our host bound and start a second one over the same store: the
    // remembered port is occupied by definition.
    const second = h.relaunch();
    const state = await second.start();
    try {
      expect(state.running).toBe(true);
      expect(portOf(state.origin!)).not.toBe(taken);
      expect(state.detail).toContain(`port ${taken} was taken`);
      expect(state.detail).toContain('re-scan the QR');
    } finally {
      await second.stop();
    }
  });

  it('reports no LAN address rather than binding something unreachable', () => {
    const chosen = lanInterface();
    if (chosen === null) {
      expect(lanAddress()).toBeNull();
      return;
    }
    expect(lanAddress()).toBe(chosen.address);
    expect(chosen.address).not.toBe('0.0.0.0');
    // A tunnel or self-assigned address is bindable but not reachable, and
    // must be flagged rather than silently served.
    if (/^(utun|awdl|bridge|docker|vnic)/i.test(chosen.name)) expect(chosen.usable).toBe(false);
    if (chosen.address.startsWith('169.254.')) expect(chosen.usable).toBe(false);
  });
});

describe('the device store', () => {
  it('persists only hashes, so a copied file cannot authenticate', () => {
    const dir = tempDir('foundry-devices-');
    const store = new DeviceStore(dir);
    const { token } = store.register('Pixel');
    const file = readFileSync(join(dir, 'companion.json'), 'utf8');
    expect(file).not.toContain(token);
    expect(store.authenticate(token)?.name).toBe('Pixel');
    expect(store.authenticate('not-the-token')).toBeNull();
  });

  it('does not rewrite the file on a second authentication moments later', () => {
    const dir = tempDir('foundry-devices-debounce-');
    let now = 1_700_000_000_000;
    const store = new DeviceStore(dir, () => now);
    const { token } = store.register('Pixel');
    const path = join(dir, 'companion.json');

    // The first hit stamps lastSeenAt; a poll two seconds later must not.
    expect(store.authenticate(token)).not.toBeNull();
    const stamped = readFileSync(path, 'utf8');
    const writtenAt = statSync(path).mtimeMs;

    now += 2_000;
    expect(store.authenticate(token)).not.toBeNull();
    expect(readFileSync(path, 'utf8')).toBe(stamped);
    expect(statSync(path).mtimeMs).toBe(writtenAt);

    // Past the debounce window the stamp moves again, so "last seen" stays true.
    now += LAST_SEEN_DEBOUNCE_MS;
    expect(store.authenticate(token)).not.toBeNull();
    expect(store.list()[0]!.lastSeenAt).toBe(new Date(now).toISOString());
  });

  it('wipes the token on unpair even though last-seen writes are debounced', () => {
    const dir = tempDir('foundry-devices-unpair-');
    let now = 1_700_000_000_000;
    const store = new DeviceStore(dir, () => now);
    const { deviceId, token } = store.register('Pixel');
    expect(store.authenticate(token)).not.toBeNull();

    now += 1_000;
    expect(store.unpair(deviceId)).toBe(true);
    expect(store.authenticate(token)).toBeNull();
    expect(store.list()).toEqual([]);
    const file = readFileSync(join(dir, 'companion.json'), 'utf8');
    expect(file).not.toContain(deviceId);
    expect(JSON.parse(file)).toMatchObject({ devices: [] });
  });

  it('ignores a hand-edited port that could never be bound', () => {
    const dir = tempDir('foundry-devices-port-');
    const path = join(dir, 'companion.json');
    const store = new DeviceStore(dir);
    store.rememberPort(52810);
    expect(store.lastPort()).toBe(52810);

    for (const bad of [0, 80, 70000, 'nope']) {
      writeFileSync(path, JSON.stringify({ desktopId: 'd', lastPort: bad, devices: [] }));
      expect(new DeviceStore(dir).lastPort()).toBeNull();
    }
  });

  it('defaults a pre-existing companion file to disabled', () => {
    const dir = tempDir('foundry-devices-enabled-');
    writeFileSync(join(dir, 'companion.json'), JSON.stringify({ desktopId: 'd', devices: [] }));
    expect(new DeviceStore(dir).enabled()).toBe(false);
  });
});
