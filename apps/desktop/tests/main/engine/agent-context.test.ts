import { describe, expect, it } from 'vitest';
import {
  envelopeSummaryBlock,
  projectCommandBlock,
} from '../../../src/main/engine/agent-context.js';

describe('healer context blocks', () => {
  it('formats prior envelopes and skips empty summaries', () => {
    expect(
      envelopeSummaryBlock([
        { phase: 'build', summary: 'added the widget' },
        { phase: 'plan', summary: '   ' },
      ]),
    ).toBe(['## Prior envelopes', '', '- build: added the widget'].join('\n'));
    expect(envelopeSummaryBlock([])).toBe('');
  });

  it('formats project commands and skips nameless or empty argv', () => {
    expect(
      projectCommandBlock([
        { name: 'test', argv: ['npm', 'test'] },
        { name: '  ', argv: ['true'] },
        { name: 'lint', argv: [] },
      ]),
    ).toBe(['## Project commands', '', '- test: npm test'].join('\n'));
    expect(projectCommandBlock([])).toBe('');
  });
});
