/**
 * `lazyTransport` must not narrow what the inner transport reports.
 *
 * It once dropped the `packageTools` getter, so `AgentSession.decide` always
 * saw `[]` through the wrapper and the policy denied every operator-installed
 * package tool (Tavily's `web_search`) as `unknown` — even with the extension
 * installed, loaded, and keyed. These tests pin the forwarding.
 */

import { describe, expect, it } from 'vitest';
import { lazyTransport } from '../../../src/main/pi/lazy-transport.js';
import type { AgentTransport } from '../../../src/main/pi/transport.js';
import type { ReasoningEffort } from '../../../src/shared/types.js';

function stubTransport(packageTools?: readonly string[]): AgentTransport {
  return {
    start: () => Promise.resolve(),
    send: () =>
      Promise.resolve({
        text: '',
        usage: null,
        reason: 'stop',
        interrupted: false,
        structuredOutput: null,
      }),
    applySettings: () => Promise.resolve({ model: 'stub' }),
    contextStats: () => Promise.resolve(null),
    contextBreakdown: () => Promise.resolve(null),
    compact: () => Promise.resolve(null),
    getRewindInfo: () => Promise.resolve(null),
    rewind: () => Promise.resolve(null),
    interrupt: () => Promise.resolve(),
    close: () => Promise.resolve(),
    kill: () => undefined,
    get id() {
      return null;
    },
    get alive() {
      return true;
    },
    get pid() {
      return undefined;
    },
    get lastUserMessageId() {
      return null;
    },
    ...(packageTools
      ? {
          get packageTools() {
            return packageTools;
          },
        }
      : {}),
    get availableModels() {
      return [];
    },
    get activeModel() {
      return 'stub';
    },
    get activeReasoningEffort(): ReasoningEffort {
      return 'medium';
    },
  };
}

describe('lazyTransport packageTools', () => {
  it('stays fail-closed before the inner transport loads', () => {
    const wrapped = lazyTransport(() => Promise.resolve(stubTransport(['web_search'])));
    expect(wrapped.packageTools ?? []).toEqual([]);
  });

  it('forwards the inner package tools once started', async () => {
    const wrapped = lazyTransport(() =>
      Promise.resolve(stubTransport(['web_search', 'web_fetch'])),
    );
    await wrapped.start();
    expect(wrapped.packageTools ?? []).toEqual(['web_search', 'web_fetch']);
  });

  it('stays fail-closed when the inner transport loads no packages', async () => {
    const wrapped = lazyTransport(() => Promise.resolve(stubTransport()));
    await wrapped.start();
    expect(wrapped.packageTools ?? []).toEqual([]);
  });
});
