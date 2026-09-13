import { describe, expect, it, vi } from 'vitest';
import { composeHarness } from '../../helpers/smith-compose.js';
import { register } from '../../../src/main/ipc/orchestrator.js';
import type { Handle } from '../../../src/main/ipc/shared.js';
import { IPC } from '../../../src/shared/ipc-contract.js';
import { warmStartPrep } from '../../../src/main/engine/operations.js';

vi.mock('../../../src/main/engine/operations.js', () => ({ warmStartPrep: vi.fn(async () => {}) }));

describe('smith compose entry-point parity', () => {
  it.each([undefined, 'fixture/override'])(
    'persists identical rows through Runs IPC and chat with model %s',
    async (model) => {
      const desktop = composeHarness();
      const chat = composeHarness();
      const handlers = new Map<string, (...args: never[]) => unknown>();
      const handle: Handle = (channel, fn) => handlers.set(channel, fn);
      register(desktop.ctx, handle);
      const input = { prompt: 'Improve help', model, reasoningEffort: 'high' as const };
      const startPlan = handlers.get(IPC.orchestratorPlan) as (
        projectId: string,
        prompt: string,
        model: string | undefined,
        reasoningEffort: 'high',
      ) => { planId: string };
      const started = startPlan('other', input.prompt, model, input.reasoningEffort);
      expect(started).toEqual({ planId: 'plan-1' });
      expect(
        await chat.execute({ operation: 'compose', projectId: 'other', ...input }),
      ).toMatchObject({ ok: true, result: started });
      expect(chat.proposals.get('plan-1')).toEqual(desktop.proposals.get('plan-1'));
      expect(chat.proposals.get('plan-1')).toMatchObject({
        projectId: 'other',
        prompt: input.prompt,
        model: model ?? 'fixture/smith',
        reasoningEffort: 'high',
        status: 'generating',
      });
      expect(warmStartPrep).toHaveBeenCalledWith(expect.anything(), 'other');
      const [desktopStart] = desktop.starts;
      const [chatStart] = chat.starts;
      expect({ ...chatStart, enabledModels: null, ghAvailable: null }).toEqual({
        ...desktopStart,
        enabledModels: null,
        ghAvailable: null,
      });
      expect(chat.queue.list()).toEqual([]);
    },
  );
});
