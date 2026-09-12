/**
 * Retry the live model on any provider error, then continue the same turn on
 * the operator's default model and the rest of the reachable catalog.
 *
 * Pi only auto-retries transient failures (overloaded, 429, 5xx). A 402 or a
 * 400 ends the turn with `stopReason: 'error'` and no `retryExhausted` flag.
 * Foundry spends the same five-attempt budget on those errors, then hops.
 */

import type { AgentSession as PiAgentSession } from '@earendil-works/pi-coding-agent';
import { INHERIT_MODEL, modelKey, type PiModel } from './model.js';
import { lastAssistantStop, type VendorEventReader } from './vendor-events.js';

/** Same-model attempts after the first failure. Matches `foundrySettings` retry. */
export const MODEL_RETRY_LIMIT = 5;

const FAILOVER_CONTINUATION =
  'The previous model failed after all automatic retries. Continue the interrupted task from the existing conversation and tool results. Do not restart completed work.';

const RETRY_CONTINUATION =
  'Retrying the interrupted turn after a provider error. Continue from the existing conversation and tool results. Do not restart completed work.';

function modelId(session: PiAgentSession): string | null {
  const model = session.model;
  return model ? modelKey(model) : null;
}

function errorStop(session: PiAgentSession): { errorMessage?: string } | null {
  const stop = lastAssistantStop(session);
  return stop?.stopReason === 'error' ? stop : null;
}

function popFailedAssistant(session: PiAgentSession): void {
  const messages = session.agent.state.messages;
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant' && last.stopReason === 'error') {
    messages.pop();
  }
}

function isUsable(model: PiModel, requireImageInput?: boolean): boolean {
  if (requireImageInput && !model.input.includes('image')) return false;
  return true;
}

function preferredId(id: string | undefined): string | undefined {
  const trimmed = id?.trim();
  if (!trimmed || trimmed === INHERIT_MODEL) return undefined;
  return trimmed;
}

async function retrigger(
  session: PiAgentSession,
  content: string,
  customType: string,
): Promise<void> {
  popFailedAssistant(session);
  await session.sendCustomMessage(
    {
      customType,
      content,
      display: false,
    },
    { triggerTurn: true },
  );
  await session.waitForIdle();
}

/**
 * Pi retries one model but does not fail over, and it will not retry a
 * non-transient error at all. Failed assistant messages are removed exactly as
 * Pi removes intermediate retry failures, then a hidden custom message starts
 * a normal turn. Same-model retries reuse the conversation; a hop also switches
 * the session model. Every fallback gets its own retry budget.
 *
 * Failover appoints nothing outside the enabled catalog it is handed: the
 * caller reads it live, so a model hidden after the session opened is skipped
 * like one already tried. The model the session currently runs is not
 * re-checked here — it was appointed from that catalog when it opened, and the
 * retry budget below belongs to it.
 *
 * The first hop prefers Settings `defaultModel` when that id is enabled.
 * Remaining hops walk the catalog, skipping ids already tried.
 */
export async function continueWithModelFailover(input: {
  session: PiAgentSession;
  events: VendorEventReader;
  /** What this install may run on. Failover names nothing outside it. */
  availableModels: readonly PiModel[];
  preferredModelId?: string;
  requireImageInput?: boolean;
  onWarning?: (warning: string) => void;
}): Promise<void> {
  const attempted = new Set<string>();
  const enabled = new Set(input.availableModels.map(modelKey));
  const initial = modelId(input.session);
  if (initial) attempted.add(initial);
  // The last model that actually ran a turn. cycleModel() walks pi's own
  // registry, which still holds ids the enabled catalog drops, and those must
  // not appear as the failure we are recovering from.
  let lastTried = initial ?? 'the current model';

  await retrySameModel(input);

  while (errorStop(input.session) && attempted.size < input.availableModels.length) {
    const next = await nextFallbackModel({
      session: input.session,
      availableModels: input.availableModels,
      attempted,
      enabled,
      preferredModelId: input.preferredModelId,
      requireImageInput: input.requireImageInput,
    });
    if (!next) return;

    const nextId = modelKey(next);
    if (attempted.has(nextId)) return;
    attempted.add(nextId);

    input.onWarning?.(`${lastTried} failed after 5 retries; continuing this turn on ${nextId}`);
    lastTried = nextId;
    input.events.startModelAttempt();
    await retrigger(input.session, FAILOVER_CONTINUATION, 'foundry-model-failover');
    await retrySameModel(input);
  }
}

/** Retry the current model when Pi did not spend its own retry budget (402, 400, …). */
async function retrySameModel(input: {
  session: PiAgentSession;
  events: VendorEventReader;
}): Promise<void> {
  if (!errorStop(input.session) || input.events.retryExhausted) return;

  const message =
    errorStop(input.session)?.errorMessage || 'the model ended the turn with an error';
  for (let attempt = 1; attempt <= MODEL_RETRY_LIMIT; attempt++) {
    input.events.noteRetry(attempt, MODEL_RETRY_LIMIT, message);
    await retrigger(input.session, RETRY_CONTINUATION, 'foundry-model-retry');
    if (!errorStop(input.session)) return;
  }
  input.events.markRetryExhausted();
}

async function nextFallbackModel(input: {
  session: PiAgentSession;
  availableModels: readonly PiModel[];
  attempted: Set<string>;
  enabled: ReadonlySet<string>;
  preferredModelId?: string;
  requireImageInput?: boolean;
}): Promise<PiModel | null> {
  const wanted = preferredId(input.preferredModelId);
  if (wanted && !input.attempted.has(wanted)) {
    const preferred = input.availableModels.find((model) => modelKey(model) === wanted);
    if (preferred && isUsable(preferred, input.requireImageInput)) {
      await input.session.setModel(preferred);
      return preferred;
    }
  }

  const seen = new Set<string>();
  while (true) {
    const next = await input.session.cycleModel();
    if (!next) return null;
    const id = modelKey(next.model);
    // cycleModel() wraps. A full lap without a new eligible id means stop.
    if (seen.has(id)) return null;
    seen.add(id);
    if (input.attempted.has(id)) continue;
    if (!input.enabled.has(id) || !isUsable(next.model, input.requireImageInput)) {
      input.attempted.add(id);
      continue;
    }
    return next.model;
  }
}
