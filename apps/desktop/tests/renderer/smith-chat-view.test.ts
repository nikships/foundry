/**
 * The Smith chat screen renders whatever these two functions say: the
 * transcript grouping decides where the visual seams fall (operator bubbles,
 * Smith turns, the readiness block), and the screen descriptor is what main
 * receives with every message. Both are pure, so they are pinned here.
 */

import { describe, expect, it } from 'vitest';
import type { SmithChatEntry, SmithTranscriptEntry } from '@shared/ipc-contract.js';
import type { ModelInfo } from '@shared/types.js';
import {
  describeScreen,
  groupTranscript,
  smithModelLabel,
} from '@renderer/view-models/smith-chat-view.js';

function entry(
  id: string,
  source: SmithTranscriptEntry['source'],
  kind: SmithChatEntry['kind'] = 'text',
): SmithTranscriptEntry {
  return { id, kind, text: id, source, at: 0 };
}

describe('groupTranscript', () => {
  it('returns nothing for an empty transcript', () => {
    expect(groupTranscript([])).toEqual([]);
  });

  it('groups consecutive same-source entries into one run', () => {
    const groups = groupTranscript([
      entry('a', 'operator'),
      entry('b', 'smith'),
      entry('c', 'smith', 'tool'),
      entry('d', 'readiness'),
      entry('e', 'readiness'),
      entry('f', 'smith'),
    ]);
    expect(groups.map((g) => g.source)).toEqual(['operator', 'smith', 'readiness', 'smith']);
    expect(groups.map((g) => g.entries.length)).toEqual([1, 2, 2, 1]);
  });

  it('keys each group by its first entry so React keys stay stable as a turn grows', () => {
    const groups = groupTranscript([entry('a', 'smith'), entry('b', 'smith')]);
    expect(groups[0]!.id).toBe('a');
  });
});

describe('smithModelLabel', () => {
  const models: ModelInfo[] = [
    {
      id: 'anthropic/claude-sonnet-4',
      displayName: 'Claude Sonnet 4',
      provider: 'anthropic',
      supportedReasoningEfforts: ['off', 'low', 'medium', 'high'],
      defaultReasoningEffort: 'medium',
      isCustom: false,
      deprecated: false,
    },
  ];

  it('names the chosen model', () => {
    expect(smithModelLabel('anthropic/claude-sonnet-4', models)).toBe('Claude Sonnet 4');
  });

  it('falls back to the bare id for a model the catalog does not describe', () => {
    expect(smithModelLabel('openai/gpt-5', models)).toBe('gpt-5');
  });

  it('asks for a choice instead of naming a fallback when nothing is chosen', () => {
    // The old copy here named "the first reachable model", which described a
    // model neither the operator nor the app could identify in advance.
    expect(smithModelLabel('inherit', models)).toBe('Select a model…');
    expect(smithModelLabel(null, models)).toBe('Select a model…');
    expect(smithModelLabel(undefined, models)).toBe('Select a model…');
  });
});

describe('describeScreen', () => {
  const position = {
    openRunId: '',
    inspectorRunId: '',
    designTab: 'pipelines' as const,
    settingsPane: 'general',
  };

  it('names the open run on the run-detail screen', () => {
    expect(describeScreen('runs', { ...position, openRunId: 'r1' })).toEqual({
      route: 'run-detail',
      entity: { kind: 'run', id: 'r1' },
    });
  });

  it('is a bare route on the runs list', () => {
    expect(describeScreen('runs', position)).toEqual({ route: 'runs' });
  });

  it('names the pinned run in the Inspector, and none when following live', () => {
    expect(describeScreen('inspector', { ...position, inspectorRunId: 'r2' })).toEqual({
      route: 'inspector',
      entity: { kind: 'run', id: 'r2' },
    });
    expect(describeScreen('inspector', position)).toEqual({ route: 'inspector' });
  });

  it('carries the Design tab in the route', () => {
    expect(describeScreen('design', { ...position, designTab: 'agents' })).toEqual({
      route: 'design/agents',
    });
  });

  it('names the settings pane as the entity', () => {
    expect(describeScreen('settings', { ...position, settingsPane: 'models' })).toEqual({
      route: 'settings',
      entity: { kind: 'settings', id: 'models' },
    });
  });
});
