/**
 * The LAN companion host: an HTTP server inside the main process that a paired
 * phone calls. Every route is a projection of an operation the desktop already
 * has — the same `startRun`, tracer pages, kill, PR, and Smith
 * chat paths the renderer reaches over IPC — so the phone can never do
 * something the window cannot, and main keeps sole ownership of git, the
 * tracer, and spawns.
 *
 * Auth is fail-closed: apart from `POST /pair` (which spends a short-lived
 * single-use pairing secret) every route requires a bearer token that hashes
 * to a paired device, and everything else — unknown paths included — answers
 * 401 before it answers 404, so an unpaired caller cannot map the surface.
 *
 * The bind is the machine's LAN address, not 0.0.0.0: a phone on the same
 * network can reach it, a loopback-only scanner cannot be reached from off
 * the machine, and the host only exists while the operator turned it on.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces, hostname } from 'node:os';
import type {
  AgentDef,
  AppSettings,
  EnvelopeDef,
  GeneratedRunPlan,
  LinearIssueSnapshot,
  LinearStatusMapping,
  LinearWorkflowState,
  ModelInfo,
  PipelineDef,
  ProjectDef,
  ReasoningEffort,
  RunSource,
  SmithProposal,
  SmithProposalAnswer,
  SmithProposalAnswerResult,
  StartRunInput,
  ValidationIssue,
} from '@shared/types.js';
import { isReasoningEffort } from '@shared/reasoning-effort.js';
import type {
  LinearConnectionState,
  OrchestratorState,
  SmithChatState,
  SmithScreenContext,
} from '@shared/ipc-contract.js';
import type {
  CompanionDevice,
  CompanionError,
  CompanionErrorCode,
  CompanionHostState,
  CompanionLinearStartRequest,
  CompanionOrchestratorOptions,
  CompanionOrchestratorStartRequest,
  CompanionOrchestratorStartResult,
  CompanionPairingPayload,
  CompanionPairRequest,
  CompanionPairResult,
  CompanionPipelineSummary,
  CompanionProjectSummary,
  CompanionSessionInfo,
} from '@shared/companion.js';
import { COMPANION_PROTOCOL_VERSION } from '@shared/companion.js';
import type { Tracer } from '../trace/tracer.js';
import type { OneShotFactory } from '../pi/oneshot.js';
import type { GhOptions } from '../system/gh.js';
import * as ghLib from '../system/gh.js';
import {
  createRunPr,
  eventPage,
  runDetail,
  runPrDraft,
  startRun,
  type StartRunDeps,
  type StartRunOutcome,
} from '../engine/operations.js';
import { listRestorableCheckpoints, restoreRun } from '../engine/restore.js';
import { startLinearIssueRun } from '../linear/orchestration.js';
import { DeviceStore } from './devices.js';
import { PairingSecrets } from './pairing.js';

/** Everything the host needs from the app, and nothing more. */
export interface CompanionHostDeps {
  supportDir: string;
  projects(): ProjectDef[];
  projectById(id: string): ProjectDef | null;
  pipelinesFor(projectId: string): PipelineDef[];
  rosterFor(projectId: string): AgentDef[];
  envelopeDefs(): EnvelopeDef[];
  settings(): AppSettings;
  saveProject(next: ProjectDef): ProjectDef;
  oneShot: OneShotFactory;
  registry: {
    start(input: {
      project: ProjectDef;
      pipeline: PipelineDef;
      agents: AgentDef[];
      envelopeDefs: EnvelopeDef[];
      request: string;
      plan?: GeneratedRunPlan | null;
      source?: RunSource | null;
    }): string;
    tracerFor(project: ProjectDef): Tracer;
    isLive(runId: string): boolean;
    kill(project: ProjectDef, runId: string): boolean;
    resume(input: {
      project: ProjectDef;
      runId: string;
      agents: AgentDef[];
      envelopeDefs: EnvelopeDef[];
    }): { ok: boolean; detail: string };
  };
  appVersion(): string;
  notifyRuns(): void;
  /** Models the privileged start boundary may accept on a round-tripped plan. */
  enabledModels?(): Promise<ModelInfo[]>;
  /** Fires when host or device state changes, so Settings re-reads. */
  onStateChanged(): void;
  orchestrator?: CompanionOrchestratorDeps;
  linear?: CompanionLinearDeps;
  /**
   * The same Smith session the desktop window talks to. Optional so a test
   * harness that never opens a chat still constructs a host; missing Smith
   * answers 404 rather than inventing a second conversation.
   */
  smith?: CompanionSmithDeps;
  /** Test seams. Production leaves all three unset. */
  bindHost?: string;
  port?: number;
  gh?: GhOptions;
}

