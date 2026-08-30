/**
 * Brand marks for the model providers Foundry can reach, from @lobehub/icons.
 *
 * The maps below are written out rather than handed to lobehub's own
 * ProviderIcon, which resolves a name against a fixed keyword list holding no
 * entry for kimi, zai, junie, codex or grok, and renders an anonymous
 * placeholder for anything it misses. That would give five of our six vendors
 * the same glyph, which reads as a broken picker rather than an unmapped brand.
 * A name this file does not know renders nothing at all, the same honest gap the
 * PNG lookup left when an asset was missing.
 *
 * Colour variant where the brand publishes one, mono glyph otherwise. The mono
 * glyphs paint in currentColor, so they inherit the palette instead of arriving
 * as black artwork on a dark surface.
 *
 * Each variant is imported on its own rather than through the brand's default
 * export, which is a compound object built by assigning an Avatar onto the mono
 * icon. That assignment is a use, so no bundler can shake it out, and the Avatar
 * pulls @lobehub/ui, antd, and emoji-mart into the renderer to draw a logo that
 * needs none of them. tests/brand-icons.test.ts fails if one of these paths moves.
 */

import type { ComponentType } from 'react';
import type { MarkProps } from './FoundryGlyph.js';
import Ai21Mono from '@lobehub/icons/es/Ai21/components/Mono.js';
import AlibabaCloudColor from '@lobehub/icons/es/AlibabaCloud/components/Color.js';
import AlibabaColor from '@lobehub/icons/es/Alibaba/components/Color.js';
import AnthropicMono from '@lobehub/icons/es/Anthropic/components/Mono.js';
import AppleMono from '@lobehub/icons/es/Apple/components/Mono.js';
import AwsColor from '@lobehub/icons/es/Aws/components/Color.js';
import BaichuanColor from '@lobehub/icons/es/Baichuan/components/Color.js';
import BedrockColor from '@lobehub/icons/es/Bedrock/components/Color.js';
import ByteDanceColor from '@lobehub/icons/es/ByteDance/components/Color.js';
import CerebrasColor from '@lobehub/icons/es/Cerebras/components/Color.js';
import ChatGLMColor from '@lobehub/icons/es/ChatGLM/components/Color.js';
import ClaudeColor from '@lobehub/icons/es/Claude/components/Color.js';
import CodexColor from '@lobehub/icons/es/Codex/components/Color.js';
import CohereColor from '@lobehub/icons/es/Cohere/components/Color.js';
import DbrxColor from '@lobehub/icons/es/Dbrx/components/Color.js';
import DeepMindColor from '@lobehub/icons/es/DeepMind/components/Color.js';
import DeepSeekColor from '@lobehub/icons/es/DeepSeek/components/Color.js';
import DoubaoColor from '@lobehub/icons/es/Doubao/components/Color.js';
import FireworksColor from '@lobehub/icons/es/Fireworks/components/Color.js';
import GemmaColor from '@lobehub/icons/es/Gemma/components/Color.js';
import GeminiColor from '@lobehub/icons/es/Gemini/components/Color.js';
import GoogleColor from '@lobehub/icons/es/Google/components/Color.js';
import GrokMono from '@lobehub/icons/es/Grok/components/Mono.js';
import GroqMono from '@lobehub/icons/es/Groq/components/Mono.js';
import HuggingFaceColor from '@lobehub/icons/es/HuggingFace/components/Color.js';
import HunyuanColor from '@lobehub/icons/es/Hunyuan/components/Color.js';
import IFlyTekCloudColor from '@lobehub/icons/es/IFlyTekCloud/components/Color.js';
import InflectionMono from '@lobehub/icons/es/Inflection/components/Mono.js';
import InternLMColor from '@lobehub/icons/es/InternLM/components/Color.js';
import JunieColor from '@lobehub/icons/es/Junie/components/Color.js';
import KimiColor from '@lobehub/icons/es/Kimi/components/Color.js';
import LmStudioMono from '@lobehub/icons/es/LmStudio/components/Mono.js';
import MetaColor from '@lobehub/icons/es/Meta/components/Color.js';
import MicrosoftColor from '@lobehub/icons/es/Microsoft/components/Color.js';
import MinimaxColor from '@lobehub/icons/es/Minimax/components/Color.js';
import MistralColor from '@lobehub/icons/es/Mistral/components/Color.js';
import MoonshotMono from '@lobehub/icons/es/Moonshot/components/Mono.js';
import NousResearchMono from '@lobehub/icons/es/NousResearch/components/Mono.js';
import NovaColor from '@lobehub/icons/es/Nova/components/Color.js';
import NvidiaColor from '@lobehub/icons/es/Nvidia/components/Color.js';
import OllamaMono from '@lobehub/icons/es/Ollama/components/Mono.js';
import OpenAIMono from '@lobehub/icons/es/OpenAI/components/Mono.js';
import OpenRouterColor from '@lobehub/icons/es/OpenRouter/components/Color.js';
import PaLMColor from '@lobehub/icons/es/PaLM/components/Color.js';
import PerplexityColor from '@lobehub/icons/es/Perplexity/components/Color.js';
import QwenColor from '@lobehub/icons/es/Qwen/components/Color.js';
import ReplitColor from '@lobehub/icons/es/Replit/components/Color.js';
import RwkvColor from '@lobehub/icons/es/Rwkv/components/Color.js';
import SenseNovaColor from '@lobehub/icons/es/SenseNova/components/Color.js';
import SnowflakeColor from '@lobehub/icons/es/Snowflake/components/Color.js';
import SparkColor from '@lobehub/icons/es/Spark/components/Color.js';
import StepfunMono from '@lobehub/icons/es/Stepfun/components/Mono.js';
import TIIColor from '@lobehub/icons/es/TII/components/Color.js';
import TencentColor from '@lobehub/icons/es/Tencent/components/Color.js';
import TogetherColor from '@lobehub/icons/es/Together/components/Color.js';
import UpstageColor from '@lobehub/icons/es/Upstage/components/Color.js';
import VolcengineColor from '@lobehub/icons/es/Volcengine/components/Color.js';
import WenxinColor from '@lobehub/icons/es/Wenxin/components/Color.js';
import XAIMono from '@lobehub/icons/es/XAI/components/Mono.js';
import YiColor from '@lobehub/icons/es/Yi/components/Color.js';
import ZAIMono from '@lobehub/icons/es/ZAI/components/Mono.js';
import ZeroOneColor from '@lobehub/icons/es/ZeroOne/components/Color.js';
import ZhipuColor from '@lobehub/icons/es/Zhipu/components/Color.js';
import styles from './BrandIcon.module.css';

