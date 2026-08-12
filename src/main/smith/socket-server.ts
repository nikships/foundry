/**
 * The Smith transport server. Listens on a unix domain socket under the app's
 * support dir; the helper CLI — run by whatever agent the user pointed at the
 * `foundry-smith` skill, in their own terminal — connects and speaks the
 * newline-delimited JSON protocol in `protocol.ts`. The socket exists only
 * while the app is running, which is what makes "Foundry is not running" a
 * connect-time answer rather than a state the app has to publish.
 *
 * `list`/`show` answer immediately from the stores, scope-aware. `create`/`edit`
 * validate through the store's own `validate()` FIRST — an invalid spec comes
 * straight back as JSON with no card raised — and only a valid spec is enqueued
 * on the proposal queue, which blocks the connection until a human answers.
 */

import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentDef, EnvelopeDef, PipelineDef, ValidationIssue } from '@shared/types.js';
import { validate as validateAgent } from '../store/roster.js';
import { validate as validatePipeline } from '../store/pipelines.js';
import { validate as validateEnvelope } from '../store/envelopes.js';
import type { AppContext } from '../context.js';
import type { ProposalQueue } from './proposals.js';
import {
  drainLines,
  encodeLine,
  type CliProject,
  type CliRequest,
  type CliResponse,
} from './protocol.js';

type Ctx = Pick<
  AppContext,
  | 'roster'
  | 'pipelines'
  | 'envelopes'
  | 'projects'
  | 'rosterScope'
  | 'pipelineScope'
  | 'rosterFor'
  | 'pipelinesFor'
  | 'commandNames'
>;

/** The entity kinds Smith may write. `project` is deliberately not among them. */
type WritableKind = 'agent' | 'pipeline' | 'envelope';

export class SmithSocketServer {
  private server: Server | null = null;

  constructor(
    private readonly socketPath: string,
    private readonly ctx: Ctx,
    private readonly queue: ProposalQueue,
  ) {}

  /** The socket path, exported to droid as `FOUNDRY_SMITH_SOCKET`. */
  path(): string {
    return this.socketPath;
  }

  /**
   * Binds the socket. A stale socket file from a crashed prior run is removed
   * first — `listen` on an existing path fails with EADDRINUSE otherwise.
   */
  start(): void {
    if (this.server) return;
    mkdirSync(dirname(this.socketPath), { recursive: true });
    if (existsSync(this.socketPath)) {
      try {
        rmSync(this.socketPath);
      } catch {
        // A path we cannot remove will surface as a listen error below.
      }
    }
    const server = createServer((socket) => this.onConnection(socket));
    server.on('error', (err) => console.warn(`[smith] socket server error: ${err.message}`));
    server.listen(this.socketPath);
    this.server = server;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    if (existsSync(this.socketPath)) {
      try {
        rmSync(this.socketPath);
      } catch {
        // Best-effort cleanup on shutdown.
      }
    }
  }