/** The existing desktop plan registry projected onto companion HTTP. */
export interface CompanionOrchestratorDeps {
  options(): Promise<CompanionOrchestratorOptions>;
  start(input: CompanionOrchestratorStartRequest): CompanionOrchestratorStartResult;
  state(planId: string): OrchestratorState | null;
  cancel(planId: string): boolean;
}

/** Linear reads plus the one setting write a Linear-backed start performs. */
export interface CompanionLinearDeps {
  state(): LinearConnectionState;
  issues(query: string): Promise<LinearIssueSnapshot[]>;
  issue(issueId: string): Promise<LinearIssueSnapshot>;
  workflowStates(teamId: string): Promise<LinearWorkflowState[]>;
  saveStatusMapping(mapping: LinearStatusMapping): ValidationIssue[];
}

/** Projection of `SmithService` the LAN host may call — no queue internals. */
export interface CompanionSmithDeps {
  chat(projectId?: string): CompanionSmithChat | null;
  listProposals(): SmithProposal[];
  answerProposal(id: string, answer: SmithProposalAnswer): Promise<SmithProposalAnswerResult>;
  /** Same catalog the desktop picker reads. Empty when no provider is connected. */
  models(): Promise<ModelInfo[]>;
}

/** The chat verbs a phone needs; matches `SmithChatSession` without importing it. */
export interface CompanionSmithChat {
  snapshot(): SmithChatState;
  send(text: string, ctx?: { screen?: SmithScreenContext }): Promise<unknown>;
  cancel(): Promise<void>;
  newChat(): Promise<void>;
  setModel(model: string): Promise<void>;
  setReasoningEffort(effort: ReasoningEffort): Promise<void>;
}

const MAX_BODY_BYTES = 256 * 1024;

class RouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: CompanionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Interface names that are almost never the address a phone on the Wi-Fi can
 * reach: VPN tunnels, AirDrop/awdl, Thunderbolt bridges, container and VM
 * adapters. macOS often reports one of these before `en0`, so taking the first
 * non-internal IPv4 silently bound the host where nothing could call it.
 */
const VIRTUAL_INTERFACE_PREFIXES = [
  'utun',
  'ipsec',
  'awdl',
  'llw',
  'bridge',
  'docker',
  'vnic',
  'vmnet',
  'tap',
  'tun',
  'gif',
  'stf',
  'anpi',
  'ap1',
];

interface LanCandidate {
  name: string;
  address: string;
  /** False for a virtual adapter or a self-assigned 169.254 address. */
  usable: boolean;
}

type BindOutcome = { ok: true; server: Server; port: number } | { ok: false; detail: string };

function isVirtualName(name: string): boolean {
  const lower = name.toLowerCase();
  return VIRTUAL_INTERFACE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Where the LAN can reach us, and whether that address is worth trusting.
 * Prefers a physical adapter with a routable IPv4; falls back to whatever
 * exists so a working-but-odd setup still binds, with the oddity reported.
 */
export function lanInterface(): LanCandidate | null {
  const candidates: LanCandidate[] = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4') continue;
      candidates.push({
        name,
        address: entry.address,
        usable: !isVirtualName(name) && !entry.address.startsWith('169.254.'),
      });
    }
  }
  return candidates.find((c) => c.usable) ?? candidates[0] ?? null;
}

/** The IPv4 address the host binds, i.e. where the LAN can reach us. */
export function lanAddress(): string | null {
  return lanInterface()?.address ?? null;
}

export class CompanionHost {
  private server: Server | null = null;
  private origin: string | null = null;
  private detail: string | undefined;
  private readonly devices: DeviceStore;
  private readonly secrets = new PairingSecrets();

