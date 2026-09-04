/**
 * Composition-rule bullets are generated from the same objects the rails run.
 * Changing a rail without this snapshot failing means the prompt drifted.
 */
import { describe, expect, it } from 'vitest';
import {
  ORCHESTRATOR_PROMPT,
  buildPlanPrompt,
  phaseModelIssues,
  stampedFewShotPipelines,
  type PlanPromptInputs,
} from '../../../src/main/orchestrator/plan.js';
import {
  COMPOSITION_RULES,
  compositionRuleBullets,
  generatedCompositionIssues,
} from '../../../src/main/orchestrator/composition.js';
import type { ModelInfo } from '../../../src/shared/types.js';

const model = (id: string, displayName: string): ModelInfo => ({
  id,
  displayName,
  provider: 'claude',
  supportedReasoningEfforts: ['off', 'low', 'medium', 'high'],
  defaultReasoningEffort: 'medium',
  isCustom: false,
  deprecated: false,
  contextWindow: 200_000,
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
});

const pool: ModelInfo[] = [
  model('anthropic/claude-opus-4', 'Claude Opus 4'),
  model('openai/gpt-5', 'GPT 5'),
  model('anthropic/claude-haiku-4', 'Claude Haiku 4'),
];

describe('orchestrator composition rules', () => {
  it('generates prompt bullets from the same functions as the rails', () => {
    const bullets = compositionRuleBullets();
    expect(bullets).toMatchSnapshot();
    expect(ORCHESTRATOR_PROMPT).toContain(bullets);
    expect(COMPOSITION_RULES.map((rule) => rule.id)).toEqual([
      'refined-request',
      'proof',
      'review-gates',
      'independent-review-before-pr',
      'phase-model',
      'feedback-to',
      'flake-rerun',
      'acceptance',
      'prefer-roster',
      'synthesized-agent',
      'synthesized-prompts',
      'phase-names',
      'no-engineer',
      'review-provider',
    ]);
  });

  it('stamps few-shot pipelines so they pass phaseModelIssues against the same pool', () => {
    const allowed = pool.map((entry) => entry.id);
    for (const pipeline of stampedFewShotPipelines(pool)) {
      expect(phaseModelIssues(pipeline.phases, allowed, 0, pool)).toEqual([]);
      for (const phase of pipeline.phases) {
        if (phase.kind !== 'agent') continue;
        expect(phase.model).toBeTruthy();
        expect(phase.model).not.toBe('inherit');
        expect(phase.reasoningEffort).toBeTruthy();
      }
    }
  });

  it('keeps the refined brief behavioral: invented repository paths are errors', () => {
    const briefIssues = (request: string | undefined, refinedRequest: string) =>
      generatedCompositionIssues({ phases: [] }, [], [], [], { request, refinedRequest });

    const invented = briefIssues(
      'let users paste images into the composer',
      'Add paste support by extending src/renderer/components/Composer.tsx and storing blobs via src/main/images.ts.',
    );
    expect(invented).toHaveLength(2);
    expect(invented[0]!.where).toBe('refinedRequest');
    expect(invented[0]!.message).toContain('src/renderer/components/Composer.tsx');
    expect(invented[1]!.message).toContain('src/main/images.ts');

    // An operator-stated path is a constraint the brief must keep, not an invention.
    expect(
      briefIssues(
        'tighten the cast pool in apps/desktop/src/main/orchestrator/plan.ts only',
        'Tighten the cast pool in apps/desktop/src/main/orchestrator/plan.ts only; change nothing else.',
      ),
    ).toEqual([]);

    // Sentence-final punctuation, markdown emphasis, and casing do not turn an
    // operator path into an invention.
    expect(
      briefIssues(
        'only touch src/main/images.ts and docs/readme.md',
        'Only touch *src/main/images.ts* and docs/README.md.',
      ),
    ).toEqual([]);

    // A leading slash is not an escape hatch for an invented path.
    expect(
      briefIssues('let users paste images', 'Extend /src/renderer/composer.tsx to handle paste.'),
    ).toHaveLength(1);

    // Prose slashes, URLs, framework pairs, and dates are not repository paths.
    expect(
      briefIssues(
        'document the retry behavior',
        'Cover read/write access, CI/CD notes on the React/Next.js page, the 09/03/2026 cutoff, and https://linear.app/foundry/issue/FOU-190.',
      ),
    ).toEqual([]);

    // Amendments and image-only planning carry no raw request: the rail stands down.
    expect(briefIssues(undefined, 'Rewrite src/invented/path.ts anyway.')).toEqual([]);
  });

  it('lists more than two cast-pool ids when more are enabled', () => {
    const inputs: PlanPromptInputs = {
      request: 'add a changes file',
      contextSummary: 'A small demo repository.',
      commands: [{ name: 'test', argv: ['npm', 'test'] }],
      roster: [],
      envelopeDefs: [],
      models: pool,
      preferredModelIds: ['anthropic/claude-opus-4'],
    };
    const prompt = buildPlanPrompt(inputs);
    expect(prompt).toContain('anthropic/claude-opus-4');
    expect(prompt).toContain('openai/gpt-5');
    expect(prompt).toContain('anthropic/claude-haiku-4');
    expect(prompt).not.toContain('$3/M');
    expect(prompt).not.toContain('cacheWrite');
  });
});
