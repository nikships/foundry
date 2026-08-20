/**
 * Electron structured-clones IPC payloads and rejects Proxies, class instances,
 * and accessors. The throw is often unawaited, so Save appears to do nothing.
 * These tests pin that `plain()` makes such payloads cloneable.
 */

import { describe, expect, it } from 'vitest';
import type { AgentDef, PipelineDef } from '../../../src/shared/types.js';

/** Duplicated from renderer `api.ts` (that module touches `window.foundry`). */
function plain<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

const agent = (): AgentDef => ({
  name: 'planner',
  purpose: 'Plan the work.',
  model: 'inherit',
  reasoningEffort: 'medium',
  systemPrompt: 'You plan.',
  userPrompt: 'Work on: {{request}}',
  writes: ['specs/', 'docs/'],
  envelope: 'plan',
  color: '#5ad2dd',
});

describe('payloads crossing IPC', () => {
  it('rejects a proxy-wrapped draft, which is the failure being guarded', () => {
    const draft = new Proxy(agent(), {});
    expect(() => structuredClone(draft)).toThrow();
    expect(() => structuredClone(plain(draft))).not.toThrow();
  });

  it('is not fixed by a shallow spread when a nested value is wrapped', () => {
    const draft = { ...agent(), writes: new Proxy(['specs/'], {}) };
    expect(() => structuredClone({ ...draft })).toThrow();
    expect(plain(draft).writes).toEqual(['specs/']);
  });

  it('strips getters, which clone silently drops rather than carrying', () => {
    const draft = { ...agent() };
    Object.defineProperty(draft, 'purpose', { get: () => 'computed', enumerable: true });
    expect(plain(draft).purpose).toBe('computed');
  });

  it('flattens a pipeline with nested phase objects', () => {
    const pipeline: PipelineDef = {
      id: 'plan-build',
      name: 'Plan then Build',
      description: 'Two phases.',
      phases: [
        {
          name: 'plan',
          kind: 'agent',
          description: 'Plan it.',
          agent: 'planner',
          envelope: 'plan',
          prompt: { inputs: ['request'] },
          gates: ['artifacts_exist'],
        },
      ],
      acceptance: { kind: 'all_phases_pass' },
    };

    const sent = plain(pipeline);
    expect(() => structuredClone(sent)).not.toThrow();
    expect(sent.phases).toHaveLength(1);
    expect(sent.acceptance).toEqual({ kind: 'all_phases_pass' });
  });

  it('round trips an agent without losing its boundary', () => {
    expect(plain(agent()).writes).toEqual(['specs/', 'docs/']);
    expect(plain({ ...agent(), writes: null }).writes).toBeNull();
  });

  it('leaves primitives and undefined alone, so optional scope args still work', () => {
    expect(plain(undefined)).toBeUndefined();
    expect(plain('project-1')).toBe('project-1');
    expect(plain(null)).toBeNull();
    expect(plain(7)).toBe(7);
  });
});
