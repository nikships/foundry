/**
 * The Smith service: the proposal queue, the socket transport, and the Ghostty
 * session registry, wired together and owned by `AppContext`. One instance per
 * app, started at boot.
 */

import { join } from 'node:path';
import type {
  AgentDef,
  EnvelopeDef,
  PipelineDef,
  ProjectDef,
  SmithProposal,
} from '@shared/types.js';
import type { WebContents } from 'electron';
import { cliVersion } from '../droid/catalog.js';
import { findCli } from '../cli/index.js';
import { ProposalQueue } from './proposals.js';
import { SmithSocketServer } from './socket-server.js';
import { SmithRegistry } from './registry.js';
import { ghosttyAvailable, spawnGhosttyEngine } from './engine.js';

/** Everything the Smith service needs from the wider app, kept to a narrow seam. */
export interface SmithServiceDeps {
  supportDir: string;
  /** Absolute path to the running helper binary (`$FOUNDRY_CLI`). */
  cliPath: string;
  /** Broadcasts a channel + payload to every window. */
  broadcast: (channel: string, payload?: unknown) => void;
  /** Channel names, passed in so this module does not import the contract twice. */
  channels: { statusChanged: string; proposalsChanged: string };
  /** The window Smith's terminal paints into (frames go straight to its canvas). */
  webContents: () => WebContents | null;
  /** Persists an approved proposal; supplied by the IPC layer (store access). */
  save: (proposal: SmithProposal) => { ok: true; entity: unknown } | { ok: false; error: string };
  /** Resolves a project's full definition for spawning. */
  projectFor: (projectId: string) => ProjectDef | null;
  /** Scope-aware inventory for the system prompt and socket reads. */
  rosterFor: (projectId?: string) => AgentDef[];
  pipelinesFor: (projectId?: string) => PipelineDef[];
  envelopes: () => EnvelopeDef[];
  /** Everything the socket server needs to answer and validate. */
  socketCtx: ConstructorParameters<typeof SmithSocketServer>[1];
}

export class SmithService {
  readonly proposals: ProposalQueue;
  readonly socket: SmithSocketServer;
  readonly registry: SmithRegistry;

  constructor(deps: SmithServiceDeps) {
    this.proposals = new ProposalQueue(
      () => deps.broadcast(deps.channels.proposalsChanged),
      // The queue awaits the save so an approve that fails the store keeps the
      // card up. The store call itself is synchronous; wrap it in a resolved
      // promise to satisfy the async handler contract.
      (proposal) => Promise.resolve(deps.save(proposal)),
    );

    const socketPath = join(deps.supportDir, 'smith', 'foundry.sock');
    this.socket = new SmithSocketServer(socketPath, deps.socketCtx, this.proposals);

    this.registry = new SmithRegistry({
      supportDir: deps.supportDir,
      cliPath: deps.cliPath,
      socketPath,
      scopeFor: (projectId) => {
        const project = deps.projectFor(projectId);
        if (!project) return null;
        return {
          project,
          agents: deps.rosterFor(projectId),
          pipelines: deps.pipelinesFor(projectId),
          envelopes: deps.envelopes(),
        };
      },
      droid: async () => {
        const path = findCli('droid');
        const version = await cliVersion(path);
        return { ok: !!version, path };
      },
      onStatusChanged: (status) => deps.broadcast(deps.channels.statusChanged, status),
      engineAvailable: ghosttyAvailable,
      spawnEngine: spawnGhosttyEngine,
      webContents: () => deps.webContents(),
    });
  }

  start(): void {
    this.socket.start();
  }

  // TODO(smith-cli-exec): the helper builds to an ESM `foundry-cli.js` with a
  // `#!/usr/bin/env node` shebang. For droid to invoke `$FOUNDRY_CLI` directly
  // the file must be executable and keep its shebang through the bundler; if a
  // future build strips it, wrap the value in a tiny generated shell shim
  // (`exec node "<path>" "$@"`) written next to the system prompt. Left until
  // the packaging path (electron-builder) is exercised on macOS.

  dispose(): void {
    this.proposals.cancelAll();
    this.registry.closeAll();
    this.socket.stop();
  }
}
