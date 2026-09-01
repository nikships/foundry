/**
 * An `AgentTransport` that loads its inner implementation on first use.
 *
 * Production run and Smith transports pull the vendor package. Wrapping them
 * lets `AppContext` and `Executor` construct without parsing that graph, then
 * pay for it on the first real turn.
 */
import type { ReasoningEffort } from '@shared/types.js';
import type { AgentTransport } from './transport.js';

const IDLE_EFFORT: ReasoningEffort = 'medium';

export function lazyTransport(load: () => Promise<AgentTransport>): AgentTransport {
  let inner: AgentTransport | null = null;
  let pending: Promise<AgentTransport> | null = null;

  const ready = async (): Promise<AgentTransport> => {
    if (inner) return inner;
    pending ??= load().then((transport) => {
      inner = transport;
      return transport;
    });
    return pending;
  };

  return {
    start: (existingSessionId) => ready().then((t) => t.start(existingSessionId)),
    send: (text, opts) => ready().then((t) => t.send(text, opts)),
    applySettings: () => ready().then((t) => t.applySettings()),
    contextStats: () => ready().then((t) => t.contextStats()),
    contextBreakdown: () => ready().then((t) => t.contextBreakdown()),
    compact: () => ready().then((t) => t.compact()),
    getRewindInfo: (messageId) => ready().then((t) => t.getRewindInfo(messageId)),
    rewind: (params) => ready().then((t) => t.rewind(params)),
    interrupt: async () => {
      await inner?.interrupt();
    },
    close: async () => {
      await inner?.close();
    },
    kill: () => {
      inner?.kill();
    },
    get id() {
      return inner?.id ?? null;
    },
    get alive() {
      return inner?.alive ?? false;
    },
    get pid() {
      return inner?.pid;
    },
    get lastUserMessageId() {
      return inner?.lastUserMessageId ?? null;
    },
    get availableModels() {
      return inner?.availableModels ?? [];
    },
    get activeModel() {
      return inner?.activeModel ?? '';
    },
    get activeReasoningEffort() {
      return inner?.activeReasoningEffort ?? IDLE_EFFORT;
    },
  };
}
