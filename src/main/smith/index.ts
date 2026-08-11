/**
 * The Smith service: the proposal queue and the socket transport, wired together
 * and owned by `AppContext`. One instance per app, started at boot.
 *
 * Smith itself does not live here. It is a skill (`skills/foundry-smith/`) that
 * any agent can load in the user's own terminal; the app's only job is to be
 * listening, to validate what that agent proposes, and to hold every write
 * behind a human's Approve. Nothing in this service spawns a process.
 */

import { join } from 'node:path';
import type { SmithProposal } from '@shared/types.js';
import { ProposalQueue } from './proposals.js';
import { SmithSocketServer } from './socket-server.js';

/** Everything the Smith service needs from the wider app, kept to a narrow seam. */
export interface SmithServiceDeps {
  supportDir: string;
  /** Broadcasts a channel + payload to every window. */
  broadcast: (channel: string, payload?: unknown) => void;
  /** Channel name, passed in so this module does not import the contract twice. */
  channels: { proposalsChanged: string };
  /** Persists an approved proposal; supplied by the IPC layer (store access). */
  save: (proposal: SmithProposal) => { ok: true; entity: unknown } | { ok: false; error: string };
  /** Everything the socket server needs to answer and validate. */
  socketCtx: ConstructorParameters<typeof SmithSocketServer>[1];
}

export class SmithService {
  readonly proposals: ProposalQueue;
  readonly socket: SmithSocketServer;

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
  }

  start(): void {
    this.socket.start();
  }

  dispose(): void {
    this.proposals.cancelAll();
    this.socket.stop();
  }
}
