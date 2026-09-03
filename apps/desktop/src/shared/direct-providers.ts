/**
 * Providers Foundry teaches pi about, so a direct API key is all an operator
 * needs to reach them.
 *
 * Pi ships a provider table of its own, and a key stored for a provider that
 * is not in it goes nowhere: `login()` refuses an id it does not know. Meta's
 * Model API is absent from the pinned runtime's table, so Foundry registers
 * the provider itself (`main/pi/direct-providers.ts`) and the key still lands
 * in pi's credential store through the ordinary login path.
 *
 * The table lives in shared because both sides need the same answer and from
 * the same place: main registers the provider under `id`, and that id is what
 * `bridge.setApiKey` passes to pi's credential store. A renderer row spelling
 * it differently would store a key nothing ever reads.
 *
 * Models are pinned rather than fetched. `GET /v1/models` answers with ids and
 * nothing else — no context window, no rate card, no thinking levels — so the
 * metadata the picker and the Orchestrator's cast pool need has to come from
 * somewhere, and a table in the repository is reviewable where a runtime guess
 * is not. Only Muse Spark 1.3 is shipped: older Spark ids, Llama, Muse Image,
 * and the transcription model are left out. An agent phase needs a current
 * text-returning model.
 */

import type { ModelCost } from './types.js';

/** A provider Foundry registers, and how pi should reach it. */
export interface DirectProviderDef {
  /** pi's provider id, and the key `bridge.setApiKey` stores under. */
  id: string;
  /** Shown in Settings and onboarding; never derived from the id. */
  label: string;
  /** Icon key the renderer maps to a provider mark. */
  icon: string;
  baseUrl: string;
  /**
   * pi's API kind. Meta's Model API is used as OpenAI Responses so a tool
   * loop can replay `reasoning.encrypted_content`; chat-completions does not
   * return thinking that can be sent back.
   */
  api: 'openai-responses';
  models: readonly DirectModelDef[];
}

export interface DirectModelDef {
  id: string;
  name: string;
  reasoning: boolean;
  /**
   * Tristate, as `references/models.md` describes it: a string is supported,
   * `null` is refused, and an omitted key falls back to the provider default.
   * Written out in full for Muse Spark because the API refuses two of pi's
   * seven levels outright, and an omitted key would leave those to a provider
   * default that does not exist.
   */
  thinkingLevelMap?: Readonly<Record<string, string | null>>;
  input: readonly ('text' | 'image')[];
  cost: ModelCost;
  contextWindow: number;
  maxTokens: number;
}

/**
 * Muse Spark's thinking levels.
 *
 * The API accepts `minimal` through `xhigh` and refuses both ends: `none`
 * answers "does not support" for every Spark model, and `max` is not a variant
 * it knows. `off` is therefore withheld rather than mapped — these models
 * always reason, and offering an effort the provider rejects would fail a
 * phase at request time instead of in the picker.
 */
const SPARK_THINKING: Readonly<Record<string, string | null>> = {
  off: null,
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: null,
};

/** Published Spark rates, in USD per million tokens — pi's `cost` unit. */
const SPARK_COST: ModelCost = { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 };

/**
 * The contributor tier is the same model at a fraction of the price, in
 * exchange for Meta being allowed to train on the prompts and outputs. That
 * trade is not visible anywhere else in the picker, so it rides in the display
 * name: it is the whole reason to choose the tier, or to avoid it.
 */
const CONTRIBUTOR_COST: ModelCost = { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 };

/** Every Spark model shares the window and the completion cap. */
const SPARK_CONTEXT_WINDOW = 1_048_576;
const SPARK_MAX_TOKENS = 943_718;

function sparkModel(id: string, name: string, cost: ModelCost): DirectModelDef {
  return {
    id,
    name,
    reasoning: true,
    thinkingLevelMap: SPARK_THINKING,
    // Video, audio, and PDF inputs are accepted by the API and absent here
    // because pi's model shape has no way to declare them.
    input: ['text', 'image'],
    cost,
    contextWindow: SPARK_CONTEXT_WINDOW,
    maxTokens: SPARK_MAX_TOKENS,
  };
}

export const DIRECT_PROVIDERS: readonly DirectProviderDef[] = [
  {
    id: 'meta',
    label: 'Meta',
    icon: 'meta',
    baseUrl: 'https://api.meta.ai/v1',
    api: 'openai-responses',
    models: [
      sparkModel('muse-spark-1.3', 'Muse Spark 1.3', SPARK_COST),
      sparkModel('muse-spark-1.3-contributor', 'Muse Spark 1.3 Contributor', CONTRIBUTOR_COST),
    ],
  },
] as const;

/** True for a provider Foundry registered itself rather than one pi ships. */
export function isDirectProviderId(providerId: string): boolean {
  return DIRECT_PROVIDERS.some((provider) => provider.id === providerId);
}