  constructor(private readonly deps: CompanionHostDeps) {
    this.devices = new DeviceStore(deps.supportDir);
  }

  state(): CompanionHostState {
    return {
      running: !!this.server,
      origin: this.origin,
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      devices: this.devices.list(),
      ...(this.detail ? { detail: this.detail } : {}),
    };
  }

  /** Restores the host only when the operator left it enabled before quitting. */
  async restore(): Promise<CompanionHostState> {
    return this.devices.enabled() ? this.start() : this.state();
  }

  /**
   * Binds the server. Idempotent: an already-running host reports itself.
   *
   * The port is the one this install bound last, so a phone that stored the
   * origin can reconnect after a relaunch without re-scanning the QR. When
   * that port is taken we bind an ephemeral one and persist it as the new
   * last-known — a changed port is reported, never silently served.
   */
  async start(): Promise<CompanionHostState> {
    this.devices.setEnabled(true);
    if (this.server) return this.state();
    const chosen = this.deps.bindHost ? null : lanInterface();
    const host = this.deps.bindHost ?? chosen?.address;
    if (!host) {
      this.detail = 'no LAN address: is this Mac on a network?';
      return this.state();
    }
    const requested = this.deps.port ?? this.devices.lastPort() ?? 0;
    let bound = await this.bind(host, requested);
    let reassigned: number | null = null;
    if (!bound.ok && requested !== 0) {
      // The remembered port is gone (another process took it, or the OS is
      // still holding it). An ephemeral port beats refusing to serve.
      bound = await this.bind(host, 0);
      if (bound.ok) reassigned = requested;
    }
    if (!bound.ok) {
      this.detail = `could not bind ${host}: ${bound.detail}`;
      return this.state();
    }

    this.server = bound.server;
    this.origin = `http://${host}:${bound.port}`;
    this.devices.rememberPort(bound.port);
    this.detail = startupWarning(chosen, reassigned, bound.port);
    this.deps.onStateChanged();
    return this.state();
  }

  /** Listens, answering the server and its port, or the failure message. */
  private bind(host: string, port: number): Promise<BindOutcome> {
    const server = createServer((req, res) => void this.handle(req, res));
    return new Promise<BindOutcome>((resolve) => {
      const onError = (e: Error): void => resolve({ ok: false, detail: e.message });
      server.once('error', onError);
      server.listen(port, host, () => {
        server.removeListener('error', onError);
        const address = server.address();
        resolve({
          ok: true,
          server,
          port: typeof address === 'object' && address ? address.port : 0,
        });
      });
    });
  }

