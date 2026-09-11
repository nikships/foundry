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
  normalizeSettingsPane,
  paneMatchesQuery,
  searchSettings,
  sectionId,
} from '@renderer/view-models/settings-search.js';

describe('settings search registry', () => {
  it('covers exactly the six panes the screen renders, in rail order', () => {
    expect(SETTINGS_PANES.map((p) => p.id)).toEqual([
      'providers',
      'models',
      'integrations',
      'project',
      'preferences',
      'system',
    ]);
  });

  it('derives stable dom ids from labels', () => {
    expect(sectionId('Software updates')).toBe('software-updates');
    expect(sectionId('API keys')).toBe('api-keys');
    expect(sectionId('Leftover worktrees')).toBe('leftover-worktrees');
  });

  it('has no duplicate jump targets within a pane and references only known panes', () => {
    const panes = new Set(SETTINGS_PANES.map((pane) => pane.id));
    const seen = new Set<string>();
    for (const section of SETTINGS_SECTIONS) {
      expect(panes.has(section.pane), section.pane).toBe(true);
      const key = `${section.pane}:${sectionId(section.label)}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  it.each([
    ['providers', 'providers'],
    ['models', 'models'],
    ['defaults', 'models'],
    ['integrations', 'integrations'],
    ['project', 'project'],
    ['project-commands', 'project'],
    ['preferences', 'preferences'],
    ['app', 'preferences'],
    ['general', 'preferences'],
    ['system', 'system'],
    ['maintenance', 'system'],
    ['about', 'system'],
    ['unknown', 'preferences'],
    ['toString', 'preferences'],
    ['__proto__', 'preferences'],
  ] as const)('normalizes %s to %s', (input, expected) => {
    expect(normalizeSettingsPane(input)).toBe(expected);
  });
});

describe('searchSettings', () => {
  it('returns nothing for an empty query', () => {
    expect(searchSettings('')).toEqual([]);
    expect(searchSettings('   ')).toEqual([]);
  });

  it('finds the API keys section under Providers, ahead of the pane hit', () => {
    const hits = searchSettings('api key');
    const section = hits.findIndex(
      (hit) => hit.pane === 'providers' && hit.sectionId === 'api-keys',
    );
    const pane = hits.findIndex((hit) => hit.pane === 'providers' && hit.sectionId === null);
    expect(section, JSON.stringify(hits)).toBeGreaterThanOrEqual(0);
    expect(pane).toBeGreaterThanOrEqual(0);
    expect(section).toBeLessThan(pane);
  });

  it('ranks exact Providers matches on the Providers pane', () => {
    const hits = searchSettings('providers');
    expect(hits[0]?.pane).toBe('providers');
    expect(hits.some((hit) => hit.pane === 'providers' && hit.sectionId === null)).toBe(true);
  });

  it('finds appearance and notification preferences', () => {
    expect(
      searchSettings('light theme').some(
        (hit) => hit.pane === 'preferences' && hit.sectionId === 'appearance',
      ),
    ).toBe(true);
    expect(
      searchSettings('midnight').some(
        (hit) => hit.pane === 'preferences' && hit.sectionId === 'appearance',
      ),
    ).toBe(true);
    expect(
      searchSettings('moments that need you').some(
        (hit) => hit.pane === 'preferences' && hit.sectionId === 'notifications',
      ),
    ).toBe(true);
  });

  it.each([
    ['retention', 'retention'],
    ['orphan', 'leftover-worktrees'],
    ['phone', 'phone'],
    ['diagnostics', 'checks'],
  ])('finds %s in System & maintenance', (query, sectionIdValue) => {
    expect(
      searchSettings(query).some(
        (hit) => hit.pane === 'system' && hit.sectionId === sectionIdValue,
      ),
    ).toBe(true);
  });

  it.each([
    ['smith', 'smith'],
    ['reasoning effort', 'model'],
    ['compaction', 'advanced'],
  ])('finds %s in Models & agent defaults', (query, sectionIdValue) => {
    expect(
      searchSettings(query).some(
        (hit) => hit.pane === 'models' && hit.sectionId === sectionIdValue,
      ),
    ).toBe(true);
  });

  it('no longer surfaces a Pull requests section', () => {
    expect(searchSettings('pr writer').some((hit) => hit.title === 'Pull requests')).toBe(false);
    expect(searchSettings('pull requests').some((hit) => hit.title === 'Pull requests')).toBe(
      false,
    );
    expect(searchSettings('pr writer').some((hit) => hit.sectionId === 'pull-requests')).toBe(
      false,
    );
  });

  it('keeps integrations and repository settings distinct', () => {
    expect(
      searchSettings('linear').some(
        (hit) => hit.pane === 'integrations' && hit.sectionId === 'linear',
      ),
    ).toBe(true);
    expect(
      searchSettings('protected paths').some(
        (hit) => hit.pane === 'project' && hit.sectionId === 'boundaries',
      ),
    ).toBe(true);
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
    expect(paneMatchesQuery('system', 'retention')).toBe(true);
    expect(paneMatchesQuery('models', 'retention')).toBe(false);
    expect(paneMatchesQuery('preferences', 'retention')).toBe(false);
  });
});

describe('SETTINGS_TOGGLES', () => {
  it('offers the notification switches plus the dock badge and sounds', () => {
    expect(SETTINGS_TOGGLES.map((toggle) => toggle.id)).toEqual([
      'accepted',
      'rejected',
      'failed',
      'dockBadge',
      'soundEffects',
    ]);
  });
});
