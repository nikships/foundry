/**
 * The SDK's error classes, recognised on this side of the seam, plus the one
 * this seam raises itself.
 *
 * `agent.ts` counts transport failures to decide when to give up on RPC, but
 * it may not import the SDK (ESLint boundary), and the SDK does not funnel
 * everything through one wrapper: a dead child arrives as `ProcessExitError`,
 * a bad frame as `ProtocolError`, a stalled request as `TimeoutError`, and a
 * broken pipe as `ConnectionError`. Naming the four explicitly rather than
 * their `DroidClientError` base keeps a future SDK error class from silently
 * counting as a strike against a transport that is working.
 */

import {
  ConnectionError,
  ProcessExitError,
  ProtocolError,
  TimeoutError,
} from '@factory/droid-sdk/node';

/**
 * A failure this seam raises rather than the SDK: a turn that timed out, a
 * result the SDK reported as an error, a session used before it started.
 */
export class DroidProtocolError extends Error {}

/** Whether a thrown value means the transport itself failed, not the turn. */
export function isTransportFailure(error: unknown): boolean {
  return (
    error instanceof ProcessExitError ||
    error instanceof ProtocolError ||
    error instanceof TimeoutError ||
    error instanceof ConnectionError ||
    error instanceof DroidProtocolError
  );
}
