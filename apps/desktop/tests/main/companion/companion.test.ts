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
import { continueDetail, continueEligibility } from '../../../src/main/engine/continue-run.js';
import { CompanionHost, lanAddress, lanInterface } from '../../../src/main/companion/host.js';
import { PairingSecrets, PAIRING_SECRET_TTL_MS } from '../../../src/main/companion/pairing.js';
import { DeviceStore, LAST_SEEN_DEBOUNCE_MS } from '../../../src/main/companion/devices.js';
import { defaultProject } from '../../../src/main/store/projects.js';
import { defaultSettings } from '../../../src/main/store/settings.js';
import { COMPANION_PROTOCOL_VERSION } from '../../../src/shared/companion.js';
import type {
  CompanionError,
  CompanionPairingPayload,
  CompanionPairResult,
} from '../../../src/shared/companion.js';
import type {
  EventPage,
  OrchestratorState,
  RunDetail,
  SmithChatState,
} from '../../../src/shared/ipc-contract.js';
import type {
  ModelInfo,
  ReasoningEffort,
  SmithProposal,
  SmithProposalAnswerResult,
} from '../../../src/shared/types.js';
import type {
  AgentDef,
  AppSettings,
  EnvelopeDef,
  GeneratedRunPlan,
  LinearIssueSnapshot,
  LinearWorkflowState,
  PipelineDef,
  ProjectDef,
  RestorableCheckpointList,
  RestoreResult,
  RunSource,
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
      gates: [{ gate: 'command_passes', config: { argv: ['test', '-f', 'README.md'] } }],
    },
  ],
});

