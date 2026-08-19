/**
 * The renderer's five verbs on the companion host: read state, start, stop,
 * read or refresh a pairing payload, unpair a device. The phone never comes
 * through here — it speaks HTTP to the host itself; this router is only the
 * desktop's on/off switch and its view of who is paired.
 */

import { IPC } from '@shared/ipc-contract.js';
import type { AppContext } from '../context.js';
import type { Handle } from './shared.js';

type Ctx = Pick<AppContext, 'companion'>;

export function register(ctx: Ctx, handle: Handle): void {
  handle(IPC.companionState, () => ctx.companion.state());
  handle(IPC.companionStart, () => ctx.companion.start());
  handle(IPC.companionStop, () => ctx.companion.stop());
  handle(IPC.companionPairingPayload, (opts?: { refresh?: boolean }) =>
    ctx.companion.pairingPayload(opts),
  );
  handle(IPC.companionUnpair, (deviceId: string) => ctx.companion.unpair(deviceId));
}
