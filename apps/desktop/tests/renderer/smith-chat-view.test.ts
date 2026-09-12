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
  extractOrchestratorPlanId,
  groupTranscript,
  hasOrchestratorPlanId,
  needsMaskedSecret,
  smithAssignedWorkPrompt,
  smithConfirmationHint,
  smithLinearPipelineRunPrompt,
  smithModelLabel,
  smithOrchestratorFollowUpPrompt,
  smithOrchestratorPlanPrompt,
  smithPipelineRunPrompt,
  smithTicketStatusPrompt,
  SMITH_QUICK_PROMPTS,
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

  it('drops vendor functionCall echoes so they never become a Smith bubble', () => {
    const groups = groupTranscript([
      { id: 'a', kind: 'text', text: 'Got it.', source: 'smith', at: 0 },
      {
        id: 'b',
        kind: 'text',
        text: '{"functionCall":{"name":"smith_readiness"}}',
        source: 'smith',
        at: 1,
      },
      { id: 'c', kind: 'tool', text: 'smith_readiness', source: 'smith', at: 2 },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.entries.map((row) => row.id)).toEqual(['a', 'c']);
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

describe('smith user-level quick prompts', () => {
  it('covers every named capability: assigned work, ticket status, plans, pipelines', () => {
    const ids = SMITH_QUICK_PROMPTS.map((item) => item.id);
    for (const id of [
      'assigned-work',
      'ticket-status',
      'orchestrator-plan',
      'orchestrator-list',
      'pipeline-run',
      'linear-pipeline-run',
      'refresh-context',
      'voice-key-state',
    ] as const) {
      expect(ids).toContain(id);
    }
    for (const item of SMITH_QUICK_PROMPTS) {
      expect(item.label.trim().length).toBeGreaterThan(0);
      expect(item.prompt.trim().length).toBeGreaterThan(0);
      expect(item.hint.trim().length).toBeGreaterThan(0);
    }
  });

  it('phrases assigned work so the tool routes to the viewer filter', () => {
    expect(smithAssignedWorkPrompt()).toMatch(/assigned to me/i);
    expect(smithAssignedWorkPrompt('FOU')).toMatch(/assigned to me/i);
    expect(smithAssignedWorkPrompt('FOU')).toContain('FOU');
  });

  it('builds ticket, plan, and pipeline prompts with their ids attached', () => {
    expect(smithTicketStatusPrompt('FOU-123')).toContain('FOU-123');
    expect(smithOrchestratorPlanPrompt('fix login')).toContain('fix login');
    expect(smithPipelineRunPrompt('ship-it', 'roll out')).toContain('ship-it');
    expect(smithPipelineRunPrompt('ship-it', 'roll out')).toContain('roll out');
    expect(smithLinearPipelineRunPrompt('ship-it', 'FOU-123')).toContain('FOU-123');
    expect(smithOrchestratorFollowUpPrompt('plan-abc123', 'prefer X')).toContain('plan-abc123');
  });
});

describe('orchestrator plan id plumbing', () => {
  it('pulls the plan handle out of Smith reply text', () => {
    expect(extractOrchestratorPlanId('Your plan plan-a1b2c3d4e5f6 is ready.')).toBe(
      'plan-a1b2c3d4e5f6',
    );
    expect(hasOrchestratorPlanId('nothing here')).toBe(false);
    expect(hasOrchestratorPlanId('Check plan-0123456789ab any time.')).toBe(true);
    expect(extractOrchestratorPlanId('no handle')).toBeNull();
  });
});

describe('smith confirmations and receipts', () => {
  it('explains the cost and exactly-once rule before a plan runs', () => {
    expect(smithConfirmationHint('orchestrator_plan')).toMatch(/agent turn/i);
    expect(smithConfirmationHint('orchestrator_accept')).toMatch(/exactly once/i);
    expect(smithConfirmationHint('orchestrator_discard')).toMatch(/destructive/i);
    expect(smithConfirmationHint('orchestrator_cancel')).toMatch(/remains/i);
    expect(smithConfirmationHint('start')).toMatch(/approval/i);
  });

  it('sends key values only through the masked approval card', () => {
    expect(needsMaskedSecret('gemini_live_set_api_key')).toBe(true);
    expect(needsMaskedSecret('linear_set_api_key')).toBe(true);
    expect(needsMaskedSecret('set_api_key')).toBe(true);
    expect(needsMaskedSecret('orchestrator_plan')).toBe(false);
    expect(smithConfirmationHint('gemini_live_set_api_key')).toMatch(/masked/i);
  });
});
