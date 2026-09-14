import { describe, expect, it, vi } from 'vitest';
import type { PlanImageAttachment } from '@shared/types.js';
import { startCompose } from '../../../../src/main/smith/compose/start.js';
import type { ComposeStart } from '../../../../src/main/smith/compose/session.js';
import type { ComposeState } from '../../../../src/shared/ipc-contract.js';
import type { PanelRegistry } from '../../../../src/main/session/index.js';

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const project = {
  id: 'p1',
  path: '/tmp/repo',
  contextSummary: '',
  commands: [],
};

const services = {
  rosterFor: () => [],
  envelopeDefs: [],
  defaultModel: 'inherit',
  enabledModels: async () => [],
  ghAvailable: async () => false,
};

function registry(): PanelRegistry<ComposeStart, ComposeState> & {
  start: ReturnType<typeof vi.fn>;
} {
  const start = vi.fn((deps: ComposeStart) => `plan-from-${deps.projectId}`);
  return {
    start,
    get: () => null,
    cancel: () => false,
    cancelAll: () => undefined,
    message: () => 'session not found',
  };
}

describe('startCompose', () => {
  it('refuses an empty prompt with no images', () => {
    const plans = registry();
    expect(
      startCompose(
        plans,
        project,
        { prompt: '   ', model: 'inherit', reasoningEffort: 'medium' },
        services,
      ),
    ).toEqual({ error: 'a plan needs a request' });
    expect(plans.start).not.toHaveBeenCalled();
  });

  it('starts an image-only plan', () => {
    const plans = registry();
    const images: PlanImageAttachment[] = [
      { mediaType: 'image/png', data: PNG_1X1, name: 'shot.png' },
    ];
    expect(
      startCompose(
        plans,
        project,
        { prompt: '  ', model: 'inherit', reasoningEffort: 'medium', images },
        services,
      ),
    ).toEqual({ planId: 'plan-from-p1' });
    expect(plans.start).toHaveBeenCalledTimes(1);
    expect(plans.start.mock.calls[0]![0]).toMatchObject({
      prompt: '  ',
      images,
    });
  });

  it('returns a user-visible error for an invalid MIME and does not start', () => {
    const plans = registry();
    expect(
      startCompose(
        plans,
        project,
        {
          prompt: 'build this',
          model: 'inherit',
          reasoningEffort: 'medium',
          images: [
            { mediaType: 'image/svg+xml', data: PNG_1X1 },
          ] as unknown as PlanImageAttachment[],
        },
        services,
      ),
    ).toEqual({ error: 'Use a PNG, JPEG, WebP, or GIF image.' });
    expect(plans.start).not.toHaveBeenCalled();
  });

  it('returns a user-visible error for an oversized image and does not start', () => {
    const plans = registry();
    const data = Buffer.alloc(4 * 1024 * 1024 + 1, 1).toString('base64');
    expect(
      startCompose(
        plans,
        project,
        {
          prompt: 'build this',
          model: 'inherit',
          reasoningEffort: 'medium',
          images: [{ mediaType: 'image/png', data }],
        },
        services,
      ),
    ).toEqual({ error: 'Keep each image under 4 MB.' });
    expect(plans.start).not.toHaveBeenCalled();
  });
});
