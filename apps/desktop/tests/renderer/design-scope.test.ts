/**
 * The Design header states where an edit lands. These pin the resolution per
 * tab, and the two notices — which differ because a project copy is seeded once
 * and then kept, so re-enabling restores an old copy rather than re-forking.
 */

import { describe, expect, it } from 'vitest';
import type { ProjectDef } from '@shared/types.js';
import {
  forkNotice,
  resolveDesignScope,
  revertNotice,
  scopeFieldFor,
  scopeFlagFor,
} from '@renderer/view-models/design-scope.js';

const project = (over: Partial<ProjectDef> = {}): ProjectDef =>
  ({
    id: 'p1',
    name: 'foundry',
    path: '/repo/foundry',
    baseBranch: 'main',
    protectedPaths: [],
    ownRoster: false,
    ownPipelines: false,
    ...over,
  }) as ProjectDef;

describe('agents scope', () => {
  it('is global when the project has not opted in', () => {
    const scope = resolveDesignScope('agents', project());
    expect(scope.level).toBe('global');
    expect(scope.label).toBe('Global');
    expect(scope.toggleable).toBe(true);
    expect(scope.detail).toContain('every project');
  });

  it('is project-only when ownRoster is set, and names the project', () => {
    const scope = resolveDesignScope('agents', project({ ownRoster: true }));
    expect(scope.level).toBe('project');
    expect(scope.label).toBe('This project only');
    expect(scope.detail).toContain('foundry');
  });

  it('is not affected by the pipelines flag', () => {
    expect(resolveDesignScope('agents', project({ ownPipelines: true })).level).toBe('global');
  });
});

describe('pipelines scope', () => {
  it('is global when the project has not opted in', () => {
    expect(resolveDesignScope('pipelines', project()).level).toBe('global');
  });

  it('is project-only when ownPipelines is set', () => {
    const scope = resolveDesignScope('pipelines', project({ ownPipelines: true }));
    expect(scope.level).toBe('project');
    expect(scope.toggleable).toBe(true);
  });

  it('is not affected by the roster flag', () => {
    expect(resolveDesignScope('pipelines', project({ ownRoster: true })).level).toBe('global');
  });
});

describe('envelopes scope', () => {
  it('is always app-global, whatever the project flags say', () => {
    for (const p of [
      project(),
      project({ ownRoster: true, ownPipelines: true }),
      null as ProjectDef | null,
    ]) {
      const scope = resolveDesignScope('envelopes', p);
      expect(scope.level).toBe('global');
      expect(scope.label).toBe('Global');
    }
  });

  it('is never toggleable, because there is no per-project envelope store', () => {
    expect(resolveDesignScope('envelopes', project({ ownRoster: true })).toggleable).toBe(false);
  });

  it('says so, so the indicator reads as informational', () => {
    expect(resolveDesignScope('envelopes', project()).detail).toContain('no per-project copy');
  });
});

describe('with no project selected', () => {
  it('reports none for agents and pipelines rather than claiming global', () => {
    for (const tab of ['agents', 'pipelines'] as const) {
      const scope = resolveDesignScope(tab, null);
      expect(scope.level).toBe('none');
      expect(scope.label).toBe('No project');
      expect(scope.toggleable).toBe(false);
    }
  });

  it('still reports envelopes as global, which is true with no project', () => {
    expect(resolveDesignScope('envelopes', null).level).toBe('global');
  });
});

describe('the flag a tab reads and writes', () => {
  it('maps each tab to its ProjectDef field', () => {
    expect(scopeFieldFor('agents')).toBe('ownRoster');
    expect(scopeFieldFor('pipelines')).toBe('ownPipelines');
    expect(scopeFieldFor('envelopes')).toBeNull();
  });

  it('reads the flag, defaulting to false with no project', () => {
    expect(scopeFlagFor('agents', project({ ownRoster: true }))).toBe(true);
    expect(scopeFlagFor('pipelines', project({ ownPipelines: true }))).toBe(true);
    expect(scopeFlagFor('agents', null)).toBe(false);
    expect(scopeFlagFor('envelopes', project({ ownRoster: true }))).toBe(false);
  });
});

describe('what the notices promise', () => {
  it('describes a first fork as a copy of the current global set', () => {
    const notice = forkNotice('agents', false);
    expect(notice).toContain('copy of the current global');
    expect(notice).toContain('independent');
  });

  it('does not claim a fresh copy when one already exists on disk', () => {
    const notice = forkNotice('agents', true);
    expect(notice).toContain('previous switch');
    expect(notice).toContain('not re-copied');
    expect(notice).not.toContain('copy of the current global');
  });

  it('says the copy is kept when reverting, since nothing is deleted', () => {
    const notice = revertNotice('pipelines');
    expect(notice).toContain('kept on disk');
    expect(notice).toContain('restores it');
  });

  it('names the right entity per tab', () => {
    expect(forkNotice('pipelines', false)).toContain('pipelines');
    expect(forkNotice('agents', false)).toContain('agents');
  });
});