  private onConnection(socket: Socket): void {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const { lines, rest } = drainLines(buffer);
      buffer = rest;
      for (const line of lines) void this.handleLine(line, socket);
    });
    socket.on('error', () => {
      // A CLI that died mid-request just drops the connection.
    });
  }

  private async handleLine(line: string, socket: Socket): Promise<void> {
    let request: CliRequest;
    try {
      request = JSON.parse(line) as CliRequest;
    } catch {
      this.reply(socket, { ok: false, error: 'malformed request' });
      return;
    }
    try {
      const response = await this.dispatch(request);
      this.reply(socket, response);
    } catch (e) {
      this.reply(socket, { ok: false, error: (e as Error).message || 'internal error' });
    }
  }

  private reply(socket: Socket, response: CliResponse): void {
    if (!socket.destroyed) socket.write(encodeLine(response));
  }

  /**
   * The whole protocol surface. Read ops answer from the stores; write ops
   * validate then propose. Exposed for unit tests that drive it without a real
   * socket.
   */
  async dispatch(request: CliRequest): Promise<CliResponse> {
    const projectId = request.projectId || undefined;

    // Projects are discoverable but never writable: the skill needs to learn
    // what it can scope itself to, and nothing more.
    if (request.kind === 'project' && request.op !== 'list') {
      return { ok: false, error: `projects are read-only: "${request.op}" is not allowed` };
    }

    switch (request.op) {
      case 'list':
        return {
          ok: true,
          kind: request.kind,
          entities: this.listEntities(request.kind, projectId),
        };
      case 'show': {
        if (!request.name) return { ok: false, error: 'show needs a name' };
        const entity = this.showEntity(request.kind, request.name, projectId);
        if (!entity) return { ok: false, error: `no ${request.kind} named "${request.name}"` };
        return { ok: true, kind: request.kind, entity };
      }
      case 'create':
      case 'edit':
        return this.write(request, projectId);
      default:
        return { ok: false, error: `unknown op "${(request as CliRequest).op}"` };
    }
  }

  private listEntities(kind: CliRequest['kind'], projectId?: string): unknown[] {
    if (kind === 'agent') return this.ctx.rosterFor(projectId);
    if (kind === 'pipeline') return this.ctx.pipelinesFor(projectId);
    if (kind === 'project') return this.listProjects();
    return this.ctx.envelopes.list();
  }

  /** Projects, projected down to the three fields the protocol allows out. */
  private listProjects(): CliProject[] {
    return this.ctx.projects
      .list()
      .map((project) => ({ id: project.id, name: project.name, path: project.path }));
  }

  private showEntity(kind: CliRequest['kind'], name: string, projectId?: string): unknown {
    if (kind === 'agent') return this.ctx.roster.get(name, this.ctx.rosterScope(projectId));
    if (kind === 'pipeline') return this.ctx.pipelines.get(name, this.ctx.pipelineScope(projectId));
    if (kind === 'project') return null;
    return this.ctx.envelopes.get(name);
  }

  private async write(request: CliRequest, projectId?: string): Promise<CliResponse> {
    if (request.spec == null || typeof request.spec !== 'object') {
      return { ok: false, error: 'create/edit needs a spec object' };
    }
    // `dispatch` already turned a project write away; this narrows the kind for
    // the proposal, which only models the three writable entities.
    if (request.kind === 'project') {
      return { ok: false, error: 'projects are read-only' };
    }
    const kind: WritableKind = request.kind;
    const { name, issues, overwrites } = this.prepare(request, kind, projectId);
    if (!name) return { ok: false, error: `${kind} spec is missing its name` };

    // Validation is the gate before any card. Warnings pass through onto the
    // card; only errors refuse here, matching the store's own save contract.
    const errors = issues.filter((i) => i.level === 'error');
    if (errors.length) return { ok: false, validation: errors };

    const warnings = issues.filter((i) => i.level === 'warning');
    let outcome;
    try {
      outcome = await this.queue.propose({
        kind,
        mode: request.op === 'create' ? 'create' : 'edit',
        name,
        spec: request.spec,
        validation: warnings,
        overwrites,
        projectId: projectId ?? '',
      });
    } catch (e) {
      // The one race the CLI is told to expect: another proposal is pending.
      return { ok: false, error: (e as Error).message };
    }

    if (outcome.approved) return { ok: true, entity: outcome.entity };
    return { ok: false, rejected: true, note: outcome.note };
  }

  /**
   * Resolves the spec's identifying name, validates it, and decides whether an
   * approve would overwrite an existing entity (stores upsert by name/id).
   */
  private prepare(
    request: CliRequest,
    kind: WritableKind,
    projectId?: string,
  ): { name: string; issues: ValidationIssue[]; overwrites: boolean } {
    const spec = request.spec as Record<string, unknown>;
    if (kind === 'agent') {
      const agent = spec as unknown as AgentDef;
      const known = this.ctx.envelopes.list().map((e) => e.name);
      return {
        name: agent.name ?? '',
        issues: validateAgent(agent, known),
        overwrites: !!this.ctx.roster.get(agent.name, this.ctx.rosterScope(projectId)),
      };
    }
    if (kind === 'pipeline') {
      const pipeline = spec as unknown as PipelineDef;
      const agents = this.ctx.rosterFor(projectId);
      const commandNames = this.ctx.commandNames(projectId);
      const known = this.ctx.envelopes.list().map((e) => e.name);
      return {
        name: pipeline.id ?? '',
        issues: validatePipeline(pipeline, agents, commandNames, known),
        overwrites: !!this.ctx.pipelines.get(pipeline.id, this.ctx.pipelineScope(projectId)),
      };
    }
    const envelope = spec as unknown as EnvelopeDef;
    return {
      name: envelope.name ?? '',
      issues: validateEnvelope(envelope),
      overwrites: !!this.ctx.envelopes.get(envelope.name),
    };
  }
}
