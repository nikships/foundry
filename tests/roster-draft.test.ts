/**
 * The agent editor edits a draft, not the store, so it has to notice when the
 * grid selection moves. FOU-41 was the case it did not: "New agent" moved the
 * selection but the pane kept showing the previous agent.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { draftSyncAction } from '@renderer/screens/roster-draft.js';

const here = dirname(fileURLToPath(import.meta.url));
const rosterSrc = readFileSync(join(here, '..', 'src/renderer/screens/RosterScreen.tsx'), 'utf8');

describe('draftSyncAction', () => {
  it('loads the newly selected agent, which is what a fresh agent is', () => {
    expect(
      draftSyncAction({ selectedName: 'agent-3', hasAgents: true, lastSyncedName: 'reviewer' }),
    ).toBe('sync');
  });

  it('loads the first agent when nothing has been synced yet', () => {
    expect(
      draftSyncAction({ selectedName: 'planner', hasAgents: true, lastSyncedName: null }),
    ).toBe('sync');
  });

  it('leaves the draft alone while the selection is unchanged, so edits survive', () => {
    expect(
      draftSyncAction({ selectedName: 'planner', hasAgents: true, lastSyncedName: 'planner' }),
    ).toBe('keep');
  });

  it('holds the pane through the beat of a rename, when the new name is not in the store yet', () => {
    expect(
      draftSyncAction({ selectedName: null, hasAgents: true, lastSyncedName: 'planner' }),
    ).toBe('keep');
  });

  it('clears the pane only when there is no agent left to edit', () => {
    expect(
      draftSyncAction({ selectedName: null, hasAgents: false, lastSyncedName: 'planner' }),
    ).toBe('clear');
  });
});

describe('creating an agent', () => {
  // The regression itself: createAgent used to pre-stamp the synced-name ref,
  // which told the effect above the draft was already loaded from the new agent.
  it('does not pre-stamp the synced name, so the effect still loads the new agent', () => {
    const createAgent = rosterSrc.slice(rosterSrc.indexOf('const createAgent'));
    expect(createAgent).toContain('setSelectedName(fresh.name)');
    expect(createAgent).not.toContain('lastSyncedNameRef.current = fresh.name');
  });

  it('flushes the outgoing agent first, so pending edits are not dropped', () => {
    const createAgent = rosterSrc.slice(
      rosterSrc.indexOf('const createAgent'),
      rosterSrc.indexOf('const TEMPLATE_TOKENS'),
    );
    expect(createAgent).toContain('await flush()');
  });
});
