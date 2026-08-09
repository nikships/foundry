/**
 * Brand marks for the CLIs and model providers Foundry drives, from
 * @lobehub/icons.
 *
 * The maps below are written out rather than handed to lobehub's own
 * ProviderIcon, which resolves a name against a fixed keyword list holding no
 * entry for kimi, zai, junie, codex, grok or droid, and renders an anonymous
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

import type { ComponentType, CSSProperties } from 'react';
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
import type { CliVendor } from '@shared/types.js';
import styles from './BrandIcon.module.css';

export interface MarkProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
}

export type Mark = ComponentType<MarkProps>;

/**
 * Factory ships no mark in lobehub's collection, and droid is the default CLI,
 * so without this the vendor most installs actually run would be the only one
 * with no logo. Taken from Factory's own site mark, currentColor so it sits
 * beside the mono glyphs rather than beside a hole.
 */
function FactoryDroid({ size = 16, className, style }: MarkProps): React.JSX.Element {
  return (
    <svg
      className={className}
      fill="none"
      height={size}
      style={style}
      viewBox="0 0 67 65"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M47.75 11.15a.867.867 0 0 1-.671-.806.84.84 0 0 1 .067-.362c1.688-4.007 2.433-7.213 1.23-8.555-3.183-3.56-15.952 3.52-20.024 5.919a.9.9 0 0 1-1.273-.41c-1.711-3.998-3.51-6.78-5.334-6.9-4.833-.323-8.73 13.49-9.87 17.992a.85.85 0 0 1-.459.563.9.9 0 0 1-.737.027c-4.109-1.647-7.398-2.373-8.773-1.2-3.651 3.104 3.609 15.557 6.068 19.528a.85.85 0 0 1-.11 1.031.9.9 0 0 1-.31.21C3.455 39.856.604 41.61.478 43.389c-.329 4.713 13.834 8.513 18.452 9.625q.186.046.337.163a.87.87 0 0 1 .332.642.84.84 0 0 1-.067.362c-1.688 4.007-2.433 7.214-1.23 8.555 3.183 3.561 15.954-3.519 20.025-5.917a.9.9 0 0 1 1.058.107.9.9 0 0 1 .215.302c1.711 3.997 3.509 6.779 5.334 6.9 4.833.322 8.73-13.49 9.868-17.993a.85.85 0 0 1 .168-.33.88.88 0 0 1 .659-.324.9.9 0 0 1 .371.066c4.109 1.647 7.397 2.372 8.773 1.2 3.651-3.105-3.61-15.559-6.07-19.53a.85.85 0 0 1 .111-1.03.9.9 0 0 1 .31-.21c4.1-1.67 6.952-3.424 7.075-5.203.331-4.713-13.833-8.513-18.45-9.623m-5.546-4.518c.93 1.624-3.858 12.446-7.42 20.015a.7.7 0 0 1-.28.303.71.71 0 0 1-.796-.059.7.7 0 0 1-.23-.341c-1.439-4.921-3.082-10.704-4.841-15.612a.84.84 0 0 1 .01-.594.87.87 0 0 1 .401-.446c4.392-2.34 11.908-5.446 13.156-3.266m-21.048 1.34c1.833.507 6.294 11.46 9.264 19.268a.67.67 0 0 1-.2.754.71.71 0 0 1-.794.08c-4.589-2.485-9.94-5.444-14.743-7.702a.87.87 0 0 1-.422-.427.84.84 0 0 1-.04-.591c1.414-4.679 4.471-12.063 6.935-11.383M7.243 23.433c1.664-.906 12.762 3.763 20.522 7.235.13.058.239.154.311.274a.67.67 0 0 1-.06.776.7.7 0 0 1-.35.225c-5.045 1.403-10.976 3.006-16.01 4.721a.9.9 0 0 1-.607-.01.88.88 0 0 1-.456-.391c-2.395-4.284-5.586-11.613-3.35-12.83M8.617 43.96c.519-1.788 11.752-6.14 19.758-9.035a.72.72 0 0 1 .773.195.67.67 0 0 1 .081.774c-2.548 4.475-5.582 9.694-7.898 14.377a.87.87 0 0 1-.437.413.9.9 0 0 1-.607.039c-4.797-1.37-12.37-4.36-11.67-6.763m15.855 13.568c-.93-1.623 3.859-12.446 7.42-20.014a.7.7 0 0 1 .28-.303.715.715 0 0 1 .796.059.7.7 0 0 1 .23.34c1.439 4.92 3.083 10.705 4.841 15.613a.84.84 0 0 1-.01.593.87.87 0 0 1-.402.445c-4.391 2.335-11.908 5.447-13.15 3.267zm21.049-1.34c-1.836-.506-6.297-11.461-9.266-19.269a.67.67 0 0 1 .2-.755.71.71 0 0 1 .795-.078c4.587 2.484 9.94 5.445 14.742 7.703.189.088.339.24.423.426a.84.84 0 0 1 .039.592c-1.413 4.686-4.47 12.063-6.933 11.381m13.912-15.462c-1.665.907-12.762-3.763-20.523-7.236a.7.7 0 0 1-.311-.273.67.67 0 0 1 .06-.777.7.7 0 0 1 .35-.225c5.046-1.402 10.975-3.005 16.009-4.72a.9.9 0 0 1 .609.01.88.88 0 0 1 .457.392c2.393 4.282 5.584 11.613 3.349 12.829M58.06 20.2c-.521 1.79-11.753 6.14-19.759 9.036a.72.72 0 0 1-.774-.195.67.67 0 0 1-.08-.776c2.547-4.474 5.581-9.694 7.897-14.377a.87.87 0 0 1 .437-.412.9.9 0 0 1 .607-.038c4.797 1.377 12.37 4.359 11.672 6.762"
        fill="currentColor"
      />
    </svg>
  );
}

/**
 * One mark per vendor in CLI_VENDOR_IDS. The harness gets its own product logo
 * where the vendor ships one, because Claude Code and Claude the model are not
 * the same thing and an agent's CLI is the more useful of the two to recognise.
 */
export const CLI_MARKS: Record<CliVendor, Mark> = {
  droid: FactoryDroid,
};

/**
 * Keyed by the `provider` string a CLI's model catalog reports. Aliases for the
 * same brand are listed separately rather than normalised, because a catalog is
 * free to say `kimi` where another says `moonshot` and neither is wrong.
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
  droid: FactoryDroid,
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

/** The logo of the CLI that runs an agent's phases. */
export function CliIcon({
  vendor,
  size = 16,
}: {
  vendor: CliVendor;
  size?: number;
}): React.JSX.Element {
  // A roster written before a vendor was renamed can still name it, and an
  // unknown vendor falls back to droid everywhere else in the app.
  const Icon = CLI_MARKS[vendor] ?? CLI_MARKS.droid;
  return (
    <span
      aria-label={vendor}
      className={styles.brandMark}
      role="img"
      style={{ width: size, height: size }}
      title={vendor}
    >
      <Icon size={size} />
    </span>
  );
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
