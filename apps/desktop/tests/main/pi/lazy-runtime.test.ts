import { describe, expect, it } from 'vitest';
import { lazyOneShots } from '../../../src/main/pi/lazy-oneshot.js';
import { lazyTransport } from '../../../src/main/pi/lazy-transport.js';
import type { OneShotFactory, OneShotResult } from '../../../src/main/pi/oneshot.js';
import type { AgentTransport } from '../../../src/main/pi/transport.js';

function stubTransport(overrides: Partial<AgentTransport> = {}): AgentTransport {
  return {
    start: async () => undefined,
    send: async () => ({
      text: 'ok',
      usage: null,
      reason: 'stop',
      interrupted: false,
      structuredOutput: null,
    }),
    applySettings: async () => ({ model: 'm' }),
    contextStats: async () => null,
    contextBreakdown: async () => null,
    compact: async () => null,
    getRewindInfo: async () => null,
    rewind: async () => null,
    interrupt: async () => undefined,
    close: async () => undefined,
    kill: () => undefined,
    id: 'sess',
    alive: true,
    pid: undefined,
    lastUserMessageId: null,
    availableModels: [],
    activeModel: 'm',
    activeReasoningEffort: 'medium',
    ...overrides,
  };
}

describe('lazyTransport', () => {
  it('does not load until a turn starts', async () => {
    let loaded = 0;
    const transport = lazyTransport(async () => {
      loaded += 1;
      return stubTransport();
    });
    expect(loaded).toBe(0);
    expect(transport.alive).toBe(false);
    expect(transport.id).toBeNull();
    await transport.start();
    expect(loaded).toBe(1);
    expect(transport.alive).toBe(true);
    await transport.send('hi');
    expect(loaded).toBe(1);
  });

  it('forwards interrupt and kill only after load', async () => {
    let interrupted = 0;
    let killed = 0;
    const transport = lazyTransport(async () =>
      stubTransport({
        interrupt: async () => {
          interrupted += 1;
        },
        kill: () => {
          killed += 1;
        },
      }),
    );
    await transport.interrupt();
    transport.kill();
    expect(interrupted).toBe(0);
    expect(killed).toBe(0);
    await transport.start();
    await transport.interrupt();
    transport.kill();
    expect(interrupted).toBe(1);
    expect(killed).toBe(1);
  });
});

describe('lazyOneShots', () => {
  it('loads the factory on send, not on construct', async () => {
    let loaded = 0;
    const load: () => Promise<OneShotFactory> = async () => {
      loaded += 1;
      return () => ({
        abort() {},
        async send(): Promise<OneShotResult> {
          return { text: 'done', usage: null, reason: 'stop', interrupted: false };
        },
      });
    };
    const factory = lazyOneShots(load);
    const session = factory({
      cwd: '/tmp',
      model: 'inherit',
      reasoningEffort: 'medium',
      access: 'read',
    });
    expect(loaded).toBe(0);
    const result = await session.send('ask');
    expect(loaded).toBe(1);
    expect(result.text).toBe('done');
  });

  it('abort before send skips the paid turn', async () => {
    let sent = 0;
    const factory = lazyOneShots(async () => () => ({
      abort() {},
      async send(): Promise<OneShotResult> {
        sent += 1;
        return { text: 'should-not', usage: null, reason: 'stop', interrupted: false };
      },
    }));
    const session = factory({
      cwd: '/tmp',
      model: 'inherit',
      reasoningEffort: 'medium',
      access: 'read',
    });
    session.abort();
    const result = await session.send('ask');
    expect(sent).toBe(0);
    expect(result.interrupted).toBe(true);
    expect(result.reason).toBe('aborted');
  });
});
