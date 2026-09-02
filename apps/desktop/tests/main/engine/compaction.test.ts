/**
 * Foundry-owned compact summary: constitution pins plus pipeline evidence,
 * never Pi's chat Goal / Progress / Next Steps template.
 */

import { describe, expect, it } from 'vitest';
import {
  artifactPathsOf,
  foundryCompactionSummary,
  requiredFieldsFor,
  stripReportBlock,
  unresolvedFailuresOf,
  type CompactionFacts,
} from '../../../src/main/engine/compaction.js';
import { FOUNDRY_RUN_HARNESS } from '../../../src/main/pi/system-prompt.js';

const PHASE_PROMPT = ['Build: ship the widget.', '', '## Request', '', 'ship the widget'].join(
  '\n',
);

const WITH_REPORT = [PHASE_PROMPT, '', '## Report', '', '{', '  "status": "success"', '}'].join(
  '\n',
);

function facts(over: Partial<CompactionFacts> = {}): CompactionFacts {
  return {
    request: 'ship the widget',
    phase: 'build',
    artifactPaths: ['.foundry-handoff/build.json', 'src/widget.ts'],
    unresolvedFailures: ['test: ./check.sh exited 1\nAssertionError: expected true'],
    filesModified: ['src/widget.ts'],
    envelopeKind: 'build',
    requiredFields: requiredFieldsFor('build'),
    phaseUserPrompt: PHASE_PROMPT,
    projectCard: '## Stack\nTypeScript\n\n## Layout\nsrc/',
    ...over,
  };
}

describe('stripReportBlock', () => {
  it('removes the trailing Report example and leaves the phase prompt', () => {
    expect(stripReportBlock(WITH_REPORT)).toBe(PHASE_PROMPT);
    expect(stripReportBlock(WITH_REPORT)).not.toContain('## Report');
    expect(stripReportBlock(PHASE_PROMPT)).toBe(PHASE_PROMPT);
  });
});

describe('foundryCompactionSummary', () => {
  it('keeps the phase prompt and project card verbatim', () => {
    const summary = foundryCompactionSummary(facts());
    expect(summary).toContain(PHASE_PROMPT);
    expect(summary).toContain('## Stack\nTypeScript\n\n## Layout\nsrc/');
  });

  it('records request, artifacts, open failures, files, and envelope fields', () => {
    const summary = foundryCompactionSummary(facts());
    expect(summary).toContain('## Request\n\nship the widget');
    expect(summary).toContain('## Current phase\n\nbuild');
    expect(summary).toContain('- .foundry-handoff/build.json');
    expect(summary).toContain('- src/widget.ts');
    expect(summary).toContain('test: ./check.sh exited 1');
    expect(summary).toContain('AssertionError: expected true');
    expect(summary).toContain('kind: build');
    expect(summary).toContain('required fields:');
    expect(summary).toContain('status');
    expect(summary).toContain('commit_message');
  });

  it('does not use Pi’s chat template or summarise the system harness', () => {
    const summary = foundryCompactionSummary(facts());
    expect(summary).not.toContain('## Goal');
    expect(summary).not.toContain('## Progress');
    expect(summary).not.toContain('## Next Steps');
    expect(summary).not.toContain(FOUNDRY_RUN_HARNESS);
    expect(summary).not.toContain('You are a Foundry pipeline agent');
  });

  it('omits empty constitution sections rather than inventing them', () => {
    const summary = foundryCompactionSummary(
      facts({ phaseUserPrompt: '', projectCard: '', artifactPaths: [], unresolvedFailures: [] }),
    );
    expect(summary).not.toContain('## Phase prompt');
    expect(summary).not.toContain('## Project card');
    expect(summary).toContain('## Artifact paths\n\n(none)');
    expect(summary).toContain('## Unresolved failures\n\n(none)');
  });
});

describe('compaction evidence collectors', () => {
  it('collects artifact paths from envelopes', () => {
    expect(
      artifactPathsOf([
        { artifacts: ['.foundry-handoff/build.json', ''] },
        { artifacts: 'not-a-list' },
        {},
      ]),
    ).toEqual(['.foundry-handoff/build.json']);
  });

  it('collects unresolved command and feedback failures', () => {
    expect(
      unresolvedFailuresOf({
        commands: [
          ['ok', { passed: true, command: 'true', exitCode: 0, outputTail: '' }],
          [
            'test',
            { passed: false, command: './check.sh', exitCode: 1, outputTail: 'AssertionError' },
          ],
        ],
        feedback: [
          ['build', 'the check failed'],
          ['skip', '  '],
        ],
      }),
    ).toEqual(['test: ./check.sh exited 1\nAssertionError', 'build: the check failed']);
  });
});
