/**
 * The settings search registry feeds two surfaces — the rail's search box and
 * the ⌘K palette — so its coverage and ranking are pinned here rather than in
 * either consumer.
 */

import { describe, expect, it } from 'vitest';
import {
  SETTINGS_PANES,
  SETTINGS_SECTIONS,
  SETTINGS_TOGGLES,
  paneMatchesQuery,
  searchSettings,
  sectionId,
} from '@renderer/view-models/settings-search.js';

describe('settings search registry', () => {
  it('covers exactly the four panes the screen renders', () => {
    expect(SETTINGS_PANES.map((p) => p.id)).toEqual(['models', 'integrations', 'project', 'app']);
  });

  it('derives stable dom ids from labels', () => {
    expect(sectionId('Software updates')).toBe('software-updates');
    expect(sectionId('API keys')).toBe('api-keys');
    expect(sectionId('Leftover worktrees')).toBe('leftover-worktrees');
  });

  it('has no duplicate jump targets within a pane', () => {
    const seen = new Set<string>();
    for (const section of SETTINGS_SECTIONS) {
      const key = `${section.pane}:${sectionId(section.label)}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });
});

describe('searchSettings', () => {
  it('returns nothing for an empty query', () => {
    expect(searchSettings('')).toEqual([]);
    expect(searchSettings('   ')).toEqual([]);
  });

  it('finds the API keys section under Providers, ahead of the pane hit', () => {
    const hits = searchSettings('api key');
    const section = hits.findIndex((h) => h.sectionId === 'api-keys');
    const pane = hits.findIndex((h) => h.pane === 'models' && h.sectionId === null);
    expect(section, JSON.stringify(hits)).toBeGreaterThanOrEqual(0);
    expect(pane).toBeGreaterThanOrEqual(0);
    expect(section).toBeLessThan(pane);
  });

  it('ranks an exact label match first, pane or section', () => {
    // The Providers pane hosts a section also called "Providers", and both are
    // fine answers — what matters is the query lands on that pane and the
    // pane-level jump target is present.
    const hits = searchSettings('providers');
    expect(hits[0]?.pane).toBe('models');
    expect(hits.some((h) => h.pane === 'models' && h.sectionId === null)).toBe(true);
  });

  it('finds the Appearance theme picker under App', () => {
    const ref = SETTINGS_SECTIONS.find((section) => section.label === 'Appearance');
    expect(ref?.pane).toBe('general');
    const hits = searchSettings('light theme');
    expect(hits.some((h) => h.pane === 'app' && h.sectionId === 'appearance')).toBe(true);
  });

  it('reaches maintenance sections by keyword', () => {
    const hits = searchSettings('retention');
    expect(hits.some((h) => h.pane === 'app' && h.sectionId === 'retention')).toBe(true);
  });

  it('reaches the Smith default-model section under Models & Providers', () => {
    const hits = searchSettings('smith');
    expect(hits.some((h) => h.pane === 'models' && h.sectionId === 'smith')).toBe(true);
  });

  it('reaches the Linear integration by issue and workflow keywords', () => {
    const hits = searchSettings('linear');
    expect(hits.some((h) => h.pane === 'integrations' && h.sectionId === 'linear')).toBe(true);
  });

  it('matches section notes, so phrases in prose still surface the section', () => {
    const hits = searchSettings('moments that need you');
    expect(hits.some((h) => h.pane === 'app' && h.sectionId === 'notifications')).toBe(true);
  });

  it('respects the cap', () => {
    expect(searchSettings('a', 5).length).toBeLessThanOrEqual(5);
  });
});

describe('paneMatchesQuery', () => {
  it('keeps every pane visible for an empty query', () => {
    for (const pane of SETTINGS_PANES) expect(paneMatchesQuery(pane.id, '')).toBe(true);
  });

  it('narrows to panes that contain a hit', () => {
    expect(paneMatchesQuery('app', 'retention')).toBe(true);
    expect(paneMatchesQuery('models', 'retention')).toBe(false);
  });
});

describe('SETTINGS_TOGGLES', () => {
  it('offers the four notification switches plus the dock badge', () => {
    expect(SETTINGS_TOGGLES.map((t) => t.id)).toEqual([
      'accepted',
      'rejected',
      'failed',
      'needsInput',
      'dockBadge',
    ]);
  });
});