  /**
   * Unbinds and drops outstanding pairing secrets. A manual stop disables
   * restoration; process shutdown preserves the operator's enabled choice.
   * Device tokens survive either way.
   */
  async stop(options: { preserveEnabled?: boolean } = {}): Promise<CompanionHostState> {
    if (!options.preserveEnabled) this.devices.setEnabled(false);
    const server = this.server;
    this.server = null;
    this.origin = null;
    this.secrets.clear();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      this.deps.onStateChanged();
    }
    return this.state();
  }

  /**
   * The pairing payload for the QR and the copy button. Re-reading returns the
   * same in-flight secret; pass `{ refresh: true }` to mint a replacement.
   * Null while the host is stopped — there is nothing to pair with.
   */
  pairingPayload(opts?: { refresh?: boolean }): CompanionPairingPayload | null {
    if (!this.origin) return null;
    const issued = opts?.refresh
      ? this.secrets.issue()
      : (this.secrets.current() ?? this.secrets.issue());
    return {
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      origin: this.origin,
      desktopId: this.devices.desktopId(),
      desktopName: hostname(),
      secret: issued.secret,
      expiresAt: issued.expiresAt,
    };
  }

  /** Unpair: deletes the device row, which is what revokes its token. */
  unpair(deviceId: string): boolean {
    const removed = this.devices.unpair(deviceId);
    if (removed) this.deps.onStateChanged();
    return removed;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.route(req, res);
    } catch (e) {
      const status = e instanceof RouteError ? e.status : 500;
      const code: CompanionErrorCode = e instanceof RouteError ? e.code : 'internal';
      this.json(res, status, {
        error: { code, message: errorMessage(e) || 'internal error' },
      } satisfies CompanionError);
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://companion.local');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (method === 'POST' && path === '/pair') {
      this.json(res, 200, await this.pair(req));
      return;
    }

    // Everything else authenticates first — including unknown paths, so an
    // unpaired caller learns nothing about the surface from status codes.
    const device = this.devices.authenticate(bearerToken(req));
    if (!device) throw new RouteError(401, 'unauthorized', 'unknown or revoked device token');

    const segments = path.split('/').filter(Boolean);
    const answer = await this.dispatch(method, segments, url, req, device);
    this.json(res, 200, answer);
  }

  private async pair(req: IncomingMessage): Promise<CompanionPairResult> {
    const body = (await readJson(req)) as Partial<CompanionPairRequest>;
    if (typeof body.protocolVersion !== 'number' || typeof body.secret !== 'string') {
      throw new RouteError(400, 'bad_request', 'pair needs protocolVersion and secret');
    }
    if (body.protocolVersion !== COMPANION_PROTOCOL_VERSION) {
      // Readable on the phone's pairing screen: the version mismatch is the
      // one error a user can only fix by updating one of the two apps.
      throw new RouteError(
        409,
        'protocol_mismatch',
        `this desktop speaks companion protocol v${COMPANION_PROTOCOL_VERSION}, the phone sent v${body.protocolVersion} — update the older app`,
      );
    }
    if (!this.secrets.redeem(body.secret)) {
      throw new RouteError(
        401,
        'pairing_invalid',
        'that pairing code is expired or already used — Foundry shows a fresh one in Settings',
      );
    }
    const { deviceId, token } = this.devices.register(
      typeof body.deviceName === 'string' ? body.deviceName : '',
    );
    this.deps.onStateChanged();
    return {
      token,
      deviceId,
      desktopId: this.devices.desktopId(),
      desktopName: hostname(),
      protocolVersion: COMPANION_PROTOCOL_VERSION,
    };
  }

  private async dispatch(
    method: string,
    segments: string[],
    url: URL,
    req: IncomingMessage,
    device: CompanionDevice,
  ): Promise<unknown> {
    const [v1, head, ...rest] = segments;
    if (v1 !== 'v1') throw new RouteError(404, 'not_found', 'no such route');

    if (method === 'POST' && head === 'unpair' && rest.length === 0) {
      this.unpair(device.deviceId);
      return { ok: true };
    }

    if (method === 'GET' && head === 'session' && rest.length === 0) {
      return {
        desktopId: this.devices.desktopId(),
        desktopName: hostname(),
        protocolVersion: COMPANION_PROTOCOL_VERSION,
        appVersion: this.deps.appVersion(),
      } satisfies CompanionSessionInfo;
    }

    if (method === 'GET' && head === 'projects' && rest.length === 0) {
      return this.deps.projects().map((project): CompanionProjectSummary => ({
        id: project.id,
        name: project.name,
        pipelines: this.deps.pipelinesFor(project.id).map(summarizePipeline),
      }));
    }

    if (head === 'orchestrator') return this.orchestratorRoute(method, rest, req);

    if (head === 'linear') return this.linearRoute(method, rest, url, req);

    if (head === 'projects' && rest.length >= 2) return this.projectRoute(method, rest, url, req);

    if (method === 'POST' && head === 'runs' && rest.length === 0) {
      const input = (await readJson(req)) as Partial<StartRunInput>;
      if (
        typeof input.projectId !== 'string' ||
        typeof input.pipelineId !== 'string' ||
        typeof input.request !== 'string'
      ) {
        throw new RouteError(400, 'bad_request', 'start needs projectId, pipelineId, and request');
      }
      const plan = parseGeneratedPlan(input.plan);
      if (input.plan != null && !plan) {
        throw new RouteError(400, 'bad_request', 'plan is not a generated run plan');
      }
      return startRun(this.startDeps(), {
        projectId: input.projectId,
        pipelineId: input.pipelineId,
        request: input.request,
        ...(plan ? { plan } : {}),
      });
    }

    if (head === 'smith') return this.smithRoute(method, rest, url, req);

    throw new RouteError(404, 'not_found', 'no such route');
  }

  /** Routes under `/v1/orchestrator`. */
  private async orchestratorRoute(
    method: string,
    rest: string[],
    req: IncomingMessage,
  ): Promise<unknown> {
    const orchestrator = this.deps.orchestrator;
    if (!orchestrator) throw new RouteError(404, 'not_found', 'Orchestrator is not available');

    if (method === 'GET' && rest[0] === 'options' && rest.length === 1) {
      return orchestrator.options();
    }
    if (method === 'POST' && rest[0] === 'plans' && rest.length === 1) {
      const body = (await readJson(req)) as Partial<CompanionOrchestratorStartRequest>;
      if (
        typeof body.projectId !== 'string' ||
        typeof body.prompt !== 'string' ||
        typeof body.model !== 'string' ||
        !isReasoningEffort(body.reasoningEffort)
      ) {
        throw new RouteError(
          400,
          'bad_request',
          'plan needs projectId, prompt, model, and a known reasoning effort',
        );
      }
      return orchestrator.start({
        projectId: body.projectId,
        prompt: body.prompt,
        model: body.model,
        reasoningEffort: body.reasoningEffort,
      });
    }
    const planId = rest[0] === 'plans' ? rest[1] : undefined;
    if (method === 'GET' && planId && rest.length === 2) {
      const state = orchestrator.state(planId);
      if (!state) throw new RouteError(404, 'not_found', 'plan not found');
      return state;
    }
    if (method === 'POST' && planId && rest[2] === 'cancel' && rest.length === 3) {
      return { ok: orchestrator.cancel(planId) };
    }
    throw new RouteError(404, 'not_found', 'no such route');
  }

  /** Routes under `/v1/linear`. */
  private async linearRoute(
    method: string,
    rest: string[],
    url: URL,
    req: IncomingMessage,
  ): Promise<unknown> {
    const linear = this.deps.linear;
    if (!linear) throw new RouteError(404, 'not_found', 'Linear is not available');

    if (method === 'GET' && rest.length === 0) {
      return {
        ...linear.state(),
        statusMapping: this.deps.settings().linearStatusMapping,
      };
    }
    if (method === 'GET' && rest[0] === 'issues' && rest.length === 1) {
      return linear.issues(url.searchParams.get('query') ?? '');
    }
    if (
      method === 'GET' &&
      rest[0] === 'teams' &&
      rest[1] &&
      rest[2] === 'workflow-states' &&
      rest.length === 3
    ) {
      return linear.workflowStates(rest[1]);
    }
    if (method === 'POST' && rest[0] === 'runs' && rest.length === 1) {
      return this.startLinearRun(linear, await readJson(req));
    }
    throw new RouteError(404, 'not_found', 'no such route');
  }

  private async startLinearRun(
    linear: CompanionLinearDeps,
    raw: unknown,
  ): Promise<StartRunOutcome> {
    const body = raw as Partial<CompanionLinearStartRequest>;
    if (
      typeof body.projectId !== 'string' ||
      typeof body.pipelineId !== 'string' ||
      typeof body.issueId !== 'string'
    ) {
      throw new RouteError(400, 'bad_request', 'start needs projectId, pipelineId, and issueId');
    }
    const statusMapping = parseStatusMapping(body.statusMapping);
    if (!statusMapping) {
      throw new RouteError(
        400,
        'bad_request',
        'statusMapping needs started, completed, and failed',
      );
    }
    const plan = parseGeneratedPlan(body.plan);
    if (body.plan != null && !plan) {
      throw new RouteError(400, 'bad_request', 'plan is not a generated run plan');
    }
    const issues = linear.saveStatusMapping(statusMapping);
    if (issues.length) return { ok: false, issues };
    try {
      return await startLinearIssueRun(this.startDeps(), linear, statusMapping, {
        projectId: body.projectId,
        pipelineId: body.pipelineId,
        issueId: body.issueId,
        ...(plan ? { plan } : {}),
      });
    } catch (error) {
      // The desktop IPC path surfaces Linear lookups as a readable outcome;
      // the companion route must not turn them into a bare 500.
      return {
        ok: false,
        issues: [
          {
            level: 'error',
            where: 'linear.issue',
            message: error instanceof Error ? error.message : 'Could not read the Linear issue',
          },
        ],
      };
    }
  }

  /** Routes under `/v1/projects/:projectId/...`. */
  private async projectRoute(
    method: string,
    rest: string[],
    url: URL,
    req: IncomingMessage,
  ): Promise<unknown> {
    const [projectId, kind, runId, tail] = rest;
    const project = projectId ? this.deps.projectById(projectId) : null;
    if (!project) throw new RouteError(404, 'not_found', 'project not found');
    const tracer = this.deps.registry.tracerFor(project);

    if (method === 'GET' && kind === 'pr-status' && rest.length === 2) {
      return ghLib.ghStatus(project.path, this.deps.gh ?? {});
    }

    if (kind !== 'runs') throw new RouteError(404, 'not_found', 'no such route');

    if (method === 'GET' && rest.length === 2) {
      const includeArchived = url.searchParams.get('archived') === 'true';
      return tracer.runs({ projectId: project.id, includeArchived });
    }
    if (!runId) throw new RouteError(404, 'not_found', 'no such route');

    if (method === 'GET' && rest.length === 3) {
      return runDetail(tracer, runId, this.deps.registry.isLive(runId));
    }
    if (method === 'GET' && tail === 'events' && rest.length === 4) {
      const after = Number(url.searchParams.get('after') ?? '0');
      return eventPage(tracer, runId, Number.isFinite(after) && after > 0 ? after : 0);
    }
    if (method === 'GET' && tail === 'checkpoints' && rest.length === 4) {
      return listRestorableCheckpoints(
        {
          tracer,
          isLive: (id) => this.deps.registry.isLive(id),
        },
        runId,
      );
    }
    if (method === 'POST' && tail === 'restore' && rest.length === 4) {
      const body = (await readJson(req)) as Partial<{
        checkpointId: string;
        acceptPartial: boolean;
      }>;
      if (typeof body.checkpointId !== 'string' || !body.checkpointId) {
        throw new RouteError(400, 'bad_request', 'restore needs checkpointId');
      }
      return restoreRun(
        {
          tracer,
          isLive: (id) => this.deps.registry.isLive(id),
          notifyRuns: () => this.deps.notifyRuns(),
        },
        {
          runId,
          checkpointId: body.checkpointId,
          ...(body.acceptPartial === true ? { acceptPartial: true } : {}),
        },
      );
    }
    if (method === 'GET' && tail === 'pr-draft' && rest.length === 4) {
      const draft = runPrDraft(tracer, runId);
      if (!draft) throw new RouteError(404, 'not_found', 'run not found');
      return draft;
    }
    if (method === 'POST' && tail === 'kill' && rest.length === 4) {
      return { ok: this.deps.registry.kill(project, runId) };
    }
    if (method === 'POST' && tail === 'continue' && rest.length === 4) {
      return this.deps.registry.resume({
        project,
        runId,
        agents: this.deps.rosterFor(projectId),
        envelopeDefs: this.deps.envelopeDefs(),
      });
    }
    if (method === 'POST' && tail === 'pr' && rest.length === 4) {
      const body = (await readJson(req)) as Partial<{ title: string; body: string }>;
      return createRunPr(
        {
          project,
          tracer,
          notifyRuns: () => this.deps.notifyRuns(),
          ...(this.deps.gh ? { gh: this.deps.gh } : {}),
        },
        runId,
        typeof body.title === 'string' ? body.title : '',
        typeof body.body === 'string' ? body.body : '',
      );
    }

    throw new RouteError(404, 'not_found', 'no such route');
  }

  /** Routes under `/v1/smith`. Same session the desktop window uses. */
  private async smithRoute(
    method: string,
    rest: string[],
    url: URL,
    req: IncomingMessage,
  ): Promise<unknown> {
    const smith = this.deps.smith;
    if (!smith) throw new RouteError(404, 'not_found', 'Smith is not available');

    if (method === 'GET' && rest.length === 0) {
      return this.smithSnapshot(smith, url.searchParams.get('projectId'));
    }
    if (method === 'GET' && rest[0] === 'proposals' && rest.length === 1) {
      return smith.listProposals();
    }
    if (method === 'GET' && rest[0] === 'models' && rest.length === 1) {
      return smith.models();
    }
    if (method === 'POST' && rest[0] === 'send' && rest.length === 1) {
      return this.smithSend(smith, await readJson(req));
    }
    if (method === 'POST' && rest[0] === 'cancel' && rest.length === 1) {
      const chat = this.smithChat(smith, scopeFromBody(await readJson(req)));
      await chat.cancel();
      return chat.snapshot();
    }
    if (method === 'POST' && rest[0] === 'new' && rest.length === 1) {
      const chat = this.smithChat(smith, scopeFromBody(await readJson(req)));
      await chat.newChat();
      return chat.snapshot();
    }
    if (method === 'POST' && rest[0] === 'proposals' && rest[1] === 'answer' && rest.length === 2) {
      return this.smithAnswer(smith, await readJson(req));
    }
    if (method === 'POST' && rest[0] === 'model' && rest.length === 1) {
      return this.smithSetModel(smith, await readJson(req));
    }
    if (method === 'POST' && rest[0] === 'effort' && rest.length === 1) {
      return this.smithSetEffort(smith, await readJson(req));
    }

    throw new RouteError(404, 'not_found', 'no such route');
  }

  private smithSnapshot(smith: CompanionSmithDeps, projectId: string | null): SmithChatState {
    return this.smithChat(smith, optionalProjectId(projectId)).snapshot();
  }

  private smithSend(smith: CompanionSmithDeps, raw: unknown): SmithChatState {
    const body = raw as Partial<{ projectId?: string; text: string; screen?: SmithScreenContext }>;
    if (typeof body.text !== 'string') {
      throw new RouteError(400, 'bad_request', 'send needs text');
    }
    const chat = this.smithChat(smith, optionalProjectId(body.projectId));
    if (!body.text.trim()) return chat.snapshot();
    const screen = parseScreen(body.screen);
    void chat.send(body.text, screen ? { screen } : {}).catch(() => undefined);
    return chat.snapshot();
  }

  private async smithAnswer(
    smith: CompanionSmithDeps,
    raw: unknown,
  ): Promise<SmithProposalAnswerResult> {
    const body = raw as Partial<{ id: string; answer: Partial<SmithProposalAnswer> }>;
    if (typeof body.id !== 'string' || !body.id || typeof body.answer?.approved !== 'boolean') {
      throw new RouteError(400, 'bad_request', 'answer needs id and approved');
    }
    const answer: SmithProposalAnswer = { approved: body.answer.approved };
    if (typeof body.answer.note === 'string') answer.note = body.answer.note;
    if (typeof body.answer.secret === 'string') answer.secret = body.answer.secret;
    return smith.answerProposal(body.id, answer);
  }

  private async smithSetModel(smith: CompanionSmithDeps, raw: unknown): Promise<SmithChatState> {
    const body = raw as Partial<{ projectId?: string; model: string }>;
    if (typeof body.model !== 'string' || !body.model.trim()) {
      throw new RouteError(400, 'bad_request', 'model is required');
    }
    const chat = this.smithChat(smith, optionalProjectId(body.projectId));
    await chat.setModel(body.model.trim());
    return chat.snapshot();
  }

  private async smithSetEffort(smith: CompanionSmithDeps, raw: unknown): Promise<SmithChatState> {
    const body = raw as Partial<{ projectId?: string; effort: string }>;
    if (!isReasoningEffort(body.effort)) {
      throw new RouteError(400, 'bad_request', 'a known reasoning effort is required');
    }
    const chat = this.smithChat(smith, optionalProjectId(body.projectId));
    await chat.setReasoningEffort(body.effort);
    return chat.snapshot();
  }

  private smithChat(smith: CompanionSmithDeps, projectId: string | undefined): CompanionSmithChat {
    const chat = smith.chat(projectId);
    if (!chat) throw new RouteError(404, 'not_found', 'Smith chat is not available');
    return chat;
  }

  private startDeps(): StartRunDeps {
    return {
      projectById: (id) => this.deps.projectById(id),
      pipelineFor: (projectId, pipelineId) =>
        this.deps.pipelinesFor(projectId).find((p) => p.id === pipelineId) ?? null,
      rosterFor: (projectId) => this.deps.rosterFor(projectId),
      envelopeDefs: () => this.deps.envelopeDefs(),
      settings: () => this.deps.settings(),
      saveProject: (next) => this.deps.saveProject(next),
      ...(this.deps.enabledModels ? { enabledModels: this.deps.enabledModels } : {}),
      oneShot: this.deps.oneShot,
      registry: this.deps.registry,
    };
  }

  private json(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      // The phone app is a native client; nothing browser-hosted may call this.
      'access-control-allow-origin': 'null',
    });
    res.end(body);
  }
}

