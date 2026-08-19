/**
 * The LAN companion host: an HTTP server inside the main process that a paired
 * phone calls. Every route is a projection of an operation the desktop already
 * has — the same `startRun`, tracer pages, kill, interrupts, and PR paths the
 * renderer reaches over IPC — so the phone can never do something the window
 * cannot, and main keeps sole ownership of git, the tracer, and spawns.
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
  InterruptAnswer,
  PendingInterrupt,
  PipelineDef,
  ProjectDef,
  StartRunInput,
} from '@shared/types.js';
import type {
  CompanionDevice,
  CompanionError,
  CompanionErrorCode,
  CompanionHostState,
  CompanionPairingPayload,
  CompanionPairRequest,
  CompanionPairResult,
  CompanionProjectSummary,
  CompanionSessionInfo,
} from '@shared/companion.js';
import { COMPANION_PROTOCOL_VERSION } from '@shared/companion.js';
import type { Tracer } from '../trace/tracer.js';
import type { OneShotFactory } from '../pi/oneshot.js';
import type { GhOptions } from '../system/gh.js';
import * as ghLib from '../system/gh.js';
import { createRunPr, eventPage, runDetail, startRun } from '../engine/operations.js';
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
    }): string;
    tracerFor(project: ProjectDef): Tracer;
    isLive(runId: string): boolean;
    kill(project: ProjectDef, runId: string): boolean;
    interrupts(): PendingInterrupt[];
    answer(answer: InterruptAnswer): boolean;
  };
  appVersion(): string;
  notifyRuns(): void;
  /** Fires when host or device state changes, so Settings re-reads. */
  onStateChanged(): void;
  /** Test seams. Production leaves all three unset. */
  bindHost?: string;
  port?: number;
  gh?: GhOptions;
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

/** The first non-internal IPv4 address, i.e. where the LAN can reach us. */
export function lanAddress(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal && entry.family === 'IPv4') return entry.address;
    }
  }
  return null;
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

  /** Binds the server. Idempotent: an already-running host reports itself. */
  async start(): Promise<CompanionHostState> {
    if (this.server) return this.state();
    const host = this.deps.bindHost ?? lanAddress();
    if (!host) {
      this.detail = 'no LAN address: is this Mac on a network?';
      return this.state();
    }
    const server = createServer((req, res) => void this.handle(req, res));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.deps.port ?? 0, host, () => resolve());
      });
    } catch (e) {
      this.detail = `could not bind ${host}: ${(e as Error).message}`;
      return this.state();
    }
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    this.server = server;
    this.origin = `http://${host}:${port}`;
    this.detail = undefined;
    this.deps.onStateChanged();
    return this.state();
  }

  /** Unbinds and drops outstanding pairing secrets. Device tokens survive. */
  async stop(): Promise<CompanionHostState> {
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
   * A fresh pairing payload for the QR. Null while the host is stopped —
   * there is nothing to pair with.
   */
  pairingPayload(): CompanionPairingPayload | null {
    if (!this.origin) return null;
    const { secret, expiresAt } = this.secrets.issue();
    return {
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      origin: this.origin,
      desktopId: this.devices.desktopId(),
      desktopName: hostname(),
      secret,
      expiresAt,
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
      if (e instanceof RouteError) {
        this.json(res, e.status, {
          error: { code: e.code, message: e.message },
        } satisfies CompanionError);
        return;
      }
      this.json(res, 500, {
        error: { code: 'internal', message: (e as Error).message || 'internal error' },
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
        pipelines: this.deps.pipelinesFor(project.id).map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          phases: p.phases.map((phase) => ({
            id: phase.name,
            name: phase.name,
            kind: phase.kind,
            isFeedbackTarget: !!phase.feedbackTo,
            ...(phase.feedbackTo ? { feedbackTo: phase.feedbackTo } : {}),
          })),
        })),
      }));
    }

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
      return startRun(this.startDeps(), {
        projectId: input.projectId,
        pipelineId: input.pipelineId,
        request: input.request,
      });
    }

    if (head === 'interrupts') {
      if (method === 'GET' && rest.length === 0) return this.deps.registry.interrupts();
      if (method === 'POST' && rest[0] === 'answer' && rest.length === 1) {
        const answer = (await readJson(req)) as Partial<InterruptAnswer>;
        if (typeof answer.interruptId !== 'string' || typeof answer.decision !== 'string') {
          throw new RouteError(400, 'bad_request', 'answer needs interruptId and decision');
        }
        return {
          ok: this.deps.registry.answer({
            interruptId: answer.interruptId,
            decision: answer.decision === 'approve' ? 'approve' : 'reject',
            ...(typeof answer.text === 'string' ? { text: answer.text } : {}),
          }),
        };
      }
    }

    throw new RouteError(404, 'not_found', 'no such route');
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
    if (method === 'POST' && tail === 'kill' && rest.length === 4) {
      return { ok: this.deps.registry.kill(project, runId) };
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

  private startDeps() {
    return {
      projectById: (id: string) => this.deps.projectById(id),
      pipelineFor: (projectId: string, pipelineId: string) =>
        this.deps.pipelinesFor(projectId).find((p) => p.id === pipelineId) ?? null,
      rosterFor: (projectId: string) => this.deps.rosterFor(projectId),
      envelopeDefs: () => this.deps.envelopeDefs(),
      settings: () => this.deps.settings(),
      saveProject: (next: ProjectDef) => this.deps.saveProject(next),
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

function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
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
