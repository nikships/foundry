/**
 * The direct-key providers Foundry configures on pi itself.
 *
 * Two things are worth pinning. The table's contract: a model whose thinking
 * map or rate card is wrong is a phase that fails at request time, not in the
 * picker, so the shape is asserted rather than assumed. And the registration:
 * it must reach a real `ModelRuntime` and leave the provider *unavailable*
 * until a key is stored, because a provider that appears reachable without a
 * credential puts a model in the cast pool that every phase then fails on.
 *
 * A real runtime is used, against a temp directory, the way
 * `pi-runtime.test.ts` does. Nothing here logs in, so no network is touched.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DIRECT_PROVIDERS, isDirectProviderId } from '../../../src/shared/direct-providers.js';
import { registerDirectProviders } from '../../../src/main/pi/direct-providers.js';
import { refreshCatalog, toModelInfo } from '../../../src/main/pi/catalog.js';
import { modelRuntime, piStateDir, resetModelRuntimes } from '../../../src/main/pi/runtime.js';
import { REASONING_EFFORTS } from '../../../src/shared/reasoning-effort.js';
import { tempDir } from '../../helpers/tmp.js';

const meta = DIRECT_PROVIDERS.find((provider) => provider.id === 'meta');

describe('the direct-provider table', () => {
  it('registers Meta under the id pi stores a key against', () => {
    // `bridge.setApiKey` passes this id straight to pi's credential store; a
    // different spelling here would store a key nothing ever reads.
    expect(meta).toBeDefined();
    expect(isDirectProviderId('meta')).toBe(true);
    expect(isDirectProviderId('anthropic')).toBe(false);
  });

  it('points at the Model API root and speaks Responses', () => {
    expect(meta?.baseUrl).toBe('https://api.meta.ai/v1');
    expect(meta?.api).toBe('openai-responses');
  });

  it('offers only text-returning models, which is all an agent phase can use', () => {
    // Muse Image and the transcription model live on the same endpoint. A
    // picture back from a build phase is a failed phase.
    const ids = meta?.models.map((model) => model.id) ?? [];
    expect(ids).toEqual(['muse-spark-1.3', 'muse-spark-1.3-contributor']);
    expect(ids.some((id) => id.includes('image') || id.includes('llama'))).toBe(false);
  });

  it('withholds the two efforts the API refuses and names the rest', () => {
    for (const model of meta?.models ?? []) {
      // Verified against the live endpoint: `none` answers "does not support"
      // for every Spark model and `max` is not a variant it knows, so both are
      // nulled rather than omitted — an omitted key means "provider default",
      // and there is no default for a level that 400s.
      expect(model.thinkingLevelMap?.off).toBeNull();
      expect(model.thinkingLevelMap?.max).toBeNull();
      expect(model.thinkingLevelMap?.minimal).toBe('minimal');
      expect(model.thinkingLevelMap?.xhigh).toBe('xhigh');
      // Every level Foundry knows gets an explicit answer, so a new level
      // added to `REASONING_EFFORTS` cannot silently inherit a default.
      for (const level of REASONING_EFFORTS) {
        expect(model.thinkingLevelMap, level).toHaveProperty(level);
      }
    }
  });

  it('prices the contributor tier below the standard one it mirrors', () => {
    const standard = meta?.models.find((model) => model.id === 'muse-spark-1.3');
    const contributor = meta?.models.find((model) => model.id === 'muse-spark-1.3-contributor');
    // Same weights, lower price, in exchange for training rights. The
    // Orchestrator casts on cost, so the two must not report the same rate.
    expect(contributor?.cost.input).toBeLessThan(standard?.cost.input ?? 0);
    expect(contributor?.cost.output).toBeLessThan(standard?.cost.output ?? 0);
    expect(contributor?.contextWindow).toBe(standard?.contextWindow);
  });

  it('keeps the completion cap inside the window the API accepts', () => {
    for (const model of meta?.models ?? []) {
      expect(model.maxTokens).toBeGreaterThan(0);
      // A cap above the window is rejected outright by the endpoint.
      expect(model.maxTokens).toBeLessThanOrEqual(model.contextWindow);
    }
  });
});

describe('registering the table on a runtime', () => {
  it('teaches pi the provider, which its own table has no entry for', async () => {
    const support = tempDir('foundry-direct-providers-');
    try {
      const runtime = await modelRuntime(support);
      // `modelRuntime` registers on build, so the provider is present before
      // any caller could look for it and find it missing.
      expect(runtime.getProviders().some((provider) => provider.id === 'meta')).toBe(true);
      expect(runtime.getModels('meta').map((model) => model.id)).toEqual(
        meta?.models.map((model) => model.id),
      );
    } finally {
      resetModelRuntimes();
    }
  });

  it('leaves every model unreachable until a key is stored', async () => {
    const support = tempDir('foundry-direct-providers-');
    try {
      const runtime = await modelRuntime(support);
      const available = await runtime.getAvailable();
      // Registration carries no credential. A model offered without one is a
      // model the picker shows and every run fails on.
      expect(available.some((model) => model.provider === 'meta')).toBe(false);
    } finally {
      resetModelRuntimes();
    }
  });

  it('routes OpenRouter through Responses without dropping pi’s model catalog', async () => {
    const support = tempDir('foundry-direct-providers-');
    try {
      const runtime = await modelRuntime(support);
      const responsesModels = runtime.getModels('openrouter');
      const responsesAuth = Object.keys(runtime.getProvider('openrouter')?.auth ?? {}).sort();
      runtime.unregisterProvider('openrouter');
      const builtinModels = runtime.getModels('openrouter');
      const builtinAuth = Object.keys(runtime.getProvider('openrouter')?.auth ?? {}).sort();

      expect(builtinModels.length).toBeGreaterThan(0);
      expect(builtinModels.every((model) => model.api === 'openai-completions')).toBe(true);
      expect(responsesModels).toEqual(
        builtinModels.map((model) => ({ ...model, api: 'openai-responses' })),
      );
      expect(responsesAuth).toEqual(builtinAuth);
    } finally {
      resetModelRuntimes();
    }
  });

  it('keeps the Responses override when models.json is refreshed', async () => {
    const support = tempDir('foundry-direct-providers-');
    try {
      const runtime = await modelRuntime(support);
      writeFileSync(
        join(piStateDir(support), 'models.json'),
        JSON.stringify({
          providers: {
            openrouter: {
              models: [
                {
                  id: 'foundry-refresh-probe',
                  name: 'Foundry refresh probe',
                  api: 'openai-completions',
                  reasoning: false,
                  input: ['text'],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 8_192,
                  maxTokens: 1_024,
                },
              ],
            },
          },
        }),
      );

      await refreshCatalog(support);

      expect(runtime.getModel('openrouter', 'foundry-refresh-probe')?.api).toBe('openai-responses');
    } finally {
      resetModelRuntimes();
    }
  });

  it('is idempotent, so a re-registration does not duplicate the models', async () => {
    const support = tempDir('foundry-direct-providers-');
    try {
      const runtime = await modelRuntime(support);
      const openrouterIds = runtime.getModels('openrouter').map((model) => model.id);
      registerDirectProviders(runtime);
      registerDirectProviders(runtime);
      expect(runtime.getModels('meta')).toHaveLength(meta?.models.length ?? 0);
      expect(runtime.getModels('openrouter').map((model) => model.id)).toEqual(openrouterIds);
    } finally {
      resetModelRuntimes();
    }
  });

  it('carries the table’s metadata onto the picker shape', async () => {
    const support = tempDir('foundry-direct-providers-');
    try {
      const runtime = await modelRuntime(support);
      const spark = runtime.getModels('meta').find((model) => model.id === 'muse-spark-1.3');
      expect(spark).toBeDefined();
      const info = toModelInfo(spark!);
      // The mark is the lab's, read off the id: Meta's ids carry the family
      // name (`muse-spark`) and never the lab.
      expect(info.provider).toBe('meta');
      // Shipped and reviewed like a built-in, so no Custom pill.
      expect(info.isCustom).toBe(false);
      expect(info.contextWindow).toBe(1_048_576);
      expect(info.cost).toEqual({ input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 });
      // `off` and `max` are refused by the API, so the picker must not offer them.
      expect(info.supportedReasoningEfforts).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh']);
      expect(info.defaultReasoningEffort).toBe('medium');
    } finally {
      resetModelRuntimes();
    }
  });
});