/**
 * What the operator needs to know about a bind that worked but is not the one
 * they would have picked: a suspicious interface, or a port that moved and
 * therefore invalidated an already-paired phone's stored origin.
 */
function startupWarning(
  chosen: LanCandidate | null,
  reassigned: number | null,
  port: number,
): string | undefined {
  const notes: string[] = [];
  if (chosen && !chosen.usable) {
    notes.push(
      `bound ${chosen.name} (${chosen.address}), which looks like a virtual adapter — a phone on your Wi-Fi may not reach it`,
    );
  }
  if (reassigned !== null) {
    notes.push(`port ${reassigned} was taken, so this host moved to ${port} — re-scan the QR`);
  }
  return notes.length ? notes.join('; ') : undefined;
}

function summarizePipeline(pipeline: PipelineDef): CompanionPipelineSummary {
  return {
    id: pipeline.id,
    name: pipeline.name,
    description: pipeline.description,
    phases: pipeline.phases.map((phase) => ({
      id: phase.name,
      name: phase.name,
      kind: phase.kind,
      isFeedbackTarget: !!phase.feedbackTo,
      ...(phase.feedbackTo ? { feedbackTo: phase.feedbackTo } : {}),
    })),
  };
}

function optionalProjectId(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function scopeFromBody(raw: unknown): string | undefined {
  const body = raw as Partial<{ projectId?: string }>;
  return optionalProjectId(body.projectId);
}

function parseStatusMapping(raw: unknown): LinearStatusMapping | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const valid = (candidate: unknown): candidate is string | null =>
    candidate === null || typeof candidate === 'string';
  if (!valid(value.started) || !valid(value.completed) || !valid(value.failed)) return null;
  return {
    started: value.started,
    completed: value.completed,
    failed: value.failed,
  };
}

