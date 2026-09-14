/**
 * Start-time warm-up: the model catalog is built while the proposal is under
 * review so the Start click does not pay that cost twice. A failed warm never
 * fails the click (start retries).
 */
import { describe, expect, it } from 'vitest';
import { warmStartPrep, type WarmStartDeps } from '../../../src/main/engine/operations.js';
import { defaultProject } from '../../../src/main/store/projects.js';
import { tempDir } from '../../helpers/tmp.js';
import type { ProjectDef } from '../../../src/shared/types.js';

function warmDeps(store: { current: ProjectDef }, catalog: { calls: number }): WarmStartDeps {
  return {
    projectById: (id: string) => (id === store.current.id ? store.current : null),
    enabledModelIds: async () => {
      catalog.calls += 1;
      return ['m'];
    },
  };
}

describe('warmStartPrep', () => {
  it('warms the model catalog for a known project', async () => {
    const store = { current: defaultProject(tempDir('foundry-warm-start-')) };
    const catalog = { calls: 0 };
    await warmStartPrep(warmDeps(store, catalog), store.current.id);
    expect(catalog.calls).toBe(1);
  });

  it('never rejects: a failed warm leaves start to retry', async () => {
    const store = { current: defaultProject(tempDir('foundry-warm-fail-')) };
    await expect(
      warmStartPrep(
        {
          projectById: (id) => (id === store.current.id ? store.current : null),
          enabledModelIds: async () => {
            throw new Error('no catalog');
          },
        },
        store.current.id,
      ),
    ).resolves.toBeUndefined();
  });

  it('does nothing without a project', async () => {
    const catalog = { calls: 0 };
    const store = { current: defaultProject(tempDir('foundry-warm-missing-')) };
    await expect(
      warmStartPrep(warmDeps(store, catalog), 'no-such-project'),
    ).resolves.toBeUndefined();
    expect(catalog.calls).toBe(0);
  });
});