const generatedPlan = (
  projectId: string,
  prompt = 'Build the requested companion change',
): GeneratedRunPlan => ({
  planId: 'plan_companion_1',
  projectId,
  prompt,
  refinedRequest: `${prompt}, with focused tests.`,
  rationale: 'The generated pipeline keeps implementation and verification together.',
  pipeline: {
    ...pipeline(),
    id: 'generated-plan-companion-1',
    name: 'Generated companion plan',
    phases: pipeline().phases.map((phase) => ({
      ...phase,
      model: 'scripted/alpha',
      reasoningEffort: 'high',
    })),
  },
  agents: [],
  warnings: [],
  model: 'scripted/alpha',
  reasoningEffort: 'high',
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
  continued: string[] = [];

  constructor(
    private readonly tracer: Tracer,
    private readonly support: string,
    private readonly scripted: () => ScriptedAgent,
  ) {}

  start(input: {
    project: ProjectDef;
    pipeline: PipelineDef;
    agents: AgentDef[];
    envelopeDefs: EnvelopeDef[];
    request: string;
    plan?: GeneratedRunPlan | null;
    source?: RunSource | null;
  }): string {
    const runId = `run_companion_${++this.seq}`;
    const agent = this.scripted();
    const executor = new Executor({
      tracer: this.tracer,
      envelopeRetries: 2,
      gateRetries: 2,
      compactionThreshold: 0.8,
      rewindAfterCorrections: 2,
      supportDir: this.support,
      transport: (req) => agent.transport(req),
      agents: input.agents,
      envelopeDefs: input.envelopeDefs,
      project: input.project,
      pipeline: input.pipeline,
      request: input.request,
      plan: input.plan,
      source: input.source,
      runId,
      engineer: 'test',
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

  /**
   * The real `RunRegistry.resume` decides through `continueEligibility`, so
   * this stand-in does too: the host route's job is to reach that decision and
   * hand its answer back verbatim, and a killed run has to reach it intact.
   */
  resume(input: { project: ProjectDef; runId: string }): { ok: boolean; detail: string } {
    this.continued.push(input.runId);
    const run = this.tracer.run(input.runId);
    if (!run) return { ok: false, detail: 'run not found' };
    const eligible = continueEligibility({
      run,
      pipeline: this.tracer.readRunJson<PipelineDef>(input.runId, 'pipeline.json'),
      phases: this.tracer.phases(input.runId),
      worktreeExists: () => true,
    });
    if (!eligible.ok) return { ok: false, detail: eligible.detail };
    return { ok: true, detail: continueDetail(eligible.strategy, eligible.failedPhase.name) };
  }
}

/** In-memory Smith so the host suite never opens a model. */
class TestSmith {
  sent: Array<{ projectId?: string; text: string; route?: string }> = [];
  cancelled: Array<string | undefined> = [];
  wiped: Array<string | undefined> = [];
  answered: Array<{ id: string; approved: boolean }> = [];
  models: ModelInfo[] = [
    {
      id: 'scripted/alpha',
      displayName: 'Alpha',
      provider: 'scripted',
      supportedReasoningEfforts: ['low', 'medium', 'high'],
      defaultReasoningEffort: 'medium',
      isCustom: true,
      deprecated: false,
    },
  ];
  private readonly chats = new Map<string, TestSmithChat>();
  proposals: SmithProposal[] = [];

  chat(projectId?: string): TestSmithChat {
    const key = projectId ?? 'global';
    const existing = this.chats.get(key);
    if (existing) return existing;
    const chat = new TestSmithChat(this, projectId);
    this.chats.set(key, chat);
    return chat;
  }
}

class TestSmithChat {
  running = false;
  model = 'inherit';
  reasoningEffort: ReasoningEffort = 'medium';
  transcript: SmithChatState['transcript'] = [];

  constructor(
    private readonly owner: TestSmith,
    private readonly projectId: string | undefined,
  ) {}

  snapshot(): SmithChatState {
    return {
      ...(this.projectId ? { projectId: this.projectId } : {}),
      model: this.model,
      activeModel: this.model === 'inherit' ? 'scripted' : this.model,
      reasoningEffort: this.reasoningEffort,
      activeReasoningEffort: this.reasoningEffort,
      running: this.running,
      error: null,
      transcript: this.transcript.map((entry) => ({ ...entry })),
    };
  }

  async send(text: string, ctx?: { screen?: { route: string } }): Promise<void> {
    this.owner.sent.push({
      ...(this.projectId ? { projectId: this.projectId } : {}),
      text,
      ...(ctx?.screen?.route ? { route: ctx.screen.route } : {}),
    });
    this.transcript.push({
      id: `op_${this.transcript.length}`,
      kind: 'text',
      text,
      source: 'operator',
      at: Date.now(),
    });
    this.running = true;
    this.transcript.push({
      id: `sm_${this.transcript.length}`,
      kind: 'text',
      text: `heard: ${text}`,
      source: 'smith',
      at: Date.now(),
    });
    this.running = false;
  }

  async cancel(): Promise<void> {
    this.owner.cancelled.push(this.projectId);
    this.running = false;
  }

  async newChat(): Promise<void> {
    this.owner.wiped.push(this.projectId);
    this.transcript = [];
    this.running = false;
    this.reasoningEffort = 'medium';
  }

  async setModel(model: string): Promise<void> {
    this.model = model;
  }

  async setReasoningEffort(effort: ReasoningEffort): Promise<void> {
    this.reasoningEffort = effort;
  }
}

interface Harness {
  host: CompanionHost;
  registry: TestRegistry;
  smith: TestSmith;
  tracer: Tracer;
  project: ProjectDef;
  repo: string;
  support: string;
  gh: FakeGh;
  origin: () => string;
  changes: string[];
  settings: () => AppSettings;
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
  const smith = new TestSmith();
  let settings = defaultSettings();
  const planStates = new Map<string, OrchestratorState>();
  let planSequence = 0;
  const linearStates: LinearWorkflowState[] = [
    { id: 'started', name: 'In Progress', type: 'started' },
    { id: 'completed', name: 'Done', type: 'completed' },
    { id: 'failed', name: 'Cancelled', type: 'canceled' },
  ];
  const linearIssue: LinearIssueSnapshot = {
    id: 'issue-204',
    identifier: 'FOU-204',
    title: 'Android parity',
    description: 'Bring the companion up to date.',
    url: 'https://linear.app/foundry/issue/FOU-204',
    updatedAt: '2026-08-26T18:00:00.000Z',
    team: { id: 'team-foundry', name: 'Foundry' },
    state: { id: 'backlog', name: 'Backlog', type: 'backlog' },
  };
  const makeHost = (): CompanionHost =>
    new CompanionHost({
      supportDir: support,
      projects: () => [project],
      projectById: (id) => (id === project.id ? project : null),
      pipelinesFor: () => [pipeline()],
      rosterFor: () => [buildAgent()],
      envelopeDefs: () => [],
      settings: () => settings,
      saveProject: (next) => next,
      oneShot: () => {
        throw new Error('the companion suite never opens a one-shot');
      },
      registry,
      appVersion: () => '0.0.0-test',
      notifyRuns: () => undefined,
      enabledModelIds: async () => ['scripted/alpha'],
      onStateChanged: () => changes.push('changed'),
      orchestrator: {
        options: async () => ({
          models: smith.models,
          model: settings.defaultModel,
          reasoningEffort: settings.defaultReasoningEffort,
        }),
        start: (input) => {
          const planId = `plan_http_${++planSequence}`;
          planStates.set(planId, {
            planId,
            projectId: input.projectId,
            status: 'done',
            model: input.model,
            reasoningEffort: input.reasoningEffort,
            prompt: input.prompt,
            entries: [],
            plan: { ...generatedPlan(input.projectId, input.prompt), planId },
            rawReply: '{"pipeline": "generated"}',
            detail: 'Plan ready.',
            startedAt: 1,
            endedAt: 2,
            messages: [],
            revision: 1,
          });
          return { planId };
        },
        state: (planId) => planStates.get(planId) ?? null,
        cancel: (planId) => {
          const state = planStates.get(planId);
          if (!state) return false;
          planStates.set(planId, {
            ...state,
            status: 'cancelled',
            plan: null,
            detail: 'Planning cancelled.',
          });
          return true;
        },
      },
      linear: {
        state: () => ({ keySet: true, detail: 'Connected to Linear.' }),
        issues: async (query) =>
          !query || linearIssue.identifier.toLowerCase().includes(query.toLowerCase())
            ? [linearIssue]
            : [],
        issue: async (issueId) => {
          if (issueId !== linearIssue.id) throw new Error('Linear issue not found');
          return linearIssue;
        },
        workflowStates: async (teamId) => (teamId === linearIssue.team.id ? linearStates : []),
        saveStatusMapping: (mapping) => {
          settings = { ...settings, linearStatusMapping: mapping };
          return [];
        },
      },
      smith: {
        chat: (projectId) => smith.chat(projectId),
        listProposals: () => smith.proposals,
        answerProposal: async (id, answer) => {
          smith.answered.push({ id, approved: answer.approved });
          return { ok: true };
        },
        models: async () => smith.models,
      },
      bindHost: '127.0.0.1',
      gh: { bin: gh.bin },
    });
  const host = makeHost();
  const state = await host.start();
  if (!state.running || !state.origin) throw new Error(`host did not start: ${state.detail}`);
  h = {
    host,
    registry,
    smith,
    tracer,
    project,
    repo,
    support,
    gh,
    origin: () => host.state().origin!,
    changes,
    settings: () => settings,
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
    ['POST', '/v1/runs'],
    ['GET', '/v1/projects/x/runs'],
    ['GET', '/v1/projects/x/runs/y'],
    ['GET', '/v1/projects/x/runs/y/events'],
    ['GET', '/v1/projects/x/runs/y/checkpoints'],
    ['POST', '/v1/projects/x/runs/y/restore'],
    ['POST', '/v1/projects/x/runs/y/kill'],
    ['POST', '/v1/projects/x/runs/y/continue'],
    ['GET', '/v1/orchestrator/options'],
    ['POST', '/v1/orchestrator/plans'],
    ['GET', '/v1/orchestrator/plans/plan'],
    ['POST', '/v1/orchestrator/plans/plan/cancel'],
    ['GET', '/v1/linear'],
    ['GET', '/v1/linear/issues'],
    ['GET', '/v1/linear/issues/issue'],
    ['GET', '/v1/linear/teams/team/workflow-states'],
    ['POST', '/v1/linear/runs'],
    ['POST', '/v1/projects/x/runs/y/pr'],
    ['GET', '/v1/projects/x/runs/y/pr-draft'],
    ['GET', '/v1/projects/x/pr-status'],
    ['GET', '/v1/smith'],
    ['POST', '/v1/smith/send'],
    ['POST', '/v1/smith/cancel'],
    ['POST', '/v1/smith/new'],
    ['GET', '/v1/smith/proposals'],
    ['POST', '/v1/smith/proposals/answer'],
    ['GET', '/v1/smith/models'],
    ['POST', '/v1/smith/model'],
    ['POST', '/v1/smith/effort'],
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

  /** A settled run with one red phase, as the registry's gate reads it. */
  function settledRun(runId: string, status: 'failed' | 'killed' | 'accepted'): void {
    h.tracer.startRun({
      runId,
      projectId: h.project.id,
      pipeline: pipeline(),
      request: 'a run that stopped',
      engineer: 'test',
      worktreePath: join(h.repo, '.foundry-worktrees', runId),
      branch: `foundry/${runId}`,
      baseRef: 'main',
      mode: 'pi',
    });
    const phaseId = h.tracer.queuePhase({
      runId,
      seq: 0,
      name: 'build',
      kind: 'agent',
      owner: 'builder',
      description: 'build it',
    });
    h.tracer.closePhase(phaseId, status === 'accepted' ? 'success' : 'fail');
    h.tracer.finishRun(runId, status, `the run ${status}`);
  }

  it('continues a failed run through the host', async () => {
    settledRun('run_failed', 'failed');
    const paired = await pairPhone();
    const res = await authed(
      paired.token,
      `/v1/projects/${h.project.id}/runs/run_failed/continue`,
      { method: 'POST' },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, detail: 'Continuing from “build”…' });
    expect(h.registry.continued).toEqual(['run_failed']);
  });

  it('continues a killed run through the host, on the same eligibility', async () => {
    settledRun('run_killed', 'killed');
    const paired = await pairPhone();
    const res = await authed(
      paired.token,
      `/v1/projects/${h.project.id}/runs/run_killed/continue`,
      { method: 'POST' },
    );

    expect(res.status).toBe(200);
    // The phone gets the same verdict and the same words the desktop banner
    // does: the interrupted phase restarts rather than resuming.
    expect(await res.json()).toEqual({
      ok: true,
      detail: 'Restarting “build” in a new session…',
    });
    expect(h.registry.continued).toEqual(['run_killed']);
  });

  it('refuses to continue a merged killed run through the host', async () => {
    settledRun('run_killed_merged', 'killed');
    h.tracer.setMerged('run_killed_merged', true);
    const paired = await pairPhone();
    const res = await authed(
      paired.token,
      `/v1/projects/${h.project.id}/runs/run_killed_merged/continue`,
      { method: 'POST' },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: false,
      detail: 'a merged run cannot be continued',
    });
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

describe('Orchestrator routes', () => {
  it('returns planning options and round-trips a confirmed generated plan into a run', async () => {
    const paired = await pairPhone();
    const options = await authed(paired.token, '/v1/orchestrator/options');
    expect(options.status).toBe(200);
    expect(await options.json()).toMatchObject({
      model: 'inherit',
      reasoningEffort: 'medium',
      models: [{ id: 'scripted/alpha' }],
    });

    const startedPlan = await authed(paired.token, '/v1/orchestrator/plans', {
      method: 'POST',
      body: JSON.stringify({
        projectId: h.project.id,
        prompt: 'Bring Android up to parity',
        model: 'scripted/alpha',
        reasoningEffort: 'high',
      }),
    });
    expect(startedPlan.status).toBe(200);
    const { planId } = (await startedPlan.json()) as { planId: string };

    const polled = await authed(paired.token, `/v1/orchestrator/plans/${planId}`);
    const state = (await polled.json()) as OrchestratorState;
    expect(state.status).toBe('done');
    expect(state.plan?.pipeline.phases[0]?.model).toBe('scripted/alpha');

    const startedRun = await authed(paired.token, '/v1/runs', {
      method: 'POST',
      body: JSON.stringify({
        projectId: h.project.id,
        pipelineId: '',
        request: state.prompt,
        plan: state.plan,
      }),
    });
    const outcome = (await startedRun.json()) as { ok: boolean; runId: string };
    expect(outcome.ok).toBe(true);
    expect(await h.registry.settled.get(outcome.runId)).toBe('accepted');
    expect(h.tracer.run(outcome.runId)).toMatchObject({
      orchestrated: true,
      request: state.plan?.refinedRequest,
    });
  });

  it('cancels a known plan and rejects malformed plan requests', async () => {
    const paired = await pairPhone();
    const malformed = await authed(paired.token, '/v1/orchestrator/plans', {
      method: 'POST',
      body: JSON.stringify({ projectId: h.project.id, prompt: 'x' }),
    });
    expect(malformed.status).toBe(400);

    const started = await authed(paired.token, '/v1/orchestrator/plans', {
      method: 'POST',
      body: JSON.stringify({
        projectId: h.project.id,
        prompt: 'Plan this',
        model: 'scripted/alpha',
        reasoningEffort: 'medium',
      }),
    });
    const { planId } = (await started.json()) as { planId: string };
    const cancelled = await authed(paired.token, `/v1/orchestrator/plans/${planId}/cancel`, {
      method: 'POST',
    });
    expect(await cancelled.json()).toEqual({ ok: true });
    const state = await authed(paired.token, `/v1/orchestrator/plans/${planId}`);
    expect((await state.json()) as OrchestratorState).toMatchObject({ status: 'cancelled' });
  });
});

describe('Linear routes', () => {
  it('searches issues, loads workflow states, saves mapping, and starts a sourced run', async () => {
    const paired = await pairPhone();
    const state = await authed(paired.token, '/v1/linear');
    expect(await state.json()).toMatchObject({
      keySet: true,
      statusMapping: { started: null, completed: null, failed: null },
    });

    const issues = await authed(paired.token, '/v1/linear/issues?query=FOU-204');
    expect(await issues.json()).toMatchObject([{ id: 'issue-204', identifier: 'FOU-204' }]);
    const issue = await authed(paired.token, '/v1/linear/issues/issue-204');
    expect(await issue.json()).toMatchObject({ id: 'issue-204', identifier: 'FOU-204' });
    const workflow = await authed(paired.token, '/v1/linear/teams/team-foundry/workflow-states');
    expect(await workflow.json()).toMatchObject([
      { id: 'started' },
      { id: 'completed' },
      { id: 'failed' },
    ]);

    const mapping = { started: 'started', completed: 'completed', failed: 'failed' };
    const started = await authed(paired.token, '/v1/linear/runs', {
      method: 'POST',
      body: JSON.stringify({
        projectId: h.project.id,
        pipelineId: 'p',
        issueId: 'issue-204',
        statusMapping: mapping,
      }),
    });
    const outcome = (await started.json()) as { ok: boolean; runId: string };
    expect(outcome.ok).toBe(true);
    expect(await h.registry.settled.get(outcome.runId)).toBe('accepted');
    expect(h.settings().linearStatusMapping).toEqual(mapping);
    expect(h.tracer.run(outcome.runId)).toMatchObject({
      source: {
        kind: 'linear',
        issueId: 'issue-204',
        snapshot: { identifier: 'FOU-204' },
      },
    });
  });

  it('accepts an explicit null plan on run starts (the phone encodes null blobs)', async () => {
    const paired = await pairPhone();
    const started = await authed(paired.token, '/v1/runs', {
      method: 'POST',
      body: JSON.stringify({
        projectId: h.project.id,
        pipelineId: 'p',
        request: 'a plain manual run',
        plan: null,
      }),
    });
    expect(started.status).toBe(200);
    const outcome = (await started.json()) as { ok: boolean };
    expect(outcome.ok).toBe(true);

    const mapping = { started: 'started', completed: 'completed', failed: 'failed' };
    const sourced = await authed(paired.token, '/v1/linear/runs', {
      method: 'POST',
      body: JSON.stringify({
        projectId: h.project.id,
        pipelineId: 'p',
        issueId: 'issue-204',
        statusMapping: mapping,
        plan: null,
      }),
    });
    expect(sourced.status).toBe(200);
    expect(((await sourced.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('surfaces a missing Linear issue as a readable outcome, not a 500', async () => {
    const paired = await pairPhone();
    const response = await authed(paired.token, '/v1/linear/runs', {
      method: 'POST',
      body: JSON.stringify({
        projectId: h.project.id,
        pipelineId: 'p',
        issueId: 'issue-not-there',
        statusMapping: { started: 'started', completed: 'completed', failed: 'failed' },
      }),
    });
    expect(response.status).toBe(200);
    const outcome = (await response.json()) as { ok: boolean; issues: { where: string }[] };
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((issue) => issue.where === 'linear.issue')).toBe(true);
  });

  it('rejects a malformed lifecycle mapping before starting', async () => {
    const paired = await pairPhone();
    const response = await authed(paired.token, '/v1/linear/runs', {
      method: 'POST',
      body: JSON.stringify({
        projectId: h.project.id,
        pipelineId: 'p',
        issueId: 'issue-204',
        statusMapping: { started: 'started' },
      }),
    });
    expect(response.status).toBe(400);
  });
});

describe('checkpoint routes', () => {
  it('lists and restores a killed run without continuing it', async () => {
    scriptedOptions = { stallOnTurns: [0] };
    const paired = await pairPhone();
    const started = await authed(paired.token, '/v1/runs', {
      method: 'POST',
      body: JSON.stringify({
        projectId: h.project.id,
        pipelineId: 'p',
        request: 'stop after checkpoint',
      }),
    });
    const { runId } = (await started.json()) as { runId: string };
    await until(() => h.registry.isLive(runId), 'the checkpoint run to go live');
    await until(() => h.tracer.phaseCheckpoints(runId).length > 0, 'the phase checkpoint');
    await authed(paired.token, `/v1/projects/${h.project.id}/runs/${runId}/kill`, {
      method: 'POST',
    });
    expect(await h.registry.settled.get(runId)).toBe('killed');

    const listResponse = await authed(
      paired.token,
      `/v1/projects/${h.project.id}/runs/${runId}/checkpoints`,
    );
    const list = (await listResponse.json()) as RestorableCheckpointList;
    expect(list.refusal).toBeNull();
    expect(list.checkpoints).toHaveLength(1);
    expect(list.checkpoints[0]).toMatchObject({ phaseName: 'build', restorable: true });

    const restoreResponse = await authed(
      paired.token,
      `/v1/projects/${h.project.id}/runs/${runId}/restore`,
      {
        method: 'POST',
        body: JSON.stringify({ checkpointId: list.checkpoints[0]!.checkpointId }),
      },
    );
    const restored = (await restoreResponse.json()) as RestoreResult;
    expect(restored.ok).toBe(true);
    expect(restored.restored).toMatchObject({ phaseName: 'build', partial: false });
    expect(h.tracer.run(runId)?.status).toBe('killed');
    expect(h.registry.continued).not.toContain(runId);
  });

  it('rejects a restore body without a checkpoint id', async () => {
    const paired = await pairPhone();
    const response = await authed(
      paired.token,
      `/v1/projects/${h.project.id}/runs/run_restore_body/restore`,
      { method: 'POST', body: '{}' },
    );
    expect(response.status).toBe(400);
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

describe('smith chat', () => {
  it('reads the global snapshot and sends into that conversation', async () => {
    const paired = await pairPhone();
    const empty = await authed(paired.token, '/v1/smith');
    expect(empty.status).toBe(200);
    const before = (await empty.json()) as SmithChatState;
    expect(before.projectId).toBeUndefined();
    expect(before.transcript).toEqual([]);
    expect(before.running).toBe(false);

    const sent = await authed(paired.token, '/v1/smith/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'list projects', screen: { route: 'runs' } }),
    });
    expect(sent.status).toBe(200);
    const after = (await sent.json()) as SmithChatState;
    expect(after.transcript.map((row) => (row.kind === 'artifact' ? '' : row.text))).toEqual([
      'list projects',
      'heard: list projects',
    ]);
    expect(h.smith.sent).toEqual([{ text: 'list projects', route: 'runs' }]);
  });

  it('scopes send and state to a project id', async () => {
    const paired = await pairPhone();
    const sent = await authed(paired.token, '/v1/smith/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: h.project.id, text: 'show this project' }),
    });
    expect(sent.status).toBe(200);
    const scoped = (await sent.json()) as SmithChatState;
    expect(scoped.projectId).toBe(h.project.id);

    const global = (await (await authed(paired.token, '/v1/smith')).json()) as SmithChatState;
    expect(global.transcript).toEqual([]);

    const again = (await (
      await authed(paired.token, `/v1/smith?projectId=${h.project.id}`)
    ).json()) as SmithChatState;
    expect(again.transcript).toHaveLength(2);
    expect(h.smith.sent[0]?.projectId).toBe(h.project.id);
  });

  it('wipes a conversation on POST /v1/smith/new', async () => {
    const paired = await pairPhone();
    await authed(paired.token, '/v1/smith/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    const wiped = await authed(paired.token, '/v1/smith/new', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(wiped.status).toBe(200);
    expect(((await wiped.json()) as SmithChatState).transcript).toEqual([]);
    expect(h.smith.wiped).toEqual([undefined]);
  });

  it('lists and answers the one pending proposal', async () => {
    const paired = await pairPhone();
    h.smith.proposals = [
      {
        type: 'action',
        id: 'prop_1',
        operation: 'settings.set',
        title: 'Change a setting',
        summary: 'Flip a toggle',
        args: { key: 'theme' },
        risk: 'write',
        createdAt: '2026-08-24T00:00:00.000Z',
      },
    ];
    const listed = await authed(paired.token, '/v1/smith/proposals');
    expect(listed.status).toBe(200);
    const proposals = (await listed.json()) as SmithProposal[];
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.id).toBe('prop_1');

    const answered = await authed(paired.token, '/v1/smith/proposals/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'prop_1', answer: { approved: true } }),
    });
    expect(answered.status).toBe(200);
    expect(((await answered.json()) as SmithProposalAnswerResult).ok).toBe(true);
    expect(h.smith.answered).toEqual([{ id: 'prop_1', approved: true }]);
  });

  it('lists models and switches model and effort on the same chat', async () => {
    const paired = await pairPhone();
    const listed = await authed(paired.token, '/v1/smith/models');
    expect(listed.status).toBe(200);
    const models = (await listed.json()) as ModelInfo[];
    expect(models.map((model) => model.id)).toEqual(['scripted/alpha']);

    const setModel = await authed(paired.token, '/v1/smith/model', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'scripted/alpha' }),
    });
    expect(setModel.status).toBe(200);
    expect(((await setModel.json()) as SmithChatState).model).toBe('scripted/alpha');

    const setEffort = await authed(paired.token, '/v1/smith/effort', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ effort: 'high' }),
    });
    expect(setEffort.status).toBe(200);
    expect(((await setEffort.json()) as SmithChatState).reasoningEffort).toBe('high');
  });

  it('refuses an unknown reasoning effort', async () => {
    const paired = await pairPhone();
    const res = await authed(paired.token, '/v1/smith/effort', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ effort: 'ludicrous' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as CompanionError).error.code).toBe('bad_request');
  });

  it('refuses a send without text', async () => {
    const paired = await pairPhone();
    const res = await authed(paired.token, '/v1/smith/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: h.project.id }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as CompanionError).error.code).toBe('bad_request');
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