export type { MarkProps } from './FoundryGlyph.js';
export { FoundryGlyph } from './FoundryGlyph.js';

export type Mark = ComponentType<MarkProps>;

/**
 * pi's mark: the letter it is named after, drawn rather than typeset so it does
 * not depend on a font that ships a Greek glyph. lobehub publishes no pi icon,
 * and pi is the harness every agent phase now runs on, so the one runtime the
 * app always uses would otherwise be the only unlabelled thing on the screen.
 */
function PiMark({ size = 16, className, style }: MarkProps): React.JSX.Element {
  return (
    <svg
      className={className}
      fill="none"
      height={size}
      style={style}
      viewBox="0 0 64 64"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <g stroke="currentColor" strokeWidth="6.4" strokeLinecap="round">
        <path d="M12 20h40" />
        <path d="M24 20v26" />
        <path d="M42 20v20a6 6 0 0 0 8 5.4" />
      </g>
    </svg>
  );
}

/** The agent harness itself, for chrome that names the transport. */
export const PiGlyph: Mark = PiMark;

/**
 * Keyed by the `provider` string the model catalog reports. Aliases for the
 * same brand are listed separately rather than normalised, because one catalog
 * is free to say `kimi` where another says `moonshot` and neither is wrong.
 */
const PROVIDER_MARKS: Record<string, Mark> = {
  ai21: Ai21Mono,
  alibaba: AlibabaColor,
  alibabacloud: AlibabaCloudColor,
  anthropic: AnthropicMono,
  apple: AppleMono,
  aws: AwsColor,
  baichuan: BaichuanColor,
  bedrock: BedrockColor,
  bytedance: ByteDanceColor,
  cerebras: CerebrasColor,
  chatglm: ChatGLMColor,
  claude: ClaudeColor,
  codex: CodexColor,
  cohere: CohereColor,
  dbrx: DbrxColor,
  deepmind: DeepMindColor,
  deepseek: DeepSeekColor,
  doubao: DoubaoColor,
  // Ernie is Baidu's Wenxin model family; the Wenxin mark covers both names.
  ernie: WenxinColor,
  fireworks: FireworksColor,
  gemini: GeminiColor,
  gemma: GemmaColor,
  glm: ChatGLMColor,
  google: GoogleColor,
  grok: GrokMono,
  groq: GroqMono,
  huggingface: HuggingFaceColor,
  hunyuan: HunyuanColor,
  // iFlyTek's model family is Spark; both names resolve to the same mark.
  iflytek: IFlyTekCloudColor,
  inflection: InflectionMono,
  internlm: InternLMColor,
  junie: JunieColor,
  kimi: KimiColor,
  lmstudio: LmStudioMono,
  meta: MetaColor,
  microsoft: MicrosoftColor,
  minimax: MinimaxColor,
  mistral: MistralColor,
  moonshot: MoonshotMono,
  nous: NousResearchMono,
  nova: NovaColor,
  nvidia: NvidiaColor,
  ollama: OllamaMono,
  openai: OpenAIMono,
  openrouter: OpenRouterColor,
  palm: PaLMColor,
  perplexity: PerplexityColor,
  qwen: QwenColor,
  replit: ReplitColor,
  rwkv: RwkvColor,
  sensenova: SenseNovaColor,
  snowflake: SnowflakeColor,
  spark: SparkColor,
  stepfun: StepfunMono,
  tii: TIIColor,
  // Hunyuan is Tencent's; the Tencent mark covers the corporate alias too.
  tencent: TencentColor,
  together: TogetherColor,
  upstage: UpstageColor,
  // Doubao is served on ByteDance's Volcengine; the Volcengine mark covers it.
  volcengine: VolcengineColor,
  wenxin: WenxinColor,
  xai: XAIMono,
  // Yi is 01.AI, whose English brand is ZeroOne; both names resolve here.
  yi: YiColor,
  zai: ZAIMono,
  zeroone: ZeroOneColor,
  zhipu: ZhipuColor,
};

/** The mark for a provider, or null when this build has no logo for it. */
export function providerMark(provider: string | null | undefined): Mark | null {
  if (!provider) return null;
  return PROVIDER_MARKS[provider.toLowerCase()] ?? null;
}

/** The logo of the vendor behind a model, or nothing when there is none. */
export function ProviderIcon({
  provider,
  size = 16,
}: {
  provider: string;
  size?: number;
}): React.JSX.Element | null {
  const Icon = providerMark(provider);
  if (!Icon) return null;
  return (
    <span
      aria-label={provider}
      className={styles.brandMark}
      role="img"
      style={{ width: size, height: size }}
      title={provider}
    >
      <Icon size={size} />
    </span>
  );
}