/**
 * Companion plans originate on this host and are only round-tripped by the
 * phone, but the transport is still untrusted. Check the fields the start
 * boundary dereferences before handing the value to its full validators.
 */
function parseGeneratedPlan(raw: unknown): GeneratedRunPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<GeneratedRunPlan>;
  if (
    typeof value.planId !== 'string' ||
    typeof value.projectId !== 'string' ||
    typeof value.prompt !== 'string' ||
    typeof value.refinedRequest !== 'string' ||
    typeof value.rationale !== 'string' ||
    typeof value.model !== 'string' ||
    !isReasoningEffort(value.reasoningEffort) ||
    !value.pipeline ||
    typeof value.pipeline !== 'object' ||
    !Array.isArray(value.pipeline.phases) ||
    !Array.isArray(value.agents) ||
    !Array.isArray(value.warnings)
  ) {
    return null;
  }
  return value as GeneratedRunPlan;
}

const SCREEN_KINDS = new Set(['run', 'pipeline', 'agent', 'envelope', 'project', 'settings']);

function parseScreen(raw: SmithScreenContext | undefined): SmithScreenContext | undefined {
  if (!raw || typeof raw !== 'object' || typeof raw.route !== 'string') return undefined;
  const screen: SmithScreenContext = { route: raw.route };
  const entity = raw.entity;
  if (
    entity &&
    typeof entity === 'object' &&
    typeof entity.id === 'string' &&
    SCREEN_KINDS.has(entity.kind)
  ) {
    screen.entity = { kind: entity.kind, id: entity.id };
  }
  return screen;
}

function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new RouteError(400, 'bad_request', 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new RouteError(400, 'bad_request', 'request body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}
