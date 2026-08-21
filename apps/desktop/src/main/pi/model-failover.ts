/** Continue an interrupted Pi turn on each next reachable model in catalog order. */

import type { AgentSession as PiAgentSession } from '@earendil-works/pi-coding-agent';
import { lastAssistantStop, type VendorEventReader } from './vendor-events.js';

const CONTINUATION =
  'The previous model failed after all automatic retries. Continue the interrupted task from the existing conversation and tool results. Do not restart completed work.';

function modelId(session: PiAgentSession): string | null {
  const model = session.model;
  return model ? `${model.provider}/${model.id}` : null;
}

/**
 * Pi retries one model but does not fail over. Its final failed assistant
 * message is removed exactly as Pi removes intermediate retry failures, then a
 * hidden custom message starts a normal turn on the next model. That keeps the
 * conversation and tools intact and gives every fallback its own retry budget.
 */
export async function continueWithModelFailover(input: {
  session: PiAgentSession;
  events: VendorEventReader;
  availableModelCount: number;
  onWarning?: (warning: string) => void;
}): Promise<void> {
  const attempted = new Set<string>();
  const initial = modelId(input.session);
  if (initial) attempted.add(initial);

  while (
    input.events.retryExhausted &&
    lastAssistantStop(input.session)?.stopReason === 'error' &&
    attempted.size < input.availableModelCount
  ) {
    const previous = modelId(input.session) ?? 'the current model';
    const next = await input.session.cycleModel();
    if (!next) return;

    const nextId = `${next.model.provider}/${next.model.id}`;
    if (attempted.has(nextId)) return;
    attempted.add(nextId);

    const messages = input.session.agent.state.messages;
    const last = messages[messages.length - 1];
    if (last?.role === 'assistant' && last.stopReason === 'error') {
      messages.pop();
    }

    input.onWarning?.(`${previous} failed after 5 retries; continuing this turn on ${nextId}`);
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
