/** Continue an interrupted Pi turn on each next reachable model in catalog order. */

import type { AgentSession as PiAgentSession } from '@earendil-works/pi-coding-agent';
import { modelKey } from './model.js';
import { lastAssistantStop, type VendorEventReader } from './vendor-events.js';

const CONTINUATION =
  'The previous model failed after all automatic retries. Continue the interrupted task from the existing conversation and tool results. Do not restart completed work.';

function modelId(session: PiAgentSession): string | null {
  const model = session.model;
  return model ? modelKey(model) : null;
}

/**
 * Pi retries one model but does not fail over. Its final failed assistant
 * message is removed exactly as Pi removes intermediate retry failures, then a
 * hidden custom message starts a normal turn on the next model. That keeps the
 * conversation and tools intact and gives every fallback its own retry budget.
 *
 * Hidden picker models are skipped, not tried. The current model may itself be
 * hidden — the operator or roster named it — but failover will not spend a
 * retry budget on anything else the operator hid.
 */
export async function continueWithModelFailover(input: {
  session: PiAgentSession;
  events: VendorEventReader;
  availableModelCount: number;
  hiddenModelIds?: readonly string[];
  requireImageInput?: boolean;
  onWarning?: (warning: string) => void;
}): Promise<void> {
  const attempted = new Set<string>();
  const hidden = new Set(input.hiddenModelIds ?? []);
  const initial = modelId(input.session);
  if (initial) attempted.add(initial);
  // The last model that actually ran a turn. cycleModel() steps onto hidden
  // ids we skip, and those must not appear as the failure we are recovering from.
  let lastTried = initial ?? 'the current model';

  while (
    input.events.retryExhausted &&
    lastAssistantStop(input.session)?.stopReason === 'error' &&
    attempted.size < input.availableModelCount
  ) {
    const next = await input.session.cycleModel();
    if (!next) return;

    const nextId = modelKey(next.model);
    if (attempted.has(nextId)) return;
    attempted.add(nextId);
    // cycleModel() has already stepped onto this id. Do not start a turn on
    // a model the operator hid or one that cannot consume this turn's images;
    // keep walking until a compatible one or a wrap.
    if (hidden.has(nextId) || (input.requireImageInput && !next.model.input.includes('image'))) {
      continue;
    }

    const messages = input.session.agent.state.messages;
    const last = messages[messages.length - 1];
    if (last?.role === 'assistant' && last.stopReason === 'error') {
      messages.pop();
    }

    input.onWarning?.(`${lastTried} failed after 5 retries; continuing this turn on ${nextId}`);
    lastTried = nextId;
    input.events.startModelAttempt();
    await input.session.sendCustomMessage(
      {
        customType: 'foundry-model-failover',
        content: CONTINUATION,
        display: false,
      },
      { triggerTurn: true },
    );
    await input.session.waitForIdle();
  }
}
